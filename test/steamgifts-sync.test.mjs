import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { getGiveawayMonth } from "../client/derive-core.js"

const source = readFileSync(new URL("../akatsuki-steamgifts-sync.user.js", import.meta.url), "utf8")
const savedSync = JSON.parse(readFileSync(new URL("../data/steamgifts-sync.json", import.meta.url)))
const oldenEra = savedSync.giveaways.find((giveaway) => giveaway.code === "R91uQ")

function collector() {
  const context = vm.createContext({ window: { location: { pathname: "/group/7Ypot/akatsukigamessteamgifts", origin: "https://www.steamgifts.com" } } })
  const exposed = source.replace("  addPanel();", "").replace(/\}\)\(\);\s*$/, `
    globalThis.collector = {
      needsGiveawayDetails, detectGiveawayMonthOverride, mergeGiveawayWithExisting,
      candidates: getGiveawaysForDetailRefresh,
    }
  })()`)
  vm.runInContext(exposed, context)
  return context.collector
}

test("completed legacy giveaway still needs its missing description month checked", () => {
  const legacy = { ...oldenEra }
  delete legacy.giveawayMonthOverride
  assert.equal(collector().needsGiveawayDetails(legacy), true)
})

test("partial sync includes historical giveaways missing a description month, without duplicates", () => {
  const api = collector()
  const legacy = { ...oldenEra }
  delete legacy.giveawayMonthOverride
  const recent = { ...legacy, code: "NEW", title: "New row" }
  const candidates = api.candidates([recent], [legacy, { ...recent, title: "Old row" }])
  assert.equal(candidates.length, 2)
  assert.equal(candidates.find((item) => item.code === "R91uQ")?.code, "R91uQ")
  assert.equal(candidates.find((item) => item.code === "NEW")?.title, "New row")
})

test("April description wins over May end date and survives list-row merging", () => {
  const api = collector()
  const month = api.detectGiveawayMonthOverride("April giveaway\nSecond try", oldenEra.endDate, "")
  assert.equal(month, "2026-04")
  const refreshed = { ...oldenEra, giveawayMonthOverride: month }
  const merged = api.mergeGiveawayWithExisting({ code: "R91uQ", endDate: oldenEra.endDate }, refreshed)
  assert.equal(getGiveawayMonth(merged), "2026-04")
  assert.equal(api.needsGiveawayDetails(merged), false)
})

test("a checked empty month falls back to end date without repeated refreshes", () => {
  const api = collector()
  for (const description of ["Enjoy!", "April and May giveaway"]) {
    const month = api.detectGiveawayMonthOverride(description, oldenEra.endDate, "")
    assert.equal(month, "")
    const checked = { ...oldenEra, giveawayMonthOverride: month }
    assert.equal(api.needsGiveawayDetails(checked), false)
    assert.equal(getGiveawayMonth({ ...checked, createdAt: checked.endDate }), "2026-05")
    assert.equal(api.candidates([], [checked]).length, 0)
  }
})

test("explicit non-cycle kinds do not need a cycle month", () => {
  const api = collector()
  for (const kind of ["extra", "penalty", "pop_free", "summer_event"]) {
    const other = { ...oldenEra, giveawayKind: kind, entriesFinalized: true }
    delete other.giveawayMonthOverride
    assert.equal(api.detectGiveawayMonthOverride("April giveaway", other.endDate, kind), "")
    assert.equal(api.needsGiveawayDetails(other), false)
  }
})

test("verified Olden Era snapshot counts toward April", () => {
  assert.equal(getGiveawayMonth({ ...oldenEra, createdAt: oldenEra.endDate }), "2026-04")
})
