# Akatsuki Group Monitor

## Overview

Akatsuki Group Monitor is a small SteamGifts operations dashboard for managing an Akatsuki giveaway group. It combines local data entry, SteamGifts sync collectors, Steam progress refresh jobs, and a static export pipeline so the same information can be used both locally and on GitHub Pages.

The project is optimized for a practical workflow rather than a framework-heavy stack:

- a Python server for local APIs, JSON persistence, refresh jobs, and static export
- a vanilla HTML/CSS/JavaScript frontend for dashboards and admin pages
- SteamGifts collectors for authenticated and public sync flows
- JSON snapshots under `data/` as the main source of persisted operational state

This repository already solves a real operational problem well: it keeps group giveaway history, cycle rules, winner progress, and special event accounting in one place. The next step is making the project easier to onboard, safer to change, and more production-like.

## What The Project Does

The current system covers these areas:

1. Dashboard and overview pages
   - Group summary cards
   - Alerts for overdue wins, penalties, and cycle status
   - Recent giveaways and active member overview

2. Monthly and cycle tracking
   - Monthly progress tables based on HLTB time and achievement thresholds
   - Cycle history, cycle giveaway counts, rule-based exemptions, and penalties
   - Manual override support for wins, games, giveaways, and cycle member state

3. Summer event tracking
   - Dedicated summer-event page
   - Tracked entrants, creator balances, winner data, and snapshot finalization
   - Sorting and filtering by creator and winner

4. SteamGifts synchronization
   - Authenticated sync via userscript
   - Authenticated sync via bookmarklet helper flow
   - Public sync via Playwright when needed
   - Merge logic on the server to combine collected batches safely

5. Steam and HLTB enrichment
   - Steam library and progress refreshes for tracked members
   - HLTB lookups and cached playtime targets
   - Steam media caching for synced giveaways

6. Static publishing
   - Static export for GitHub Pages
   - Snapshot validation before deployment
   - GitHub Actions workflow that rebuilds the public site from source on push to `main`

## High-Level Architecture

### 1. Frontend

The frontend is a multi-page vanilla app.

- `app.js` is the main runtime. It loads remote JSON, normalizes sync payloads, manages local state, applies overrides, and renders all dashboard views.
- `client/utils.js` contains shared formatting, date, ID, and helper utilities.
- `client/cycle-rules.js` contains cycle-specific rule and period logic.
- HTML files such as `index.html`, `cycles.html`, `monthly-progress.html`, `summer-event.html`, `active-users.html`, `inactive-users.html`, and `admin.html` expose focused views over the same shared runtime.
- `styles.css` provides the shared visual system across all pages.

### 2. Backend / Local Server

`server.py` is both the local server and the main data utility entry point.

It is responsible for:

- serving the local site and API endpoints on `http://127.0.0.1:4173`
- merging incoming SteamGifts sync payloads into `data/steamgifts-sync.json`
- refreshing Steam library and Steam progress snapshots
- hydrating cached Steam media and release metadata
- exporting a static version of the site
- validating the exported static snapshot contract

### 3. Collectors

There are three collection paths:

- `akatsuki-steamgifts-sync.user.js`
  - authenticated userscript collector intended for normal logged-in usage

- `steamgifts-live-bookmarklet.js`
  - authenticated bookmarklet collector used together with `bookmarklet-helper.html`

- `scripts/steamgifts-public-sync.mjs`
  - Playwright-based public collector for fallback or automation scenarios

These collectors enrich SteamGifts giveaway data with creator, winner, description-derived metadata, point cost, entries, and result state before the server merges the result.

### 4. Persistent Data

The project stores operational state as JSON under `data/`.

Important files:

- `data/steamgifts-sync.json`
  - main SteamGifts sync payload, including members, giveaways, and wins

- `data/steam-progress.json`
  - cached progress refresh output

- `data/steam-library.json`
  - cached Steam library snapshots and playtime data

- `data/hltb-cache.json`
  - HLTB lookup cache

- `data/steam-media-cache.json`
  - cached media and release metadata for synced games

- `data/overrides.json`
  - shared overrides published by the admin UI

