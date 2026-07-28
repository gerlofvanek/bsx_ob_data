#!/usr/bin/env python3
"""Generate plain-text market stats artifacts from orderbook.json.

Writes stats.txt, summary.json, status.txt, feed.xml, bulletin.txt, and diff.txt
under plain/ (or a custom output directory).

Usage:
    python scripts/plain_stats.py orderbook.json --health health.json \\
        --manifest snapshots/manifest.json --out-dir plain
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import xml.sax.saxutils as xml_escape
from datetime import datetime, timezone
from typing import Any

COIN_GECKO_IDS = {
    "BTC": "bitcoin", "XMR": "monero", "LTC": "litecoin", "PART": "particl",
    "PART_BLIND": "particl", "PART_ANON": "particl", "BCH": "bitcoin-cash",
    "FIRO": "zcoin", "DASH": "dash", "PIVX": "pivx", "WOW": "wownero",
    "DOGE": "dogecoin", "DCR": "decred", "NAV": "nav-coin", "NMC": "namecoin",
    "LTC_MWEB": "litecoin",
}

RULE_MIN = 45
TOP_N = 10
BAR_W = 12
SPARK_W = 8

KNOWN_MAKERS = {
    "PgTfpGmwtXppGVrNUAdJicKAVErZBEK2xo": "WizardSwap",
}


def pair_key(a: str, b: str) -> str:
    return f"{a}/{b}" if a < b else f"{b}/{a}"


def is_expired(o: dict, now: int | None = None) -> bool:
    now = now or int(time.time())
    return (o.get("timestamp", 0) + o.get("time_valid", 0)) <= now


def live_offers(book: dict, now: int | None = None) -> list[dict]:
    now = now or int(time.time())
    return [o for o in book.get("offers", []) if not is_expired(o, now)]


def fetch_prices() -> dict[str, float]:
    ids = ",".join(sorted(set(COIN_GECKO_IDS.values())))
    url = f"https://api.coingecko.com/api/v3/simple/price?ids={ids}&vs_currencies=usd"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.load(resp)
        out: dict[str, float] = {}
        for coin_id, val in data.items():
            if isinstance(val, dict) and val.get("usd"):
                out[coin_id] = float(val["usd"])
        return out
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return {}


def coin_usd(ticker: str, prices: dict[str, float]) -> float:
    cid = COIN_GECKO_IDS.get(ticker)
    return prices.get(cid, 0.0) if cid else 0.0


def offer_usd(o: dict, prices: dict[str, float]) -> float:
    p = coin_usd(o.get("coin_from", ""), prices)
    if not p:
        return 0.0
    try:
        return float(o.get("amount_from_str") or 0) * p
    except (TypeError, ValueError):
        return 0.0


def fiat_compact(n: float | None) -> str:
    if n is None or not isinstance(n, (int, float)):
        return "—"
    if n >= 1e9:
        return f"${n / 1e9:.0f}B" if n >= 1e10 else f"${n / 1e9:.1f}B"
    if n >= 1e6:
        return f"${n / 1e6:.0f}M" if n >= 1e7 else f"${n / 1e6:.1f}M"
    if n >= 1e3:
        return f"${n / 1e3:.0f}K" if n >= 1e4 else f"${n / 1e3:.1f}K"
    if n == 0:
        return "$0"
    if n < 1:
        return f"${n:.2f}"
    return f"${round(n):,}"


def int_fmt(n: int | float) -> str:
    return f"{int(n):,}"


def spread_word(p: float | None) -> str:
    if p is None or p < 0:
        return "—"
    if p < 1:
        return "tight"
    if p <= 3:
        return "fair"
    return "wide"


def get_bids_asks(offers: list[dict], base: str, quote: str) -> tuple[list, list]:
    bids, asks = [], []
    for o in offers:
        try:
            fa = float(o.get("amount_from_str") or 0)
            ta = float(o.get("amount_to_str") or 0)
        except (TypeError, ValueError):
            continue
        if not fa or not ta:
            continue
        if o.get("coin_from") == base and o.get("coin_to") == quote:
            asks.append(ta / fa)
        elif o.get("coin_from") == quote and o.get("coin_to") == base:
            bids.append(fa / ta)
    bids.sort(reverse=True)
    asks.sort()
    return bids, asks


def pair_spread(offers: list[dict], base: str, quote: str) -> float | None:
    bids, asks = get_bids_asks(offers, base, quote)
    if not bids or not asks:
        return None
    bid, ask = bids[0], asks[0]
    mid = (bid + ask) / 2
    return ((ask - bid) / mid * 100) if mid else None


def top_pairs(offers: list[dict], prices: dict[str, float], limit: int = TOP_N) -> list[dict]:
    totals: dict[str, dict] = {}
    for o in offers:
        cf, ct = o.get("coin_from"), o.get("coin_to")
        if not cf or not ct:
            continue
        k = pair_key(cf, ct)
        if k not in totals:
            base = cf if cf < ct else ct
            quote = ct if cf < ct else cf
            totals[k] = {"liq": 0.0, "base": base, "quote": quote, "offers": 0, "key": k}
        totals[k]["liq"] += offer_usd(o, prices)
        totals[k]["offers"] += 1
    return sorted(totals.values(), key=lambda t: t["liq"], reverse=True)[:limit]


def pair_count_at(snap: dict | None, base: str, quote: str) -> int:
    if not snap:
        return 0
    pc = snap.get("pair_counts") or {}
    k = pair_key(base, quote)
    a, b = k.split("/")
    return int(pc.get(f"{a}/{b}", 0)) + int(pc.get(f"{b}/{a}", 0))


def snapshot_around(manifest: list[dict], target_ts: int) -> dict | None:
    if not manifest:
        return None
    best, best_delta = None, 10**18
    for s in manifest:
        d = abs(int(s.get("ts", 0)) - target_ts)
        if d < best_delta:
            best_delta, best = d, s
    if best is None or abs(int(best.get("ts", 0)) - target_ts) > 18 * 3600:
        return None
    return best


def pair_sparkline(manifest: list[dict], base: str, quote: str, width: int = SPARK_W) -> list[int]:
    snaps = manifest[-width:]
    return [pair_count_at(s, base, quote) for s in snaps]


def ascii_sparkline(data: list[int]) -> str:
    if len(data) < 2:
        return "·" * SPARK_W
    mn, mx = min(data), max(data)
    rng = mx - mn or 1
    chars = "·▁▂▃▄▅▆▇█"
    out = []
    for v in data[-SPARK_W:]:
        idx = min(7, int((v - mn) / rng * 8))
        out.append(chars[idx])
    return "".join(out).ljust(SPARK_W, "·")


def ascii_bar(value: float, max_val: float, width: int = BAR_W) -> str:
    if not max_val or max_val <= 0:
        return ""
    n = max(0, min(width, round(value / max_val * width)))
    return "#" * n


def pad_left(s: str, w: int) -> str:
    s = str(s)
    return s if len(s) >= w else " " * (w - len(s)) + s


def pad_right(s: str, w: int) -> str:
    s = str(s)
    return s if len(s) >= w else s + " " * (w - len(s))


def ascii_table(headers: list[str], rows: list[list[str]], aligns: list[str] | None = None) -> str:
    gap = "  "
    aligns = aligns or ["l"] + ["r"] * (len(headers) - 1)
    widths = [
        max(len(h), *(len(str(r[i])) for r in rows))
        for i, h in enumerate(headers)
    ]

    def fmt(s: str, i: int) -> str:
        s = str(s)
        return pad_right(s, widths[i]) if aligns[i] == "l" else pad_left(s, widths[i])

    lines = [gap.join(fmt(h, i) for i, h in enumerate(headers))]
    lines.append(gap.join("-" * w for w in widths))
    for row in rows:
        lines.append(gap.join(fmt(row[i], i) for i in range(len(headers))))
    return "\n".join(lines)


def truncate_addr(addr: str, left: int = 4, right: int = 4) -> str:
    if len(addr) <= left + right + 1:
        return addr
    return f"{addr[:left]}…{addr[-right:]}"


def maker_label(addr: str) -> str:
    if not addr:
        return "—"
    a = str(addr).strip()
    for full, name in KNOWN_MAKERS.items():
        if a == full:
            return name
        if len(a) >= 9 and a.startswith(full[:4]) and a.endswith(full[-4:]):
            return name
    return truncate_addr(a)


def top_makers(offers: list[dict], prices: dict[str, float], limit: int = 8) -> list[dict]:
    by: dict[str, dict] = {}
    for o in offers:
        addr = o.get("addr_from")
        if not addr:
            continue
        if addr not in by:
            by[addr] = {"addr": addr, "offers": 0, "liq": 0.0, "pairs": set()}
        by[addr]["offers"] += 1
        by[addr]["liq"] += offer_usd(o, prices)
        cf, ct = o.get("coin_from"), o.get("coin_to")
        if cf and ct:
            by[addr]["pairs"].add(pair_key(cf, ct))
    rows = [
        {**v, "pairs": len(v["pairs"])}
        for v in by.values()
    ]
    return sorted(rows, key=lambda r: r["liq"], reverse=True)[:limit]


def render_top_pairs_section(
    offers: list[dict],
    prices: dict[str, float],
    manifest: list[dict],
    now: int,
) -> str:
    pairs = top_pairs(offers, prices, TOP_N)
    if not pairs:
        return "(no live pairs)"

    total_liq = sum(offer_usd(o, prices) for o in offers)
    shown_liq = sum(t["liq"] for t in pairs)
    past = snapshot_around(manifest, now - 86400)
    max_liq = pairs[0]["liq"] if pairs else 0

    rows = []
    for i, t in enumerate(pairs, 1):
        sp = pair_spread(offers, t["base"], t["quote"])
        sp_str = f"{spread_word(sp)} {sp:.1f}%" if sp is not None else "—"
        pct = f"{round(t['liq'] / total_liq * 100)}%" if total_liq else "—"
        delta = t["offers"] - pair_count_at(past, t["base"], t["quote"]) if past else None
        delta_str = f"{delta:+d}" if delta is not None and delta != 0 else ("0" if delta == 0 else "—")
        spark = ascii_sparkline(pair_sparkline(manifest, t["base"], t["quote"]))
        bar = ascii_bar(t["liq"], max_liq, BAR_W)
        rows.append([
            str(i),
            t["key"],
            fiat_compact(t["liq"]),
            pct,
            bar,
            sp_str,
            str(t["offers"]),
            delta_str,
            spark,
        ])

    table = ascii_table(
        ["#", "Pair", "Liq", "%", "Bar", "Spread", "N", "Δ24h", "Trend"],
        rows,
        ["r", "l", "r", "r", "l", "r", "r", "r", "l"],
    )
    footer = (
        f"{fiat_compact(shown_liq)} shown · "
        f"{fiat_compact(total_liq)} total · top {len(pairs)} pairs"
    )
    return table + "\n\n" + footer


def fmt_snap_label(ts: int, mark_today: bool = False) -> str:
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    label = dt.strftime("%d/%m")
    if mark_today:
        today = datetime.now(tz=timezone.utc).date()
        if dt.date() == today:
            label = f"*{label}"
    return label


def render_activity_section(manifest: list[dict]) -> str:
    snaps = manifest[-12:]
    if len(snaps) < 2:
        return ""

    def series(field: str) -> list[int]:
        return [int(s.get(field, 0)) for s in snaps]

    def chart(vals: list[int], height: int = 3) -> list[str]:
        mn, mx = min(vals), max(vals)
        rng = mx - mn or 1
        grid = [[" "] * len(vals) for _ in range(height)]
        for i, v in enumerate(vals):
            row = min(height - 1, int((v - mn) / rng * height))
            for r in range(row + 1):
                grid[height - 1 - r][i] = "#"
        lines = []
        for r in range(height):
            y = mx - (rng * r / max(1, height - 1))
            lines.append(pad_left(int_fmt(round(y)), 3) + "|" + "".join(grid[r]))
        return lines

    offers = series("active_offers")
    totals = series("num_offers")
    pair_counts = [len(s.get("pair_counts") or {}) for s in snaps]

    first_ts = int(snaps[0].get("ts", 0))
    last_ts = int(snaps[-1].get("ts", 0))
    span_h = max(1, round((last_ts - first_ts) / 3600))

    lines = [
        f"last {len(snaps)} snapshots · ~{span_h}h window",
        "",
        "live offers",
        *chart(offers),
        "",
        "total offers",
        *chart(totals),
        "",
        "active pairs",
        *chart(pair_counts),
    ]

    labels = [fmt_snap_label(int(s.get("ts", 0)), i == len(snaps) - 1) for i, s in enumerate(snaps)]
    lines.append("   +" + "-" * len(snaps))
    lines.append("    " + "".join(pad_right(l, 2) for l in labels))
    lines.append(
        f"now {offers[-1]} live · {totals[-1]} total · {pair_counts[-1]} pairs"
    )
    return "\n".join(lines)


def render_makers_section(offers: list[dict], prices: dict[str, float]) -> str:
    makers = top_makers(offers, prices, 8)
    if not makers:
        return "(no makers)"
    return ascii_table(
        ["Maker", "Offers", "Liq", "Pairs"],
        [[maker_label(m["addr"]), str(m["offers"]), fiat_compact(m["liq"]), str(m["pairs"])] for m in makers],
        ["l", "r", "r", "r"],
    )


def offer_map(book: dict) -> dict[str, dict]:
    return {o["msg_id"]: o for o in book.get("offers", []) if o.get("msg_id")}


def render_offer_diff(old_book: dict, new_book: dict, limit: int = 20) -> str:
    """Offer-level churn between two full orderbook snapshots."""
    old_offers, new_offers = offer_map(old_book), offer_map(new_book)
    new_ts = int(new_book.get("timestamp", 0))
    stable = old_offers.keys() & new_offers.keys()
    appeared = new_offers.keys() - old_offers.keys()
    vanished = old_offers.keys() - new_offers.keys()
    vanished_active = [
        m for m in vanished
        if (old_offers[m].get("timestamp", 0) + old_offers[m].get("time_valid", 0)) > new_ts
    ]

    old_n, new_n = len(old_offers), len(new_offers)
    lines = [
        "offer-level churn",
        f"old  {old_n} offers ({old_book.get('updated_at', '?')})",
        f"new  {new_n} offers ({new_book.get('updated_at', '?')})",
        f"stable    {len(stable):4d}  ({100 * len(stable) / max(1, old_n):.1f}% of old)",
        f"appeared  {len(appeared):4d}",
        f"vanished  {len(vanished):4d}  (still active: {len(vanished_active)})",
    ]
    if vanished_active:
        lines.append("")
        lines.append("vanished while still active (top)")
        for m in sorted(vanished_active)[:limit]:
            o = old_offers[m]
            lines.append(
                f"  {m[:20]}…  {o.get('coin_from')}→{o.get('coin_to')}"
                f"  {o.get('amount_from_str', '?')}"
            )
        if len(vanished_active) > limit:
            lines.append(f"  … and {len(vanished_active) - limit} more")
    if appeared:
        lines.append("")
        lines.append("new offers (top)")
        for m in sorted(appeared)[:limit]:
            o = new_offers[m]
            lines.append(
                f"  {m[:20]}…  {o.get('coin_from')}→{o.get('coin_to')}"
                f"  {o.get('amount_from_str', '?')}"
            )
        if len(appeared) > limit:
            lines.append(f"  … and {len(appeared) - limit} more")
    return "\n".join(lines)


def build_bulletins_manifest(bulletins_dir: str) -> list[dict]:
    if not os.path.isdir(bulletins_dir):
        return []
    entries: list[dict] = []
    for name in sorted(os.listdir(bulletins_dir), reverse=True):
        if not name.endswith(".txt"):
            continue
        path = os.path.join(bulletins_dir, name)
        if not os.path.isfile(path):
            continue
        kind = "weekly" if name.startswith("week-") else "daily"
        entries.append({"file": name, "kind": kind, "bytes": os.path.getsize(path)})
    return entries


def render_diff_section(manifest: list[dict]) -> str:
    if len(manifest) < 2:
        return ""
    prev, cur = manifest[-2], manifest[-1]
    d_offers = int(cur.get("active_offers", 0)) - int(prev.get("active_offers", 0))
    d_total = int(cur.get("num_offers", 0)) - int(prev.get("num_offers", 0))
    prev_pc = prev.get("pair_counts") or {}
    cur_pc = cur.get("pair_counts") or {}
    prev_pairs = set(prev_pc.keys())
    cur_pairs = set(cur_pc.keys())
    gained = sorted(cur_pairs - prev_pairs)
    lost = sorted(prev_pairs - cur_pairs)

    movers = []
    for k in cur_pairs & prev_pairs:
        d = int(cur_pc.get(k, 0)) - int(prev_pc.get(k, 0))
        if d:
            movers.append((k, d))
    movers.sort(key=lambda x: abs(x[1]), reverse=True)

    lines = [
        f"since previous snapshot ({prev.get('file', '?')})",
        f"live offers  {d_offers:+d}  ({prev.get('active_offers')} → {cur.get('active_offers')})",
        f"total offers {d_total:+d}  ({prev.get('num_offers')} → {cur.get('num_offers')})",
    ]
    if gained:
        lines.append("pairs gained  " + ", ".join(gained[:6]) + ("…" if len(gained) > 6 else ""))
    if lost:
        lines.append("pairs lost    " + ", ".join(lost[:6]) + ("…" if len(lost) > 6 else ""))
    if not gained and not lost:
        lines.append("pairs         unchanged")
    if movers:
        lines.append("")
        lines.append("pair offer churn (top)")
        for k, d in movers[:8]:
            lines.append(f"  {k:<12} {d:+d}  ({prev_pc.get(k, 0)} → {cur_pc.get(k, 0)})")
    return "\n".join(lines)


def render_coin_liquidity(offers: list[dict], prices: dict[str, float], limit: int = 10) -> str:
    by_coin: dict[str, float] = {}
    for o in offers:
        cf = o.get("coin_from")
        if not cf:
            continue
        by_coin[cf] = by_coin.get(cf, 0.0) + offer_usd(o, prices)
    entries = sorted(by_coin.items(), key=lambda x: x[1], reverse=True)[:limit]
    if not entries:
        return "(none)"
    max_liq = entries[0][1]
    rows = []
    for coin, liq in entries:
        rows.append([coin, fiat_compact(liq), ascii_bar(liq, max_liq, BAR_W)])
    return ascii_table(["Coin", "Liq", "Bar"], rows, ["l", "r", "l"])


def render_offer_freshness(offers: list[dict], now: int) -> str:
    if not offers:
        return "(none)"
    buckets = {"<1h": 0, "1–6h": 0, "6–24h": 0, ">24h": 0, "<6h left": 0}
    for o in offers:
        age = now - int(o.get("timestamp", now))
        if age < 3600:
            buckets["<1h"] += 1
        elif age < 6 * 3600:
            buckets["1–6h"] += 1
        elif age < 86400:
            buckets["6–24h"] += 1
        else:
            buckets[">24h"] += 1
        left = (o.get("timestamp", 0) + o.get("time_valid", 0)) - now
        if 0 < left < 6 * 3600:
            buckets["<6h left"] += 1
    lines = [f"{k}  {v}" for k, v in buckets.items()]
    return "\n".join(lines)


def render_pair_txt(
    book: dict, offers: list[dict], prices: dict[str, float], base: str, quote: str, now: int,
) -> str:
    pair_offers = [
        o for o in offers
        if (o.get("coin_from") == base and o.get("coin_to") == quote)
        or (o.get("coin_from") == quote and o.get("coin_to") == base)
    ]
    if not pair_offers:
        return f"{base}/{quote}\n\n(no live offers)\n"
    liq = sum(offer_usd(o, prices) for o in pair_offers)
    sp = pair_spread(offers, base, quote)
    lines = [
        f"{base} / {quote}",
        f"updated {book.get('updated_at', '—')}",
        "",
        f"liquidity   {fiat_compact(liq)}",
        f"live offers {len(pair_offers)}",
    ]
    if sp is not None:
        lines.append(f"spread      {spread_word(sp)} · {sp:.2f}%")
    lines.extend(["", "plain view: /plain/?pair=" + base + "-" + quote])
    return "\n".join(lines) + "\n"


def render_now_section(book: dict, offers: list[dict], prices: dict[str, float], manifest: list[dict], now: int) -> str:
    liq = sum(offer_usd(o, prices) for o in offers)
    pairs = book.get("unique_pairs") or len({pair_key(o["coin_from"], o["coin_to"]) for o in offers if o.get("coin_from")})
    makers = book.get("unique_makers") or len({o["addr_from"] for o in offers if o.get("addr_from")})
    newest = sum(1 for o in book.get("offers", []) if o.get("timestamp", 0) >= now - 86400)
    age_s = now - int(book.get("timestamp", now))

    def age_short(s: int) -> str:
        if s < 60:
            return f"{s}s"
        if s < 3600:
            return f"{s // 60}m"
        if s < 86400:
            return f"{s // 3600}h"
        return f"{s // 86400}d"

    past = snapshot_around(manifest, now - 86400)
    live_delta = None
    if past and past.get("active_offers"):
        live_delta = (len(offers) - int(past["active_offers"])) / int(past["active_offers"]) * 100

    lines = [
        f"listed liquidity  {fiat_compact(liq)}",
        f"active pairs      {int_fmt(pairs)}",
        f"active makers     {int_fmt(makers)}",
        f"live offers       {int_fmt(len(offers))}" + (f"  ({live_delta:+.1f}% vs 24h)" if live_delta else ""),
        f"new offers · 24h   {int_fmt(newest)}",
        f"snapshot age      {age_short(age_s)}",
    ]
    return "\n".join(lines)


def render_new_offers_24h(book: dict, now: int) -> str:
    cutoff = now - 86400
    by_pair: dict[str, int] = {}
    for o in book.get("offers", []):
        if o.get("timestamp", 0) < cutoff or is_expired(o, now):
            continue
        cf, ct = o.get("coin_from"), o.get("coin_to")
        if not cf or not ct:
            continue
        k = pair_key(cf, ct)
        by_pair[k] = by_pair.get(k, 0) + 1
    entries = sorted(by_pair.items(), key=lambda x: x[1], reverse=True)[:8]
    if not entries:
        return "(none in last 24h)"
    return ascii_table(
        ["Pair", "New"],
        [[k, f"+{n}"] for k, n in entries],
        ["l", "r"],
    )


def render_bulletin(book: dict, offers: list[dict], prices: dict[str, float], manifest: list[dict], now: int) -> str:
    updated = book.get("updated_at", "—")
    liq = sum(offer_usd(o, prices) for o in offers)
    past = snapshot_around(manifest, now - 86400)
    yday = snapshot_around(manifest, now - 2 * 86400)

    lines = [
        f"BasicSwap bulletin · {updated}",
        "",
        render_now_section(book, offers, prices, manifest, now),
        "",
        "=" * RULE_MIN,
        "",
        "Top pairs",
        "",
        render_top_pairs_section(offers, prices, manifest, now),
    ]

    if past:
        d_offers = len(offers) - int(past.get("active_offers", len(offers)))
        d_liq_pct = None
        lines.extend(["", "vs ~24h ago", f"live offers  {d_offers:+d}"])
    if yday and past:
        lines.append(f"snapshots    {len(manifest)} in manifest")

    diff = render_diff_section(manifest)
    if diff:
        lines.extend(["", "=" * RULE_MIN, "", "Since last snapshot", "", diff])

    lines.extend([
        "",
        "-" * RULE_MIN,
        "data: Particl SMSG · not a live exchange feed",
    ])
    return "\n".join(lines)


def build_summary(book: dict, offers: list[dict], prices: dict[str, float]) -> dict[str, Any]:
    liq = sum(offer_usd(o, prices) for o in offers)
    pairs = top_pairs(offers, prices, TOP_N)
    ticker_prices = {}
    for ticker, cid in COIN_GECKO_IDS.items():
        if cid in prices and ticker not in ticker_prices:
            ticker_prices[ticker] = prices[cid]
    return {
        "updated_at": book.get("updated_at"),
        "timestamp": book.get("timestamp"),
        "listed_liquidity_usd": round(liq, 2) if liq else None,
        "active_offers": len(offers),
        "num_offers": book.get("num_offers"),
        "unique_pairs": book.get("unique_pairs"),
        "unique_makers": book.get("unique_makers"),
        "usd_prices": ticker_prices,
        "top_pairs": [
            {
                "pair": t["key"],
                "liquidity_usd": round(t["liq"], 2),
                "offers": t["offers"],
            }
            for t in pairs
        ],
    }


def _median(vals: list[float]) -> float | None:
    if not vals:
        return None
    s = sorted(vals)
    n = len(s)
    if n % 2:
        return float(s[n // 2])
    return (s[n // 2 - 1] + s[n // 2]) / 2.0


def maker_watch(offers: list[dict], limit: int = 8, flag_min: int = 10) -> list[dict]:
    counts: dict[str, int] = {}
    for o in offers:
        addr = o.get("addr_from") or ""
        if addr:
            counts[addr] = counts.get(addr, 0) + 1
    total = len(offers) or 1
    rows: list[dict] = []
    for addr, n in sorted(counts.items(), key=lambda x: -x[1])[:limit]:
        short = addr if len(addr) <= 12 else f"{addr[:6]}…{addr[-4:]}"
        rows.append({
            "addr": addr,
            "addr_short": short,
            "offers": n,
            "pct": round(n / total * 100, 1),
            "flagged": n >= flag_min,
        })
    return rows


def build_ops_data(
    book: dict,
    health: dict | None,
    manifest: list[dict],
    now: int,
) -> dict:
    """Aggregated threat signals and baselines for the hidden SKYNET ops dashboard."""
    stats = book.get("stats") or {}
    h = health or {}
    alerts: list[dict] = []
    threat = 0

    def bump(level: int, sev: str, msg: str) -> None:
        nonlocal threat
        alerts.append({"level": sev, "msg": msg})
        threat = max(threat, level)

    invalid = int(stats.get("revokes_invalid_sig") or 0)
    if invalid > 0:
        bump(3, "critical", f"Invalid revokes: {invalid} — possible censorship attempt")

    msgs = int(h.get("msgs_received") or stats.get("msgs_received") or 0)
    if h.get("ok") is False or msgs == 0:
        bump(3, "critical", "Scrape failed or zero SMSG traffic")

    ts = int(book.get("timestamp") or now)
    age_s = max(0, now - ts)
    if age_s > 2 * 3600:
        bump(2, "critical", f"Snapshot stale ({age_s // 3600}h old)")
    elif age_s > 30 * 60:
        bump(1, "warn", f"Snapshot aging ({age_s // 60}m old)")

    parse_err = int(stats.get("parse_errors") or 0)
    if parse_err > 0:
        bump(1, "warn", f"Parse errors: {parse_err}")

    recent = manifest[-14:]
    msg_rates = [float(s["msg_rate_per_s"]) for s in recent if s.get("msg_rate_per_s") is not None]
    cur_rate = h.get("msg_rate_per_s")
    median_rate = _median(msg_rates)
    if cur_rate is not None and median_rate and median_rate > 0:
        ratio = float(cur_rate) / median_rate
        if ratio > 2.5:
            bump(2, "warn", f"Message rate {cur_rate}/s is {ratio:.1f}× median ({median_rate:.1f}/s)")

    active_hist = [int(s.get("active_offers") or 0) for s in recent]
    cur_active = int(book.get("active_offers") or 0)
    median_active = _median([float(x) for x in active_hist if x > 0])
    if median_active and cur_active > 0:
        drop_pct = (median_active - cur_active) / median_active * 100
        if drop_pct > 30:
            bump(
                2, "warn",
                f"Active offers down {drop_pct:.0f}% vs recent median "
                f"({int(median_active)} → {cur_active})",
            )

    revokes_seen = int(stats.get("revokes_seen") or 0)
    offers_parsed = int(stats.get("offers_parsed") or 0)
    revoke_ratio = revokes_seen / max(offers_parsed, 1)
    if revoke_ratio > 2.0 and revokes_seen > 20:
        bump(1, "warn", f"High revoke ratio ({revoke_ratio:.1f} revokes per offer parsed)")

    not_for_us = int(stats.get("not_for_us") or 0)
    msgs_recv = int(stats.get("msgs_received") or 1)
    foreign_ratio = not_for_us / max(msgs_recv, 1)

    offers = live_offers(book, now)
    makers = maker_watch(offers)
    flagged_makers = [m for m in makers if m["flagged"]]
    if flagged_makers:
        bump(1, "warn", f"Maker spam: {len(flagged_makers)} address(es) with ≥10 offers")

    labels = ["LOW", "WATCH", "ELEVATED", "HIGH"]
    mtc = stats.get("message_type_counts") or {}
    bsx_msgs = sum(int(mtc.get(k) or 0) for k in ("offer", "bid", "bid_accept", "offer_revoke"))

    return {
        "updated_at": book.get("updated_at"),
        "timestamp": ts,
        "threat_level": threat,
        "threat_label": labels[threat],
        "alerts": alerts,
        "scores": {
            "snapshot_age_s": age_s,
            "foreign_smsg_ratio": round(foreign_ratio, 3),
            "revoke_ratio": round(revoke_ratio, 2),
            "msg_rate_per_s": cur_rate,
            "msg_rate_median_14": round(median_rate, 2) if median_rate else None,
            "active_offers_median_14": int(median_active) if median_active else None,
        },
        "health": h,
        "stats": stats,
        "market": {
            "active_offers": cur_active,
            "num_offers": book.get("num_offers"),
            "unique_makers": book.get("unique_makers"),
            "unique_pairs": book.get("unique_pairs"),
            "last_bsx_msg_ts": book.get("last_bsx_msg_ts"),
        },
        "trends": {
            "active_offers": active_hist[-12:],
            "msg_rate_per_s": msg_rates[-12:],
            "invalid_revokes": [int(s.get("revokes_invalid_sig") or 0) for s in recent[-12:]],
        },
        "maker_watch": makers,
        "bsx_messages": bsx_msgs,
    }


def build_status(health: dict | None, book: dict) -> str:
    h = health or {}
    ok = h.get("ok")
    ok_str = "yes" if ok is True else ("no" if ok is False else "—")
    dur = h.get("duration_s")
    rate = h.get("msg_rate_per_s")
    msgs = h.get("msgs_received", book.get("stats", {}).get("msgs_received", "—"))
    parsed = h.get("offers_parsed", book.get("stats", {}).get("offers_parsed", "—"))
    parts = [
        f"ok · last run {ok_str}",
    ]
    if dur is not None:
        parts.append(f"scrape {dur}s")
    if rate is not None:
        parts.append(f"{rate:.1f} msg/s")
    parts.append(f"{msgs} SMSGs")
    parts.append(f"{parsed} parsed")
    parts.append(f"{len(live_offers(book))} live offers")
    return " · ".join(str(p) for p in parts)


def build_feed_xml(book: dict, offers: list[dict], prices: dict[str, float], site_base: str = "") -> str:
    liq = sum(offer_usd(o, prices) for o in offers)
    title = f"{len(offers)} live offers · {fiat_compact(liq)} liquidity · {book.get('unique_pairs', '?')} pairs"
    updated = book.get("updated_at", "")
    desc = render_now_section(book, offers, prices, [], int(time.time()))
    link = (site_base.rstrip("/") + "/plain/") if site_base else "/plain/"
    guid = str(book.get("timestamp", updated))
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>BasicSwap plain market stats</title>
    <link>{xml_escape.escape(link)}</link>
    <description>Snapshot summaries from the Particl SMSG orderbook</description>
    <lastBuildDate>{xml_escape.escape(updated)}</lastBuildDate>
    <item>
      <title>{xml_escape.escape(title)}</title>
      <link>{xml_escape.escape(link)}</link>
      <guid isPermaLink="false">{xml_escape.escape(guid)}</guid>
      <pubDate>{xml_escape.escape(updated)}</pubDate>
      <description><![CDATA[{desc}]]></description>
    </item>
  </channel>
</rss>
"""


