import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import * as derive from "../client/derive-core.js"

test("synced giveaway labels survive classification without manual overrides", () => {
  for (const kind of ["penalty", "pop_free", "extra", "summer_event", "cycle"]) {
    assert.equal(derive.getGiveawayKind({ giveawayKind: kind, type: "sync", title: "Game" }), kind)
  }
  assert.equal(derive.getGiveawayKind({ giveawayKind: " PoP Free " }), "pop_free")
  assert.equal(derive.getGiveawayKind({ type: "penalty" }), "penalty")
  assert.equal(derive.getGiveawayKind({ title: "Penalty GA" }), "penalty")
  assert.equal(derive.getGiveawayKind({ notes: "Summer event" }), "summer_event")
  assert.equal(derive.getGiveawayKind({ type: "sync" }), "cycle")
})

test("manual labels still take precedence over synced labels", () => {
  assert.equal(derive.getGiveawayKind({ giveawayKind: "penalty", giveawayKindOverride: "cycle" }), "cycle")
  assert.equal(derive.getGiveawayKind({ giveawayKind: "cycle", giveawayKindOverride: "penalty" }), "penalty")
})

test("browser classification agrees with the shared calculation core", () => {
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8")
  const context = vm.createContext({ derive })
  for (const name of ["getBaseGiveawayKind", "getGiveawayKind"]) {
    const fn = source.match(new RegExp(`function ${name}\\(giveaway\\) \\{[\\s\\S]*?\\n\\}`))
    assert.ok(fn)
    vm.runInContext(fn[0], context)
  }
  const penalty = { giveawayKind: "penalty", title: "Nivalis Nights", penaltyForCode: "kaiKt" }
  assert.equal(context.getBaseGiveawayKind(penalty), "penalty")
  assert.equal(context.getGiveawayKind(penalty), "penalty")
  assert.equal(context.getGiveawayKind({ ...penalty, giveawayKindOverride: "extra" }), "extra")
})

test("a penalty stays linked and in progress until it ends with a winner", () => {
  const sync = {
    members: [{ username: "Saikania", isActiveMember: true }],
    giveaways: [
      {
        code: "kaiKt", title: "Crimson Desert Enhanced", creatorUsername: "Koalala",
        url: "https://www.steamgifts.com/giveaway/kaiKt/crimson-desert-enhanced",
        appId: 1, giveawayKind: "cycle", endDate: "2026-03-31T16:00:00.000Z",
        winners: [{ username: "Saikania" }], totalAchievements: 30,
      },
      {
        code: "XAkzm", title: "Mewgenics", creatorUsername: "Koalala",
        url: "https://www.steamgifts.com/giveaway/XAkzm/mewgenics",
        appId: 2, giveawayKind: "cycle", endDate: "2026-04-30T16:00:00.000Z",
        winners: [{ username: "Saikania" }], totalAchievements: 100,
      },
      {
        code: "i76qD", title: "Nivalis Nights", creatorUsername: "Saikania",
        url: "https://www.steamgifts.com/giveaway/i76qD/nivalis-nights",
        appId: 1488490, giveawayKind: "penalty", penaltyForCode: "kaiKt",
        startDate: "2026-10-03T08:48:13.000Z", endDate: "2026-10-30T16:00:00.000Z",
        resultStatus: "open", winners: [],
      },
    ],
  }
  const { penalties } = derive.buildPenaltyAndMemberDerived({ sync, settings: { currentDate: "2026-10-03" } })
  assert.equal(penalties.counts.settled, 0)
  assert.equal(penalties.counts.inProgress, 1)
  assert.equal(penalties.inProgress[0].member, "Saikania")
  assert.equal(penalties.inProgress[0].game, "Crimson Desert Enhanced")
  assert.match(penalties.inProgress[0].penaltyGiveaways[0].url, /\/i76qD\//)
  assert.match(penalties.inProgress[0].giveawayUrl, /\/kaiKt\//)
  assert.equal(penalties.counts.overdue, 1)
  assert.equal(penalties.owedNow[0].game, "Mewgenics")

  const penalty = sync.giveaways[2]
  penalty.resultStatus = "awaiting_feedback"
  const awaiting = derive.buildPenaltyAndMemberDerived({ sync, settings: { currentDate: "2026-11-01" } }).penalties
  assert.equal(awaiting.counts.inProgress, 1)
  assert.equal(awaiting.counts.settled, 0)

  penalty.resultStatus = "won"
  penalty.winners = [{ username: "NewWinner" }]
  // A winner accidentally present before closing cannot settle the penalty.
  const early = derive.buildPenaltyAndMemberDerived({ sync, settings: { currentDate: "2026-10-03" } }).penalties
  assert.equal(early.counts.settled, 0)
  const paid = derive.buildPenaltyAndMemberDerived({ sync, settings: { currentDate: "2026-11-01" } }).penalties
  assert.equal(paid.counts.inProgress, 0)
  assert.equal(paid.counts.settled, 1)
  assert.equal(paid.counts.overdue, 1)
  assert.match(paid.settled[0].giveawayPageUrl, /\/i76qD\//)
  assert.match(paid.settled[0].wonGiveawayUrl, /\/kaiKt\//)

  penalty.resultStatus = "no_winners"
  penalty.winners = []
  const failed = derive.buildPenaltyAndMemberDerived({ sync, settings: { currentDate: "2026-11-01" } }).penalties
  assert.equal(failed.counts.inProgress, 0)
  assert.equal(failed.counts.settled, 0)
  assert.equal(failed.counts.overdue, 2)
  assert.equal(failed.owedNow.find(row => row.game === "Crimson Desert Enhanced").penaltyGiveaways[0].status, "no-winner")
})

test("settlement uses giveaway sync time and accepts a recorded manual winner", () => {
  const penalty = { code: "PEN", endDate: "2026-10-03T12:00:00Z", resultStatus: "won", resultLabel: "Winner" }
  assert.equal(derive.getPenaltyGiveawayStatus(penalty, { giveawayReferenceDate: "2026-10-03T13:00:00Z" }), "settled")
  assert.equal(derive.getPenaltyGiveawayStatus(penalty, { giveawayReferenceDate: "2026-10-03T11:00:00Z" }), "in-progress")
  assert.equal(derive.getPenaltyGiveawayStatus({ ...penalty, resultStatus: "awaiting_feedback" }, { currentDate: "2026-10-04" }), "in-progress")
  assert.equal(derive.getPenaltyGiveawayStatus({ ...penalty, resultStatus: "no_winners" }, {
    currentDate: "2026-10-04", overrides: { giveaways: { "sg-PEN": { manualWinners: [{ username: "Winner" }] } } },
  }), "settled")
})