### 5. Deployment

Deployment is source-driven, not artifact-driven.

- The GitHub Pages workflow in `.github/workflows/pages.yml` checks out the repo.
- It installs Node 24 dependencies.
- It runs `npm run check:node24`.
- It runs `python server.py --export-static --output-dir dist`.
- It runs `python server.py --validate-static --output-dir dist`.
- It uploads `dist/` as the Pages artifact.

That means the public site is rebuilt in CI from the committed source files. The local `site/` folder is useful for local export and validation, but GitHub Pages is not relying on committed exported artifacts.

## Repository Layout

### Core application files

- `app.js` - main frontend runtime
- `styles.css` - shared styling
- `server.py` - local API server, refresh jobs, export pipeline

### Page entry points

- `index.html` - main overview dashboard
- `cycles.html` - cycle history and giveaway accounting
- `monthly-progress.html` - monthly progress tracking
- `summer-event.html` - summer event statistics and balances
- `active-users.html` - active user summaries
- `inactive-users.html` - inactive user summaries
- `admin.html` - admin and override workflows
- `bookmarklet-helper.html` - helper page for the bookmarklet collector

### Client modules

- `client/utils.js`
- `client/cycle-rules.js`

### Collector and automation scripts

- `akatsuki-steamgifts-sync.user.js`
- `steamgifts-live-bookmarklet.js`
- `scripts/steamgifts-public-sync.mjs`
- `scripts/publish-snapshot.ps1`
- `scripts/setup-publish.ps1`
- `publish-snapshot.cmd`
- `setup-publish.cmd`

### Data and export folders

- `data/` - local JSON state and caches
- `site/` - local static export output
- `dist/` - CI export output during GitHub Pages deployment

## Current Runtime Requirements

### Required

- Python 3.13 recommended
- Node.js 24.x
- npm

### Optional but important

- `STEAM_WEB_API_KEY` in environment or `.env`
  - required for Steam library/progress refreshes

- Google Chrome or Microsoft Edge
  - useful for the authenticated collection workflow and Playwright public sync

## Recommended Local Setup

### 1. Install dependencies

Use the helper if you want the project to configure the machine for you:

```powershell
setup-publish.cmd
```

Manual setup is also fine:

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2. Configure Steam API access

Create a `.env` file when you need Steam library or progress refreshes:

```env
STEAM_WEB_API_KEY=your_key_here
```

### 3. Start the local server

```powershell
python server.py
```

The local app will be available at:

```text
http://127.0.0.1:4173
```

## Common Workflows

### Run the local dashboard

```powershell
python server.py
```

### Check JavaScript syntax

```powershell
npm run check:node24
```

### Refresh Steam progress

```powershell
python server.py --refresh-steam-progress
```

### Refresh Steam library snapshot

```powershell
python server.py --refresh-steam-library
```

### Hydrate missing media for synced giveaways

```powershell
python server.py --hydrate-sync-media --recent-days 365
```

### Export the static site locally

```powershell
python server.py --export-static
python server.py --validate-static
```

### Run the public Playwright sync

```powershell
npm run public-sync
```

### Run the end-to-end publish helper

```powershell
publish-snapshot.cmd
```

That helper:

- starts the local server if needed
- opens the helper page and SteamGifts group for collector mode
- waits for a fresh sync when using the authenticated flow
- hydrates media
- refreshes Steam progress
- exports and validates the static snapshot
- optionally commits and pushes snapshot changes in that workflow

## Strengths Of The Current Project

The project already has several strong qualities:

- It solves a very specific operational problem with a tight workflow.
- It avoids unnecessary framework complexity.
- It has a real local-to-public publishing model.
- It already includes some validation in CI.
- It stores data in transparent JSON files instead of opaque storage.
- It supports both manual and automated collection paths.
- It has enough domain logic to handle cycle rules, summer events, overrides, and progress tracking in one place.

## Current Weak Spots

These are the main places where the project still feels more like a working internal tool than a polished product:

1. Documentation is thin.
2. There is no formal Python dependency manifest such as `requirements.txt` or `pyproject.toml`.
3. `app.js` is large and handles many responsibilities.
4. There is no automated test coverage for the domain rules and parsing logic.
5. Operational data schemas are implied by code rather than documented explicitly.
6. Error handling and observability are functional but still lightweight.
7. Environment setup is partly documented through scripts instead of a clear human-readable guide.
8. There is no release/versioning/changelog discipline yet.

## Possible Improvements

This section expands the existing `POSSIBLE_IMPROVEMENTS.md` list into a broader roadmap.

### Documentation and onboarding

- Add an `.env.example` with every supported variable and a short explanation.
- Add a dedicated architecture document with data flow diagrams.
- Add contributor instructions for the collector workflow and publishing flow.
- Document the JSON payload structure for sync, progress, library, and overrides.

### Code organization

- Split `app.js` into focused modules such as sync loading, cycle logic, summer event rendering, admin actions, and shared rendering helpers.
- Move shared parsing logic used by multiple collectors into reusable utility modules when practical.
- Reduce duplicate collection logic between the userscript, bookmarklet, and public sync script.

### Quality and safety

- Add unit tests for cycle rules, month overrides, giveaway merging, and result parsing.
- Add integration tests for representative JSON payload normalization.
- Add Python syntax and smoke checks to CI, not only Node-side checks.
- Add regression fixtures for known tricky giveaways and event cases.

### Operations and reliability

- Save richer metadata for refresh jobs, including target scope, duration, and per-user errors.
- Improve long-running refresh visibility in the UI.
- Add structured logs or exportable run summaries for collector and refresh jobs.
- Add backup/rotation strategy for important JSON data files.

### User experience

- Add clearer admin diagnostics when sync fields are missing or inconsistent.
- Make expensive operations show progress states and last successful completion time.
- Add a small status page for sync health, cache freshness, and last export validation.

### Data model and governance

- Define stable JSON schemas for the major data files.
- Add data migration helpers so schema evolution is safer.
- Add explicit validation when loading persisted JSON to surface bad records early.

## What Would Make The Project More Professional

If the goal is to move from a capable internal tool to a more professional software project, these changes have the highest leverage.

### Priority 1: Foundation

1. Keep this README updated and add `.env.example`.
2. Add a Python dependency manifest.
3. Add automated tests for the core rule engine and parsing logic.
4. Add Python validation to CI alongside the existing Node checks.

Why this matters:

- new contributors can onboard faster
- environments become reproducible
- regressions become harder to introduce silently
- deployment confidence increases immediately

### Priority 2: Maintainability

1. Break `app.js` into smaller modules.
2. Reduce duplication across collectors.
3. Document the main JSON payload formats and override rules.

Why this matters:

- future feature work becomes cheaper
- debugging gets faster
- domain logic becomes easier to reason about and review

### Priority 3: Operational maturity

1. Add structured logs and richer refresh metadata.
2. Add backup conventions for the `data/` folder.
3. Add status visibility for sync freshness, failures, and export validation.

Why this matters:

- failures become easier to diagnose
- important data becomes safer
- the system becomes more trustworthy for regular operations

### Priority 4: Engineering polish

1. Add a changelog or release notes process.
2. Add issue templates or a lightweight task board.
3. Add code-style automation or linting beyond syntax checks.
4. Add a small set of fixture-based regression tests for real problematic cases.

Why this matters:

- the project feels intentional rather than ad hoc
- team habits become consistent
- historical decisions become easier to track

## Suggested Next Steps

If you want the shortest path to a more professional repo, do these next:

1. Add `.env.example`.
2. Add `requirements.txt` or `pyproject.toml`.
3. Add a small `tests/` folder that covers cycle rules and sync normalization.
4. Add Python checks to GitHub Actions.
5. Start splitting `app.js` into feature modules.

## Summary

Akatsuki Group Monitor already has solid domain value, a workable local workflow, and a functioning deployment pipeline. The biggest gap is not usefulness, it is project hygiene: documentation, test coverage, dependency definition, and modularity. Fixing those areas will do more for professionalism than a visual rewrite or a larger framework migration.