// Precompute derived dashboard data once, at update time, so the published site
// doesn't recompute it (from megabytes of raw JSON) in every visitor's browser.
//
// Reuses the EXACT browser calculation code from client/derive-core.js, so there
// is a single source of truth — no risk of a Python re-implementation drifting
// from the JS the live app runs.
//
// Usage:
//   node tools/build-derived.mjs [inputDir] [outFile]
//   - inputDir: where steamgifts-sync.json + overrides.json live (default: data)
//   - outFile:  where to write derived.json (default: <inputDir>/derived.json)
//
// Run as part of the static export (server.py) and the daily refresh, i.e. on
// every input change: a new SteamGifts sync, a Steam data refresh, or a
// published-overrides change.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSummerEventDerived } from "../client/derive-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// Accept either the raw stored shape ({ savedAt, overrides: {...} }) or the
// already-normalized export shape ({ games, wins, giveaways, ... }).
function extractOverrides(payload) {
  if (payload && typeof payload === "object" && payload.overrides && typeof payload.overrides === "object") {
    return payload.overrides;
  }
  return payload && typeof payload === "object" ? payload : {};
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  const inputDir = process.argv[2] ? String(process.argv[2]) : join(ROOT, "data");
  const outFile = process.argv[3] ? String(process.argv[3]) : join(inputDir, "derived.json");

  const sync = readJson(join(inputDir, "steamgifts-sync.json"), {});
  const overrides = extractOverrides(readJson(join(inputDir, "overrides.json"), {}));

  const giveaways = Array.isArray(sync.giveaways) ? sync.giveaways : [];
  const syncMembers = Array.isArray(sync.members) ? sync.members : [];
  const now = Date.now();

  // Shared overrides only — the public, precomputed view. Browsers with local
  // (unpublished) overrides recompute live instead of trusting this file.
  const summerEvent = buildSummerEventDerived({
    giveaways,
    members: [],
    syncMembers,
    overrides,
    settings: { summerRuleset: "auto", currentDate: todayISO() },
    now,
  });

  const derived = {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    source: {
      syncedAt: sync.syncedAt || sync.savedAt || null,
      giveaways: giveaways.length,
      members: syncMembers.length,
    },
    summerEvent,
  };

  writeFileSync(outFile, `${JSON.stringify(derived, null, 2)}\n`, "utf8");
  const periods = summerEvent.periods
    .map((p) => `${p.label}: ${p.counts.trackedGiveaways} GAs (${p.counts.activeGiveaways} active / ${p.counts.finishedGiveaways} finished), ${p.counts.participants} participants`)
    .join("\n  ");
  process.stdout.write(`derived.json written to ${outFile}\n  ${periods || "(no summer-event periods)"}\n`);
}

main();