def build_feed_json(book: dict, offers: list[dict], prices: dict[str, float], site_base: str = "") -> dict:
    liq = sum(offer_usd(o, prices) for o in offers)
    title = f"{len(offers)} live offers · {fiat_compact(liq)} liquidity · {book.get('unique_pairs', '?')} pairs"
    link = (site_base.rstrip("/") + "/plain/") if site_base else "/plain/"
    desc = render_now_section(book, offers, prices, [], int(time.time()))
    return {
        "version": "https://jsonfeed.org/version/1.1",
        "title": "BasicSwap plain market stats",
        "home_page_url": link,
        "feed_url": link + "feed.json",
        "items": [{
            "id": str(book.get("timestamp", book.get("updated_at", ""))),
            "title": title,
            "url": link,
            "date_published": book.get("updated_at"),
            "content_text": desc,
        }],
    }


def build_weekly_bulletin(bulletins_dir: str) -> str | None:
    if not os.path.isdir(bulletins_dir):
        return None
    files = sorted(f for f in os.listdir(bulletins_dir) if f.endswith(".txt"))[-7:]
    if not files:
        return None
    lines = [f"BasicSwap weekly bulletin · {files[0]} – {files[-1]}", ""]
    for name in files:
        path = os.path.join(bulletins_dir, name)
        try:
            with open(path, encoding="utf-8") as f:
                head = f.read(400).strip().split("\n")
            lines.append(f"--- {name} ---")
            lines.extend(head[:6])
            lines.append("")
        except OSError:
            continue
    return "\n".join(lines).strip() + "\n"


