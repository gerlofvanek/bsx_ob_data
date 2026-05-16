"""Quick standalone replication of findArbCycles() against the live snapshot.

Mirrors the JS logic in app.js so we can sanity-check what the UI sees.
Run from the repo root:  python bsx_orderbook/scripts/arb_check.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.normpath(os.path.join(HERE, '..', 'orderbook.json'))
d = json.load(open(SNAP))
offers = d['offers']
print(f'Total offers: {len(offers)}')

# Build best[from][to] = max units of `to` per 1 unit of `from`
best = {}
for o in offers:
    af = float(o['amount_from_str'] or 0)
    at = float(o['amount_to_str'] or 0)
    if not af or not at:
        continue
    a, b, r = o['coin_to'], o['coin_from'], af / at
    best.setdefault(a, {})
    if b not in best[a] or r > best[a][b]:
        best[a][b] = r

coins = sorted(best.keys())
print(f'Coins in directed graph: {len(coins)} -> {coins}')
for a in coins:
    print(f'  {a:6s} -> {list(best[a].keys())}')

# 3-hop cycles
hits3 = []
for a in coins:
    for b in coins:
        if a == b:
            continue
        for c in coins:
            if c in (a, b):
                continue
            r1 = best.get(a, {}).get(b)
            r2 = best.get(b, {}).get(c)
            r3 = best.get(c, {}).get(a)
            if not r1 or not r2 or not r3:
                continue
            hits3.append((r1 * r2 * r3 - 1, a, b, c))

hits3.sort(reverse=True)
print(f'\n--- 3-hop cycles found: {len(hits3)} ---')
print('Best 10:')
for edge, a, b, c in hits3[:10]:
    print(f'  {a}->{b}->{c}->{a}: edge {edge * 100:+.4f}%')
print('Counts:')
print(f'  >= 5%:   {sum(1 for e, *_ in hits3 if e >= 0.05)}')
print(f'  >= 1%:   {sum(1 for e, *_ in hits3 if e >= 0.01)}')
print(f'  >= 0.1%: {sum(1 for e, *_ in hits3 if e >= 0.001)}')
print(f'  > 0:     {sum(1 for e, *_ in hits3 if e > 0)}')

# 4-hop cycles
hits4 = []
for a in coins:
    for b in coins:
        if b == a:
            continue
        for c in coins:
            if c in (a, b):
                continue
            for dn in coins:
                if dn in (a, b, c):
                    continue
                r1 = best.get(a, {}).get(b)
                r2 = best.get(b, {}).get(c)
                r3 = best.get(c, {}).get(dn)
                r4 = best.get(dn, {}).get(a)
                if not all([r1, r2, r3, r4]):
                    continue
                hits4.append((r1 * r2 * r3 * r4 - 1, a, b, c, dn))

hits4.sort(reverse=True)
print(f'\n--- 4-hop cycles found: {len(hits4)} ---')
print('Best 10:')
for edge, a, b, c, dn in hits4[:10]:
    print(f'  {a}->{b}->{c}->{dn}->{a}: edge {edge * 100:+.4f}%')
print('Counts:')
print(f'  >= 5%:   {sum(1 for e, *_ in hits4 if e >= 0.05)}')
print(f'  >= 1%:   {sum(1 for e, *_ in hits4 if e >= 0.01)}')
print(f'  >= 0.1%: {sum(1 for e, *_ in hits4 if e >= 0.001)}')
print(f'  > 0:     {sum(1 for e, *_ in hits4 if e > 0)}')
