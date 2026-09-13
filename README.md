# Akatsuki Group Monitor

A lightweight operations dashboard for running a SteamGifts group, tracking member progress, and keeping cycle and summer-event data aligned with the live state of the giveaway history.

This project combines a Python server, a static vanilla HTML/JS frontend, and JSON-backed data files under `data/` so the same dataset can be used locally and exported for GitHub Pages.

## What it does

- Tracks group activity, recent giveaways, and member status
- Maintains cycle history and monthly progress reporting
- Scores summer-event giveways and entry balances
- Stores overrides for manual corrections without overwriting synced data
- Refreshes Steam library/progress data from Steam-backed sources
- Merges SteamGifts sync snapshots into a persistent local state
- Exports a static site suitable for GitHub Pages publishing

## Project structure

```text
.
├── app.js                    # Main frontend runtime
├── styles.css               # Shared styling
├── server.py                # Local server, data refresh jobs, export pipeline
├── package.json             # Node checks and lint/test scripts
├── index.html               # Overview dashboard
├── cycles.html              # Cycle history and rules
├── monthly-progress.html    # Monthly progress tracking
├── summer-event.html        # Summer event standings
├── summer-event-entries.html
├── active-users.html        # Active member summaries
├── inactive-users.html      # Inactive member summaries
├── admin.html               # Manager/admin UI
├── giveaways.html           # Giveaway browsing
├── penalties.html           # Penalty / rule views
├── akatsuki-steamgifts-sync.user.js
├── client/
│   ├── utils.js
│   ├── cycle-rules.js
│   └── derive-core.js
├── data/
│   ├── steamgifts-sync.json
│   ├── steam-progress.json
│   ├── steam-library.json
│   ├── hltb-cache.json
│   ├── steam-media-cache.json
│   ├── steam-package-cache.json
│   ├── steam-price-cache.json
│   └── overrides.json
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CODE_REVIEW.md
│   └── POSSIBLE_IMPROVEMENTS.md
├── test/
│   └── derive-core.test.mjs
├── tools/
│   └── build-derived.mjs
├── site/                   # Local static export output
├── .github/workflows/      # GitHub Pages and refresh automation
└── README.md
```

## Architecture at a glance

### Frontend

The frontend is intentionally simple and dependency-free:

- `app.js` loads state, applies overrides, and renders each page
- `client/utils.js` contains shared formatting and data helpers
- `client/cycle-rules.js` contains cycle-specific rules and period logic
- The HTML pages are thin shells that fill the same shared UI with data-driven tables and panels

### Backend

`server.py` acts as the app's control plane:

- serves the local dashboard and JSON APIs
- merges SteamGifts sync payloads into persisted local data
- refreshes Steam library and achievement/progress data
- hydrates Steam media metadata and giveway info
- exports static HTML/JS assets for GitHub Pages
- validates the static snapshot contract before publication

### Data model

The project uses JSON files under `data/` as its operational database. The most important ones are:

- `steamgifts-sync.json` — normalized SteamGifts state, members, giveaways, and wins
- `steam-progress.json` — refreshed progress data for tracked members
- `steam-library.json` — Steam library snapshot and playtime data
- `hltb-cache.json` — HowLongToBeat lookup cache
- `steam-media-cache.json` — cached game/media metadata
- `overrides.json` — manual corrections published through the admin flow

## Local setup

### Requirements

- Python 3.13 recommended
- Node.js 24.x
- npm

Optional but important for live data refreshes:

- `STEAM_WEB_API_KEY` in your environment or a `.env` file

### Install

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### Environment

If you need Steam library progress refreshes, create a `.env` file in the project root:

```env
STEAM_WEB_API_KEY=your_key_here
```

## Run the app locally

```powershell
python server.py
```

Then open:

```text
http://127.0.0.1:4173
```

## Common commands

### Check frontend and script health

```powershell
npm run check:node24
```

### Run the JavaScript tests

```powershell
npm test
```

### Refresh Steam progress

```powershell
python server.py --refresh-steam-progress
```

### Refresh the Steam library snapshot

```powershell
python server.py --refresh-steam-library
```

### Hydrate missing media data for synced giveaways

```powershell
python server.py --hydrate-sync-media --recent-days 365
```

### Export and validate the static site locally

```powershell
python server.py --export-static
python server.py --validate-static
```

## Manual override model

A key part of the project is that synced data is never blindly overwritten with manual edits.

Instead, the app stores override data separately and reapplies it at render time. This lets the system keep group data current while preserving corrections like:

- game metadata fixes
- manual winner assignments
- giveaway classification adjustments
- cycle member status changes

This is handled in the frontend and shared through the server's override payload flow.

## Deployment

The site is designed to be published from source rather than by committing built artifacts.

- GitHub Actions rebuilds the public site from source on push to `main`
- `site/` is a local export area and is not treated as the source of truth
- `dist/` is the export folder generated during CI publication
- the dashboard can publish shared override updates via GitHub-backed workflows

## Notes for contributors

- `node --check` catches syntax issues, but browser validation is still important for UI behavior
- the app is intentionally plain JavaScript and Python; it avoids a heavy framework
- `data/` is the real operational store for the project
- static export and validation are part of the normal release flow

## Related docs

- `docs/ARCHITECTURE.md` — deeper technical walkthrough of how the system fits together
- `docs/POSSIBLE_IMPROVEMENTS.md` — roadmap and modernization ideas
- `docs/CODE_REVIEW.md` — review notes and implementation observations

## Summary

Akatsuki Group Monitor is a practical dashboard for managing a SteamGifts giveaway group with a strong emphasis on data correctness, automation, and static publishing. It is built around simple, transparent tooling: Python for the server and refresh jobs, vanilla JavaScript for the UI, and JSON files under `data/` for persistent state.