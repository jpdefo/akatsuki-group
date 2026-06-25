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

  assert.equal(penalties.counts.settled, 1, "exactly one settled");
  assert.equal(penalties.settled[0].payer, "eve");

  // grandfathered / complete / pop_free / paid must NOT appear as owed or coming-due
  const flagged = [...penalties.owedNow, ...penalties.comingDue].map((r) => r.member);
  assert.deepEqual(flagged.sort(), ["dave", "eve"]); // only the OVD(dave) + CDU(eve)
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
