from __future__ import annotations

import argparse
import json
import os
import re
import time
import traceback
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from email.utils import parsedate_to_datetime
from html import unescape
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from shutil import copy2, copytree
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
ENV_PATH = BASE_DIR / ".env"
SYNC_PATH = DATA_DIR / "steamgifts-sync.json"
PROGRESS_PATH = DATA_DIR / "steam-progress.json"
LIBRARY_PATH = DATA_DIR / "steam-library.json"
HLTB_CACHE_PATH = DATA_DIR / "hltb-cache.json"
MEDIA_CACHE_PATH = DATA_DIR / "steam-media-cache.json"
OVERRIDES_PATH = DATA_DIR / "overrides.json"
STATIC_EXPORT_DIR = BASE_DIR / "site"
HOST = "127.0.0.1"
PORT = 4173
LIBRARY_SNAPSHOT_TTL_HOURS = 48
PROGRESS_SNAPSHOT_TTL_HOURS = 48
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
)
STEAM_API_BASE = "https://api.steampowered.com"
HLTB_BASE = "https://howlongtobeat.com"
SNAPSHOT_CONTRACT_VERSION = 1
STATIC_FILE_NAMES = [
    "admin.html",
    "cycles.html",
    "index.html",
    "monthly-progress.html",
    "summer-event.html",
    "app.js",
    "steamgifts-live-bookmarklet.js",
    "styles.css",
    "active-users.html",
    "inactive-users.html",
    "bookmarklet-helper.html",
    "bookmarklet-helper.png",
    "akatsuki.png",
]
STATIC_DIRECTORIES = ["client"]
PUBLIC_PAGE_FILES = [
    "index.html",
    "cycles.html",
    "monthly-progress.html",
    "summer-event.html",
    "active-users.html",
    "inactive-users.html",
    "admin.html",
    "404.html",
]
PUBLIC_API_FILES = [
    "steamgifts-sync.json",
    "steam-progress.json",
    "steam-library.json",
    "dashboard.json",
    "members.json",
    "giveaways.json",
    "overrides.json",
    "snapshot.json",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_store_release_date(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if re.match(r"^\d{4}-\d{2}-\d{2}$", raw):
        return raw
    lowered = raw.lower()
    if any(token in lowered for token in ("coming soon", "to be announced", "tba")):
        return ""
    for fmt in ("%d %b, %Y", "%b %d, %Y", "%d %B, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    for fmt in ("%b %Y", "%B %Y"):
        try:
            parsed = datetime.strptime(raw, fmt)
            return parsed.date().replace(day=1).isoformat()
        except ValueError:
            continue
    return ""


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


def empty_progress_payload() -> dict:
    return {"updatedAt": None, "progress": [], "stats": {}, "libraryStats": {}}


def empty_library_payload() -> dict:
    return {
        "updatedAt": None,
        "apiEnabled": False,
        "refreshedScope": None,
        "refreshedMonth": None,
        "profiles": [],
        "playtimes": [],
        "source": "steam-web-api",
        "stats": {},
    }


def empty_media_cache() -> dict:
    return {"updatedAt": None, "apps": {}}


def empty_overrides_payload() -> dict:
    return {
        "savedAt": None,
        "overrides": {
            "games": {},
            "wins": {},
            "giveaways": {},
            "cycleMembers": {},
        },
    }


def normalize_overrides_payload(payload=None) -> dict:
    source = payload if isinstance(payload, dict) else {}
    raw_overrides = source.get("overrides") if isinstance(source.get("overrides"), dict) else source
    if not isinstance(raw_overrides, dict):
        raw_overrides = {}
    return {
        "savedAt": str(source.get("savedAt") or "") or None,
        "overrides": {
            "games": dict(raw_overrides.get("games") or {}),
            "wins": dict(raw_overrides.get("wins") or {}),
            "giveaways": dict(raw_overrides.get("giveaways") or {}),
            "cycleMembers": dict(raw_overrides.get("cycleMembers") or {}),
        },
    }


def build_snapshot_manifest(
    sync_export: dict,
    progress_payload: dict,
    library_payload: dict,
    overrides_payload: dict,
    dashboard_payload: dict,
    members_payload: dict,
    giveaways_payload: dict,
) -> dict:
    return {
        "contractVersion": SNAPSHOT_CONTRACT_VERSION,
        "generatedAt": utc_now(),
        "pages": list(PUBLIC_PAGE_FILES),
        "apiFiles": list(PUBLIC_API_FILES),
        "frontend": {
            "files": list(STATIC_FILE_NAMES),
            "directories": list(STATIC_DIRECTORIES),
        },
        "source": {
            "steamgiftsUpdatedAt": sync_export.get("syncedAt") or sync_export.get("savedAt") or sync_export.get("updatedAt"),
            "steamProgressUpdatedAt": progress_payload.get("updatedAt"),
            "steamLibraryUpdatedAt": library_payload.get("updatedAt"),
            "overridesSavedAt": overrides_payload.get("savedAt"),
        },
        "counts": {
            "members": len(sync_export.get("members", [])),
            "activeMembers": members_payload.get("counts", {}).get("active", 0),
            "inactiveMembers": members_payload.get("counts", {}).get("inactive", 0),
            "giveaways": len(sync_export.get("giveaways", [])),
            "wins": len(sync_export.get("wins", [])),
            "dashboardGiveaways": len(dashboard_payload.get("recentGiveaways", [])),
            "publicGiveawayRows": len(giveaways_payload.get("results", [])),
        },
    }


def validate_static_site(output_dir: Path) -> None:
    errors: list[str] = []

    def expect_path(path: Path, label: str) -> None:
        if not path.exists():
            errors.append(f"Missing {label}: {path}")

    def read_mapping(path: Path, label: str) -> dict | None:
        if not path.exists():
            errors.append(f"Missing {label}: {path}")
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            errors.append(f"Invalid JSON in {label}: {error}")
            return None
        if not isinstance(payload, dict):
            errors.append(f"Expected {label} to be a JSON object.")
            return None
        return payload

    def expect_list(payload: dict | None, key: str, label: str) -> None:
        if payload is None:
            return
        if not isinstance(payload.get(key), list):
            errors.append(f"Expected {label}.{key} to be a list.")

    for file_name in PUBLIC_PAGE_FILES:
        expect_path(output_dir / file_name, f"public page {file_name}")
    for file_name in STATIC_FILE_NAMES:
        expect_path(output_dir / file_name, f"static file {file_name}")
    for directory_name in STATIC_DIRECTORIES:
        path = output_dir / directory_name
        if not path.is_dir():
            errors.append(f"Missing static directory {directory_name}: {path}")

    api_dir = output_dir / "api"
    if not api_dir.is_dir():
        errors.append(f"Missing API directory: {api_dir}")

    sync_export = read_mapping(api_dir / "steamgifts-sync.json", "steamgifts-sync.json")
    progress_payload = read_mapping(api_dir / "steam-progress.json", "steam-progress.json")
    library_payload = read_mapping(api_dir / "steam-library.json", "steam-library.json")
    dashboard_payload = read_mapping(api_dir / "dashboard.json", "dashboard.json")
    members_payload = read_mapping(api_dir / "members.json", "members.json")
    giveaways_payload = read_mapping(api_dir / "giveaways.json", "giveaways.json")
    overrides_payload = read_mapping(api_dir / "overrides.json", "overrides.json")
    manifest_payload = read_mapping(api_dir / "snapshot.json", "snapshot.json")

    expect_list(sync_export, "members", "steamgifts-sync.json")
    expect_list(sync_export, "giveaways", "steamgifts-sync.json")
    expect_list(sync_export, "wins", "steamgifts-sync.json")
    expect_list(progress_payload, "progress", "steam-progress.json")
    expect_list(library_payload, "profiles", "steam-library.json")
    expect_list(library_payload, "playtimes", "steam-library.json")
    expect_list(dashboard_payload, "recentGiveaways", "dashboard.json")
    expect_list(members_payload, "active", "members.json")
    expect_list(members_payload, "inactive", "members.json")
    expect_list(giveaways_payload, "results", "giveaways.json")

    if overrides_payload is not None and not isinstance(overrides_payload.get("overrides"), dict):
        errors.append("Expected overrides.json.overrides to be an object.")

    if manifest_payload is not None:
        if manifest_payload.get("contractVersion") != SNAPSHOT_CONTRACT_VERSION:
            errors.append("snapshot.json has an unexpected contractVersion.")
        if sorted(manifest_payload.get("pages") or []) != sorted(PUBLIC_PAGE_FILES):
            errors.append("snapshot.json pages do not match the exported public pages.")
        if sorted(manifest_payload.get("apiFiles") or []) != sorted(PUBLIC_API_FILES):
            errors.append("snapshot.json apiFiles do not match the exported API payloads.")
        if not isinstance(manifest_payload.get("counts"), dict):
            errors.append("Expected snapshot.json.counts to be an object.")

    if manifest_payload is not None and sync_export is not None:
        counts = manifest_payload.get("counts") or {}
        if counts.get("members") != len(sync_export.get("members", [])):
            errors.append("snapshot.json member count does not match steamgifts-sync.json.")
        if counts.get("giveaways") != len(sync_export.get("giveaways", [])):
            errors.append("snapshot.json giveaway count does not match steamgifts-sync.json.")
        if counts.get("wins") != len(sync_export.get("wins", [])):
            errors.append("snapshot.json win count does not match steamgifts-sync.json.")

    if manifest_payload is not None and members_payload is not None:
        counts = manifest_payload.get("counts") or {}
        member_counts = members_payload.get("counts") or {}
        if counts.get("activeMembers") != member_counts.get("active"):
            errors.append("snapshot.json active member count does not match members.json.")
        if counts.get("inactiveMembers") != member_counts.get("inactive"):
            errors.append("snapshot.json inactive member count does not match members.json.")

    if manifest_payload is not None and giveaways_payload is not None and dashboard_payload is not None:
        counts = manifest_payload.get("counts") or {}
        if counts.get("publicGiveawayRows") != len(giveaways_payload.get("results", [])):
            errors.append("snapshot.json publicGiveawayRows does not match giveaways.json.")
        if counts.get("dashboardGiveaways") != len(dashboard_payload.get("recentGiveaways", [])):
            errors.append("snapshot.json dashboardGiveaways does not match dashboard.json.")

    if errors:
        raise SystemExit("Static site validation failed:\n - " + "\n - ".join(errors))

    print(
        f"Validated static site snapshot at {output_dir}:"
        f" {len(PUBLIC_PAGE_FILES)} pages,"
        f" {len(PUBLIC_API_FILES)} API payloads."
    )


def build_media_lookup(media_cache: dict) -> dict[int, dict]:
    lookup = {}
    for key, value in (media_cache.get("apps") or {}).items():
        app_id = parse_int(key)
        if app_id:
            lookup[app_id] = value
    return lookup


def parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_dotenv_values(path: Path = ENV_PATH) -> dict[str, str]:
    if not path.exists():
        return {}
    values = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key.strip()] = value
    return values


def month_key(value: str | None) -> str:
    return str(value or "")[:7]


def get_effective_month_key(base_date: str | None, release_date: str | None) -> str:
    base_month = month_key(base_date)
    release_month = month_key(normalize_store_release_date(release_date))
    if not release_month or release_month <= base_month:
        return base_month
    return release_month


def parse_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


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


def build_steam_media(app_id: int | None) -> dict[str, str]:
    if not app_id:
        return {
            "headerImageUrl": "",
            "capsuleImageUrl": "",
            "capsuleSmallUrl": "",
        }

    return {
        "headerImageUrl": f"https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/header.jpg",
        "capsuleImageUrl": f"https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/capsule_616x353.jpg",
        "capsuleSmallUrl": f"https://cdn.cloudflare.steamstatic.com/steam/apps/{app_id}/capsule_184x69.jpg",
    }


def fetch_store_media(app_id: int) -> dict[str, str]:
    payload = fetch_json(
        f"https://store.steampowered.com/api/appdetails?{urlencode({'appids': str(app_id), 'l': 'english'})}"
    )
    data = (payload.get(str(app_id)) or {}).get("data") or {}
    release_date = (data.get("release_date") or {})
    return {
        "headerImageUrl": str(data.get("header_image") or ""),
        "capsuleImageUrl": str(data.get("capsule_image") or ""),
        "capsuleSmallUrl": str(data.get("capsule_imagev5") or data.get("capsule_image") or ""),
        "releaseDate": normalize_store_release_date(release_date.get("date")),
        "comingSoon": bool(release_date.get("coming_soon")),
    }


def fetch_store_media_batch(app_ids: list[int]) -> dict[int, dict[str, str]]:
    unique_ids = [app_id for app_id in sorted({parse_int(app_id) for app_id in app_ids if parse_int(app_id)}) if app_id]
    if not unique_ids:
        return {}
    payload = fetch_json(
        f"https://store.steampowered.com/api/appdetails?{urlencode({'appids': ','.join(str(app_id) for app_id in unique_ids), 'l': 'english'})}"
    )
    results: dict[int, dict[str, str]] = {}
    for app_id in unique_ids:
        data = (payload.get(str(app_id)) or {}).get("data") or {}
        release_date = (data.get("release_date") or {})
        results[app_id] = {
            "appId": app_id,
            "headerImageUrl": str(data.get("header_image") or ""),
            "capsuleImageUrl": str(data.get("capsule_image") or ""),
            "capsuleSmallUrl": str(data.get("capsule_imagev5") or data.get("capsule_image") or ""),
            "releaseDate": normalize_store_release_date(release_date.get("date")),
            "comingSoon": bool(release_date.get("coming_soon")),
        }
    return results


def has_complete_media_entry(media_entry: dict | None) -> bool:
    entry = media_entry or {}
    return bool(
        entry.get("headerImageUrl")
        and entry.get("capsuleImageUrl")
        and entry.get("capsuleSmallUrl")
        and (normalize_store_release_date(entry.get("releaseDate")) or entry.get("comingSoon"))
    )


def collect_sync_media_app_ids(sync_payload: dict, *, recent_days: int | None = None) -> list[int]:
    if recent_days is None:
        return sorted({parse_int(win.get("appId")) for win in derive_wins(sync_payload) if parse_int(win.get("appId"))})

    threshold = datetime.now(timezone.utc) - timedelta(days=max(1, recent_days))
    app_ids = {
        parse_int(giveaway.get("appId"))
        for giveaway in sync_payload.get("giveaways", [])
        if parse_int(giveaway.get("appId"))
        and parse_datetime(giveaway.get("endDate"))
        and parse_datetime(giveaway.get("endDate")) >= threshold
    }
    return sorted(app_id for app_id in app_ids if app_id)


def hydrate_media_cache_for_sync(sync_payload: dict, media_cache: dict, *, recent_days: int | None = None) -> dict:
    app_ids = collect_sync_media_app_ids(sync_payload, recent_days=recent_days)
    missing_app_ids = []
    for app_id in app_ids:
        cached = media_cache.get("apps", {}).get(str(app_id)) or {}
        if has_complete_media_entry(cached):
            continue
        missing_app_ids.append(app_id)

    changed = False
    for start in range(0, len(missing_app_ids), 50):
        batch = missing_app_ids[start : start + 50]
        try:
            batch_results = fetch_store_media_batch(batch)
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
            batch_results = {}

        for app_id in batch:
            media = batch_results.get(app_id)
            if not media:
                try:
                    media = fetch_store_media(app_id)
                except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
                    continue
            if not any(
                (
                    media.get("headerImageUrl"),
                    media.get("capsuleImageUrl"),
                    media.get("capsuleSmallUrl"),
                    media.get("releaseDate"),
                    media.get("comingSoon"),
                )
            ):
                continue
            media_cache.setdefault("apps", {})[str(app_id)] = media
            changed = True

    if changed:
        media_cache["updatedAt"] = utc_now()

    if changed:
        save_json(MEDIA_CACHE_PATH, media_cache)
    return media_cache


def count_missing_media_entries(sync_payload: dict, media_cache: dict, *, recent_days: int | None = None) -> int:
    app_ids = collect_sync_media_app_ids(sync_payload, recent_days=recent_days)
    return sum(1 for app_id in app_ids if not has_complete_media_entry((media_cache.get("apps", {}) or {}).get(str(app_id))))


def get_media_cache_entry(app_id: int, media_cache: dict, *, fetch_missing: bool = False) -> dict[str, str]:
    cache_key = str(app_id)
    cached = media_cache.get("apps", {}).get(cache_key)
    if cached is not None:
        normalized_release_date = normalize_store_release_date(cached.get("releaseDate"))
        if normalized_release_date != str(cached.get("releaseDate") or ""):
            cached["releaseDate"] = normalized_release_date
            media_cache.setdefault("apps", {})[cache_key] = cached
            media_cache["updatedAt"] = utc_now()
        return cached
    if not fetch_missing:
        return {}
    try:
        fetched = fetch_store_media(app_id)
    except (HTTPError, URLError, TimeoutError):
        return {}
    media_cache.setdefault("apps", {})[cache_key] = fetched
    media_cache["updatedAt"] = utc_now()
    return fetched


def with_giveaway_media(giveaway: dict, media_lookup: dict[int, dict] | None = None) -> dict:
    app_id = parse_int(giveaway.get("appId")) or None
    media = build_steam_media(app_id)
    cached_media = (media_lookup or {}).get(app_id or 0, {})
    return {
        **giveaway,
        "appId": app_id,
        "headerImageUrl": giveaway.get("headerImageUrl") or cached_media.get("headerImageUrl") or media["headerImageUrl"],
        "capsuleImageUrl": giveaway.get("capsuleImageUrl") or cached_media.get("capsuleImageUrl") or media["capsuleImageUrl"],
        "capsuleSmallUrl": giveaway.get("capsuleSmallUrl") or cached_media.get("capsuleSmallUrl") or media["capsuleSmallUrl"],
        "releaseDate": normalize_store_release_date(giveaway.get("releaseDate") or cached_media.get("releaseDate")),
        "comingSoon": bool(giveaway.get("comingSoon") or cached_media.get("comingSoon")),
    }


def get_media_payload(app_ids: list[int]) -> dict:
    media_cache = load_json(MEDIA_CACHE_PATH, empty_media_cache())
    results = {}
    changed = False
    for app_id in sorted({app_id for app_id in app_ids if app_id}):
        before = json.dumps(media_cache.get("apps", {}).get(str(app_id)))
        cached = get_media_cache_entry(app_id, media_cache, fetch_missing=True)
        if json.dumps(cached) != before:
            changed = True
        fallback = build_steam_media(app_id)
        results[str(app_id)] = {
            "appId": app_id,
            "headerImageUrl": cached.get("headerImageUrl") or fallback["headerImageUrl"],
            "capsuleImageUrl": cached.get("capsuleImageUrl") or fallback["capsuleImageUrl"],
            "capsuleSmallUrl": cached.get("capsuleSmallUrl") or fallback["capsuleSmallUrl"],
            "releaseDate": cached.get("releaseDate") or "",
            "comingSoon": bool(cached.get("comingSoon")),
        }
    if changed:
        save_json(MEDIA_CACHE_PATH, media_cache)
    return {"updatedAt": media_cache.get("updatedAt"), "results": results}


def build_sync_export_payload(sync_payload: dict, *, media_lookup: dict[int, dict] | None = None) -> dict:
    return {
        **sync_payload,
        "giveaways": [with_giveaway_media(giveaway, media_lookup) for giveaway in sync_payload.get("giveaways", [])],
    }


def enrich_sync_payload_with_media(sync_payload: dict) -> dict:
    media_cache = hydrate_media_cache_for_sync(sync_payload, load_json(MEDIA_CACHE_PATH, empty_media_cache()))
    media_lookup = build_media_lookup(media_cache)
    return build_sync_export_payload(sync_payload, media_lookup=media_lookup)


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

    earned = int(match.group(1)) if match else 0
    total = int(match.group(2)) if match else 0
    percent = int(match.group(3)) if match else 0

    return {
        "visible": bool(match),
        "earnedAchievements": earned,
        "totalAchievements": total,
        "achievementPercent": percent,
        "playtimeHours": None,
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
    item.setdefault("playtimeCheckedAt", None)
    item.setdefault("playtimeSource", "")
    item.setdefault("playtimeVisible", None)
    item.setdefault("gamesVisible", None)
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


def build_progress_lookup(progress_payload: dict) -> dict[tuple[str, int], dict]:
    lookup = {}
    for item in progress_payload.get("progress", []):
        steam_profile = item.get("steamProfile")
        app_id = parse_int(item.get("appId"))
        if steam_profile and app_id:
            lookup[(steam_profile, app_id)] = item
    return lookup


def build_library_playtime_lookup(library_payload: dict) -> dict[tuple[str, int], dict]:
    lookup = {}
    for item in library_payload.get("playtimes", []):
        steam_profile = item.get("steamProfile")
        app_id = parse_int(item.get("appId"))
        if steam_profile and app_id:
            lookup[(steam_profile, app_id)] = item
    return lookup


def build_library_profile_lookup(library_payload: dict) -> dict[str, dict]:
    return {
        item.get("steamProfile"): item
        for item in library_payload.get("profiles", [])
        if item.get("steamProfile")
    }


def is_library_profile_fresh(item: dict, *, ttl_hours: int = LIBRARY_SNAPSHOT_TTL_HOURS) -> bool:
    checked_at = parse_datetime(item.get("checkedAt"))
    if not checked_at:
        return False
    age_seconds = (datetime.now(timezone.utc) - checked_at).total_seconds()
    return age_seconds < ttl_hours * 3600


def is_progress_item_fresh(item: dict, *, ttl_hours: int = PROGRESS_SNAPSHOT_TTL_HOURS) -> bool:
    checked_at = parse_datetime(item.get("checkedAt"))
    if not checked_at:
        return False
    age_seconds = (datetime.now(timezone.utc) - checked_at).total_seconds()
    return age_seconds < ttl_hours * 3600


def build_members_payload(sync_payload: dict) -> dict:
    win_counts: dict[str, int] = {}
    latest_wins: dict[str, str] = {}

    for win in derive_wins(sync_payload):
        username = win.get("winnerUsername") or win.get("username")
        if not username:
            continue
        win_counts[username] = win_counts.get(username, 0) + 1
        win_date = win.get("winDate") or ""
        if win_date and win_date > latest_wins.get(username, ""):
            latest_wins[username] = win_date

    active = []
    inactive = []
    for member in sorted(sync_payload.get("members", []), key=lambda item: str(item.get("username") or "").lower()):
        username = member.get("username")
        if not username:
            continue
        item = {
            "username": username,
            "profileUrl": member.get("profileUrl", ""),
            "steamProfile": member.get("steamProfile", ""),
            "isActiveMember": bool(member.get("isActiveMember")),
            "winsCount": win_counts.get(username, 0),
            "lastWinDate": latest_wins.get(username) or None,
        }
        if item["isActiveMember"]:
            active.append(item)
        else:
            inactive.append(item)

    return {
        "active": active,
        "inactive": inactive,
        "counts": {
            "all": len(active) + len(inactive),
            "active": len(active),
            "inactive": len(inactive),
        },
    }


def build_winner_progress_items(
    giveaway: dict,
    members_by_username: dict[str, dict],
    progress_lookup: dict[tuple[str, int], dict],
    library_playtime_lookup: dict[tuple[str, int], dict],
    library_profile_lookup: dict[str, dict],
) -> list[dict]:
    app_id = parse_int(giveaway.get("appId"))
    items = []
    for winner in giveaway.get("winners", []):
        username = winner.get("username")
        steam_profile = members_by_username.get(username, {}).get("steamProfile", "")
        library_profile = library_profile_lookup.get(steam_profile, {})
        if not username or not app_id:
            items.append(
                {
                    "username": username or "",
                    "steamProfile": steam_profile,
                    "playtimeHours": None,
                    "playtimeCheckedAt": library_profile.get("checkedAt"),
                    "playtimeSource": "",
                    "playtimeVisible": library_profile.get("playtimeVisible"),
                    "gamesVisible": library_profile.get("gamesVisible"),
                    "earnedAchievements": 0,
                    "totalAchievements": 0,
                    "visible": False,
                    "progressUrl": "",
                    "achievementCheckedAt": None,
                    "error": None,
                }
            )
            continue
        progress = progress_lookup.get((steam_profile, app_id), {})
        playtime = library_playtime_lookup.get((steam_profile, app_id), {})
        items.append(
            {
                "username": username,
                "steamProfile": steam_profile,
                "playtimeHours": playtime.get("playtimeHours", progress.get("playtimeHours")),
                "playtimeCheckedAt": playtime.get("checkedAt"),
                "playtimeSource": playtime.get("source", ""),
                "playtimeVisible": library_profile.get("playtimeVisible"),
                "gamesVisible": library_profile.get("gamesVisible"),
                "earnedAchievements": parse_int(progress.get("earnedAchievements")),
                "totalAchievements": parse_int(progress.get("totalAchievements")),
                "visible": bool(progress.get("visible")),
                "progressUrl": progress.get("progressUrl", ""),
                "achievementCheckedAt": progress.get("checkedAt"),
                "error": progress.get("error"),
            }
        )
    return items


def build_giveaways_payload(sync_payload: dict, progress_payload: dict, library_payload: dict, *, limit: int | None = 24) -> dict:
    media_lookup = build_media_lookup(load_json(MEDIA_CACHE_PATH, empty_media_cache()))
    members_by_username = {
        member.get("username"): member
        for member in sync_payload.get("members", [])
        if member.get("username")
    }
    progress_lookup = build_progress_lookup(progress_payload)
    library_playtime_lookup = build_library_playtime_lookup(library_payload)
    library_profile_lookup = build_library_profile_lookup(library_payload)
    giveaways = sorted(
        (with_giveaway_media(giveaway, media_lookup) for giveaway in sync_payload.get("giveaways", [])),
        key=lambda item: (item.get("endDate") or "", item.get("code") or ""),
        reverse=True,
    )
    if limit is not None:
        giveaways = giveaways[:limit]

    results = []
    for giveaway in giveaways:
        winner_progress = build_winner_progress_items(
            giveaway,
            members_by_username,
            progress_lookup,
            library_playtime_lookup,
            library_profile_lookup,
        )
        primary_progress = winner_progress[0] if len(winner_progress) == 1 else None
        results.append(
            {
                "code": giveaway.get("code", ""),
                "title": giveaway.get("title", ""),
                "url": giveaway.get("url", ""),
                "steamAppUrl": giveaway.get("steamAppUrl", ""),
                "appId": giveaway.get("appId"),
                "creatorUsername": giveaway.get("creatorUsername", ""),
                "creatorProfileUrl": giveaway.get("creatorProfileUrl", ""),
                "entriesCount": parse_int(giveaway.get("entriesCount")),
                "points": parse_int(giveaway.get("points")),
                "resultStatus": giveaway.get("resultStatus", ""),
                "resultLabel": giveaway.get("resultLabel", ""),
                "endDate": giveaway.get("endDate"),
                "winnerCount": len(giveaway.get("winners", [])),
                "winners": [winner.get("username", "") for winner in giveaway.get("winners", []) if winner.get("username")],
                "headerImageUrl": giveaway.get("headerImageUrl", ""),
                "capsuleImageUrl": giveaway.get("capsuleImageUrl", ""),
                "capsuleSmallUrl": giveaway.get("capsuleSmallUrl", ""),
                "releaseDate": giveaway.get("releaseDate", ""),
                "comingSoon": bool(giveaway.get("comingSoon")),
                "winnerProgress": winner_progress,
                "primaryProgress": primary_progress,
            }
        )

    return {
        "updatedAt": utc_now(),
        "results": results,
        "total": len(sync_payload.get("giveaways", [])),
        "progressUpdatedAt": progress_payload.get("updatedAt"),
        "libraryUpdatedAt": library_payload.get("updatedAt"),
    }


def build_dashboard_payload(sync_payload: dict, progress_payload: dict, library_payload: dict) -> dict:
    wins = derive_wins(sync_payload)
    members_payload = build_members_payload(sync_payload)
    giveaways_payload = build_giveaways_payload(sync_payload, progress_payload, library_payload, limit=12)
    library_profiles = library_payload.get("profiles", [])
    return {
        "updatedAt": utc_now(),
        "group": sync_payload.get("group") or {},
        "summary": {
            "syncedAt": sync_payload.get("syncedAt") or sync_payload.get("savedAt"),
            "members": len(sync_payload.get("members", [])),
            "activeMembers": members_payload["counts"]["active"],
            "giveaways": len(sync_payload.get("giveaways", [])),
            "wins": len(wins),
            "steamProgressUpdatedAt": progress_payload.get("updatedAt"),
            "refreshedScope": progress_payload.get("refreshedScope"),
            "refreshedMonth": progress_payload.get("refreshedMonth"),
            "steamApiEnabled": bool(progress_payload.get("steamApiEnabled")),
            "libraryUpdatedAt": library_payload.get("updatedAt"),
            "libraryApiEnabled": bool(library_payload.get("apiEnabled")),
            "libraryProfiles": len(library_profiles),
            "libraryFreshProfiles": sum(1 for item in library_profiles if is_library_profile_fresh(item)),
            "librarySnapshotTtlHours": LIBRARY_SNAPSHOT_TTL_HOURS,
            "libraryRefreshedScope": library_payload.get("refreshedScope"),
            "libraryRefreshedMonth": library_payload.get("refreshedMonth"),
            "progressStats": progress_payload.get("stats") or {},
            "libraryStats": library_payload.get("stats") or {},
        },
        "members": members_payload,
        "recentGiveaways": giveaways_payload["results"],
    }


def parse_limit(query: dict[str, list[str]], *, default: int | None, maximum: int = 200) -> int | None:
    value = (query.get("limit") or [None])[0]
    if value in (None, "", "all"):
        return default
    limit = parse_int(value, default or maximum)
    return max(1, min(maximum, limit))


def get_steam_api_key() -> str:
    api_key = os.environ.get("STEAM_WEB_API_KEY", "").strip()
    if api_key:
        return api_key
    return load_dotenv_values().get("STEAM_WEB_API_KEY", "").strip()


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


def fetch_owned_games_snapshot(steam_id: str, api_key: str) -> dict:
    if not steam_id or not api_key:
        return {
            "gamesVisible": False,
            "playtimeVisible": False,
            "gameCount": 0,
            "playtimes": [],
        }

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
    response = payload.get("response", {})
    games = response.get("games")
    if games is None:
        return {
            "gamesVisible": False,
            "playtimeVisible": False,
            "gameCount": 0,
            "playtimes": [],
        }

    playtimes = [
        {
            "appId": parse_int(game.get("appid")),
            "playtimeMinutes": parse_int(game.get("playtime_forever")),
            "playtimeHours": round(float(game.get("playtime_forever", 0)) / 60, 2),
        }
        for game in games
        if game.get("appid")
    ]
    return {
        "gamesVisible": True,
        "playtimeVisible": True,
        "gameCount": parse_int(response.get("game_count"), len(playtimes)) or len(playtimes),
        "playtimes": playtimes,
    }


def collect_library_targets(
    sync_payload: dict,
    target_month: str | None = None,
    *,
    full_refresh: bool = False,
) -> tuple[list[dict], str | None]:
    if full_refresh:
        targets = []
        for member in sync_payload.get("members", []):
            if member.get("isActiveMember") is not True or not member.get("steamProfile") or not member.get("username"):
                continue
            targets.append(
                {
                    "username": member.get("username"),
                    "steamProfile": member.get("steamProfile"),
                }
            )
        return targets, None

    target_wins, members, _, selected_month = collect_progress_targets(sync_payload, target_month)
    targets = []
    seen = set()
    for win in target_wins:
        username = win.get("winnerUsername") or win.get("username")
        steam_profile = members.get(username, {}).get("steamProfile", "")
        if not username or not steam_profile or steam_profile in seen:
            continue
        seen.add(steam_profile)
        targets.append({"username": username, "steamProfile": steam_profile})
    return targets, selected_month


def refresh_steam_library(
    sync_payload: dict,
    target_month: str | None = None,
    *,
    full_refresh: bool = False,
) -> dict:
    started_at = time.perf_counter()
    existing_payload = load_json(LIBRARY_PATH, empty_library_payload())
    playtime_cache = build_library_playtime_lookup(existing_payload)
    profile_cache = build_library_profile_lookup(existing_payload)
    targets, selected_month = collect_library_targets(sync_payload, target_month, full_refresh=full_refresh)
    steam_api_key = get_steam_api_key()
    steam_id_cache: dict[str, str] = {}
    refreshed_profiles = 0
    reused_profiles = 0
    error_profiles = 0
    missing_api_profiles = 0

    for target in targets:
        username = target.get("username", "")
        steam_profile = target.get("steamProfile", "")
        existing_profile = dict(profile_cache.get(steam_profile, {}))
        if not steam_profile:
            continue

        if not steam_api_key:
            missing_api_profiles += 1
            profile_cache[steam_profile] = {
                **existing_profile,
                "username": username or existing_profile.get("username", ""),
                "steamProfile": steam_profile,
                "error": "STEAM_WEB_API_KEY is not configured.",
            }
            continue

        if existing_profile and is_library_profile_fresh(existing_profile):
            reused_profiles += 1
            profile_cache[steam_profile] = {
                **existing_profile,
                "username": username or existing_profile.get("username", ""),
                "steamProfile": steam_profile,
                "error": existing_profile.get("error"),
            }
            continue

        try:
            steam_id = extract_steam_id_from_profile(steam_profile, steam_api_key, steam_id_cache)
            snapshot = fetch_owned_games_snapshot(steam_id or "", steam_api_key)
            checked_at = utc_now()

            stale_keys = [key for key in playtime_cache if key[0] == steam_profile]
            for key in stale_keys:
                del playtime_cache[key]

            for item in snapshot["playtimes"]:
                app_id = parse_int(item.get("appId"))
                if not app_id:
                    continue
                playtime_cache[(steam_profile, app_id)] = {
                    "username": username,
                    "steamProfile": steam_profile,
                    "appId": app_id,
                    "playtimeMinutes": parse_int(item.get("playtimeMinutes")),
                    "playtimeHours": item.get("playtimeHours"),
                    "checkedAt": checked_at,
                    "source": "steam-web-api",
                }

            profile_cache[steam_profile] = {
                "username": username,
                "steamProfile": steam_profile,
                "steamId": steam_id or "",
                "checkedAt": checked_at,
                "gamesVisible": snapshot.get("gamesVisible"),
                "playtimeVisible": snapshot.get("playtimeVisible"),
                "gameCount": snapshot.get("gameCount", 0),
                "error": None,
            }
            refreshed_profiles += 1
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as error:
            error_profiles += 1
            profile_cache[steam_profile] = {
                **existing_profile,
                "username": username or existing_profile.get("username", ""),
                "steamProfile": steam_profile,
                "checkedAt": utc_now(),
                "error": str(error),
            }

    payload = {
        "updatedAt": utc_now(),
        "apiEnabled": bool(steam_api_key),
        "refreshedScope": "all" if full_refresh else "month",
        "refreshedMonth": selected_month,
        "profiles": sorted(profile_cache.values(), key=lambda item: str(item.get("username") or "").lower()),
        "playtimes": sorted(
            playtime_cache.values(),
            key=lambda item: (str(item.get("username") or "").lower(), parse_int(item.get("appId"))),
        ),
        "source": "steam-web-api",
        "stats": {
            "durationSeconds": round(time.perf_counter() - started_at, 2),
            "targetProfiles": len(targets),
            "refreshedProfiles": refreshed_profiles,
            "reusedProfiles": reused_profiles,
            "errorProfiles": error_profiles,
            "missingApiProfiles": missing_api_profiles,
            "totalProfiles": len(profile_cache),
            "freshProfiles": sum(1 for item in profile_cache.values() if is_library_profile_fresh(item)),
            "totalPlaytimeRows": len(playtime_cache),
        },
    }
    save_json(LIBRARY_PATH, payload)
    return payload


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
    media_lookup = build_media_lookup(load_json(MEDIA_CACHE_PATH, empty_media_cache()))
    release_by_code: dict[str, str] = {}
    release_by_app_id: dict[int, str] = {}
    release_by_title: dict[str, str] = {}

    for giveaway in sync_payload.get("giveaways", []):
        code = str(giveaway.get("code") or "")
        app_id = parse_int(giveaway.get("appId"))
        title = str(giveaway.get("title") or "")
        release_date = normalize_store_release_date(
            giveaway.get("releaseDate") or (media_lookup.get(app_id) or {}).get("releaseDate")
        )
        if code and release_date:
            release_by_code[code] = release_date
        if app_id and release_date:
            release_by_app_id[app_id] = release_date
        if title and release_date:
            release_by_title[title] = release_date

    for win in derive_wins(sync_payload):
        username = win.get("winnerUsername") or win.get("username")
        app_id = parse_int(win.get("appId"))
        steam_profile = members.get(username, {}).get("steamProfile", "")
        release_date = (
            release_by_code.get(str(win.get("giveawayCode") or ""))
            or release_by_app_id.get(app_id)
            or release_by_title.get(str(win.get("title") or ""))
            or ""
        )
        win_month = get_effective_month_key(win.get("winDate"), release_date)
        if active_usernames and username not in active_usernames:
            continue
        if not username or not app_id or not steam_profile:
            continue
        eligible_wins.append(win)
        if win_month:
            available_months.add(win_month)

    selected_month = None if full_refresh else target_month or (max(available_months) if available_months else None)
    if selected_month:
        eligible_wins = [
            win
            for win in eligible_wins
            if get_effective_month_key(
                win.get("winDate"),
                release_by_code.get(str(win.get("giveawayCode") or ""))
                or release_by_app_id.get(parse_int(win.get("appId")))
                or release_by_title.get(str(win.get("title") or ""))
                or "",
            )
            == selected_month
        ]
    return eligible_wins, members, active_usernames, selected_month


def refresh_steam_progress(
    sync_payload: dict,
    target_month: str | None = None,
    *,
    full_refresh: bool = False,
) -> dict:
    started_at = time.perf_counter()
    target_wins, members, active_usernames, selected_month = collect_progress_targets(
        sync_payload,
        target_month,
        full_refresh=full_refresh,
    )
    library_payload = refresh_steam_library(
        sync_payload,
        target_month=target_month,
        full_refresh=full_refresh,
    )
    library_playtime_lookup = build_library_playtime_lookup(library_payload)
    library_profile_lookup = build_library_profile_lookup(library_payload)
    remote_titles = set() if full_refresh else {win.get("title") for win in target_wins if win.get("title")}
    sync_payload, hltb_items = enrich_sync_with_hltb(
        sync_payload,
        remote_titles=remote_titles,
    )
    existing_progress_payload = load_json(PROGRESS_PATH, empty_progress_payload())
    progress_cache = build_progress_cache(existing_progress_payload)
    seen = set()
    achievement_successes = 0
    achievement_errors = 0
    cached_fallbacks = 0
    cached_reuses = 0
    library_playtime_hits = 0

    for win in target_wins:
        username = win.get("winnerUsername") or win.get("username")
        app_id = win.get("appId")
        steam_profile = members.get(username, {}).get("steamProfile", "")
        key = (steam_profile, str(app_id))
        if key in seen:
            continue
        seen.add(key)

        cached_item = progress_cache.get((steam_profile, int(app_id)))
        library_item = library_playtime_lookup.get((steam_profile, int(app_id)), {})
        library_profile = library_profile_lookup.get(steam_profile, {})
        api_playtime = library_item.get("playtimeHours")
        if api_playtime is not None:
            library_playtime_hits += 1

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
        item["playtimeCheckedAt"] = library_item.get("checkedAt")
        item["playtimeSource"] = library_item.get("source", "")
        item["playtimeVisible"] = library_profile.get("playtimeVisible")
        item["gamesVisible"] = library_profile.get("gamesVisible")

        if cached_item and is_progress_item_fresh(cached_item):
            item["error"] = cached_item.get("error")
            progress_cache[(steam_profile, int(app_id))] = item
            cached_reuses += 1
            continue

        try:
            html = fetch_html(progress_url)
            if is_suspicious_steam_response(html):
                raise RuntimeError("Steam Community temporarily blocked the stats page.")
            item.update(parse_achievement_summary(html))
            if api_playtime is not None:
                item["playtimeHours"] = api_playtime
            item["error"] = None
            achievement_successes += 1
        except (HTTPError, URLError, TimeoutError, RuntimeError) as error:
            achievement_errors += 1
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
                item["playtimeCheckedAt"] = library_item.get("checkedAt")
                item["playtimeSource"] = library_item.get("source", "")
                item["playtimeVisible"] = library_profile.get("playtimeVisible")
                item["gamesVisible"] = library_profile.get("gamesVisible")
                cached_fallbacks += 1
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
        "steamApiEnabled": bool(library_payload.get("apiEnabled")),
        "activeOnly": bool(active_usernames),
        "refreshedMonth": selected_month,
        "refreshedScope": "all" if full_refresh else "month",
        "libraryUpdatedAt": library_payload.get("updatedAt"),
        "libraryStats": library_payload.get("stats") or {},
        "stats": {
            "durationSeconds": round(time.perf_counter() - started_at, 2),
            "targetWins": len(target_wins),
            "uniqueProgressTargets": len(seen),
            "libraryPlaytimeHits": library_playtime_hits,
            "cachedReuses": cached_reuses,
            "achievementSuccesses": achievement_successes,
            "achievementErrors": achievement_errors,
            "cachedFallbacks": cached_fallbacks,
            "hltbTitlesRequested": len(remote_titles),
            "hltbResultsAvailable": len(hltb_items),
        },
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
            query = parse_qs(parsed.query)
            if parsed.path == "/api/steamgifts-sync":
                if SYNC_PATH.exists():
                    body = SYNC_PATH.read_bytes()
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.write_json({})
                return
            if parsed.path == "/api/steam-progress":
                self.write_json(load_json(PROGRESS_PATH, empty_progress_payload()))
                return
            if parsed.path == "/api/steam-library":
                self.write_json(load_json(LIBRARY_PATH, empty_library_payload()))
                return
            if parsed.path == "/api/steam-media":
                raw_app_ids = ",".join(query.get("appIds", []))
                app_ids = [parse_int(part) for part in raw_app_ids.split(",") if parse_int(part)]
                self.write_json(get_media_payload(app_ids))
                return
            if parsed.path == "/api/dashboard":
                sync_payload = load_json(SYNC_PATH, {})
                progress_payload = load_json(PROGRESS_PATH, empty_progress_payload())
                library_payload = load_json(LIBRARY_PATH, empty_library_payload())
                self.write_json(build_dashboard_payload(sync_payload, progress_payload, library_payload))
                return
            if parsed.path == "/api/members":
                sync_payload = load_json(SYNC_PATH, {})
                self.write_json(build_members_payload(sync_payload))
                return
            if parsed.path == "/api/giveaways":
                sync_payload = load_json(SYNC_PATH, {})
                progress_payload = load_json(PROGRESS_PATH, empty_progress_payload())
                library_payload = load_json(LIBRARY_PATH, empty_library_payload())
                self.write_json(
                    build_giveaways_payload(
                        sync_payload,
                        progress_payload,
                        library_payload,
                        limit=parse_limit(query, default=24),
                    )
                )
                return
            if parsed.path == "/api/overrides":
                self.write_json(normalize_overrides_payload(load_json(OVERRIDES_PATH, empty_overrides_payload())))
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
            if parsed.path == "/api/refresh-steam-library":
                sync_payload = load_json(SYNC_PATH, {})
                payload = self.read_json()
                target_month = payload.get("month") if isinstance(payload, dict) else None
                full_refresh = bool(payload.get("fullRefresh")) if isinstance(payload, dict) else False
                self.write_json(
                    refresh_steam_library(
                        sync_payload,
                        target_month=target_month,
                        full_refresh=full_refresh,
                    )
                )
                return
            if parsed.path == "/api/overrides":
                payload = self.read_json()
                if not isinstance(payload, dict):
                    self.write_json({"error": "JSON payload expected."}, status=HTTPStatus.BAD_REQUEST)
                    return
                overrides_payload = normalize_overrides_payload(payload)
                overrides_payload["savedAt"] = utc_now()
                save_json(OVERRIDES_PATH, overrides_payload)
                self.write_json({"ok": True, **overrides_payload})
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
    parser = argparse.ArgumentParser(description="Akatsuki Monitor server utilities")
    parser.add_argument("--export-static", action="store_true", help="Export a static site for GitHub Pages")
    parser.add_argument("--validate-static", action="store_true", help="Validate the exported static snapshot contract")
    parser.add_argument("--output-dir", default=str(STATIC_EXPORT_DIR), help="Static export output directory")
    parser.add_argument("--merge-sync-file", help="Merge a SteamGifts sync JSON file into data/steamgifts-sync.json")
    parser.add_argument("--hydrate-sync-media", action="store_true", help="Fetch missing cached media and release dates for SteamGifts wins")
    parser.add_argument("--recent-days", type=int, default=365, help="Limit sync media hydration to giveaways from the last N days")
    parser.add_argument("--refresh-steam-library", action="store_true", help="Refresh cached Steam library data")
    parser.add_argument("--refresh-steam-progress", action="store_true", help="Refresh cached Steam progress data")
    parser.add_argument("--month", help="Refresh only the specified month (YYYY-MM) when applicable")
    parser.add_argument("--full-refresh", action="store_true", help="Refresh the full active-member history instead of a single month")
    args = parser.parse_args()

    ensure_data_dir()
    performed_task = False
    sync_payload: dict | None = None

    if args.merge_sync_file:
        incoming_path = Path(args.merge_sync_file)
        payload = load_json(incoming_path, None)
        if not isinstance(payload, dict):
            raise SystemExit(f"Could not read a JSON object from {incoming_path}")
        existing = load_json(SYNC_PATH, {})
        sync_payload = merge_sync_payload(existing, payload)
        save_json(SYNC_PATH, sync_payload)
        print(
            "Merged SteamGifts sync payload:"
            f" {len(sync_payload.get('members', []))} member(s),"
            f" {len(sync_payload.get('giveaways', []))} giveaway(s)."
        )
        performed_task = True

    if args.hydrate_sync_media:
        sync_payload = sync_payload or load_json(SYNC_PATH, {})
        if not sync_payload.get("giveaways"):
            raise SystemExit("No SteamGifts sync data available yet.")
        media_cache = load_json(MEDIA_CACHE_PATH, empty_media_cache())
        missing_before = count_missing_media_entries(sync_payload, media_cache, recent_days=args.recent_days)
        media_cache = hydrate_media_cache_for_sync(sync_payload, media_cache, recent_days=args.recent_days)
        missing_after = count_missing_media_entries(sync_payload, media_cache, recent_days=args.recent_days)
        print(
            "Hydrated Steam media cache:"
            f" {max(0, missing_before - missing_after)} app(s) updated,"
            f" {missing_after} still missing."
        )
        performed_task = True

    if args.refresh_steam_library or args.refresh_steam_progress:
        sync_payload = sync_payload or load_json(SYNC_PATH, {})
        if not sync_payload.get("giveaways"):
            raise SystemExit("No SteamGifts sync data available yet.")
        if args.refresh_steam_library and not args.refresh_steam_progress:
            library_payload = refresh_steam_library(
                sync_payload,
                target_month=args.month,
                full_refresh=args.full_refresh,
            )
            print(
                "Refreshed Steam library:"
                f" {library_payload.get('stats', {}).get('profilesTargeted', 0)} targeted profile(s)."
            )
        if args.refresh_steam_progress:
            progress_payload = refresh_steam_progress(
                sync_payload,
                target_month=args.month,
                full_refresh=args.full_refresh,
            )
            print(
                "Refreshed Steam progress:"
                f" {progress_payload.get('stats', {}).get('uniqueProgressTargets', 0)} target(s)."
            )
        performed_task = True

    if args.export_static:
        export_static_site(Path(args.output_dir))
        performed_task = True

    if args.validate_static:
        validate_static_site(Path(args.output_dir))
        performed_task = True

    if performed_task:
        return

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Akatsuki Monitor server running at http://{HOST}:{PORT}")
    server.serve_forever()


def export_static_site(output_dir: Path) -> None:
    sync_payload = load_json(SYNC_PATH, {})
    progress_payload = load_json(PROGRESS_PATH, empty_progress_payload())
    library_payload = load_json(LIBRARY_PATH, empty_library_payload())
    overrides_payload = normalize_overrides_payload(load_json(OVERRIDES_PATH, empty_overrides_payload()))
    media_cache = load_json(MEDIA_CACHE_PATH, empty_media_cache())
    media_lookup = build_media_lookup(media_cache)
    sync_export = build_sync_export_payload(sync_payload, media_lookup=media_lookup)
    dashboard_payload = build_dashboard_payload(sync_export, progress_payload, library_payload)
    members_payload = build_members_payload(sync_export)
    giveaways_payload = build_giveaways_payload(sync_export, progress_payload, library_payload, limit=24)
    manifest_payload = build_snapshot_manifest(
        sync_export,
        progress_payload,
        library_payload,
        overrides_payload,
        dashboard_payload,
        members_payload,
        giveaways_payload,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    api_dir = output_dir / "api"
    api_dir.mkdir(parents=True, exist_ok=True)

    for file_name in STATIC_FILE_NAMES:
        source = BASE_DIR / file_name
        if source.exists():
            copy2(source, output_dir / file_name)

    for directory_name in STATIC_DIRECTORIES:
        source_dir = BASE_DIR / directory_name
        if source_dir.exists():
            copytree(source_dir, output_dir / directory_name, dirs_exist_ok=True)

    (output_dir / ".nojekyll").write_text("", encoding="utf-8")
    copy2(output_dir / "index.html", output_dir / "404.html")

    save_json(api_dir / "steamgifts-sync.json", sync_export)
    save_json(api_dir / "steam-progress.json", progress_payload)
    save_json(api_dir / "steam-library.json", library_payload)
    save_json(api_dir / "dashboard.json", dashboard_payload)
    save_json(api_dir / "members.json", members_payload)
    save_json(api_dir / "giveaways.json", giveaways_payload)
    save_json(api_dir / "overrides.json", overrides_payload)
    save_json(api_dir / "snapshot.json", manifest_payload)
    validate_static_site(output_dir)
    print(f"Static site exported to {output_dir}")


if __name__ == "__main__":
    main()
