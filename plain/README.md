# BasicSwap plain text market stats

A brolly-inspired minimal view of BasicSwap network liquidity. Lives in `/plain/` and reads the same root data files as the main dashboard.

## URLs

| URL | Description |
|-----|-------------|
| `/plain/` | Network overview |
| `/plain/?pair=BTC-LTC` | Pair detail + order book |
| `/plain/BTC-LTC` | Same (via `404.html` redirect on GitHub Pages) |
| `/plain/?watch=BTC-LTC,XMR-BTC` | Watchlist-filtered overview (also saved in `localStorage`) |
| `/plain/?mark=BTC-LTC` | Overview with that pair highlighted in Top pairs |
| `/plain/stats.txt` | Pre-rendered plain text snapshot |
| `/stats.txt` | Same snapshot at repo root (for `curl`) |
| `/plain/pairs/BTC-LTC.txt` | Per-pair plain text |
| `/plain/health.html` | Scrape health one-pager |
| `/plain/diff.html` | Snapshot diff (pair + offer churn) |
| `/plain/bulletins/` | Daily and weekly bulletins |
| `/status.txt` | One-line scrape health (repo root) |

## Keyboard (pair pages)

- `[` / `]` — previous / next top pair
- `Esc` — back to overview

## Theme

- **☾ / ☀ toggle** in the nav bar switches light and dark mode
- Uses the same `bsx-theme` setting as the [full dashboard](../) — choice persists across both views

## Data sources

- `../orderbook.json`, `../health.json`, `../snapshots/manifest.json`
- `summary.json` — cached USD prices (fallback if CoinGecko rate-limits)
- CoinGecko — live USD prices in the browser

## Local dev

```bash
python -m http.server 8000
# http://localhost:8000/plain/
```

Regenerate artifacts:

```bash
python scripts/plain_stats.py orderbook.json --health health.json --manifest snapshots/manifest.json --out-dir plain
python scripts/bsx_stats.py orderbook.json --pair BTC-LTC
```

## CI

Each scrape writes `plain/*`, root `status.txt`, daily + weekly bulletins, and per-pair `.txt` files.

## Full dashboard

Interactive UI: [`/`](../)
