# CLAUDE.md

Agent-facing quick reference for the Akatsuki Group Monitor. Keep this concise; deep detail lives in [ARCHITECTURE.md](ARCHITECTURE.md). User-facing overview is in [README.md](README.md).

## What this is
A SteamGifts giveaway-group operations dashboard: a Python server (`server.py`) for local APIs + refresh jobs + static export, and a vanilla HTML/CSS/JS frontend (`app.js` + `client/`). State is JSON under `data/`. Deployed to GitHub Pages from source.

## Commands
- Run locally: `python server.py` → http://127.0.0.1:4173
- JS syntax check (CI gate): `npm run check:node24`
- Static export + validate: `python server.py --export-static --output-dir dist` then `python server.py --validate-static --output-dir dist`
- Refresh data (needs `STEAM_WEB_API_KEY` in env or `.env`): `--refresh-steam-progress`, `--refresh-steam-library`, `--hydrate-sync-media --recent-days 365`

## Map (where things live)
- `app.js` — entire frontend runtime (~5k lines): load JSON, normalize sync, apply overrides, render every page. Single file, no bundler.
- `client/utils.js` — `escapeHtml`, `parseDate`, `formatMonthKey`, `formatISODateLocal`, ids. Imported by app.js.
- `client/cycle-rules.js` — cycle calendar + Rule-9/period logic (`getPeriodInfo`, `getCycleMonthKeys`).
- `server.py` — server + CLI; sync merge, Steam/HLTB refresh, static export/validate.
- `*.html` — one page each (index, cycles, monthly-progress, summer-event, summer-event-entries, active/inactive-users, admin). Thin shells; `app.js` fills `#id` tables.
- `data/*.json` — persisted state (steamgifts-sync, steam-progress, steam-library, hltb-cache, steam-media-cache, overrides).
- `.github/workflows/` — `pages.yml` (deploy on push to main), `daily-refresh.yml` (cron 06:00 UTC: refresh Steam data, commit, self-deploy).

## Conventions / gotchas (read before editing)
- **Frontend persistence key**: `localStorage["akatsuki-monitor-state-v1"]`.
- **Override system** drives all manual edits. `state.overrides = {games, wins, giveaways, cycleMembers}`, keyed maps. `getEffectiveOverrideState()` merges shared (server) + local. `updateOverrideField(bucket, key, field, value|null)` is the single setter (persists + re-renders). Only whitelisted fields survive: `GAME_/WIN_/GIVEAWAY_OVERRIDE_FIELDS`. Overrides re-apply on top of synced data every render, so **sync never clobbers a manual override**.
- **Giveaway identity**: cycle giveaways (`state.giveaways`) have `sourceId = "sg-<code>"` but **no** `code`; summer-event giveaways (`state.sync.steamgifts.giveaways`) have `code` but **no** `sourceId`. Use `getGiveawayCodeKey(g)` to get the shared `sg-<code>` key across both.
- **Giveaway classification** comes from the giveaway **description text** (collectors, not server): contains `summer event` → summer_event (highest priority); `extra`/`penalty` → extra; `monthly` → cycle (earliest keyword wins). A `cycle` giveaway's month = the single month name in the description, else falls back to end date.
- **Summer-event points**: base = `steamPricePoints` (if checked) else `points`; swing/`entryDelta` = 10 if base≥30 else 5; a creator's entry points = `entrants × swing`; total = base + entry. `no_winners` ⇒ counts as 0 / excluded from standings.
- **`site/` and `dist/` are gitignored.** `publish-snapshot.ps1` does `git add data site` but only `data/` is actually tracked.
- **GitHub Actions**: a push by `GITHUB_TOKEN` does **not** trigger other workflows, so `daily-refresh.yml` deploys Pages itself instead of relying on `pages.yml`.
- Windows/PowerShell host. Prefer `npm run check:node24` + the browser smoke test (below) over assuming runtime correctness — `node --check` only catches syntax.

## Verifying frontend changes
`node --check app.js` catches syntax only. For real verification, run `python server.py`, open the pages in a browser, watch the devtools console for `console`/`pageerror` output, and confirm the `#id` tables/panels render. A manual override is verified by setting it, reloading, and confirming it re-renders from `localStorage`.

## Editing rules
- Match the surrounding vanilla style (template-literal HTML strings, `escapeHtml` all interpolated text, `data-*` attributes dispatched in the global `click`/`change` listeners in `setupEvents`).
- Keep work commit-free unless the user asks. Commit messages end with the Co-Authored-By trailer.
