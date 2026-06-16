"""Regression tests for summer-event base-point freezing.

Run with stdlib only (no pytest dependency):

    python test_store_price_freeze.py

The rule under test: once a summer-event giveaway has its final snapshot
captured (``entriesFinalized``), its base points are frozen to the price
recorded at that snapshot, so a later Steam price change never retroactively
alters the points it awarded. Before the snapshot, the current price applies
and is captured at the moment the snapshot is taken.
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
    def test_finalized_with_captured_price_is_frozen(self):
        giveaway = _giveaway(
            entriesFinalized=True,
            steamPriceChecked=True,
            steamPricePoints=30,
        )
        # Cache now says the game is cheaper (10), but the snapshot was 30.
        result = server.with_giveaway_store_price(giveaway, _price_cache(10))
        self.assertEqual(result["steamPricePoints"], 30)

    def test_not_finalized_reapplies_current_price(self):
        giveaway = _giveaway(
            entriesFinalized=False,
            steamPriceChecked=True,
            steamPricePoints=30,
        )
        result = server.with_giveaway_store_price(giveaway, _price_cache(10))
        self.assertEqual(result["steamPricePoints"], 10)

    def test_finalized_without_captured_price_captures_at_snapshot(self):
        # Finalized but no price captured yet: fall through and record the
        # current price so it can then be frozen.
        giveaway = _giveaway(entriesFinalized=True)
        result = server.with_giveaway_store_price(giveaway, _price_cache(15))
        self.assertTrue(result["steamPriceChecked"])
        self.assertEqual(result["steamPricePoints"], 15)


if __name__ == "__main__":
    unittest.main()
