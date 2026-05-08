from __future__ import annotations

import json
import os
import re
import time
import traceback
from datetime import datetime, timezone
from difflib import SequenceMatcher
from email.utils import parsedate_to_datetime
from html import unescape
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
SYNC_PATH = DATA_DIR / "steamgifts-sync.json"
PROGRESS_PATH = DATA_DIR / "steam-progress.json"
HLTB_CACHE_PATH = DATA_DIR / "hltb-cache.json"
HOST = "127.0.0.1"
PORT = 4173
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
)
STEAM_API_BASE = "https://api.steampowered.com"
HLTB_BASE = "https://howlongtobeat.com"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def save_json(path: Path, payload) -> None:
    ensure_data_dir()
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def month_key(value: str | None) -> str:
    return str(value or "")[:7]


def compute_retry_delay(error: HTTPError | URLError | TimeoutError, attempt: int) -> float:
    if isinstance(error, HTTPError):
        retry_after = error.headers.get("Retry-After")
        if retry_after:
            try:
                return max(0.5, float(retry_after))
            except ValueError:
                parsed = parsedate_to_datetime(retry_after)
                return max(0.5, (parsed - datetime.now(timezone.utc)).total_seconds())
    return min(12.0, 1.5 * (2**attempt))


def open_url(request: Request, *, timeout: int = 30, attempts: int = 4):
    for attempt in range(attempts):
        try:
            return urlopen(request, timeout=timeout)
        except HTTPError as error:
            if error.code not in {HTTPStatus.TOO_MANY_REQUESTS, 500, 502, 503, 504} or attempt == attempts - 1:
                raise
            time.sleep(compute_retry_delay(error, attempt))
        except (URLError, TimeoutError) as error:
            if attempt == attempts - 1:
                raise
            time.sleep(compute_retry_delay(error, attempt))


def merge_sync_payload(existing: dict, incoming: dict) -> dict:
    if not existing:
        merged = incoming.copy()
        merged["mergedAt"] = utc_now()
        return merged

    members = {
        member.get("username"): member
        for member in existing.get("members", [])
        if member.get("username")
    }
    for member in incoming.get("members", []):
        username = member.get("username")
        if not username:
            continue
        if username not in members:
            members[username] = member
            continue
        if not members[username].get("steamProfile") and member.get("steamProfile"):
            members[username]["steamProfile"] = member.get("steamProfile")
        if "isActiveMember" in member:
            members[username]["isActiveMember"] = bool(member.get("isActiveMember"))

    giveaways = {
        giveaway.get("code"): giveaway
        for giveaway in existing.get("giveaways", [])
        if giveaway.get("code")
    }
    for giveaway in incoming.get("giveaways", []):
        code = giveaway.get("code")
        if not code:
            continue
        if code not in giveaways:
            giveaways[code] = giveaway
            continue
        merged_giveaway = giveaways[code]
        for key, value in giveaway.items():
            if value not in (None, "", [], {}):
                merged_giveaway[key] = value
        incoming_status = giveaway.get("resultStatus")
        if incoming_status and incoming_status != "unknown":
            merged_giveaway["winners"] = list(giveaway.get("winners", []))
        else:
            winners = {
                winner.get("username"): winner
                for winner in merged_giveaway.get("winners", [])
                if winner.get("username")
            }
            for winner in giveaway.get("winners", []):
                username = winner.get("username")
                if username:
                    winners[username] = winner
            merged_giveaway["winners"] = list(winners.values())

    merged = {
        **existing,
        **incoming,
        "group": incoming.get("group") or existing.get("group"),
        "members": sorted(members.values(), key=lambda item: item.get("username", "").lower()),
        "giveaways": sorted(
            giveaways.values(),
            key=lambda item: (item.get("endDate") or "", item.get("code") or ""),
            reverse=True,
        ),
        "wins": build_wins_from_giveaways(
            {
                "giveaways": sorted(
                    giveaways.values(),
                    key=lambda item: (item.get("endDate") or "", item.get("code") or ""),
                    reverse=True,
                ),
                "syncedAt": incoming.get("syncedAt") or existing.get("syncedAt"),
            }
        ),
        "savedAt": utc_now(),
        "mergedAt": utc_now(),
    }
    return merged


