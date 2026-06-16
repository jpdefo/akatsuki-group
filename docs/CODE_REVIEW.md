# Code Review — 2026-06-16

A point-in-time review of the Akatsuki Group Monitor codebase, grounded in the
source as it stands on `main` today. It is intentionally dated: treat it as a
snapshot, not a living document. For routine review of a change, run
`/code-review` on the branch. For the forward roadmap, see
[POSSIBLE_IMPROVEMENTS.md](POSSIBLE_IMPROVEMENTS.md).

Scope reviewed: `server.py` (2,062 lines), `app.js` (5,894), `client/utils.js`,
`client/cycle-rules.js`, the userscript collector, and the static
export/validate contract. The `.venv/` tree is vendored pip and out of scope.

## Overall assessment

The project is in good shape for what it is: a single-operator operations
dashboard with a stdlib-only Python backend and a no-build vanilla frontend.
The domain logic is genuinely intricate (cycle rules, summer-event scoring, two
giveaway shapes, an override layer that survives sync) and it is mostly
well-contained behind named helpers. The export/validate contract
(`validate_static_site`, `server.py:221`) is a real strength — it actively
guards the shape of what ships to Pages and cross-checks counts.

The two structural liabilities are well known and already on the roadmap: the
5.9k-line `app.js` monolith and the near-total absence of automated tests. The
findings below focus on things that are *not* already obvious from the roadmap —
concrete reliability and safety issues found in the code.

## Findings by priority

### High — data durability: writes are not atomic

`save_json` writes in place with `path.write_text(...)` (`server.py:125`). If
the process is killed mid-write (Ctrl-C, crash, power loss, CI runner
termination), the target file is left truncated/corrupted. Because `data/` *is*
the database — and `steamgifts-sync.json` is large and rewritten often — a
corrupted write loses real state, and `load_json` silently falls back to the
default on `JSONDecodeError` (`server.py:116`), so the corruption can pass
unnoticed until data "disappears."

**Fix:** write to a temp file in the same directory and `os.replace()` onto the
target (atomic on the same filesystem). One change in `save_json` protects every
caller. Low effort, high payoff.

### High — concurrent writes can race

`ThreadingHTTPServer` (`server.py:2243`) serves requests on multiple threads,
and several `GET` endpoints call `load_sync_payload_with_store_prices(persist=True)`
(`server.py:2024`, `:2038`, `:2044`, `:2048`), which rewrites
`steamgifts-sync.json` on the read path whenever a price changed. Two overlapping
requests — or a `GET` racing the sync `POST` at `:2103` — can interleave their
writes with no locking. Combined with the non-atomic write above, that is a
corruption path.

**Fix:** atomic replace (above) removes the torn-write half. For full safety,
guard `save_json` of the shared data files with a module-level `threading.Lock`,
or stop persisting on the read path (see the next item).

### Medium — persisting on the GET read path is surprising

Dashboard/members/giveaways `GET`s persist the enriched sync back to disk
(`persist=True`). This is write-on-read: every page load can rewrite the
canonical file. It is the mechanism that makes the price-freeze durable, but it
couples "viewing" to "mutating," amplifies I/O, and is the main source of the
race above. Consider persisting prices only on the sync `POST` and on an
explicit refresh, and letting reads enrich in-memory (as the export path already
does at `server.py:2286`).

### Medium — local API has no auth and permissive CORS

