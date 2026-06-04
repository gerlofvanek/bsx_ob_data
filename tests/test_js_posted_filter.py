"""Smoke-test for the (legacy) posted-time / activity-heatmap filter.

The activity-heatmap UI and its posted-time filter were removed when the
Markets page was redesigned around the liquidity heatmap + selected-pair
detail view. The original Node harness exercised ``filterByHour`` /
``getFilteredOffers`` / ``writeHash`` / ``readHash`` / ``clearPostedFilter``,
none of which exist in the new ``app.js``. The legacy implementation lives at
``bsx_orderbook/_legacy/app.js`` for reference; this test is left skipped
rather than deleted so the rollout history stays auditable.
"""
import pytest


@pytest.mark.skip(reason="posted-time filter removed in Markets page redesign")
def test_filter_by_hour_round_trip():
    pass