def build_stats_txt(book: dict, offers: list[dict], prices: dict[str, float], manifest: list[dict], now: int) -> str:
    w = RULE_MIN
    updated = book.get("updated_at", "—")
    sections = [
        "plain text market stats",
        "",
        f"BasicSwap · Particl SMSG network",
        updated,
        "",
        "=" * w,
        "",
        "Now",
        "",
        render_now_section(book, offers, prices, manifest, now),
        "",
        "=" * w,
        "",
        "Top pairs",
        "",
        render_top_pairs_section(offers, prices, manifest, now),
    ]
    activity = render_activity_section(manifest)
    if activity:
        sections.extend(["", "=" * w, "", "Activity", "", activity])
    coin_liq = render_coin_liquidity(offers, prices)
    sections.extend(["", "=" * w, "", "Liquidity by coin", "", coin_liq])
    freshness = render_offer_freshness(offers, now)
    sections.extend(["", "=" * w, "", "Offer freshness", "", freshness])
    sections.extend([
        "",
        "=" * w,
        "",
        "New offers · 24h",
        "",
        render_new_offers_24h(book, now),
        "",
        "=" * w,
        "",
        "Makers",
        "",
        render_makers_section(offers, prices),
    ])
    diff = render_diff_section(manifest)
    if diff:
        sections.extend(["", "=" * w, "", "Since last snapshot", "", diff])
    sections.extend([
        "",
        "-" * w,
        f"market data last fetched at: {updated}",
        "plain view: /plain/ · full view: /",
    ])
    return "\n".join(sections) + "\n"


