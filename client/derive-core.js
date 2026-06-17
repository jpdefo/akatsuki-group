// Shared calculation core. Pure, DOM-free, context-based functions extracted
// from app.js so the exact same logic runs in two places:
//   - the browser (app.js imports these), and
//   - the Node precompute (tools/build-derived.mjs imports these) that writes
//     data/derived.json at update time.
//
// Nothing here reads module globals. Override- and settings-dependent helpers
// take the merged override map and a small settings object explicitly, so the
// caller decides whether to feed shared-only overrides (the public, precomputed
// view) or shared + local overrides (the admin's live recompute).
import { parseDate, normalizeGameTitle } from "./utils.js";
import { getPeriodInfo } from "./cycle-rules.js";

// --- Membership ----------------------------------------------------------
// Stable per-member key used by member overrides. Matches app.js's
// getStableCycleMemberKey for member objects (steamgifts username / name).
export function getStableMemberKey(member) {
  const rawKey = String(
    member?.steamgiftsUsername || member?.name || member?.username || member?.id || "",
  ).trim();
  return rawKey ? normalizeGameTitle(rawKey).replace(/\s+/g, "-") : "";
}

// Effective active flag: a membership override (active/inactive) wins over the
// synced flag. This is the "membership is only known after applying overrides"
// step that everything downstream (active count, thresholds) depends on.
export function getEffectiveMemberActive(member, overrides) {
  const key = getStableMemberKey(member);
  const status = key ? String(overrides?.members?.[key]?.membershipStatus || "").toLowerCase() : "";
  if (status === "active") {
    return true;
  }
  if (status === "inactive") {
    return false;
  }
  return Boolean(member?.isActiveMember);
}

// Rule-9 minimum monthly entries: 10% of the active-member count (min 1).
export function computeMinimumEntriesRequired(activeMembers) {
  return Math.max(1, Math.floor(Number(activeMembers || 0) * 0.1));
}

// --- Override merge -------------------------------------------------------

export function normalizeOverrideState(overrides = {}) {
  const source = overrides && typeof overrides === "object" ? overrides : {};
  return {
    games: { ...(source.games || {}) },
    wins: { ...(source.wins || {}) },
    giveaways: { ...(source.giveaways || {}) },
    cycleMembers: { ...(source.cycleMembers || {}) },
    members: { ...(source.members || {}) },
  };
}

export function mergeOverrideStates(baseOverrides = {}, overridingOverrides = {}) {
  const base = normalizeOverrideState(baseOverrides);
  const overriding = normalizeOverrideState(overridingOverrides);
  return {
    games: { ...base.games, ...overriding.games },
    wins: { ...base.wins, ...overriding.wins },
    giveaways: { ...base.giveaways, ...overriding.giveaways },
    cycleMembers: { ...base.cycleMembers, ...overriding.cycleMembers },
    members: { ...base.members, ...overriding.members },
  };
}

// --- Giveaway identity + kind --------------------------------------------

export function getGiveawayCodeKey(giveaway) {
  const code = String(giveaway?.code || "").trim();
  if (code) {
    return `sg-${code}`;
  }
  const sourceId = String(giveaway?.sourceId || "").trim();
  if (sourceId) {
    return sourceId;
  }
  return String(giveaway?.id || "").trim();
}

export function normalizeGiveawayKindValue(kind, giveaway = null) {
  const value = String(kind || "").trim().toLowerCase();
  if (value === "extra") {
    return "extra";
  }
  if (value === "penalty") {
    return "penalty";
  }
  if (value === "pop_free" || value === "pop-free" || value === "pop free") {
    return "pop_free";
  }
  if (value === "summer_event" || value === "summer-event" || value === "summer event") {
    return "summer_event";
  }
  if (giveaway && /\bsummer event\b/i.test(`${String(giveaway.title || "")} ${String(giveaway.notes || "")}`)) {
    return "summer_event";
  }
  return "cycle";
}

