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
import {
  buildSummerEventDerived,
  buildPenaltyAndMemberDerived,
  normalizeOverrideState,
  getStableMemberKey,
  getEffectiveMemberActive,
  computeMinimumEntriesRequired,
} from "../client/derive-core.js";

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
  const progress = readJson(join(inputDir, "steam-progress.json"), {});

  const giveaways = Array.isArray(sync.giveaways) ? sync.giveaways : [];
  const syncMembers = (Array.isArray(sync.members) ? sync.members : []).filter(
    (member) => String(member?.username || "").trim(),
  );
  const now = Date.now();
  // app.js uses the sync date as the "current date" reference for penalty timing
  // and period fallbacks; match it so the precompute agrees with the live app.
  const currentDate = sync.syncedAt ? String(sync.syncedAt).slice(0, 10) : todayISO();

  // Shared overrides only — the public, precomputed view. Browsers with local
  // (unpublished) overrides recompute live instead of trusting this file.
  const mergedOverrides = normalizeOverrideState(overrides);

  const summerEvent = buildSummerEventDerived({
    giveaways,
    members: [],
    syncMembers,
    overrides: mergedOverrides,
    settings: { summerRuleset: "auto", currentDate },
    now,
  });

  const penaltiesAndMembers = buildPenaltyAndMemberDerived({
    sync,
    progress,
    overrides: mergedOverrides,
    settings: { currentDate },
  });

  // Membership: the synced active count drives the Rule-9 threshold (matches
  // app.js, which counts raw synced actives), while the per-member effective
  // flag (membership override applied) drives active/inactive bucket placement.
  const memberRows = syncMembers.map((member) => {
    const username = String(member.username).trim();
    const memberLike = {
      username,
      steamgiftsUsername: username,
      name: username,
      isActiveMember: Boolean(member.isActiveMember),
    };
    return {
      username,
      key: getStableMemberKey(memberLike),
      syncActive: Boolean(member.isActiveMember),
      active: getEffectiveMemberActive(memberLike, mergedOverrides),
    };
  });
  const syncActiveMembers = memberRows.filter((member) => member.syncActive).length;
  const effectiveActiveMembers = memberRows.filter((member) => member.active).length;
  const membership = {
    syncActiveMembers,
    effectiveActiveMembers,
    effectiveInactiveMembers: memberRows.length - effectiveActiveMembers,
    minimumEntriesRequired: computeMinimumEntriesRequired(syncActiveMembers),
    members: memberRows,
  };

  const derived = {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    source: {
      syncedAt: sync.syncedAt || sync.savedAt || null,
      giveaways: giveaways.length,
      members: syncMembers.length,
    },
    membership,
    penalties: penaltiesAndMembers.penalties,
    members: {
      counts: penaltiesAndMembers.counts,
      active: penaltiesAndMembers.activeMembers,
      inactive: penaltiesAndMembers.inactiveMembers,
    },
    summerEvent,
  };

  writeFileSync(outFile, `${JSON.stringify(derived, null, 2)}\n`, "utf8");
  process.stdout.write(
    `  membership: ${membership.syncActiveMembers} synced-active (min entries ${membership.minimumEntriesRequired}), `
    + `${membership.effectiveActiveMembers} effective-active / ${membership.effectiveInactiveMembers} inactive\n`,
  );
  process.stdout.write(
    `  penalties owed: ${penaltiesAndMembers.counts.penalties}`
    + `${penaltiesAndMembers.penalties.length ? ` — ${penaltiesAndMembers.penalties.slice(0, 8).map((p) => `${p.member} (${p.game})`).join("; ")}${penaltiesAndMembers.penalties.length > 8 ? " …" : ""}` : ""}\n`,
  );
  const periods = summerEvent.periods
    .map((p) => `${p.label}: ${p.counts.trackedGiveaways} GAs (${p.counts.activeGiveaways} active / ${p.counts.finishedGiveaways} finished), ${p.counts.participants} participants`)
    .join("\n  ");
  process.stdout.write(`derived.json written to ${outFile}\n  ${periods || "(no summer-event periods)"}\n`);
}

main();