def fetch_html(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with open_url(request) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_json(url: str, *, headers: dict | None = None, data: bytes | None = None, method: str | None = None):
    request_headers = {"User-Agent": USER_AGENT, **(headers or {})}
    request = Request(url, headers=request_headers, data=data, method=method or ("POST" if data else "GET"))
    with open_url(request) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def strip_html(html: str) -> str:
    cleaned = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    cleaned = re.sub(r"<style[\s\S]*?</style>", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"<[^>]+>", " ", cleaned)
    return re.sub(r"\s+", " ", unescape(cleaned)).strip()


def build_achievement_url(steam_profile: str, app_id: int | str) -> str:
    normalized = steam_profile.rstrip("/")
    return f"{normalized}/stats/{app_id}/achievements/"


def parse_achievement_summary(html: str) -> dict:
    text = strip_html(html)
    match = re.search(r"(\d+)\s+of\s+(\d+)\s+\((\d+)%\)\s+achievements earned", text, re.I)
    hours_match = re.search(r"([\d.,]+)\s*hrs on record", text, re.I)

    earned = int(match.group(1)) if match else 0
    total = int(match.group(2)) if match else 0
    percent = int(match.group(3)) if match else 0
    playtime_hours = None
    if hours_match:
        playtime_hours = float(hours_match.group(1).replace(",", "."))

    return {
        "visible": bool(match),
        "earnedAchievements": earned,
        "totalAchievements": total,
        "achievementPercent": percent,
        "playtimeHours": playtime_hours,
    }


def is_suspicious_steam_response(html: str) -> bool:
    text = strip_html(html).lower()
    return any(
        marker in text
        for marker in (
            "access denied",
            "verify that you are human",
            "captcha",
            "too many requests",
            "error was encountered while processing your request",
        )
    )


def build_progress_cache(existing_payload: dict) -> dict[tuple[str, int], dict]:
    cache = {}
    for item in existing_payload.get("progress", []):
        steam_profile = item.get("steamProfile")
        app_id = item.get("appId")
        if not steam_profile or not app_id:
            continue
        try:
            cache[(steam_profile, int(app_id))] = item
        except (TypeError, ValueError):
            continue
    return cache


def merge_progress_item(base: dict | None, *, username: str, steam_profile: str, app_id: int, title: str, progress_url: str, api_playtime):
    item = dict(base or {})
    item.update(
        {
            "username": username,
            "steamProfile": steam_profile,
            "appId": int(app_id),
            "title": title,
            "progressUrl": progress_url,
        }
    )
    if api_playtime is not None:
        item["playtimeHours"] = api_playtime
    item.setdefault("visible", False)
    item.setdefault("earnedAchievements", 0)
    item.setdefault("totalAchievements", 0)
    item.setdefault("achievementPercent", 0)
    item.setdefault("playtimeHours", None)
    item.setdefault("error", None)
    return item


def derive_wins(sync_payload: dict) -> list[dict]:
    wins = sync_payload.get("wins")
    if wins:
        return wins

    return build_wins_from_giveaways(sync_payload)


def build_wins_from_giveaways(sync_payload: dict) -> list[dict]:
    derived = []
    for giveaway in sync_payload.get("giveaways", []):
        for winner in giveaway.get("winners", []):
            derived.append(
                {
                    "giveawayCode": giveaway.get("code"),
                    "title": giveaway.get("title"),
                    "appId": giveaway.get("appId"),
                    "winnerUsername": winner.get("username"),
                    "creatorUsername": giveaway.get("creatorUsername"),
                    "winDate": giveaway.get("endDate"),
                }
            )
    return derived


def get_steam_api_key() -> str:
    return os.environ.get("STEAM_WEB_API_KEY", "").strip()


def extract_steam_id_from_profile(steam_profile: str, api_key: str, cache: dict[str, str]) -> str | None:
    if not steam_profile:
        return None
    if steam_profile in cache:
        return cache[steam_profile] or None

    profile_match = re.search(r"/profiles/(\d+)", steam_profile)
    if profile_match:
        cache[steam_profile] = profile_match.group(1)
        return cache[steam_profile]

    vanity_match = re.search(r"/id/([^/?#]+)", steam_profile)
    if not vanity_match or not api_key:
        cache[steam_profile] = ""
        return None

    query = urlencode({"key": api_key, "vanityurl": vanity_match.group(1), "format": "json"})
    payload = fetch_json(f"{STEAM_API_BASE}/ISteamUser/ResolveVanityURL/v1/?{query}")
    steam_id = str(payload.get("response", {}).get("steamid") or "")
    cache[steam_profile] = steam_id
    return steam_id or None


def fetch_owned_games_playtime(steam_id: str, api_key: str) -> dict[str, float]:
    if not steam_id or not api_key:
        return {}

    query = urlencode(
        {
            "key": api_key,
            "steamid": steam_id,
            "include_appinfo": "0",
            "include_played_free_games": "1",
            "format": "json",
        }
    )
    payload = fetch_json(f"{STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/?{query}")
    games = payload.get("response", {}).get("games", [])
    return {
        str(game.get("appid")): round(float(game.get("playtime_forever", 0)) / 60, 2)
        for game in games
        if game.get("appid")
    }


def normalize_title(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", value.lower())).strip()


def fetch_hltb_auth() -> dict:
    return fetch_json(
        f"{HLTB_BASE}/api/bleed/init?t={int(time.time() * 1000)}",
        headers={"Referer": f"{HLTB_BASE}/", "Origin": HLTB_BASE},
    )


def search_hltb(title: str) -> dict | None:
    auth = fetch_hltb_auth()
    payload = {
        "searchType": "games",
        "searchTerms": title.strip().split(),
        "searchPage": 1,
        "size": 20,
        "searchOptions": {
            "games": {
                "userId": 0,
                "platform": "",
                "sortCategory": "popular",
                "rangeCategory": "main",
                "rangeTime": {"min": 0, "max": 0},
                "gameplay": {
                    "perspective": "",
                    "flow": "",
                    "genre": "",
                    "difficulty": "",
                },
                "rangeYear": {"min": "", "max": ""},
                "modifier": "",
            },
            "users": {"sortCategory": "postcount"},
            "lists": {"sortCategory": "follows"},
            "filter": "",
            "sort": 0,
            "randomizer": 0,
        },
        "useCache": True,
    }
    hp_key = auth.get("hpKey")
    hp_val = auth.get("hpVal")
    if hp_key:
        payload[hp_key] = hp_val

    headers = {
        "Content-Type": "application/json",
        "Accept": "*/*",
        "Referer": f"{HLTB_BASE}/",
        "Origin": HLTB_BASE,
        "x-auth-token": str(auth.get("token") or ""),
        "x-hp-key": str(hp_key or ""),
        "x-hp-val": str(hp_val or ""),
    }

    try:
        return fetch_json(
            f"{HLTB_BASE}/api/bleed",
            headers=headers,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
        )
    except HTTPError as error:
        if error.code != HTTPStatus.FORBIDDEN:
            raise
        auth = fetch_hltb_auth()
        hp_key = auth.get("hpKey")
        hp_val = auth.get("hpVal")
        if hp_key:
            payload[hp_key] = hp_val
        headers["x-auth-token"] = str(auth.get("token") or "")
        headers["x-hp-key"] = str(hp_key or "")
        headers["x-hp-val"] = str(hp_val or "")
        return fetch_json(
            f"{HLTB_BASE}/api/bleed",
            headers=headers,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
        )


def choose_hltb_match(title: str, results: list[dict]) -> dict | None:
    normalized_title = normalize_title(title)
    best_match = None
    best_score = 0.0

    for item in results:
        game_name = item.get("game_name") or ""
        candidate = normalize_title(game_name)
        if not candidate:
            continue
        score = SequenceMatcher(None, normalized_title, candidate).ratio()
        if candidate == normalized_title:
            score += 0.25
        elif normalized_title in candidate or candidate in normalized_title:
            score += 0.1
        if item.get("game_type") != "game":
            score -= 0.15
        if not item.get("comp_main"):
            score -= 0.05
        if score > best_score:
            best_score = score
            best_match = item

    if best_score < 0.45:
        return None
    return best_match


def lookup_hltb_hours(title: str, cache: dict) -> dict:
    cache_key = normalize_title(title)
    if cache_key in cache:
        return cache[cache_key]

    try:
        payload = search_hltb(title)
        best_match = choose_hltb_match(title, payload.get("data", [])) if payload else None
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        best_match = None

    result = {
        "title": title,
        "hltbHours": round(float(best_match.get("comp_main", 0)) / 3600, 2) if best_match else None,
        "matchedTitle": best_match.get("game_name") if best_match else "",
        "gameId": best_match.get("game_id") if best_match else None,
        "url": f"{HLTB_BASE}/game/{best_match.get('game_id')}" if best_match and best_match.get("game_id") else "",
    }
    cache[cache_key] = result
    return result


def enrich_sync_with_hltb(sync_payload: dict, *, remote_titles: set[str] | None = None) -> tuple[dict, list[dict]]:
    cache = load_json(HLTB_CACHE_PATH, {})
    changed = False
    hltb_items = []
    remote_title_keys = {
        normalize_title(title)
        for title in (remote_titles or set())
        if normalize_title(title)
    }
    all_titles = sorted(
        {
            giveaway.get("title")
            for giveaway in sync_payload.get("giveaways", [])
            if giveaway.get("title")
        }
    )
    title_results = {}
    for title in all_titles:
        cache_key = normalize_title(title)
        if not cache_key:
            continue
        cached = cache.get(cache_key)
        if cached is None and (remote_titles is None or cache_key in remote_title_keys):
            cached = lookup_hltb_hours(title, cache)
        if cached is not None:
            title_results[title] = cached

    for giveaway in sync_payload.get("giveaways", []):
        title = giveaway.get("title") or ""
        cached = title_results.get(title)
        if not cached:
            continue
        hltb_hours = cached.get("hltbHours")
        if hltb_hours and giveaway.get("hltbHours") != hltb_hours:
            giveaway["hltbHours"] = hltb_hours
            changed = True

    for giveaway in sync_payload.get("giveaways", []):
        title = giveaway.get("title") or ""
        cached = title_results.get(title)
        if not cached:
            continue
        hltb_items.append(
            {
                "title": title,
                "appId": giveaway.get("appId"),
                "hltbHours": cached.get("hltbHours"),
                "matchedTitle": cached.get("matchedTitle", ""),
                "url": cached.get("url", ""),
            }
        )

    save_json(HLTB_CACHE_PATH, cache)
    if changed:
        save_json(SYNC_PATH, sync_payload)
    return sync_payload, hltb_items


def collect_progress_targets(
    sync_payload: dict,
    target_month: str | None = None,
    *,
    full_refresh: bool = False,
) -> tuple[list[dict], dict, set[str], str | None]:
    members = {
        member.get("username"): member
        for member in sync_payload.get("members", [])
        if member.get("username")
    }
    active_usernames = {
        member.get("username")
        for member in sync_payload.get("members", [])
        if member.get("username") and member.get("isActiveMember") is True
    }
    eligible_wins = []
    available_months = set()

    for win in derive_wins(sync_payload):
        username = win.get("winnerUsername") or win.get("username")
        app_id = win.get("appId")
        steam_profile = members.get(username, {}).get("steamProfile", "")
        win_month = month_key(win.get("winDate"))
        if active_usernames and username not in active_usernames:
            continue
        if not username or not app_id or not steam_profile:
            continue
        eligible_wins.append(win)
        if win_month:
            available_months.add(win_month)

    selected_month = None if full_refresh else target_month or (max(available_months) if available_months else None)
    if selected_month:
        eligible_wins = [win for win in eligible_wins if month_key(win.get("winDate")) == selected_month]
    return eligible_wins, members, active_usernames, selected_month


def refresh_steam_progress(
    sync_payload: dict,
    target_month: str | None = None,
    *,
    full_refresh: bool = False,
) -> dict:
    target_wins, members, active_usernames, selected_month = collect_progress_targets(
        sync_payload,
        target_month,
        full_refresh=full_refresh,
    )
    sync_payload, hltb_items = enrich_sync_with_hltb(
        sync_payload,
        remote_titles=set() if full_refresh else {win.get("title") for win in target_wins if win.get("title")},
    )
    existing_progress_payload = load_json(PROGRESS_PATH, {"progress": []})
    progress_cache = build_progress_cache(existing_progress_payload)
    steam_api_key = get_steam_api_key()
    steam_id_cache: dict[str, str] = {}
    owned_games_cache: dict[str, dict[str, float]] = {}
    seen = set()

    for win in target_wins:
        username = win.get("winnerUsername") or win.get("username")
        app_id = win.get("appId")
        steam_profile = members.get(username, {}).get("steamProfile", "")
        key = (steam_profile, str(app_id))
        if key in seen:
            continue
        seen.add(key)

        cached_item = progress_cache.get((steam_profile, int(app_id)))
        api_playtime = None
        if steam_api_key:
            try:
                if steam_profile not in owned_games_cache:
                    steam_id = extract_steam_id_from_profile(steam_profile, steam_api_key, steam_id_cache)
                    owned_games_cache[steam_profile] = (
                        fetch_owned_games_playtime(steam_id, steam_api_key) if steam_id else {}
                    )
                api_playtime = owned_games_cache.get(steam_profile, {}).get(str(app_id))
            except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
                api_playtime = None

        progress_url = build_achievement_url(steam_profile, app_id)
        item = {
            **merge_progress_item(
                cached_item,
                username=username,
                steam_profile=steam_profile,
                app_id=int(app_id),
                title=win.get("title", ""),
                progress_url=progress_url,
                api_playtime=api_playtime,
            ),
            "checkedAt": utc_now(),
        }

        try:
            html = fetch_html(progress_url)
            if is_suspicious_steam_response(html):
                raise RuntimeError("Steam Community temporarily blocked the stats page.")
            item.update(parse_achievement_summary(html))
            if api_playtime is not None:
                item["playtimeHours"] = api_playtime
            item["error"] = None
        except (HTTPError, URLError, TimeoutError, RuntimeError) as error:
            if cached_item:
                item = merge_progress_item(
                    cached_item,
                    username=username,
                    steam_profile=steam_profile,
                    app_id=int(app_id),
                    title=win.get("title", ""),
                    progress_url=progress_url,
                    api_playtime=api_playtime,
                )
            item["error"] = str(error)
            item["checkedAt"] = utc_now()

        progress_cache[(steam_profile, int(app_id))] = item

    payload = {
        "updatedAt": utc_now(),
        "progress": sorted(
            progress_cache.values(),
            key=lambda item: (str(item.get("username") or "").lower(), int(item.get("appId") or 0)),
        ),
        "hltb": hltb_items,
        "steamApiEnabled": bool(steam_api_key),
        "activeOnly": bool(active_usernames),
        "refreshedMonth": selected_month,
        "refreshedScope": "all" if full_refresh else "month",
    }
    save_json(PROGRESS_PATH, payload)
    return payload


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/steamgifts-sync":
                self.write_json(load_json(SYNC_PATH, {}))
                return
            if parsed.path == "/api/steam-progress":
                self.write_json(load_json(PROGRESS_PATH, {"updatedAt": None, "progress": []}))
                return
            super().do_GET()
        except Exception as error:  # noqa: BLE001
            self.handle_api_exception(error)

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/steamgifts-sync":
                payload = self.read_json()
                if not isinstance(payload, dict):
                    self.write_json({"error": "JSON payload expected."}, status=HTTPStatus.BAD_REQUEST)
                    return
                payload.setdefault("savedAt", utc_now())
                existing = load_json(SYNC_PATH, {})
                merged = merge_sync_payload(existing, payload)
                save_json(SYNC_PATH, merged)
                self.write_json(
                    {
                        "ok": True,
                        "savedAt": merged["savedAt"],
                        "members": len(merged.get("members", [])),
                        "giveaways": len(merged.get("giveaways", [])),
                    }
                )
                return
            if parsed.path == "/api/refresh-steam-progress":
                sync_payload = load_json(SYNC_PATH, {})
                if not sync_payload.get("giveaways"):
                    self.write_json(
                        {"error": "No SteamGifts sync data available yet."},
                        status=HTTPStatus.BAD_REQUEST,
                    )
                    return
                payload = self.read_json()
                target_month = payload.get("month") if isinstance(payload, dict) else None
                full_refresh = bool(payload.get("fullRefresh")) if isinstance(payload, dict) else False
                self.write_json(
                    refresh_steam_progress(
                        sync_payload,
                        target_month=target_month,
                        full_refresh=full_refresh,
                    )
                )
                return

            self.write_json({"error": "Not found."}, status=HTTPStatus.NOT_FOUND)
        except Exception as error:  # noqa: BLE001
            self.handle_api_exception(error)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            return None

    def write_json(self, payload, status=HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_api_exception(self, error: Exception) -> None:
        traceback.print_exc()
        try:
            self.write_json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
        except OSError:
            pass

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


def main() -> None:
    ensure_data_dir()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Akatsuki Monitor server running at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
