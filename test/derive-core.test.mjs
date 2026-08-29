// Unit tests for the shared calculation core (client/derive-core.js).
//
// Why this exists: the precompute (tools/build-derived.mjs) and the browser
// (app.js) must compute the same numbers. For summer-event and membership,
// app.js now calls derive-core directly, so they are identical by construction.
// The penalty/progress engine is the one piece with a faithful *port* (app.js
// keeps its own live copy), so these tests pin derive-core's behavior against
// hand-computed expectations derived from the documented rules — the same rules
// the trusted live logic implements.
//
// Run: npm test   (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSummerEventDerived,
  buildPenaltyAndMemberDerived,
  getEffectiveMemberActive,
  getStableMemberKey,
  computeMinimumEntriesRequired,
  effortScore,
} from "../client/derive-core.js";

// --- helpers to build synthetic sync records -----------------------------

function member(username, isActiveMember, steamProfile = "") {
  return { username, isActiveMember, steamProfile };
}

function giveaway(overrides) {
  return {
    code: "GA",
    title: "Game",
    creatorUsername: "creator",
    appId: 1,
    points: 30,
    entriesCount: 0,
    entryUsers: [],
    winners: [],
    resultStatus: "",
    resultLabel: "",
    giveawayKind: "",
    url: "",
    startDate: "",
    endDate: "",
    ...overrides,
  };
}

function progressEntry(steamProfile, appId, playtimeHours, extra = {}) {
  return {
    steamProfile,
    appId,
    playtimeHours,
    earnedAchievements: 0,
    totalAchievements: 0,
    visible: true,
    ...extra,
  };
}

// =========================================================================
// Summer event
// =========================================================================

test("summer-event standings: base points, swing, entry costs", () => {
  // 2026 ruleset: base 30P -> swing 10. Creator alice runs a 30P giveaway won by
  // bob with entrants [bob, carol].
  //   alice (creator): +30 base, +2*10 entry bonus  => balance 50, created 30
  //   bob   (winner) : won 30 base (not added to balance); entrant => -10
  //   carol (entrant): -10
  const sync = {
    members: [member("alice", true), member("bob", true), member("carol", true)],
    giveaways: [
      giveaway({
        code: "S1",
        creatorUsername: "alice",
        points: 30,
        winners: [{ username: "bob" }],
        entryUsers: ["bob", "carol"],
        resultStatus: "won",
        giveawayKind: "summer_event",
        endDate: "2026-05-10T00:00:00.000Z",
      }),
    ],
  };
  const { periods } = buildSummerEventDerived({
    giveaways: sync.giveaways,
    members: [],
    syncMembers: sync.members,
    overrides: {},
    settings: { summerRuleset: "auto", currentDate: "2026-06-15" },
    now: Date.parse("2026-06-15T00:00:00.000Z"),
  });
  assert.equal(periods.length, 1);
  const standings = Object.fromEntries(periods[0].standings.map((s) => [s.username, s]));
  assert.equal(standings.alice.balance, 50);
  assert.equal(standings.alice.createdPoints, 30);
  assert.equal(standings.alice.entryBonusPoints, 20);
  assert.equal(standings.bob.wonPoints, 30);
  assert.equal(standings.bob.balance, -10);
  assert.equal(standings.carol.balance, -10);
});

