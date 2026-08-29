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
import { parseDate, normalizeGameTitle, monthKey, formatHours, getAchievementPercent } from "./utils.js";
import { getPeriodInfo, getRequiredHours } from "./cycle-rules.js";

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

// A giveaway the collector confirmed was deleted on SteamGifts (a clean 404 on
// its detail page). Tombstoned records stay in the synced data for history but
// are excluded from every calculation and listing.
export function isGiveawayDeleted(giveaway) {
  return Boolean(giveaway?.deleted);
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
    // A giveaway nobody entered awards no points to anyone — not the creator's
    // base + entry bonus, nor the winner's base. It still counts as "created";
    // entrant costs are unaffected because there are no entrants.
    const hasEntries = entryUsers.length > 0;

    if (creator) {
      creator.createdGiveaways += 1;
      if (hasEntries) {
        creator.createdPoints += basePoints;
        creator.entryBonusPoints += entryUsers.length * entryDelta;
        creator.receivedEntries += entryUsers.length;
        creator.balance += basePoints + entryUsers.length * entryDelta;
      }
    }

    if (hasEntries) {
      for (const username of winnerUsers) {
        const winner = ensureParticipant(username);
        if (!winner) {
          continue;
        }
        winner.wonGiveaways += 1;
        winner.wonPoints += basePoints;
      }
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
  const normalized = giveaways
    .filter((giveaway) => !isGiveawayDeleted(giveaway))
    .map((giveaway) => normalizeGiveawaySyncRecord(giveaway));
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
          // No entries => the giveaway scores nothing (matches standings).
          totalPoints: entryUsers.length ? basePoints + entryPoints : 0,
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

// --- Progress + penalty engine -------------------------------------------
// The complex, drift-prone business rules (monthly progress, release-aware PoP
// month, Rule-9 penalty deadlines) live here, parameterized over a context so
// both the browser (app.js, with its uid-keyed state) and the Node precompute
// (with deterministically-keyed entities) run the identical logic.
//
// ctx = {
//   giveaways,        // override-applied giveaway entities (have giveawayKindOverride etc.)
//   gamesById,        // Map(gameId -> game)
//   membersById,      // Map(memberId -> member)
//   syncGiveaways,    // normalized raw sync giveaways (release-date fallback)
//   currentDate,      // "YYYY-MM-DD" SteamGifts sync date (period/date fallbacks)
//   penaltyReferenceDate, // "YYYY-MM-DD" Steam playtime/achievement sync date: the
//                     // reference "today" for penalty timing (falls back to currentDate)
//   penaltyReady,     // gate: false suppresses penalty classification (app load)
// }

export const GAME_OVERRIDE_FIELDS = ["hltbHoursOverride", "achievementTargetOverride"];
export const WIN_OVERRIDE_FIELDS = ["requiredAchievementsOverride", "monthOverride", "completionOverride"];
export const GIVEAWAY_OVERRIDE_FIELDS = ["giveawayKindOverride", "manualWinners", "cycleMonthOverride", "summerBasePointsOverride"];
export const MEMBER_OVERRIDE_FIELDS = ["membershipStatus"];
export const PENALTY_GRACE_MONTHS = 4;
export const PENALTY_TRACKING_START_MONTH = "2026-01";

export function stripOverrideFields(item, fields) {
  const nextItem = { ...item };
  for (const field of fields) {
    delete nextItem[field];
  }
  return nextItem;
}

export function getGameOverrideKey(game) {
  const appId = Number(game?.appId || 0);
  if (appId) {
    return `app:${appId}`;
  }
  const normalizedTitle = normalizeGameTitle(game?.title || "");
  if (normalizedTitle) {
    return `title:${normalizedTitle}`;
  }
  return String(game?.id || "");
}

export function getWinOverrideKey(win) {
  return String(win?.sourceId || win?.id || "");
}

export function getGiveawayOverrideKey(giveaway) {
  return String(giveaway?.sourceId || giveaway?.id || "");
}

export function normalizeGiveawayMonthOverrideValue(rawValue) {
  const value = String(rawValue || "").trim();
  if (!/^\d{4}-\d{2}$/.test(value)) {
    return "";
  }
  const [year, month] = value.split("-").map(Number);
  if (!year || month < 1 || month > 12) {
    return "";
  }
  return value;
}

const RELEASE_MONTH_LOOKUP = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export function getReleaseMonthKey(releaseDate) {
  const raw = String(releaseDate || "").trim();
  if (!raw) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw.slice(0, 7);
  }
  const normalized = raw.replace(/,/g, "");
  const dayMonthYear = normalized.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  const monthYear = normalized.match(/^([A-Za-z]+)\s+(\d{4})$/);
  const match = dayMonthYear || monthYear;
  if (!match) {
    return "";
  }
  const [, monthName, year] = dayMonthYear
    ? [match[0], match[2], match[3]]
    : [match[0], match[1], match[2]];
  const month = RELEASE_MONTH_LOOKUP[String(monthName).toLowerCase()];
  if (!month) {
    return "";
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function getBaseGiveawayKind(giveaway) {
  const kind = String(giveaway?.giveawayKind || giveaway?.type || "").toLowerCase();
  const penaltyText = `${String(giveaway?.title || "")} ${String(giveaway?.notes || "")}`;
  if (kind === "summer_event" || kind === "summer-event") {
    return "summer_event";
  }
  if (kind === "extra" || /\bpenalty\b/i.test(penaltyText)) {
    return "extra";
  }
  if (/\bsummer event\b/i.test(penaltyText)) {
    return "summer_event";
  }
  return "cycle";
}

export function getGiveawayKind(giveaway) {
  const rawOverrideKind = String(giveaway?.giveawayKindOverride || "").trim();
  if (rawOverrideKind) {
    return normalizeGiveawayKindValue(rawOverrideKind, giveaway);
  }
  return normalizeGiveawayKindValue(getBaseGiveawayKind(giveaway), giveaway);
}

export function getGiveawayMonth(giveaway) {
  const manualMonth = normalizeGiveawayMonthOverrideValue(giveaway?.cycleMonthOverride);
  if (manualMonth) {
    return manualMonth;
  }
  const overrideMonth = normalizeGiveawayMonthOverrideValue(giveaway?.giveawayMonthOverride);
  if (overrideMonth && getGiveawayKind(giveaway) === "cycle") {
    return overrideMonth;
  }
  return monthKey(giveaway?.createdAt || "");
}

export function getWinGiveawayUrl(win) {
  const directUrl = String(win?.giveawayUrl || "").trim();
  if (directUrl) {
    return directUrl;
  }
  const note = String(win?.evidenceNotes || "").trim();
  const steamGiftsMatch = note.match(/^SteamGifts sync:\s*(https?:\/\/\S+)$/i);
  return steamGiftsMatch ? steamGiftsMatch[1] : "";
}

export function findGiveawayForWin(win, ctx) {
  if (!win) {
    return null;
  }
  const giveaways = ctx?.giveaways || [];
  const sourceId = String(win.giveawaySourceId || "").trim();
  if (sourceId) {
    // Use the sourceId index when the ctx provides one (avoids an O(giveaways)
    // scan per win); fall back to a linear scan otherwise.
    const bySourceId = ctx?.giveawayBySourceId?.get(sourceId)
      || giveaways.find((giveaway) => giveaway.sourceId === sourceId);
    if (bySourceId) {
      return bySourceId;
    }
  }
  const giveawayUrl = getWinGiveawayUrl(win);
  if (giveawayUrl) {
    const byUrl = giveaways.find((giveaway) => String(giveaway.notes || "").trim() === giveawayUrl);
    if (byUrl) {
      return byUrl;
    }
  }
  const sourceMatch = String(win.sourceId || "").match(/^sg-win-([^-]+)-/);
  if (sourceMatch) {
    return giveaways.find((giveaway) => giveaway.sourceId === `sg-${sourceMatch[1]}`) || null;
  }
  return null;
}

export function getWinTrackKind(win, ctx) {
  const giveaway = findGiveawayForWin(win, ctx);
  return giveaway ? getGiveawayKind(giveaway) : "cycle";
}

export function getGameHltbHours(game) {
  if (game?.hltbHoursOverride !== undefined && game?.hltbHoursOverride !== null && game.hltbHoursOverride !== "") {
    return Number(game.hltbHoursOverride || 0);
  }
  return Number(game?.hltbHours || 0);
}

export function getGameAchievementsTotal(game) {
  return Number(game?.achievementsTotal || 0);
}

export function getRequiredAchievementsTarget(win, game) {
  if (game?.achievementTargetOverride !== undefined && game?.achievementTargetOverride !== null && game.achievementTargetOverride !== "") {
    return Number(game.achievementTargetOverride || 0);
  }
  if (win?.requiredAchievementsOverride !== undefined && win?.requiredAchievementsOverride !== null && win.requiredAchievementsOverride !== "") {
    return Number(win.requiredAchievementsOverride || 0);
  }
  const totalAchievements = getGameAchievementsTotal(game);
  return totalAchievements > 0 ? Math.max(1, Math.floor(totalAchievements * 0.1)) : 0;
}

export function getWinReleaseDate(win, game, ctx) {
  if (game?.releaseDate) {
    return game.releaseDate;
  }
  const syncGiveaways = ctx?.syncGiveaways || [];
  const byUrl = syncGiveaways.find((giveaway) => giveaway?.url && giveaway.url === win.giveawayUrl);
  if (byUrl?.releaseDate) {
    return byUrl.releaseDate;
  }
  const byGame = syncGiveaways.find(
    (giveaway) =>
      (Number(giveaway?.appId || 0) && Number(giveaway?.appId || 0) === Number(game?.appId || 0)) ||
      (giveaway?.title && giveaway.title === game?.title),
  );
  return byGame?.releaseDate || "";
}

export function getBaseEffectiveWinMonth(win, ctx) {
  const giveaway = findGiveawayForWin(win, ctx);
  if (giveaway) {
    return getGiveawayMonth(giveaway);
  }
  return monthKey(win.winDate || "");
}

export function getEffectiveWinMonth(win, ctx) {
  const overrideMonth = String(win?.monthOverride || "").trim();
  if (overrideMonth) {
    return overrideMonth;
  }
  return getBaseEffectiveWinMonth(win, ctx);
}

export function getWinPlayMonth(win, ctx) {
  let baseMonth = getEffectiveWinMonth(win, ctx);
  // Summer-event wins all count under July for PoP requirements, even the ones
  // gifted in June. A manual per-win monthOverride still wins; an unreleased
  // game still moves forward to its release month (handled below).
  if (!String(win?.monthOverride || "").trim() && getWinTrackKind(win, ctx) === "summer_event") {
    const yearMatch = /^(\d{4})-\d{2}$/.exec(baseMonth);
    if (yearMatch) {
      baseMonth = `${yearMatch[1]}-07`;
    }
  }
  const game = ctx?.gamesById?.get(win.gameId) || null;
  const releaseMonth = getReleaseMonthKey(getWinReleaseDate(win, game, ctx));
  return releaseMonth && releaseMonth > baseMonth ? releaseMonth : baseMonth;
}

export function evaluateBaseMonthlyProgress(win, ctx) {
  const game = (ctx?.gamesById?.get(win.gameId)) || { id: "", title: "Unknown game", hltbHours: 0, achievementsTotal: 0 };
  const hltbHours = getGameHltbHours(game);
  const totalAchievements = getGameAchievementsTotal(game);
  const currentHours = Number(win.currentHours || 0);
  const currentAchievements = Number(win.earnedAchievements || 0);
  const requiredHours = hltbHours > 0 ? getRequiredHours(hltbHours, "standard-25") : 0;
  const requiredAchievements = getRequiredAchievementsTarget(win, game);
  const hasThresholdData = hltbHours > 0 || totalAchievements > 0;
  const meetsHours = requiredHours === 0 || currentHours >= requiredHours;
  const meetsAchievements = requiredAchievements === 0 || currentAchievements >= requiredAchievements;
  const allAchievementsDone = totalAchievements > 0 && currentAchievements >= totalAchievements;

  if (win.completionOverride === true) {
    return { badge: "success", label: "Marked complete", note: "Marked complete manually; future requirement changes do not affect this win.", requiredHours, requiredAchievements };
  }

  // Once a win has genuinely reached the threshold it stays met forever, even if
  // the game's HLTB later grows (expansions) and pushes the required hours up.
  if (win.popThresholdMetAt) {
    return { badge: "success", label: "Threshold met", note: "Threshold reached previously — locked as complete.", requiredHours, requiredAchievements };
  }

  if (!hasThresholdData) {
    return { badge: "danger", label: "Missing data", note: "No HLTB or achievement totals were found yet.", requiredHours, requiredAchievements };
  }
  if (allAchievementsDone) {
    return { badge: "warning", label: "All achievements", note: "Completed every achievement for this game.", requiredHours, requiredAchievements };
  }
  if (meetsHours && meetsAchievements) {
    return { badge: "success", label: "Threshold met", note: "Reached 25% of HLTB time and 10% of achievements.", requiredHours, requiredAchievements };
  }
  const missingBits = [];
  if (requiredHours > currentHours) {
    missingBits.push(`${formatHours(requiredHours - currentHours)} more playtime`);
  }
  if (requiredAchievements > currentAchievements) {
    missingBits.push(`${requiredAchievements - currentAchievements} more achievement(s)`);
  }
  return { badge: "danger", label: "Below threshold", note: missingBits.length ? `Needs ${missingBits.join(" + ")}.` : "Threshold not met yet.", requiredHours, requiredAchievements };
}

export function evaluateMonthlyProgress(win, ctx) {
  const base = evaluateBaseMonthlyProgress(win, ctx);
  if (getWinTrackKind(win, ctx) === "pop_free" && base.badge === "danger") {
    return { ...base, badge: "info", label: "PoP free", note: "PoP Free — counts as complete; no minimum play required." };
  }
  return base;
}

// Effort bands grade how much of the GAME was done, as opposed to
// evaluateMonthlyProgress which is the pass/fail on the group's minimum. Array
// order is load-bearing: it is the rank used for sorting and for the stacked
// bar on the scoreboard. "fresh" is not a band - it is the scoreboard's holding
// pen for failing wins still inside their penalty grace (see countMemberEffort).
export const POP_EFFORT_BANDS = [
  { key: "below", label: "Below", tone: "danger" },
  { key: "minimum", label: "At minimum", tone: "warning" },
  { key: "above", label: "Above", tone: "info" },
  { key: "well-above", label: "Well above", tone: "success" },
  // Every achievement earned. Amber rather than green so it reads as its own
  // thing next to "well above" instead of just more of the same.
  { key: "complete", label: "Complete", tone: "warning" },
];

// `progress` is injectable because app.js memoizes evaluateMonthlyProgress and
// the PoP page grades a couple of thousand wins per render; recomputing it here
// would undo that.
export function getPopEffort(win, ctx, progress = evaluateMonthlyProgress(win, ctx)) {
  const game = ctx?.gamesById?.get(win.gameId) || null;
  const requiredHours = Number(progress.requiredHours || 0);
  const requiredAchievements = Number(progress.requiredAchievements || 0);
  const currentHours = Number(win.currentHours || 0);
  const earnedAchievements = Number(win.earnedAchievements || 0);
  const totalAchievements = getGameAchievementsTotal(game);
  const fullyCompleted = totalAchievements > 0 && earnedAchievements >= totalAchievements;

  const hltbHours = getGameHltbHours(game);
  const hoursRatio = requiredHours > 0 ? currentHours / requiredHours : null;
  const achievementRatio = requiredAchievements > 0 ? earnedAchievements / requiredAchievements : null;

  // Grade on how much of the GAME was done, not on multiples of the requirement.
  // The two requirements are different sizes (25% of playtime vs 10% of
  // achievements), so "3x the minimum" means 75% of a game on one axis and 30% on
  // the other. Completion percentages are the same unit on both sides, so they
  // can be averaged; that also means heavy playtime with almost no achievements
  // cannot reach the top on its own, without needing a special case for it.
  const hoursCompletion = hltbHours > 0 ? Math.min(1, currentHours / hltbHours) : null;
  const achievementCompletion = totalAchievements > 0 ? Math.min(1, earnedAchievements / totalAchievements) : null;
  const measured = [hoursCompletion, achievementCompletion].filter((value) => value !== null);
  const completion = measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
  const ratio = completion;

  // Purely informational: the game is essentially played through but the
  // achievements barely moved, which can mean it was left running.
  const hoursOnlyOutlier =
    !fullyCompleted &&
    achievementCompletion !== null &&
    achievementCompletion < 0.15 &&
    (hoursCompletion ?? 0) >= 0.9;

  // Pass/fail stays with evaluateMonthlyProgress, which carries the special cases
  // (locked-in thresholds, all-achievements wins). The ratio only grades degree.
  let band = "below";
  if (fullyCompleted) {
    band = "complete";
  } else if (progress.badge !== "danger") {
    // The top band needs depth on BOTH measures, not just a high average. Pure
    // averaging cannot separate 65%/64% (deep and balanced) from 100%/29% (ran
    // the clock out with a quarter of the achievements) - they score the same.
    // So "well above" also requires the weaker of the two to be substantial.
    const weakest = measured.length > 1 ? Math.min(...measured) : (completion ?? 0);
    if (completion === null || completion < 0.35) {
      band = "minimum";
    } else if (completion < 0.6 || weakest < 0.45) {
      band = "above";
    } else {
      band = "well-above";
    }
  }

  return {
    progress,
    ratio,
    band,
    totalAchievements,
    fullyCompleted,
    hoursOnlyOutlier,
    hoursCompletion,
    achievementCompletion,
    completion,
    requiredHours,
    requiredAchievements,
    currentHours,
    earnedAchievements,
    hoursRatio,
    achievementRatio,
  };
}

// Not a band - the scoreboard's holding pen for failing wins still inside their
// 4-month penalty grace (PENALTY_GRACE_MONTHS). Such a win has not actually
// missed anything yet: games won weeks ago are unplayed far more often than not
// (74% of wins aged 1-2 months sit below the threshold, against 5-11% once they
// are over a year old), so counting them as failures would rank members by who
// won most recently. It stays visible on the bar - only the verdict is withheld.
export const EFFORT_FRESH_KEY = "fresh";

// Named keys rather than a positional tuple: POP_EFFORT_BANDS order is
// load-bearing for sorting and has been reordered before, and a reorder must not
// silently reassign every count already published in derived.json.
export function summarizeMemberWins(memberWins, ctx, options = {}) {
  const bandFor = options.bandFor || ((win) => getPopEffort(win, ctx).band);
  const penaltyStatusFor = options.penaltyStatusFor || ((win) => getWinPenaltyInfo(win, ctx)?.status || "");
  const progressFor = options.progressFor || ((win) => evaluateMonthlyProgress(win, ctx));
  const achievementPercentFor =
    options.achievementPercentFor || ((win) => getAchievementPercent(win, ctx?.gamesById?.get(win.gameId)));

  const bands = {};
  let totalPlaytime = 0;
  let thresholdMet = 0;
  let achievementSum = 0;
  let achievementCount = 0;
  for (const win of memberWins) {
    const band = bandFor(win);
    const key = band === "below" && penaltyStatusFor(win) === "coming-due" ? EFFORT_FRESH_KEY : band;
    bands[key] = (bands[key] || 0) + 1;
    totalPlaytime += Number(win.currentHours || 0);
    if (progressFor(win).badge !== "danger") {
      thresholdMet += 1;
    }
    const percent = achievementPercentFor(win);
    if (percent !== null) {
      achievementSum += percent;
      achievementCount += 1;
    }
  }
  return {
    totalWins: memberWins.length,
    totalPlaytime: Math.round(totalPlaytime * 100) / 100,
    averageAchievements: achievementCount ? Math.round(achievementSum / achievementCount) : null,
    thresholdMet,
    bands,
  };
}

// Same stat bundle as the all-time one, keyed by the year of the win, so the
// scoreboard's year filter is a lookup rather than a second code path.
export function summarizeMemberWinsByYear(memberWins, ctx, options = {}) {
  const byYear = new Map();
  for (const win of memberWins) {
    const year = String(win.winDate || "").slice(0, 4);
    if (!/^\d{4}$/.test(year)) {
      continue;
    }
    if (!byYear.has(year)) {
      byYear.set(year, []);
    }
    byYear.get(year).push(win);
  }
  const years = {};
  for (const year of [...byYear.keys()].sort()) {
    years[year] = summarizeMemberWins(byYear.get(year), ctx, options);
  }
  return years;
}

// Share of JUDGED wins (grace excluded from the denominator) that reached at
// least "above". Null when nothing is judged yet, so callers can say "no data"
// rather than print a misleading 0%.
export function effortScore(bands) {
  if (!bands) {
    return null;
  }
  const judged = POP_EFFORT_BANDS.reduce((sum, band) => sum + (bands[band.key] || 0), 0);
  if (!judged) {
    return null;
  }
  const reached = (bands.above || 0) + (bands["well-above"] || 0) + (bands.complete || 0);
  return reached / judged;
}

export function getPenaltyForCodeKey(giveaway) {
  const raw = String(giveaway?.penaltyForCode || "").trim();
  if (!raw) {
    return "";
  }
  return raw.startsWith("sg-") ? raw : `sg-${raw}`;
}

export function getWinGiveawayCodeKey(win, ctx) {
  const giveaway = findGiveawayForWin(win, ctx);
  return giveaway ? getGiveawayCodeKey(giveaway) : "";
}

export function isWinPenaltyPaid(win, ctx) {
  const codeKey = getWinGiveawayCodeKey(win, ctx);
  if (!codeKey) {
    return false;
  }
  return (ctx?.giveaways || []).some(
    (giveaway) => getGiveawayKind(giveaway) === "penalty" && getPenaltyForCodeKey(giveaway) === codeKey,
  );
}

// Reference "today" for penalty timing (overdue / days left). The judgement is
// about playtime + achievements, so it is only as current as the Steam refresh
// that produced them — NOT the SteamGifts sync (settings.currentDate), which can
// be days newer or older and says nothing about a member's progress. Takes the
// freshest of the progress refresh and the library (playtime) refresh, and only
// falls back to the SteamGifts sync date when no Steam refresh is recorded.
export function resolvePenaltyReferenceDate({ progressUpdatedAt, libraryUpdatedAt, currentDate } = {}) {
  const candidates = [progressUpdatedAt, libraryUpdatedAt]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((item) => Number.isFinite(item.time))
    .sort((left, right) => right.time - left.time);
  if (candidates.length) {
    return candidates[0].value.slice(0, 10);
  }
  return String(currentDate || "").slice(0, 10);
}

export function getPenaltyDeadlineForMonth(popMonth) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(popMonth || ""));
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  return new Date(Date.UTC(year, month + PENALTY_GRACE_MONTHS, 1));
}

export function getWinPenaltyInfo(win, ctx) {
  if (ctx?.penaltyReady === false) {
    return null;
  }
  const trackKind = getWinTrackKind(win, ctx);
  if (trackKind === "pop_free" || trackKind === "penalty") {
    return null;
  }
  const popMonth = getWinPlayMonth(win, ctx);
  if (!popMonth) {
    return null;
  }
  if (popMonth < PENALTY_TRACKING_START_MONTH) {
    return { status: "grandfathered", popMonth, deadline: null };
  }
  if (evaluateMonthlyProgress(win, ctx).badge !== "danger") {
    return { status: "complete", popMonth, deadline: null };
  }
  const deadline = getPenaltyDeadlineForMonth(popMonth);
  if (!deadline) {
    return null;
  }
  if (isWinPenaltyPaid(win, ctx)) {
    return { status: "paid", popMonth, deadline };
  }
  // Timed against the Steam refresh, not the SteamGifts sync — see
  // resolvePenaltyReferenceDate.
  const now = parseDate(ctx?.penaltyReferenceDate || ctx?.currentDate || "");
  const reference = Number.isFinite(now.getTime()) ? now : new Date();
  const days = Math.round((deadline.getTime() - reference.getTime()) / 86400000);
  if (reference.getTime() >= deadline.getTime()) {
    return { status: "overdue", popMonth, deadline, daysOverdue: Math.abs(days) };
  }
  return { status: "coming-due", popMonth, deadline, daysLeft: days };
}

export function getOutstandingPenalties(wins, ctx) {
  return wins
    .map((win) => {
      const info = getWinPenaltyInfo(win, ctx);
      return info && info.status === "overdue" ? { win, deadline: info.deadline, popMonth: info.popMonth } : null;
    })
    .filter(Boolean)
    .map((debt) => ({
      ...debt,
      member: ctx?.membersById?.get(debt.win.memberId) || null,
      game: ctx?.gamesById?.get(debt.win.gameId) || null,
    }))
    .sort((left, right) => left.deadline.getTime() - right.deadline.getTime());
}

export function compareMemberBucketRows(left, right, sortMode) {
  switch (sortMode) {
    case "name":
      return String(left.name || "").localeCompare(String(right.name || ""), "pt-BR", { sensitivity: "base" });
    case "playtime":
      return right.totalPlaytime - left.totalPlaytime || right.totalWins - left.totalWins || compareMemberBucketRows(left, right, "name");
    case "achievements":
      return (
        (right.averageAchievements ?? -1) - (left.averageAchievements ?? -1) ||
        right.totalWins - left.totalWins ||
        compareMemberBucketRows(left, right, "name")
      );
    case "threshold":
      return right.thresholdMet - left.thresholdMet || right.totalWins - left.totalWins || compareMemberBucketRows(left, right, "name");
    case "effort": {
      // Members with nothing judged yet sink rather than tie at the top.
      const leftScore = effortScore(left.bands) ?? -1;
      const rightScore = effortScore(right.bands) ?? -1;
      const finished = (row) => (row.bands?.["well-above"] || 0) + (row.bands?.complete || 0);
      return (
        rightScore - leftScore ||
        finished(right) - finished(left) ||
        right.totalWins - left.totalWins ||
        compareMemberBucketRows(left, right, "name")
      );
    }
    case "wins":
    default:
      return right.totalWins - left.totalWins || right.totalPlaytime - left.totalPlaytime || compareMemberBucketRows(left, right, "name");
  }
}

export function computeMemberBucketRows(members, wins, ctx, isActiveMember, sortMode = "wins", options = {}) {
  return members
    .filter((member) => Boolean(member.isActiveMember) === isActiveMember)
    .map((member) => {
      const memberWins = wins.filter((win) => win.memberId === member.id);
      const sgUsername = String(member.steamgiftsUsername || member.name || "").trim();
      // The row IS the all-time bucket, and each year mirrors the same field
      // names, so the scoreboard's year filter is `year === "all" ? row : row.years[year]`.
      return {
        name: member.name,
        overrideKey: getStableMemberKey(member),
        steamgiftsUrl: member.profileUrl || (sgUsername ? `https://www.steamgifts.com/user/${encodeURIComponent(sgUsername)}` : ""),
        ...summarizeMemberWins(memberWins, ctx, options),
        years: summarizeMemberWinsByYear(memberWins, ctx, options),
      };
    })
    .filter((row) => row.totalWins > 0 || isActiveMember)
    .sort((left, right) => compareMemberBucketRows(left, right, sortMode));
}

// --- Node-side entity builder --------------------------------------------
// Mirrors app.js importSteamGiftsSync + applySteamProgress + applyManualOverrides,
// producing the same {members, games, wins, giveaways} graph the browser holds —
// but with deterministic ids (the browser uses uid()). Penalty/progress math is
// computed within this one consistent graph, so id shape is irrelevant.
export function buildEntityGraph({ sync = {}, progress = {}, overrides = {}, settings = {} } = {}) {
  const mergedOverrides = normalizeOverrideState(overrides);
  const currentDate = settings.currentDate || "";
  const syncMembers = (Array.isArray(sync.members) ? sync.members : []).filter((member) => String(member?.username || "").trim());
  const memberSteamProfiles = {};
  const memberActivity = {};
  for (const member of syncMembers) {
    const username = String(member.username).trim();
    memberSteamProfiles[username] = member.steamProfile || "";
    memberActivity[username] = Boolean(member.isActiveMember);
  }
  const profileByUsername = new Map(syncMembers.map((member) => [String(member.username).trim(), member.profileUrl || ""]));
  const syncGiveaways = (Array.isArray(sync.giveaways) ? sync.giveaways : [])
    .filter((giveaway) => !isGiveawayDeleted(giveaway))
    .map((giveaway) => normalizeGiveawaySyncRecord(giveaway));

  const members = [];
  const upsertMember = (record) => {
    const username = String(record?.username || "").trim();
    if (!username) {
      return "";
    }
    let member = members.find((item) => item.steamgiftsUsername === username || item.name === username);
    if (!member) {
      member = {
        id: `member:${username}`,
        name: username,
        steamProfile: record.steamProfile || "",
        steamgiftsUsername: username,
        isActiveMember: Boolean(record.isActiveMember),
        profileUrl: profileByUsername.get(username) || "",
      };
      members.push(member);
      return member.id;
    }
    if (!member.steamProfile && record.steamProfile) {
      member.steamProfile = record.steamProfile;
    }
    if (typeof record.isActiveMember === "boolean") {
      member.isActiveMember = record.isActiveMember;
    }
    return member.id;
  };

  const games = [];
  const upsertGame = (giveawayRecord) => {
    const appId = Number(giveawayRecord.appId || 0);
    let game = games.find((item) => (appId ? Number(item.appId) === appId : item.title === giveawayRecord.title));
    if (!game) {
      game = {
        id: `game:${appId ? `app:${appId}` : `title:${normalizeGameTitle(giveawayRecord.title || "")}`}`,
        title: giveawayRecord.title,
        appId,
        hltbHours: Number(giveawayRecord.hltbHours || 0),
        achievementsTotal: Number(giveawayRecord.totalAchievements || 0),
        steamAppUrl: giveawayRecord.steamAppUrl || "",
        releaseDate: giveawayRecord.releaseDate || "",
        comingSoon: Boolean(giveawayRecord.comingSoon),
      };
      games.push(game);
      return game.id;
    }
    if (!game.appId && appId) {
      game.appId = appId;
    }
    if (!game.hltbHours && giveawayRecord.hltbHours) {
      game.hltbHours = Number(giveawayRecord.hltbHours);
    }
    if (!game.achievementsTotal && giveawayRecord.totalAchievements) {
      game.achievementsTotal = Number(giveawayRecord.totalAchievements);
    }
    if (giveawayRecord.releaseDate && game.releaseDate !== giveawayRecord.releaseDate) {
      game.releaseDate = giveawayRecord.releaseDate;
    }
    return game.id;
  };

  const giveaways = [];
  const upsertGiveaway = (giveawayRecord, creatorId) => {
    const sourceId = `sg-${giveawayRecord.code}`;
    const existing = giveaways.find((item) => item.sourceId === sourceId);
    const normalizedKind = normalizeGiveawayKindValue(giveawayRecord.giveawayKind, giveawayRecord);
    const payload = {
      id: existing?.id || `giveaway:${sourceId}`,
      sourceId,
      creatorId,
      title: giveawayRecord.title,
      type: "sync",
      createdAt: giveawayRecord.startDate || giveawayRecord.endDate || currentDate,
      valuePoints: Number(giveawayRecord.points || 0),
      entriesCount: Number(giveawayRecord.entriesCount || 0),
      notes: giveawayRecord.url || "",
      giveawayKind: normalizedKind,
      giveawayMonthOverride: normalizedKind === "cycle" ? normalizeGiveawayMonthOverrideValue(giveawayRecord.giveawayMonthOverride) : "",
      penaltyForCode: String(giveawayRecord.penaltyForCode || existing?.penaltyForCode || "").trim(),
      creatorUsername: giveawayRecord.creatorUsername || existing?.creatorUsername || "",
      resultStatus: String(giveawayRecord.resultStatus || "").toLowerCase(),
      resultLabel: giveawayRecord.resultLabel || "",
      appId: Number(giveawayRecord.appId || 0) || existing?.appId || null,
      startDate: giveawayRecord.startDate || existing?.startDate || "",
      endDate: giveawayRecord.endDate || existing?.endDate || "",
    };
    if (!existing) {
      giveaways.push(payload);
    } else {
      Object.assign(existing, payload);
    }
    return payload.id;
  };

  const wins = [];
  const upsertWin = (giveawayRecord, winner, memberId, gameId) => {
    const sourceId = `sg-win-${giveawayRecord.code}-${winner.username}`;
    const existing = wins.find((item) => item.sourceId === sourceId);
    const payload = {
      id: existing?.id || `win:${sourceId}`,
      sourceId,
      giveawaySourceId: `sg-${giveawayRecord.code}`,
      memberId,
      gameId,
      creatorUsername: giveawayRecord.creatorUsername || "",
      giveawayUrl: giveawayRecord.url || "",
      winDate: giveawayRecord.endDate || currentDate,
      ruleMode: "standard-25",
      currentHours: 0,
      earnedAchievements: 0,
      proofProvided: Boolean(giveawayRecord.earnedAchievements > 0),
      evidenceNotes: giveawayRecord.notes || (giveawayRecord.url ? `SteamGifts sync: ${giveawayRecord.url}` : ""),
    };
    if (!existing) {
      wins.push(payload);
    } else {
      Object.assign(existing, payload);
    }
  };

  for (const member of syncMembers) {
    upsertMember({ username: member.username, steamProfile: member.steamProfile, isActiveMember: member.isActiveMember });
  }
  for (const giveawayRecord of syncGiveaways) {
    const creatorId = upsertMember({
      username: giveawayRecord.creatorUsername,
      steamProfile: memberSteamProfiles[giveawayRecord.creatorUsername] || "",
      isActiveMember: memberActivity[giveawayRecord.creatorUsername],
    });
    upsertGiveaway(giveawayRecord, creatorId);
    for (const winner of giveawayRecord.winners) {
      const memberId = upsertMember({
        username: winner.username,
        steamProfile: memberSteamProfiles[winner.username] || "",
        isActiveMember: memberActivity[winner.username],
      });
      const gameId = upsertGame(giveawayRecord);
      upsertWin(giveawayRecord, winner, memberId, gameId);
    }
  }

  // Steam progress/library merge (playtime + achievements into wins, hltb +
  // achievement totals into games). Mirrors applySteamProgress.
  let membersById = new Map(members.map((member) => [member.id, member]));
  let gamesById = new Map(games.map((game) => [game.id, game]));
  const progressItems = Array.isArray(progress.progress) ? progress.progress : [];
  const hltbItems = Array.isArray(progress.hltb) ? progress.hltb : [];
  const progressByKey = new Map(progressItems.map((item) => [`${item.steamProfile}|${item.appId}`, item]));
  const hltbByAppId = new Map(hltbItems.filter((item) => item?.appId && item?.hltbHours).map((item) => [Number(item.appId), Number(item.hltbHours)]));
  const hltbByTitle = new Map(hltbItems.filter((item) => item?.title && item?.hltbHours).map((item) => [item.title, Number(item.hltbHours)]));

  // Apply Steam playtime/achievements onto wins. Defined here, but invoked AFTER
  // the manual-winner reconcile below: manual winners get their win objects
  // rebuilt there (reset to 0h / 0 achievements), so merging only here would
  // leave them stuck at zero and wrongly flag them below threshold.
  const applyProgressToWins = (winList, membersByIdMap, gamesByIdMap) => {
    for (const win of winList) {
      const member = membersByIdMap.get(win.memberId);
      const game = gamesByIdMap.get(win.gameId);
      if (!member?.steamProfile || !game?.appId) {
        continue;
      }
      const entry = progressByKey.get(`${member.steamProfile}|${game.appId}`);
      if (!entry) {
        continue;
      }
      if (entry.playtimeHours !== null && entry.playtimeHours !== undefined) {
        win.currentHours = entry.playtimeHours;
      }
      win.earnedAchievements = entry.earnedAchievements ?? win.earnedAchievements;
      win.proofProvided = entry.visible;
      // Permanent "threshold met" latch (stamped server-side once genuinely reached).
      win.popThresholdMetAt = entry.popThresholdMetAt || win.popThresholdMetAt || null;
    }
  };
  // Merge HLTB hours + achievement totals onto games. Also re-run after the
  // manual-winner reconcile: a pre-release giveaway with no synced winner has no
  // game until reconcile's upsertGame creates it, so without a second pass that
  // game would keep 0 HLTB / 0 achievements and read as "Missing data".
  const applyProgressToGames = (gameList) => {
    for (const game of gameList) {
      const entry = progressItems.find((item) => Number(item.appId) === Number(game.appId));
      if (!entry) {
        continue;
      }
      game.hltbHours = hltbByAppId.get(Number(game.appId)) || hltbByTitle.get(game.title) || Number(game.hltbHours || 0);
      game.achievementsTotal = entry.totalAchievements > 0 ? entry.totalAchievements : game.achievementsTotal;
    }
  };
  applyProgressToGames(games);

  // Apply manual overrides on top (games/wins/giveaways/members), then
  // reconcile manual-winner wins. Mirrors applyManualOverrides.
  const applyEntityOverrides = (list, bucket, fields, keyFn) =>
    list.map((item) => {
      const key = keyFn(item);
      const stripped = stripOverrideFields(item, fields);
      return { ...stripped, ...(key ? mergedOverrides[bucket][key] || {} : {}) };
    });
  let nextGames = applyEntityOverrides(games, "games", GAME_OVERRIDE_FIELDS, getGameOverrideKey);
  let nextWins = applyEntityOverrides(wins, "wins", WIN_OVERRIDE_FIELDS, getWinOverrideKey);
  let nextGiveaways = applyEntityOverrides(giveaways, "giveaways", GIVEAWAY_OVERRIDE_FIELDS, getGiveawayOverrideKey);
  const nextMembers = members.map((member) => {
    const key = getStableMemberKey(member);
    const stripped = stripOverrideFields(member, MEMBER_OVERRIDE_FIELDS);
    const status = key ? String(mergedOverrides.members[key]?.membershipStatus || "").toLowerCase() : "";
    if (status === "inactive") {
      return { ...stripped, isActiveMember: false };
    }
    if (status === "active") {
      return { ...stripped, isActiveMember: true };
    }
    return stripped;
  });

  // reconcileManualWinnerWins: a manual winner replaces whatever the sync
  // recorded for that giveaway.
  membersById = new Map(nextMembers.map((member) => [member.id, member]));
  nextWins = nextWins.filter((win) => !win.manualWinner);
  const findMemberByUsername = (username) => {
    const normalized = String(username || "").trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    return (
      nextMembers.find((member) => {
        const sg = String(member?.steamgiftsUsername || "").trim().toLowerCase();
        const name = String(member?.name || "").trim().toLowerCase();
        return (sg && sg === normalized) || (name && name === normalized);
      }) || null
    );
  };
  for (const [key, entry] of Object.entries(mergedOverrides.giveaways || {})) {
    const manualWinners = Array.isArray(entry?.manualWinners) ? entry.manualWinners : [];
    if (!manualWinners.length) {
      continue;
    }
    const giveaway = nextGiveaways.find((item) => getGiveawayCodeKey(item) === key);
    if (!giveaway?.sourceId) {
      continue;
    }
    nextWins = nextWins.filter((win) => String(win.giveawaySourceId || "") !== giveaway.sourceId);
    const code = giveaway.sourceId.replace(/^sg-/, "");
    const syncGiveaway = syncGiveaways.find((item) => String(item.code) === code) || null;
    const gameId = syncGiveaway
      ? upsertGame(syncGiveaway)
      : nextGames.find((game) => game.title === giveaway.title)?.id || null;
    for (const winnerInfo of manualWinners) {
      const member = findMemberByUsername(winnerInfo.username);
      if (!member) {
        continue;
      }
      nextWins.unshift({
        id: `win:sg-win-${code}-${winnerInfo.username}`,
        sourceId: `sg-win-${code}-${winnerInfo.username}`,
        giveawaySourceId: giveaway.sourceId,
        memberId: member.id,
        gameId,
        manualWinner: true,
        creatorUsername: giveaway.creatorUsername || "",
        giveawayUrl: String(giveaway.notes || "").trim(),
        winDate: giveaway.createdAt || currentDate,
        ruleMode: "standard-25",
        currentHours: 0,
        earnedAchievements: 0,
        proofProvided: false,
        evidenceNotes: "Manual winner set in the dashboard.",
      });
    }
  }
  // upsertGame may have appended during reconcile; merge progress onto those new
  // games, then re-apply game overrides to them and refresh lookups.
  applyProgressToGames(games);
  nextGames = applyEntityOverrides(games, "games", GAME_OVERRIDE_FIELDS, getGameOverrideKey);
  gamesById = new Map(nextGames.map((game) => [game.id, game]));

  // Now that wins are final (override-applied + manual winners reconciled), merge
  // Steam playtime/achievements so every win — including rebuilt manual winners —
  // reflects real progress.
  applyProgressToWins(nextWins, membersById, gamesById);

  return {
    members: nextMembers,
    games: nextGames,
    wins: nextWins,
    giveaways: nextGiveaways,
    syncGiveaways,
    membersById,
    gamesById,
  };
}

export function getGiveawayPageUrl(giveaway) {
  if (!giveaway) {
    return "";
  }
  const note = String(giveaway.notes || giveaway.url || "").trim();
  if (/^https?:\/\//.test(note)) {
    return note;
  }
  const code = String(giveaway.code || "").trim() || String(giveaway.sourceId || "").replace(/^sg-/, "");
  return code ? `https://www.steamgifts.com/giveaway/${code}/` : "";
}

// Penalty giveaways that have been created, resolved to the won giveaway they
// settle (the audit/settled list). Mirrors app.js getPenaltyGiveawayRecords.
// Penalty giveaways without a resolvable "Penalty GA - <link>" target (legacy,
// pre-2026) are excluded: with no known paid-for game they aren't "settled".
export function getPenaltyGiveawayRecords(wins, ctx) {
  const giveaways = ctx?.giveaways || [];
  return giveaways
    .filter((giveaway) => getGiveawayKind(giveaway) === "penalty")
    .map((giveaway) => {
      const targetKey = getPenaltyForCodeKey(giveaway);
      const target = targetKey ? giveaways.find((item) => getGiveawayCodeKey(item) === targetKey) || null : null;
      const targetWin = target ? wins.find((win) => getWinGiveawayCodeKey(win, ctx) === targetKey) || null : null;
      return {
        giveaway,
        target,
        targetWin,
        creator: ctx?.membersById?.get(giveaway.creatorId) || null,
        targetGame: targetWin ? ctx?.gamesById?.get(targetWin.gameId) || null : null,
      };
    })
    .filter((record) => record.target)
    .sort((left, right) => String(right.giveaway.createdAt || "").localeCompare(String(left.giveaway.createdAt || "")));
}

// Per-win "have / need" raw figures for the penalties table cells. The frontend
// formats them (formatHours etc.) so number formatting stays single-source there.
function penaltyProgressFigures(win, ctx) {
  if (!win) {
    return { currentHours: null, requiredHours: null, earnedAchievements: null, requiredAchievements: null };
  }
  const progress = evaluateMonthlyProgress(win, ctx);
  return {
    currentHours: Number(win.currentHours || 0),
    requiredHours: progress.requiredHours || 0,
    earnedAchievements: Number(win.earnedAchievements || 0),
    requiredAchievements: progress.requiredAchievements || 0,
  };
}

// One-call pipeline for the Node precompute: build the graph, then emit the
// penalty rows (owed/coming-due/settled) and active/inactive member rows — all
// shaped so the frontend can render them directly without recomputing.
export function buildPenaltyAndMemberDerived({ sync = {}, progress = {}, overrides = {}, settings = {} } = {}) {
  const graph = buildEntityGraph({ sync, progress, overrides, settings });
  // Penalty clock = the Steam refresh that produced the playtime/achievements,
  // taken from the progress payload unless the caller passes one explicitly.
  const penaltyReferenceDate =
    String(settings.penaltyReferenceDate || "").slice(0, 10) ||
    resolvePenaltyReferenceDate({
      progressUpdatedAt: progress?.updatedAt,
      libraryUpdatedAt: progress?.libraryUpdatedAt,
      currentDate: settings.currentDate,
    });
  const ctx = {
    giveaways: graph.giveaways,
    giveawayBySourceId: new Map(graph.giveaways.map((giveaway) => [giveaway.sourceId, giveaway])),
    gamesById: graph.gamesById,
    membersById: graph.membersById,
    syncGiveaways: graph.syncGiveaways,
    currentDate: settings.currentDate || "",
    penaltyReferenceDate,
    penaltyReady: true,
  };

  // Real store art, keyed by appId, taken from the synced giveaway records. The
  // frontend can guess header.jpg from an appId, but that URL 404s for packages
  // and some delisted apps, so ship the URLs the collector actually saw.
  const mediaByAppId = new Map();
  for (const giveaway of sync.giveaways || []) {
    const appId = Number(giveaway?.appId || 0);
    if (!appId || mediaByAppId.has(appId)) {
      continue;
    }
    if (giveaway.headerImageUrl || giveaway.capsuleImageUrl || giveaway.capsuleSmallUrl) {
      mediaByAppId.set(appId, {
        headerImageUrl: giveaway.headerImageUrl || "",
        capsuleImageUrl: giveaway.capsuleImageUrl || "",
        capsuleSmallUrl: giveaway.capsuleSmallUrl || "",
      });
    }
  }
  const mediaFor = (appId) => mediaByAppId.get(Number(appId || 0)) || {};

  const owedNow = [];
  const comingDue = [];
  for (const win of graph.wins) {
    const info = getWinPenaltyInfo(win, ctx);
    if (!info || (info.status !== "overdue" && info.status !== "coming-due")) {
      continue;
    }
    const member = ctx.membersById.get(win.memberId);
    const game = ctx.gamesById.get(win.gameId);
    const row = {
      member: member?.name || win.creatorUsername || "Unknown member",
      memberKey: member ? getStableMemberKey(member) : "",
      game: game?.title || win.title || "",
      // The frontend derives the store art from appId (getSteamMediaUrls), so the
      // penalty tiles look the same on the derived fast path as on the live one.
      appId: Number(game?.appId || 0) || null,
      steamAppUrl: game?.steamAppUrl || "",
      ...mediaFor(game?.appId),
      giveawayUrl: getWinGiveawayUrl(win),
      deadline: info.deadline instanceof Date ? info.deadline.toISOString() : null,
      popMonth: info.popMonth,
      manualWinner: Boolean(win.manualWinner),
      ...penaltyProgressFigures(win, ctx),
    };
    if (info.status === "overdue") {
      row.daysOverdue = info.daysOverdue;
      owedNow.push(row);
    } else {
      row.daysLeft = info.daysLeft;
      comingDue.push(row);
    }
  }
  const byDeadline = (left, right) => new Date(left.deadline || 0).getTime() - new Date(right.deadline || 0).getTime();
  owedNow.sort(byDeadline);
  comingDue.sort(byDeadline);

  const settled = getPenaltyGiveawayRecords(graph.wins, ctx).map((record) => ({
    payer: record.creator?.name || record.giveaway.creatorUsername || "Unknown member",
    game: record.targetGame?.title || record.target?.title || record.giveaway.title || "",
    appId: Number(record.targetGame?.appId || 0) || null,
    steamAppUrl: record.targetGame?.steamAppUrl || "",
    ...mediaFor(record.targetGame?.appId),
    giveawayPageUrl: getGiveawayPageUrl(record.giveaway),
    wonGiveawayUrl: getGiveawayPageUrl(record.target),
    createdAt: record.giveaway.createdAt || null,
    manualWinner: Boolean(record.targetWin?.manualWinner),
    ...penaltyProgressFigures(record.targetWin, ctx),
  }));

  const activeMembers = computeMemberBucketRows(graph.members, graph.wins, ctx, true, "wins");
  const inactiveMembers = computeMemberBucketRows(graph.members, graph.wins, ctx, false, "wins");

  return {
    penalties: {
      referenceDate: penaltyReferenceDate,
      counts: { overdue: owedNow.length, comingDue: comingDue.length, settled: settled.length },
      owedNow,
      comingDue,
      settled,
    },
    members: {
      counts: { active: activeMembers.length, inactive: inactiveMembers.length },
      active: activeMembers,
      inactive: inactiveMembers,
    },
  };
}
