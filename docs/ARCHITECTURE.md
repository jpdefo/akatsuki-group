# Architecture

Developer/agent-facing architecture of the Akatsuki Group Monitor. For commands and the short rule-set, see [CLAUDE.md](../CLAUDE.md). For the user-facing tour, see [README.md](../README.md).

## 1. Shape of the system

```
Collectors (browser userscript)  ──►  data/steamgifts-sync.json
                                              │
server.py  ──► merge / refresh / hydrate ─────┤
                                              ▼
            data/*.json  ◄── overrides ──►  app.js (frontend)
                                              │
server.py --export-static ──► dist/  ──►  GitHub Pages
```

- **No framework, no build step.** The frontend is plain ES modules served as static files. `app.js` is loaded directly by every HTML page.
- **JSON files are the database.** Everything persistent lives under `data/`.
- **Two runtimes share one codebase**: the Python `server.py` (local API + jobs + export) and the browser `app.js` (rendering + manual overrides).

## 2. Frontend (`app.js`)

One ~5k-line module. Lifecycle:

1. `loadState()` reads `localStorage["akatsuki-monitor-state-v1"]` into `state`.
2. On boot it fetches the published JSON snapshots (or talks to the local server API), normalizes the SteamGifts sync payload, and derives `state.members / games / wins / giveaways`.
3. `applyManualOverrides()` layers overrides on top.
4. `render()` calls the per-page render functions; each writes template-literal HTML into a `#id` `<tbody>`/container.

### Key state slices
- `state.sync.steamgifts` — the raw normalized sync payload (`members`, `giveaways`, `wins`). **Summer-event pages read giveaways straight from here.**
- `state.giveaways` / `state.wins` — derived per-record objects used by the cycle/monthly views. Built by `upsertGiveawayFromSync` / `upsertWinFromSync`.
- `state.overrides` — manual edits (see §3).

### Event wiring
All interactivity is delegated: `setupEvents()` registers global `click` / `change` listeners that match `data-*` attributes:
- `data-edit-action="..."` → `handleEditAction` → opens the override edit modal (`openEditModal`). Actions: `hltb`, `achievement-target`, `month`, `winner`.
- `data-giveaway-kind-select` → `handleGiveawayKindChange`.
- `data-cycle-member-status-select` → `handleCycleMemberStatusChange`.

### Per-page render entry points
- `renderCycleHistoryPage` → `renderCycleHistoryMembersTable`, `renderCycleHistoryResultsTable` (cycles.html).
- `renderCycleViews` — cycle widgets on the dashboard.
- `renderSummerEventPage`, `renderSummerEventEntriesPage`.
- `renderProgressViews` (monthly), `renderMemberBuckets` (active/inactive), `renderSummary`, `renderRecentGiveaways`.

## 3. The override system (most important subsystem)

Manual corrections never mutate synced data — they are stored separately and re-applied on every render, so a future sync can't undo them.

- `state.overrides = { games, wins, giveaways, cycleMembers }` — each a map of `key → { field: value }`.
- `runtime.sharedOverrides` — overrides published to the server (shared with all viewers). `getEffectiveOverrideState()` = `mergeOverrideStates(shared, local)`.
- `updateOverrideField(bucket, key, field, value)` — the **only** setter. `value === null/""/undefined` deletes the field (and the entry if empty). Calls `applyManualOverrides()` + `persistAndRender()`.
- `applyManualOverrides()` — for each `state.games/wins/giveaways`, strips the whitelisted override fields from the base record then spreads the override on top. Whitelists: `GAME_OVERRIDE_FIELDS`, `WIN_OVERRIDE_FIELDS`, `GIVEAWAY_OVERRIDE_FIELDS`. **A field only persists across sync if it's in a whitelist.**
- Keys: `getGameOverrideKey` (`app:<id>`/`title:<t>`), `getWinOverrideKey` (`sourceId`), `getGiveawayOverrideKey` (`sourceId`). Cycle-member keys are `"<cycleKey>:<stableMemberKey>"`.
- Publishing: `publishSharedOverrides()` POSTs `getPublishableOverrideState()` to the server (`data/overrides.json`). In static/Pages mode writes are local-only.

### Manual winners (example override, both surfaces)
- Stored as `overrides.giveaways[getGiveawayCodeKey(g)].manualWinners = [{username, displayName}]` (whitelisted in `GIVEAWAY_OVERRIDE_FIELDS`).
- Read via `getGiveawayManualWinners(g)` / `hasManualWinners(g)` (reads the effective override map directly by `sg-<code>` key, so it works for both `state.giveaways` and the sync-only summer-event records).
- Summer-event: `getSummerEventWinnerUsers` and `isSummerEventNoWinners` prefer manual winners; a manual winner forces the giveaway to "won" so it scores.
- UI: `data-edit-action="winner"` button → `openWinnerEditModal(key, currentWinners)`; the modal input has a `<datalist>` of member usernames (type-or-pick).