test("summer-event: a giveaway with no entries awards no points (both rulesets)", () => {
  // alice runs a 50P giveaway that nobody entered. She must earn 0 points from it
  // (no base, no entry bonus) and the per-giveaway total must be 0 — under either
  // ruleset, since the no-entry rule is ruleset-agnostic. The giveaway still
  // counts as created.
  const sync = {
    members: [member("alice", true)],
    giveaways: [
      giveaway({
        code: "EMPTY",
        creatorUsername: "alice",
        points: 50,
        winners: [],
        entryUsers: [],
        resultStatus: "",
        giveawayKind: "summer_event",
        endDate: "2026-05-10T00:00:00.000Z",
      }),
    ],
  };
  for (const summerRuleset of ["legacy", "2026", "auto"]) {
    const { periods } = buildSummerEventDerived({
      giveaways: sync.giveaways,
      members: [],
      syncMembers: sync.members,
      overrides: {},
      settings: { summerRuleset, currentDate: "2026-06-15" },
      now: Date.parse("2026-06-15T00:00:00.000Z"),
    });
    const alice = periods[0].standings.find((s) => s.username === "alice");
    assert.equal(alice.balance, 0, `[${summerRuleset}] no-entry giveaway: zero balance`);
    assert.equal(alice.createdPoints, 0, `[${summerRuleset}] no-entry giveaway: zero created points`);
    assert.equal(alice.entryBonusPoints, 0, `[${summerRuleset}] no-entry giveaway: zero entry bonus`);
    assert.equal(alice.createdGiveaways, 1, `[${summerRuleset}] still counts as created`);
    assert.equal(periods[0].giveaways[0].totalPoints, 0, `[${summerRuleset}] per-giveaway total is 0`);
  }
});

test("summer-event active/finished classification", () => {
  const now = Date.parse("2026-06-15T00:00:00.000Z");
  const sync = {
    members: [member("alice", true)],
    giveaways: [
      giveaway({ code: "PAST", creatorUsername: "alice", giveawayKind: "summer_event", resultStatus: "won", winners: [{ username: "alice" }], endDate: "2026-05-10T00:00:00.000Z" }),
      giveaway({ code: "LIVE", creatorUsername: "alice", giveawayKind: "summer_event", endDate: "2026-12-01T00:00:00.000Z" }),
    ],
  };
  const { periods } = buildSummerEventDerived({
    giveaways: sync.giveaways,
    members: [],
    syncMembers: sync.members,
    overrides: {},
    settings: { summerRuleset: "auto", currentDate: "2026-06-15" },
    now,
  });
  const period = periods.find((p) => p.year === 2026);
  assert.equal(period.counts.activeGiveaways, 1);
  assert.equal(period.counts.finishedGiveaways, 1);
  assert.equal(period.giveaways.find((g) => g.code === "LIVE").active, true);
  assert.equal(period.giveaways.find((g) => g.code === "PAST").active, false);
});

// =========================================================================
// Membership
// =========================================================================

test("membership: override-applied active flag + Rule-9 threshold", () => {
  const members = [
    member("m1", true),
    member("m2", true),
    member("m3", true),
    member("m4", true), // overridden inactive
    member("m5", false), // overridden active
  ];
  const overrides = {
    members: {
      [getStableMemberKey({ steamgiftsUsername: "m4" })]: { membershipStatus: "inactive" },
      [getStableMemberKey({ steamgiftsUsername: "m5" })]: { membershipStatus: "active" },
    },
  };
  const syncActive = members.filter((m) => m.isActiveMember).length;
  const effectiveActive = members.filter((m) =>
    getEffectiveMemberActive({ steamgiftsUsername: m.username, isActiveMember: m.isActiveMember }, overrides),
  ).length;

  assert.equal(syncActive, 4); // raw synced actives -> drives the threshold
  assert.equal(effectiveActive, 4); // m1,m2,m3 + m5(on) - m4(off)
  assert.equal(computeMinimumEntriesRequired(syncActive), 1); // floor(4*0.1)=0 -> min 1
  assert.equal(computeMinimumEntriesRequired(23), 2); // floor(23*0.1)=2 (matches live data)
});

// =========================================================================
// Penalty engine ("who needs to pay")
// =========================================================================

