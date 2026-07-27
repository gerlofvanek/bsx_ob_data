#!/usr/bin/env python3
"""Print BasicSwap market stats to stdout (terminal-friendly).

Usage:
    python scripts/bsx_stats.py
    python scripts/bsx_stats.py orderbook.json
    python scripts/bsx_stats.py orderbook.json --pair BTC-LTC
    python scripts/bsx_stats.py orderbook.json | grep XMR/BTC
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from scripts.plain_stats import (  # noqa: E402
    build_stats_txt,
    fetch_prices,
    get_bids_asks,
    live_offers,
    pair_key,
    pair_spread,
    spread_word,
    top_pairs,
    fiat_compact,
)


def render_pair_detail(book: dict, base: str, quote: str, prices: dict) -> str:
    offers = live_offers(book)
    pair_offers = [
        o for o in offers
        if (o.get("coin_from") == base and o.get("coin_to") == quote)
        or (o.get("coin_from") == quote and o.get("coin_to") == base)
    ]
    if not pair_offers:
        return f"{base}/{quote}\n\n(no live offers for this pair)\n"

    from scripts.plain_stats import offer_usd  # noqa: E402

    liq = sum(offer_usd(o, prices) for o in pair_offers)
    sp = pair_spread(offers, base, quote)
    lines = [
        f"{base} / {quote}",
        "",
        f"liquidity   {fiat_compact(liq)}",
        f"live offers {len(pair_offers)}",
    ]
    bids, asks = get_bids_asks(offers, base, quote)
    if bids:
        lines.append(f"best bid    {bids[0]:.8f} {quote}")
    if asks:
        lines.append(f"best ask    {asks[0]:.8f} {quote}")
    if sp is not None:
        lines.append(f"spread      {spread_word(sp)} · {sp:.2f}%")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Print plain market stats to stdout")
    p.add_argument("orderbook", nargs="?", default="orderbook.json")
    p.add_argument("--health", default="health.json")
    p.add_argument("--manifest", default="snapshots/manifest.json")
    p.add_argument("--pair", help="Show detail for one pair (e.g. BTC-LTC or XMR/BTC)")
    p.add_argument("--no-prices", action="store_true")
    args = p.parse_args(argv)

    if not os.path.isfile(args.orderbook):
        print(f"error: {args.orderbook} not found", file=sys.stderr)
        return 1

    with open(args.orderbook, encoding="utf-8") as f:
        book = json.load(f)

    prices = {} if args.no_prices else fetch_prices()
    now = int(time.time())

    if args.pair:
        raw = args.pair.strip().upper()
        sep = "/" if "/" in raw else "-"
        parts = raw.split(sep, 1)
        if len(parts) != 2:
            print("error: --pair must look like BTC-LTC or XMR/BTC", file=sys.stderr)
            return 1
        print(render_pair_detail(book, parts[0], parts[1], prices), end="")
        return 0

    manifest = []
    if os.path.isfile(args.manifest):
        with open(args.manifest, encoding="utf-8") as f:
            manifest = json.load(f).get("snapshots", [])

    offers = live_offers(book, now)
    print(build_stats_txt(book, offers, prices, manifest, now), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
