#!/usr/bin/env python3
"""Compare two orderbook snapshots (e.g. consecutive CI runs) and report offer
churn: how many offers are stable, newly appeared, or disappeared, split by
whether the disappeared ones had actually expired. High "vanished while still
active" counts mean the scrape window is missing offers, not that the market
moved.

Usage: python scripts/diff_snapshots.py old_orderbook.json new_orderbook.json
"""
import json
import sys


def load(path):
    with open(path) as f:
        return json.load(f)


def offer_map(snap):
    return {o["msg_id"]: o for o in snap.get("offers", []) if o.get("msg_id")}


def main(old_path, new_path):
    old, new = load(old_path), load(new_path)
    old_offers, new_offers = offer_map(old), offer_map(new)
    new_ts = new.get("timestamp", 0)

    stable = old_offers.keys() & new_offers.keys()
    appeared = new_offers.keys() - old_offers.keys()
    vanished = old_offers.keys() - new_offers.keys()
    vanished_active = [
        m for m in vanished
        if (old_offers[m].get("timestamp", 0) + old_offers[m].get("time_valid", 0)) > new_ts
    ]

    old_n, new_n = len(old_offers), len(new_offers)
    print(f"old: {old_n} offers ({old.get('updated_at', '?')})")
    print(f"new: {new_n} offers ({new.get('updated_at', '?')})")
    print(f"stable:    {len(stable):4d}  ({100 * len(stable) / max(1, old_n):.1f}% of old)")
    print(f"appeared:  {len(appeared):4d}")
    print(f"vanished:  {len(vanished):4d}  "
          f"(of which still active: {len(vanished_active)})")
    if vanished_active:
        print("\nStill-active offers missing from the new snapshot "
              "(scrape window likely too short or peer incomplete):")
        for m in sorted(vanished_active)[:20]:
            o = old_offers[m]
            print(f"  {m[:24]}…  {o.get('coin_from')}->{o.get('coin_to')}"
                  f"  {o.get('amount_from_str')}  maker={o.get('addr_from', '')[:14]}")
        if len(vanished_active) > 20:
            print(f"  … and {len(vanished_active) - 20} more")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    sys.exit(main(sys.argv[1], sys.argv[2]))