export function parseWinnerUsernamesFromResultLabel(resultLabel) {
  const text = String(resultLabel || "").trim();
  if (!text || /^(open|awaiting feedback|no winners?)$/i.test(text)) {
    return [];
  }
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function normalizeGiveawaySyncWinners(giveaway) {
  const winners = Array.isArray(giveaway?.winners) ? giveaway.winners.filter((winner) => winner?.username) : [];
  if (winners.length || String(giveaway?.resultStatus || "").toLowerCase() !== "won") {
    return winners;
  }
  return parseWinnerUsernamesFromResultLabel(giveaway.resultLabel).map((username) => ({
    username,
    profileUrl: "",
    status: "Won",
  }));
}

// Lean normalization of a synced giveaway record: just the fields the shared
// calculations read. Media/store-price/month-override handling stays in app.js.
export function normalizeGiveawaySyncRecord(giveaway) {
  const winners = normalizeGiveawaySyncWinners(giveaway);
  const entryUsers = Array.from(
    new Set(
      (Array.isArray(giveaway?.entryUsers) ? giveaway.entryUsers : [])
        .map((username) => String(username || "").trim())
        .filter(Boolean),
    ),
  );
  return {
    ...giveaway,
    giveawayKind: normalizeGiveawayKindValue(giveaway?.giveawayKind, giveaway),
    winners,
    entryUsers,
    entriesFinalized: Boolean(giveaway?.entriesFinalized),
    entriesSnapshotAt: giveaway?.entriesSnapshotAt || "",
  };
}

// --- Manual winners (override-driven) ------------------------------------

export function getGiveawayManualWinners(giveaway, overrides) {
  const key = getGiveawayCodeKey(giveaway);
  if (!key) {
    return [];
  }
  const list = overrides?.giveaways?.[key]?.manualWinners;
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((entry) => ({
      username: String(entry?.username || "").trim(),
      displayName: String(entry?.displayName || "").trim(),
    }))
    .filter((entry) => entry.username);
}

export function hasManualWinners(giveaway, overrides) {
  return getGiveawayManualWinners(giveaway, overrides).length > 0;
}

// --- Summer event --------------------------------------------------------

export function isSummerEventNoWinners(giveaway, overrides) {
  if (hasManualWinners(giveaway, overrides)) {
    return false;
  }
  return String(giveaway?.resultStatus || "").trim().toLowerCase() === "no_winners";
}

export function doesSummerEventGiveawayCountForStandings(giveaway, overrides) {
  return !isSummerEventNoWinners(giveaway, overrides);
}

// "Active" = still running: end date in the future. Anything ended (or without
// an end date) is finished. Shared by the frontend status filter and derived.json.
export function isSummerEventGiveawayActive(giveaway, now = Date.now()) {
  const end = giveaway?.endDate ? new Date(giveaway.endDate).getTime() : NaN;
  return Number.isFinite(end) && end > now;
}

export function hasSummerEventSteamPrice(giveaway) {
  return Boolean(giveaway?.steamPriceChecked)
    && giveaway?.steamPricePoints !== null
    && giveaway?.steamPricePoints !== undefined
    && giveaway?.steamPricePoints !== "";
}

export function getSummerEventBasePointsOverride(giveaway, overrides) {
  const key = getGiveawayCodeKey(giveaway);
  if (!key) {
    return null;
  }
  const raw = overrides?.giveaways?.[key]?.summerBasePointsOverride;
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function getSummerEventBasePoints(giveaway, overrides) {
  // No winner => 0 overall, so a manual base does nothing here; it only matters
  // for giveaways that ended with a winner (and applies if one is set later).
  if (isSummerEventNoWinners(giveaway, overrides)) {
    return 0;
  }
  const override = getSummerEventBasePointsOverride(giveaway, overrides);
  if (override !== null) {
    return override;
  }
  if (hasSummerEventSteamPrice(giveaway)) {
    return Number(giveaway?.steamPricePoints || 0);
  }
  return Number(giveaway?.points || 0);
}

export function getSummerEventPeriodDescriptor(giveaway, settings = {}) {
  const referenceDate = giveaway?.endDate || giveaway?.createdAt || settings.currentDate;
  const parsed = parseDate(referenceDate);
  const year = Number.isFinite(parsed.getTime()) ? parsed.getFullYear() : new Date().getFullYear();
  const period = getPeriodInfo(referenceDate);
  const label = /^Summer event/i.test(String(period?.label || "")) ? period.label : `Summer event (${year})`;
  return { key: `summer-event-${year}`, label, year };
}

export function getActiveSummerRuleset(giveaway, settings = {}) {
  const selected = String(settings.summerRuleset || "auto");
  if (selected === "legacy" || selected === "2026") {
    return selected;
  }
  // Auto: 2026 rules apply from the 2026 event onward, legacy before.
  return getSummerEventPeriodDescriptor(giveaway, settings).year >= 2026 ? "2026" : "legacy";
}

export function getSummerEventEntryDelta(giveaway, overrides, settings = {}) {
  if (isSummerEventNoWinners(giveaway, overrides)) {
    return 0;
  }
  const basePoints = getSummerEventBasePoints(giveaway, overrides);
  if (getActiveSummerRuleset(giveaway, settings) === "2026") {
    // 2026: 15-29P -> 5, 30-59P -> 10, 60P+ -> 15.
    if (basePoints >= 60) {
      return 15;
    }
    if (basePoints >= 30) {
      return 10;
    }
    return basePoints >= 15 ? 5 : 0;
  }
  // Legacy: under 30P -> 5, 30P+ -> 10.
  return basePoints >= 30 ? 10 : 5;
}

export function getSummerEventEntryUsers(giveaway) {
  return Array.from(
    new Set(
      (Array.isArray(giveaway?.entryUsers) ? giveaway.entryUsers : [])
        .map((username) => String(username || "").trim())
        .filter(Boolean),
    ),
  );
}

export function getSummerEventWinnerUsers(giveaway, overrides) {
  const manualWinners = getGiveawayManualWinners(giveaway, overrides);
  if (manualWinners.length) {
    return Array.from(new Set(manualWinners.map((winner) => winner.username)));
  }
  return Array.from(
    new Set(
      (Array.isArray(giveaway?.winners) ? giveaway.winners : [])
        .map((winner) => String(winner?.username || "").trim())
        .filter(Boolean),
    ),
  );
}

// Build the username -> member descriptor index from local members + sync members.
export function getSummerEventMemberIndex(members = [], syncMembers = []) {
  const index = new Map();

  for (const member of members) {
    const username = String(member?.steamgiftsUsername || member?.name || "").trim();
    if (!username || index.has(username)) {
      continue;
    }
    index.set(username, {
      username,
      displayName: member.name || username,
      profileUrl: `https://www.steamgifts.com/user/${encodeURIComponent(username)}`,
      isActiveMember: Boolean(member.isActiveMember),
    });
  }

  for (const member of syncMembers) {
    const username = String(member?.username || "").trim();
    if (!username) {
      continue;
    }
    const existing = index.get(username) || {};
    index.set(username, {
      username,
      displayName: existing.displayName || username,
      profileUrl: member.profileUrl || existing.profileUrl || `https://www.steamgifts.com/user/${encodeURIComponent(username)}`,
      isActiveMember: typeof member.isActiveMember === "boolean" ? member.isActiveMember : Boolean(existing.isActiveMember),
    });
  }

  return index;
}

// Filter the raw synced giveaways down to summer-event ones, honoring the manual
// kind override (looked up by code key, since raw sync records carry no override).
export function getTrackedSummerEventGiveaways(giveaways = [], overrides) {
  const overrideGiveaways = overrides?.giveaways || {};
  return giveaways.filter((giveaway) => {
    const key = getGiveawayCodeKey(giveaway);
    const overrideKind = key ? String(overrideGiveaways[key]?.giveawayKindOverride || "").trim() : "";
    const kind = overrideKind
      ? normalizeGiveawayKindValue(overrideKind, giveaway)
      : normalizeGiveawayKindValue(giveaway?.giveawayKind, giveaway);
    return kind === "summer_event";
  });
}

export function getSummerEventPeriods(giveaways, settings = {}) {
  const periods = new Map();
  for (const giveaway of giveaways) {
    const descriptor = getSummerEventPeriodDescriptor(giveaway, settings);
    if (!periods.has(descriptor.key)) {
      periods.set(descriptor.key, descriptor);
    }
  }
  return Array.from(periods.values()).sort((left, right) => right.year - left.year || right.key.localeCompare(left.key));
}

export function computeSummerEventStandings(giveaways, memberIndex, overrides, settings = {}) {
  const standings = new Map();

  const ensureParticipant = (username) => {
    const normalizedUsername = String(username || "").trim();
    if (!normalizedUsername) {
      return null;
    }
    if (!standings.has(normalizedUsername)) {
      const member = memberIndex.get(normalizedUsername) || null;
      standings.set(normalizedUsername, {
        username: normalizedUsername,
        displayName: member?.displayName || normalizedUsername,
        profileUrl: member?.profileUrl || `https://www.steamgifts.com/user/${encodeURIComponent(normalizedUsername)}`,
        isActiveMember: Boolean(member?.isActiveMember),
        createdGiveaways: 0,
        createdPoints: 0,
        wonGiveaways: 0,
        wonPoints: 0,
        entryBonusPoints: 0,
        receivedEntries: 0,
        joinedGiveaways: 0,
        entryCostPoints: 0,
        balance: 0,
      });
    }
    return standings.get(normalizedUsername);
  };

  for (const giveaway of giveaways) {
    if (!doesSummerEventGiveawayCountForStandings(giveaway, overrides)) {
      continue;
    }
    const entryUsers = getSummerEventEntryUsers(giveaway);
    const winnerUsers = getSummerEventWinnerUsers(giveaway, overrides);
    const basePoints = getSummerEventBasePoints(giveaway, overrides);
    const entryDelta = getSummerEventEntryDelta(giveaway, overrides, settings);
    const creator = ensureParticipant(giveaway.creatorUsername);

    if (creator) {
      creator.createdGiveaways += 1;
      creator.createdPoints += basePoints;
      creator.entryBonusPoints += entryUsers.length * entryDelta;
      creator.receivedEntries += entryUsers.length;
      creator.balance += basePoints + entryUsers.length * entryDelta;
    }

    for (const username of winnerUsers) {
      const winner = ensureParticipant(username);
      if (!winner) {
        continue;
      }
      winner.wonGiveaways += 1;
      winner.wonPoints += basePoints;
    }

    for (const username of entryUsers) {
      if (!username || username === giveaway.creatorUsername) {
        continue;
      }
      const participant = ensureParticipant(username);
      if (!participant) {
        continue;
      }
      participant.joinedGiveaways += 1;
      participant.entryCostPoints += entryDelta;
      participant.balance -= entryDelta;
    }
  }

  return Array.from(standings.values()).sort(
    (left, right) =>
      right.balance - left.balance ||
      right.createdPoints - left.createdPoints ||
      left.displayName.localeCompare(right.displayName, "en-US", { sensitivity: "base" }),
  );
}

// One-call pipeline used by the Node precompute. Takes the raw (export-shaped)
// sync giveaways + members and the merged overrides, returns per-period
// standings plus a per-giveaway computed summary. `now` is injected for
// deterministic active/finished classification.
export function buildSummerEventDerived({
  giveaways = [],
  members = [],
  syncMembers = [],
  overrides = {},
  settings = {},
  now = Date.now(),
} = {}) {
  const mergedOverrides = normalizeOverrideState(overrides);
  const normalized = giveaways.map((giveaway) => normalizeGiveawaySyncRecord(giveaway));
  const tracked = getTrackedSummerEventGiveaways(normalized, mergedOverrides);
  const memberIndex = getSummerEventMemberIndex(members, syncMembers);
  const periods = getSummerEventPeriods(tracked, settings);

  const periodPayloads = periods.map((period) => {
    const periodGiveaways = tracked.filter(
      (giveaway) => getSummerEventPeriodDescriptor(giveaway, settings).key === period.key,
    );
    const standings = computeSummerEventStandings(periodGiveaways, memberIndex, mergedOverrides, settings);
    const giveawayRows = periodGiveaways
      .map((giveaway) => {
        const entryUsers = getSummerEventEntryUsers(giveaway);
        const basePoints = getSummerEventBasePoints(giveaway, mergedOverrides);
        const entryDelta = getSummerEventEntryDelta(giveaway, mergedOverrides, settings);
        const entryPoints = entryUsers.length * entryDelta;
        return {
          key: getGiveawayCodeKey(giveaway),
          code: giveaway.code || "",
          title: giveaway.title || "",
          creatorUsername: giveaway.creatorUsername || "",
          endDate: giveaway.endDate || "",
          active: isSummerEventGiveawayActive(giveaway, now),
          basePoints,
          entryDelta,
          entryUsers: entryUsers.length,
          entryPoints,
          totalPoints: basePoints + entryPoints,
          winners: getSummerEventWinnerUsers(giveaway, mergedOverrides),
          resultStatus: String(giveaway.resultStatus || "").toLowerCase(),
          noWinners: isSummerEventNoWinners(giveaway, mergedOverrides),
        };
      });
    return {
      key: period.key,
      label: period.label,
      year: period.year,
      counts: {
        trackedGiveaways: periodGiveaways.length,
        activeGiveaways: giveawayRows.filter((row) => row.active).length,
        finishedGiveaways: giveawayRows.filter((row) => !row.active).length,
        participants: standings.length,
      },
      standings,
      giveaways: giveawayRows,
    };
  });

  return { periods: periodPayloads };
}