test("penalties: overdue / coming-due / grandfathered / complete / paid / pop_free-exempt", () => {
  const currentDate = "2026-06-15"; // ref date for deadline comparison
  const sync = {
    members: [member("dave", true, "p-dave"), member("eve", true, "p-eve")],
    giveaways: [
      // dave, Jan 2026, 5h of a 100h game (req 25h) -> below, no penalty GA -> OVERDUE (deadline Jun 1)
      giveaway({ code: "OVD", creatorUsername: "eve", appId: 100, winners: [{ username: "dave" }], startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-01-10T00:00:00.000Z" }),
      // eve, Feb 2026, below -> COMING-DUE (deadline Jul 1, after ref)
      giveaway({ code: "CDU", creatorUsername: "dave", appId: 200, winners: [{ username: "eve" }], startDate: "2026-02-05T00:00:00.000Z", endDate: "2026-02-10T00:00:00.000Z" }),
      // dave, Dec 2025, below -> GRANDFATHERED (before tracking start)
      giveaway({ code: "GFD", creatorUsername: "eve", appId: 300, winners: [{ username: "dave" }], startDate: "2025-12-05T00:00:00.000Z", endDate: "2025-12-10T00:00:00.000Z" }),
      // eve, Jan 2026, 90h -> COMPLETE
      giveaway({ code: "CMP", creatorUsername: "dave", appId: 400, winners: [{ username: "eve" }], startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-01-10T00:00:00.000Z" }),
      // dave, Jan 2026, below, but tagged pop_free -> EXEMPT
      giveaway({ code: "POF", creatorUsername: "eve", appId: 500, winners: [{ username: "dave" }], startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-01-10T00:00:00.000Z" }),
      // eve, Jan 2026, below, but a penalty GA is attached -> PAID
      giveaway({ code: "PAD", creatorUsername: "dave", appId: 600, winners: [{ username: "eve" }], startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-01-10T00:00:00.000Z" }),
      // the penalty giveaway that settles PAD (kind via override below)
      giveaway({ code: "PEN", creatorUsername: "eve", appId: 700, penaltyForCode: "PAD", startDate: "2026-03-01T00:00:00.000Z", endDate: "2026-03-02T00:00:00.000Z" }),
      // legacy penalty giveaway with no "Penalty GA - <link>" target -> NOT settled
      giveaway({ code: "LGC", creatorUsername: "eve", appId: 800, startDate: "2024-03-01T00:00:00.000Z", endDate: "2024-03-02T00:00:00.000Z" }),
    ],
  };
  const progress = {
    progress: [
      progressEntry("p-dave", 100, 5),
      progressEntry("p-eve", 200, 5),
      progressEntry("p-dave", 300, 5),
      progressEntry("p-eve", 400, 90),
      progressEntry("p-dave", 500, 5),
      progressEntry("p-eve", 600, 5),
    ],
    hltb: [100, 200, 300, 400, 500, 600, 700].map((appId) => ({ appId, hltbHours: 100 })),
  };
  const overrides = {
    giveaways: {
      "sg-POF": { giveawayKindOverride: "pop_free" },
      "sg-PEN": { giveawayKindOverride: "penalty" },
      "sg-LGC": { giveawayKindOverride: "penalty" },
    },
  };

  const { penalties } = buildPenaltyAndMemberDerived({ sync, progress, overrides, settings: { currentDate } });

  assert.equal(penalties.counts.overdue, 1, "exactly one overdue");
  assert.equal(penalties.owedNow[0].member, "dave");
  assert.equal(penalties.owedNow[0].game, "Game");
  assert.equal(penalties.owedNow[0].currentHours, 5);
  assert.equal(penalties.owedNow[0].requiredHours, 25);

  assert.equal(penalties.counts.comingDue, 1, "exactly one coming-due");
  assert.equal(penalties.comingDue[0].member, "eve");

  assert.equal(penalties.counts.settled, 1, "exactly one settled (unlinked legacy LGC excluded)");
  assert.equal(penalties.settled[0].payer, "eve");
  // Both links: the created penalty GA and the won GA it pays off (via penaltyForCode)
  assert.match(penalties.settled[0].giveawayPageUrl, /\/giveaway\/PEN\//);
  assert.match(penalties.settled[0].wonGiveawayUrl, /\/giveaway\/PAD\//);

  // grandfathered / complete / pop_free / paid must NOT appear as owed or coming-due
  const flagged = [...penalties.owedNow, ...penalties.comingDue].map((r) => r.member);
  assert.deepEqual(flagged.sort(), ["dave", "eve"]); // only the OVD(dave) + CDU(eve)
});

test("penalties: the clock runs off the Steam refresh, not the SteamGifts sync", () => {
  // A win whose deadline is Jun 1 2026. The SteamGifts sync is from Jun 15 (past
  // the deadline), but the playtime/achievements were last refreshed on May 20 —
  // and those are what the penalty is judged on. So as far as the data goes the
  // win is still coming due (12 days left), not overdue.
  const sync = {
    members: [member("dave", true, "p-dave")],
    giveaways: [
      giveaway({ code: "OVD", creatorUsername: "x", appId: 100, winners: [{ username: "dave" }], startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-01-10T00:00:00.000Z" }),
    ],
  };
  const progress = {
    updatedAt: "2026-05-20T04:00:00.000Z",
    progress: [progressEntry("p-dave", 100, 5)],
    hltb: [{ appId: 100, hltbHours: 100 }],
  };

  const { penalties } = buildPenaltyAndMemberDerived({
    sync,
    progress,
    overrides: {},
    settings: { currentDate: "2026-06-15" },
  });
  assert.equal(penalties.referenceDate, "2026-05-20", "reference date comes from the progress refresh");
  assert.equal(penalties.counts.overdue, 0);
  assert.equal(penalties.counts.comingDue, 1);
  // ~12 days May 20 -> Jun 1; the exact rounding depends on the local timezone
  // (parseDate anchors at local noon), so pin the range, not the digit.
  assert.ok([11, 12].includes(penalties.comingDue[0].daysLeft), `daysLeft ${penalties.comingDue[0].daysLeft}`);

  // A newer library (playtime) refresh wins over an older progress refresh, and
  // pushes the same win past its deadline.
  const later = buildPenaltyAndMemberDerived({
    sync,
    progress: { ...progress, libraryUpdatedAt: "2026-06-10T04:00:00.000Z" },
    overrides: {},
    settings: { currentDate: "2026-06-15" },
  });
  assert.equal(later.penalties.referenceDate, "2026-06-10");
  assert.equal(later.penalties.counts.overdue, 1);
  assert.ok([9, 10].includes(later.penalties.owedNow[0].daysOverdue), `daysOverdue ${later.penalties.owedNow[0].daysOverdue}`); // Jun 1 -> Jun 10

  // No Steam refresh recorded at all: fall back to the SteamGifts sync date.
  const fallback = buildPenaltyAndMemberDerived({
    sync,
    progress: { progress: progress.progress, hltb: progress.hltb },
    overrides: {},
    settings: { currentDate: "2026-06-15" },
  });
  assert.equal(fallback.penalties.referenceDate, "2026-06-15");
  assert.equal(fallback.penalties.counts.overdue, 1);
});

test("penalties: member bucket rows (wins, playtime, threshold-met)", () => {
  const currentDate = "2026-06-15";
  const sync = {
    members: [member("dave", true, "p-dave")],
    giveaways: [
      giveaway({ code: "A", creatorUsername: "x", appId: 100, winners: [{ username: "dave" }], startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-01-10T00:00:00.000Z" }),
      giveaway({ code: "B", creatorUsername: "x", appId: 200, winners: [{ username: "dave" }], startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-01-10T00:00:00.000Z" }),
    ],
  };
  const progress = {
    progress: [progressEntry("p-dave", 100, 5), progressEntry("p-dave", 200, 90)],
    hltb: [{ appId: 100, hltbHours: 100 }, { appId: 200, hltbHours: 100 }],
  };
  const { members } = buildPenaltyAndMemberDerived({ sync, progress, overrides: {}, settings: { currentDate } });
  const dave = members.active.find((m) => m.name === "dave");
  assert.equal(dave.totalWins, 2);
  assert.equal(dave.totalPlaytime, 95); // 5 + 90
  assert.equal(dave.thresholdMet, 1); // only the 90h win meets 25% of 100h
});

test("manual winner wins inherit Steam playtime/achievements (pre-release winner snapshot)", () => {
  // Pre-release game: the giveaway has no synced winner yet, so an admin sets the
  // winner manually. That manual win is rebuilt after the progress merge, so it
  // must still pick up the member's real playtime/achievements — otherwise it
  // shows 0h / 0 achievements and gets wrongly flagged for a penalty.
  const currentDate = "2026-06-15";
  const sync = {
    members: [member("frank", true, "p-frank")],
    giveaways: [
      // Jan 2026 win, no synced winner; if treated as 0h it would be OVERDUE.
      giveaway({ code: "MAN", creatorUsername: "x", appId: 800, winners: [], startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-01-10T00:00:00.000Z" }),
    ],
  };
  const progress = {
    progress: [progressEntry("p-frank", 800, 90, { earnedAchievements: 6, totalAchievements: 42 })],
    hltb: [{ appId: 800, hltbHours: 100 }],
  };
  const overrides = { giveaways: { "sg-MAN": { manualWinners: [{ username: "frank" }] } } };

  const { penalties, members } = buildPenaltyAndMemberDerived({ sync, progress, overrides, settings: { currentDate } });

  // The manual win counts like any other win and reflects real progress.
  const frank = members.active.find((m) => m.name === "frank");
  assert.equal(frank.totalWins, 1, "manual winner produces a win");
  assert.equal(frank.totalPlaytime, 90, "real Steam playtime merged onto the manual win");
  assert.equal(frank.thresholdMet, 1, "90h of a 100h game + 6/42 achievements meets threshold");

  // Threshold met => not flagged for a penalty (would be overdue if it read 0h).
  const flagged = [...penalties.owedNow, ...penalties.comingDue].map((r) => r.member);
  assert.equal(flagged.includes("frank"), false, "compliant manual winner is not penalised");
});

test("summer-event wins count under July for PoP, even when gifted in June", () => {
  // Rule: every summer-event win belongs to July for PoP/penalty tracking, even
  // the ones gifted in June. The June win's penalty deadline must therefore be
  // computed from July (2026-07), not June.
  const currentDate = "2026-08-15";
  const sync = {
    members: [member("gwen", true, "p-gwen")],
    giveaways: [
      // Summer-event giveaway gifted in June 2026, below threshold (5h of 100h).
      giveaway({
        code: "SUM",
        creatorUsername: "x",
        appId: 900,
        winners: [{ username: "gwen" }],
        startDate: "2026-06-05T00:00:00.000Z",
        endDate: "2026-06-10T00:00:00.000Z",
      }),
    ],
  };
  const progress = {
    progress: [progressEntry("p-gwen", 900, 5)],
    hltb: [{ appId: 900, hltbHours: 100 }],
  };
  const overrides = { giveaways: { "sg-SUM": { giveawayKindOverride: "summer_event" } } };

  const { penalties } = buildPenaltyAndMemberDerived({ sync, progress, overrides, settings: { currentDate } });

  const row = [...penalties.owedNow, ...penalties.comingDue].find((r) => r.member === "gwen");
  assert.ok(row, "the June-gifted summer-event win is tracked for a penalty");
  assert.equal(row.popMonth, "2026-07", "summer-event win counts under July, not June");
});

test("threshold met is permanent: a latched win stays met even when now below required", () => {
  // HLTB 100 => required 25h, but dave only has 5h logged. A popThresholdMetAt
  // latch (stamped when he genuinely met it earlier) keeps the win "met" even
  // though the required hours later grew past his playtime.
  const currentDate = "2026-06-15";
  const sync = {
    members: [member("dave", true, "p-dave")],
    giveaways: [
      giveaway({ code: "A", creatorUsername: "x", appId: 100, winners: [{ username: "dave" }], startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-01-10T00:00:00.000Z" }),
    ],
  };
  const hltb = [{ appId: 100, hltbHours: 100 }];

  const latched = buildPenaltyAndMemberDerived({
    sync,
    progress: { progress: [progressEntry("p-dave", 100, 5, { popThresholdMetAt: "2026-02-01T00:00:00.000Z" })], hltb },
    overrides: {},
    settings: { currentDate },
  });
  assert.equal(latched.members.active.find((m) => m.name === "dave").thresholdMet, 1, "latched win counts as met despite 5h < 25h required");
  assert.equal(latched.penalties.owedNow.concat(latched.penalties.comingDue).some((r) => r.member === "dave"), false, "latched win is not penalised");

  // Control: identical data without the latch is below threshold.
  const control = buildPenaltyAndMemberDerived({
    sync,
    progress: { progress: [progressEntry("p-dave", 100, 5)], hltb },
    overrides: {},
    settings: { currentDate },
  });
  assert.equal(control.members.active.find((m) => m.name === "dave").thresholdMet, 0, "without the latch, 5h < 25h is below threshold");
});

test("manual completion override is per-win and preserves the normal achievement target", () => {
  const currentDate = "2026-06-15";
  const sync = {
    members: [member("dave", true, "p-dave"), member("eve", true, "p-eve")],
    giveaways: [
      giveaway({ code: "A", creatorUsername: "x", appId: 100, winners: [{ username: "dave" }], startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-01-10T00:00:00.000Z" }),
      giveaway({ code: "B", creatorUsername: "x", appId: 100, winners: [{ username: "eve" }], startDate: "2026-01-05T00:00:00.000Z", endDate: "2026-01-10T00:00:00.000Z" }),
    ],
  };
  const progress = {
    progress: [
      progressEntry("p-dave", 100, 5, { totalAchievements: 7 }),
      progressEntry("p-eve", 100, 25, { totalAchievements: 7 }),
    ],
    hltb: [{ appId: 100, hltbHours: 100 }],
  };
  const derived = buildPenaltyAndMemberDerived({
    sync,
    progress,
    overrides: { wins: { "sg-win-A-dave": { completionOverride: true } } },
    settings: { currentDate },
  });

  const active = Object.fromEntries(derived.members.active.map((row) => [row.name, row]));
  assert.equal(active.dave.thresholdMet, 1, "the manually completed win counts as met");
  assert.equal(active.eve.thresholdMet, 0, "another player still has to earn the one-achievement target");
});

// =========================================================================
// Scoreboard effort bands
// =========================================================================

test("scoreboard: effort bands, the fresh grace bucket, and per-year buckets", () => {
  // Ref date sits inside the 4-month penalty grace for the Jun 2026 wins but
  // past it for the Jan 2026 one, which is what separates "below" from "fresh".
  const currentDate = "2026-07-15";
  const hundredHourGame = (appId) => ({ appId, hltbHours: 100 });
  const sync = {
    members: [member("dave", true, "p-dave")],
    giveaways: [
      // 2024, 5h of 100h, no achievements -> BELOW (deadline long past)
      giveaway({ code: "OLD", appId: 100, winners: [{ username: "dave" }], startDate: "2024-03-01T00:00:00.000Z", endDate: "2024-03-05T00:00:00.000Z" }),
      // 2025, 30h -> passes the 25% threshold, completion 0.30 -> AT MINIMUM
      giveaway({ code: "MIN", appId: 200, winners: [{ username: "dave" }], startDate: "2025-03-01T00:00:00.000Z", endDate: "2025-03-05T00:00:00.000Z" }),
      // 2025, 50h -> completion 0.50 -> ABOVE
      giveaway({ code: "ABV", appId: 300, winners: [{ username: "dave" }], startDate: "2025-04-01T00:00:00.000Z", endDate: "2025-04-05T00:00:00.000Z" }),
      // 2025, 80h + 8/10 achievements -> both measures deep -> WELL ABOVE
      giveaway({ code: "WEL", appId: 400, winners: [{ username: "dave" }], startDate: "2025-05-01T00:00:00.000Z", endDate: "2025-05-05T00:00:00.000Z" }),
      // 2025, every achievement earned -> COMPLETE
      giveaway({ code: "CMP", appId: 500, winners: [{ username: "dave" }], startDate: "2025-06-01T00:00:00.000Z", endDate: "2025-06-05T00:00:00.000Z" }),
      // Jun 2026, unplayed, still inside the 4-month grace -> FRESH, not below
      giveaway({ code: "NEW", appId: 600, winners: [{ username: "dave" }], startDate: "2026-06-01T00:00:00.000Z", endDate: "2026-06-05T00:00:00.000Z" }),
      // Jun 2026 but already played through -> grace must NOT steal a real band
      giveaway({ code: "NWP", appId: 700, winners: [{ username: "dave" }], startDate: "2026-06-01T00:00:00.000Z", endDate: "2026-06-05T00:00:00.000Z" }),
    ],
  };
  const progress = {
    progress: [
      progressEntry("p-dave", 100, 5),
      progressEntry("p-dave", 200, 30),
      progressEntry("p-dave", 300, 50),
      progressEntry("p-dave", 400, 80, { earnedAchievements: 8, totalAchievements: 10 }),
      progressEntry("p-dave", 500, 10, { earnedAchievements: 10, totalAchievements: 10 }),
      progressEntry("p-dave", 600, 0),
      progressEntry("p-dave", 700, 90, { earnedAchievements: 9, totalAchievements: 10 }),
    ],
    hltb: [100, 200, 300, 400, 500, 600, 700].map(hundredHourGame),
  };

  const { members } = buildPenaltyAndMemberDerived({ sync, progress, overrides: {}, settings: { currentDate } });
  const dave = members.active.find((row) => row.name === "dave");

  assert.deepEqual(
    dave.bands,
    { below: 1, minimum: 1, above: 1, "well-above": 2, complete: 1, fresh: 1 },
    "one win in each band, the unplayed 2026 win held in fresh",
  );
  assert.equal(dave.totalWins, 7);

  // Fresh only ever drains "below": a recent win that was actually played keeps
  // the band it earned.
  assert.equal(dave.years["2026"].bands.fresh, 1);
  assert.equal(dave.years["2026"].bands["well-above"], 1);
  assert.equal(dave.years["2026"].bands.below, undefined, "a played 2026 win is not fresh");

  // Year buckets mirror the top-level stat fields and partition the wins.
  assert.deepEqual(Object.keys(dave.years).sort(), ["2024", "2025", "2026"]);
  assert.equal(dave.years["2024"].totalWins, 1);
  assert.equal(dave.years["2025"].totalWins, 4);
  assert.equal(dave.years["2026"].totalWins, 2);
  assert.equal(
    Object.values(dave.years).reduce((sum, year) => sum + year.totalWins, 0),
    dave.totalWins,
    "years partition the member's wins",
  );

  // effortScore: 4 of 6 judged wins (above, well-above x2, complete) reached at
  // least "above"; the fresh win is excluded from the denominator entirely.
  assert.equal(Math.round(effortScore(dave.bands) * 100), 67);
  assert.equal(effortScore({ fresh: 3 }), null, "nothing judged yet has no score");
  assert.equal(effortScore(undefined), null);
});