def write_text_atomic(path: str, text: str) -> None:
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def write_json_atomic(path: str, obj: Any) -> None:
    write_text_atomic(path, json.dumps(obj, indent=2) + "\n")


def generate_plain_artifacts(
    book: dict,
    out_dir: str,
    health: dict | None = None,
    manifest_path: str | None = None,
    site_base: str = "",
    fetch_usd: bool = True,
    repo_root: str | None = None,
) -> None:
    now = int(time.time())
    manifest: list[dict] = []
    if manifest_path and os.path.isfile(manifest_path):
        try:
            with open(manifest_path, encoding="utf-8") as f:
                manifest = json.load(f).get("snapshots", [])
        except (json.JSONDecodeError, OSError):
            manifest = []

    offers = live_offers(book, now)
    prices = fetch_prices() if fetch_usd else {}
    status_line = build_status(health, book)
    stats_txt = build_stats_txt(book, offers, prices, manifest, now)

    write_text_atomic(os.path.join(out_dir, "stats.txt"), stats_txt)
    write_json_atomic(os.path.join(out_dir, "summary.json"), build_summary(book, offers, prices))
    write_text_atomic(os.path.join(out_dir, "status.txt"), status_line)
    write_text_atomic(os.path.join(out_dir, "feed.xml"), build_feed_xml(book, offers, prices, site_base))
    write_json_atomic(os.path.join(out_dir, "feed.json"), build_feed_json(book, offers, prices, site_base))

    bulletins_dir = os.path.join(out_dir, "bulletins")
    day = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    write_text_atomic(
        os.path.join(bulletins_dir, f"{day}.txt"),
        render_bulletin(book, offers, prices, manifest, now),
    )
    weekly = build_weekly_bulletin(bulletins_dir)
    if weekly:
        iso = datetime.now(tz=timezone.utc).isocalendar()
        write_text_atomic(os.path.join(bulletins_dir, f"week-{iso.year}-W{iso.week:02d}.txt"), weekly)

    diff = render_diff_section(manifest)
    history_dir = os.path.dirname(manifest_path) if manifest_path else ""
    offer_diff = ""
    if history_dir and len(manifest) >= 2:
        prev_file = manifest[-2].get("file")
        if prev_file:
            prev_path = os.path.join(history_dir, prev_file)
            if os.path.isfile(prev_path):
                try:
                    with open(prev_path, encoding="utf-8") as f:
                        old_book = json.load(f)
                    offer_diff = render_offer_diff(old_book, book)
                except (json.JSONDecodeError, OSError):
                    offer_diff = ""

    if diff or offer_diff:
        body = diff
        if offer_diff:
            body = (body + "\n\n" if body else "") + offer_diff
        write_text_atomic(os.path.join(out_dir, "diff.txt"), body + "\n")
    if offer_diff:
        write_text_atomic(os.path.join(out_dir, "diff-offers.txt"), offer_diff + "\n")

    bulletins_manifest = build_bulletins_manifest(bulletins_dir)
    if bulletins_manifest:
        write_json_atomic(
            os.path.join(bulletins_dir, "manifest.json"),
            {"bulletins": bulletins_manifest},
        )

    pairs_dir = os.path.join(out_dir, "pairs")
    for t in top_pairs(offers, prices, TOP_N):
        slug = t["base"] + "-" + t["quote"]
        write_text_atomic(
            os.path.join(pairs_dir, slug + ".txt"),
            render_pair_txt(book, offers, prices, t["base"], t["quote"], now),
        )

    abs_out = os.path.abspath(out_dir)
    root = repo_root
    if not root and os.path.basename(abs_out) == "plain":
        root = os.path.dirname(abs_out)
    if root:
        write_text_atomic(os.path.join(root, "status.txt"), status_line + "\n")
        write_text_atomic(os.path.join(root, "stats.txt"), stats_txt)

    ops_dir = os.path.join(out_dir, "skynet-ops")
    write_json_atomic(
        os.path.join(ops_dir, "ops-data.json"),
        build_ops_data(book, health, manifest, now),
    )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Generate plain market stats artifacts")
    p.add_argument("orderbook", help="Path to orderbook.json")
    p.add_argument("--health", help="Path to health.json")
    p.add_argument("--manifest", help="Path to snapshots/manifest.json")
    p.add_argument("--out-dir", default="plain", help="Output directory (default: plain)")
    p.add_argument("--site-base", default="", help="Public site base URL for RSS links")
    p.add_argument("--no-prices", action="store_true", help="Skip CoinGecko USD fetch")
    args = p.parse_args(argv)

    with open(args.orderbook, encoding="utf-8") as f:
        book = json.load(f)

    health = None
    if args.health and os.path.isfile(args.health):
        with open(args.health, encoding="utf-8") as f:
            health = json.load(f)

    generate_plain_artifacts(
        book,
        args.out_dir,
        health=health,
        manifest_path=args.manifest,
        site_base=args.site_base,
        fetch_usd=not args.no_prices,
    )
    print(f"Wrote plain artifacts to {args.out_dir}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
