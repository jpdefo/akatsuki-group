"""Regression tests for summer-event base-point freezing.

Run with stdlib only (no pytest dependency):

    python test_store_price_freeze.py

The rule under test: the first enrichment after a giveaway is finalized
(``entriesFinalized``) captures the current price and locks it
(``steamPriceFrozen``). Every later enrichment reuses that frozen price, so a
later Steam price change never retroactively alters the points it awarded.
Before finalization the current price applies on every enrichment.
"""

import unittest

import server


def _price_cache(points):
    return {
        "items": {
            "app:12345": {
                "checkedAt": "2026-06-01T00:00:00+00:00",
                "currency": "USD",
                "listPriceCents": points * 100,
                "finalPriceCents": points * 100,
                "pricePoints": points,
            }
        }
    }


def _giveaway(**overrides):
    base = {
        "steamAppUrl": "https://store.steampowered.com/app/12345",
        "giveawayKind": "summer_event",
        "points": 50,
    }
    base.update(overrides)
    return base


class StorePriceFreezeTests(unittest.TestCase):
    def test_locked_price_is_frozen(self):
        giveaway = _giveaway(
            entriesFinalized=True,
            steamPriceFrozen=True,
            steamPriceChecked=True,
            steamPricePoints=30,
        )
        # Cache now says the game is cheaper (10), but the price is locked at 30.
        result = server.with_giveaway_store_price(giveaway, _price_cache(10))
        self.assertEqual(result["steamPricePoints"], 30)
        self.assertTrue(result["steamPriceFrozen"])

    def test_not_finalized_reapplies_current_price(self):
        giveaway = _giveaway(
            entriesFinalized=False,
            steamPriceChecked=True,
            steamPricePoints=30,
        )
        result = server.with_giveaway_store_price(giveaway, _price_cache(10))
        self.assertEqual(result["steamPricePoints"], 10)
        self.assertNotIn("steamPriceFrozen", result)

    def test_finalizing_captures_current_price_and_locks(self):
        # First enrichment after finalization: record the current price (15) and
        # lock it, even if an older price (30) was captured while live.
        giveaway = _giveaway(
            entriesFinalized=True,
            steamPriceChecked=True,
            steamPricePoints=30,
        )
        result = server.with_giveaway_store_price(giveaway, _price_cache(15))
        self.assertEqual(result["steamPricePoints"], 15)
        self.assertTrue(result["steamPriceFrozen"])

    def test_finalized_without_price_locks_last_captured(self):
        # Finalized, a price was captured while live, but no fresh price is
        # available now (no resolvable store id, so no lookup): lock the last
        # captured price.
        giveaway = _giveaway(
            steamAppUrl="",
            entriesFinalized=True,
            steamPriceChecked=True,
            steamPricePoints=22,
        )
        result = server.with_giveaway_store_price(giveaway, {"items": {}})
        self.assertEqual(result["steamPricePoints"], 22)
        self.assertTrue(result["steamPriceFrozen"])


if __name__ == "__main__":
    unittest.main()