`end_headers` sends `Access-Control-Allow-Origin: *` (`server.py:2010`) and the
`POST` endpoints (`/api/steamgifts-sync`, `/api/overrides`, refresh triggers)
have no authentication. The server binds `127.0.0.1`, so this is low severity,
but any web page open in the operator's browser can issue cross-origin POSTs to
`http://127.0.0.1:4173` and overwrite `overrides.json` or kick off refreshes
(classic CSRF / DNS-rebinding shape). **Fix:** drop the wildcard CORS header (the
frontend is same-origin and doesn't need it), or require a simple local token
header on mutating routes.

### Medium — GitHub token lives in localStorage in plaintext

`getStoredGithubToken`/`setStoredGithubToken` keep a write-scoped GitHub token in
`localStorage` (`app.js:3490`). This is a deliberate, documented tradeoff and is
reasonable for a single operator, but localStorage is readable by any script on
the origin — so it is only as safe as the page's XSS posture (next item). The
mitigations are already the right ones and worth enforcing in docs: fine-grained,
**repo-scoped, short-expiry** token, plus the planned "clear token" button
(POSSIBLE_IMPROVEMENTS #7). The existing `CLEAR` sentinel in `promptForGithubToken`
(`app.js:3526`) already covers removal — surfacing it as a button is the gap.

### Medium — XSS defense rests entirely on manual `escapeHtml` discipline

The frontend builds HTML with template literals and assigns via `innerHTML` in
~71 places. `escapeHtml` (`client/utils.js:132`) is correct and the sampled
render functions apply it consistently to every interpolated value
(`buildMemberCard`, `app.js:2339`). But the data is attacker-influenceable —
SteamGifts usernames, game titles, and giveaway descriptions all flow in from the
collector — so a single future interpolation that forgets `escapeHtml` is a
stored-XSS hole, and nothing mechanical prevents it. **Fix:** add an ESLint rule
(e.g. a `no-restricted-syntax`/`no-unsanitized` style guard) to CI, or introduce
a tagged-template helper that escapes interpolations by default and migrate sinks
to it over time.

### Low — `parseDate` is unguarded on empty/invalid input

`parseDate(undefined|null|"")` produces an `Invalid Date` (`client/utils.js:95`),
and `formatDate` calls it directly (`:58`) while `formatDateTime` guards with a
`-` fallback (`:66`). Callers that pass a possibly-missing date to `formatDate`
will render `"Invalid Date"`. Add the same empty-guard to `parseDate`/`formatDate`
for consistency.

### Low — sync merge can never clear a field

In `merge_sync_payload`, incoming values only overwrite when
`value not in (None, "", [], {})` (`server.py:583`). This is intentional (it
stops the collector from clobbering server-resolved data with blanks), but it
also means a field that legitimately becomes empty upstream can never be cleared
by a re-sync — only an override can. Worth a one-line comment at the site so it
isn't mistaken for a bug later.

### Low — leftover deprecated surface

`--month` and `--full-refresh` are accepted but documented as ignored/default
(`server.py:2159`), and `publishSharedOverrides` (`app.js:3636`) is the
local-server publish path that the GitHub-direct flow has largely superseded.
Neither is harmful; both are candidates for removal once you're sure nothing
external invokes them, to shrink the surface a new reader has to understand.

## Structural observations (already on the roadmap)

- **`app.js` monolith (5.9k lines, ~230 functions, globals `state`/`elements`/
  `runtime`).** The single biggest maintainability cost and the reason almost
  none of the domain logic is unit-testable. Roadmap Phase 3 covers this; the
  highest-leverage first cut is extracting the pure domain functions
  (summer-event scoring, cycle math, classification) into modules that take data
  in and return values out, with no `state`/DOM access — those become testable
  immediately.
- **Testing.** The only automated test is `test_store_price_freeze.py`. The
  highest-risk untested logic is cycle-rule/period math (`client/cycle-rules.js`),
  summer-event scoring, and `merge_sync_payload`. These are pure-ish and would
  repay tests cheaply. No Python runs in CI beyond export succeeding.

## Concrete next steps (in suggested order)

1. **Atomic `save_json`** (temp file + `os.replace`). Smallest change, removes
   the corruption class. *(High)*
2. **Serialize data writes** with a lock, and/or stop persisting on GET reads.
   *(High/Medium)*
3. **Drop wildcard CORS** on the local server. *(Medium, ~1 line)*
4. **Add the "clear token" admin button** wired to the existing `CLEAR` path.
   *(Medium, small)*
5. **Add an escaping lint gate** (or auto-escaping tagged template) to CI.
   *(Medium)*
6. **Extract pure domain modules** from `app.js` and add unit tests for cycle
   rules, summer scoring, and sync merge; run them (plus the existing pytest-style
   stdlib test) in CI. *(Larger; roadmap Phases 2–3)*
7. **Guard `parseDate`** and prune the deprecated CLI args / `publishSharedOverrides`
   once confirmed unused. *(Low)*

## Status — applied 2026-06-16

Context correction: the interactive local server (`python server.py` as a
long-running host) is effectively retired — the workflow is now the Tampermonkey
collector (which publishes straight to GitHub), the live GitHub Pages site, and
the `server.py` **CLI** jobs run by `daily-refresh.yml`. That **lowers** the
priority of the concurrency findings (#2/#3 only bite when the threaded HTTP
server is actually serving) but **not** the atomic-write one: the CI refresh jobs
still call `save_json` to write committed `data/*.json`, so a killed job can still
corrupt state.

Applied in this pass:

1. **Atomic `save_json`** — write to a same-dir temp file then `os.replace`,
   guarded by a process-level lock. Removes the torn-write corruption class for
   both the CLI jobs and any server use. *(done)*
2. **Stopped persisting on GET reads** (`persist=False` on the dashboard/members/
   giveaways/sync endpoints) and added the write lock. Prices still freeze and
   persist on the sync `POST`. *(done)*
3. **Dropped the wildcard CORS** headers and the now-unneeded `OPTIONS` handler.
   *(done)*
4. **Added a "Clear GitHub token" admin button** wired to `setStoredGithubToken("")`
   with a confirm. *(done)*
5. **ESLint in CI** (`npm run lint`, chained into `check:node24`): high-signal
   correctness rules as errors (currently clean), and `no-unsanitized` surfacing
   the ~60 `innerHTML` sinks as **warnings**. An auto-escaping `html` tagged
   template was added to `client/utils.js` as the safe primitive for new markup.
   *Follow-up:* migrate the existing sinks to `html` (with browser verification),
   then flip `no-unsanitized` to `error` for a true blocking gate.
6. *(skipped — pure-domain module extraction + unit tests; roadmap Phases 2–3.)*
7. **Guarded `parseDate`/`formatDate`** against empty input and removed the unused
   `--month` CLI arg. `--full-refresh` was **kept** (still passed by
   `daily-refresh.yml`); `publishSharedOverrides` was **kept** (still wired to a
   live admin button). *(done)*