## 4. Giveaway data model & identity

The same underlying SteamGifts giveaway appears in two shapes:

| | Cycle view (`state.giveaways`) | Summer-event view (`state.sync.steamgifts.giveaways`) |
|---|---|---|
| stable id | `sourceId = "sg-<code>"` | `code` |
| winners | linked `state.wins` via `findWinsForGiveaway` | `giveaway.winners[]` (usernames) |
| points | `valuePoints` | `points` / `steamPricePoints` |

`getGiveawayCodeKey(g)` unifies them → always `sg-<code>` (falls back to `sourceId`, then `id`). Use it for any cross-surface keying.

### Classification (set by collectors from description text)
`detectGiveawayKindFromDescription` (in `akatsuki-steamgifts-sync.user.js`):
1. `\bsummer event\b` → `summer_event` (wins outright).
2. else earliest of `\bextra\b` / `\bpenalty\b` (→ `extra`) or `\bmonthly\b` (→ `cycle`).
3. For `cycle`, `detectGiveawayMonthOverride` reads a **single** month name from the description → that month; 0 or ≥2 names ⇒ no override (use end date).

Members can override the kind in the UI (`giveawayKindOverride`).

## 5. Cycle calendar & rules (`client/cycle-rules.js`)
- Cycle 1 = Jan–Mar, Cycle 2 = Apr–Jun, **Jul = Summer event**, **Aug = Pause**, Cycle 3 = Sep–Nov, **Dec = Secret Santa**. (`getPeriodInfo`)
- Required playtime = HLTB × {0.25 standard, 0.5/0.75/1.0 custom} (`getRequiredHours`).
- Rule 9 ("best gifter of the cycle") exemption logic: `getNextCycleExemptionInfo`, plus `buildCycleBestGifterAward` / `getRule9CarryoverForCycle` in app.js.
- Full human rules: `AKATSUKI rules.docx`.

## 6. Summer-event scoring (app.js)
- `getSummerEventBasePoints(g)` = `steamPricePoints` if `steamPriceChecked` else `points`; `0` if `no_winners`.
- `getSummerEventEntryDelta(g)` ("swing") = 10 if base ≥ 30 else 5.
- Creator earns `base + entrants × swing`; each non-creator entrant pays `swing`. See `computeSummerEventStandings`.
- Giveaways table columns: Giveaway · Creator · Base points · Entry points · Total points · Entries tracked · Winner · Result · Snapshot.

## 7. Backend (`server.py`)
- Serves the site + JSON APIs at `127.0.0.1:4173`; also a CLI (argparse) for batch jobs.
- Merges incoming sync (`--merge-sync-file`), refreshes Steam library/progress, hydrates media, exports/validates the static snapshot.
- `STATIC_FILE_NAMES` / `PUBLIC_PAGE_FILES` / `PUBLIC_API_FILES` define what `--export-static` emits to `dist/` (or `site/`). `--validate-static` enforces the snapshot contract (`SNAPSHOT_CONTRACT_VERSION`).
- Steam key from `STEAM_WEB_API_KEY` (env or `.env` via `load_dotenv_values`).

## 8. Collectors
- `akatsuki-steamgifts-sync.user.js` — logged-in userscript (the sole collector; installs/updates via its raw GitHub `.user.js` URL through Tampermonkey).
It enriches giveaways with creator/winner/points/entries/kind before the server merges.

## 9. Deployment & automation
- `pages.yml` — on push to `main`: `npm ci` + `check:node24`, `--export-static`/`--validate-static` to `dist/`, deploy Pages. Rebuilds the public site from committed source.
- `daily-refresh.yml` — cron 06:00 UTC + manual: refresh Steam data, commit `data/`, then **deploy Pages in the same job** (a `GITHUB_TOKEN` push won't trigger `pages.yml`). Needs the `STEAM_WEB_API_KEY` repo secret.
- Overrides go live via the dashboard's **Publish to GitHub Pages** button (`publishOverridesToGitHub`), which commits `data/overrides.json` straight to the repo through the GitHub API; the public site then rebuilds via `pages.yml`.
- `site/`, `dist/`, `node_modules/`, `.env` are gitignored.

## 10. Gotchas index
- `node --check` validates syntax only — verify UI in a browser.
- `site/` gitignored despite `git add data site`.
- `GITHUB_TOKEN` pushes don't chain workflows.
- Only whitelisted override fields survive a sync.
- Two giveaway shapes; always key with `getGiveawayCodeKey`.
