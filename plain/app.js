/* ============================================================================
   BasicSwap · plain text market stats
   Reads ../orderbook.json, ../health.json, ../snapshots/manifest.json
   ============================================================================ */

const DATA = {
  orderbook: '../orderbook.json',
  health: '../health.json',
  manifest: '../snapshots/manifest.json',
};

(function cleanPairPath() {
  if (location.search) return;
  const path = location.pathname.replace(/\/$/, '');
  const m = path.match(/\/plain\/([A-Za-z0-9]+[-/][A-Za-z0-9_]+)$/i);
  if (!m) return;
  const pair = m[1].toUpperCase().replace('/', '-');
  location.replace(location.pathname.replace(/\/[^/]+$/, '/') + '?pair=' + encodeURIComponent(pair));
})();

const COIN_GECKO_IDS = {
  BTC:'bitcoin', XMR:'monero', LTC:'litecoin', PART:'particl',
  PART_BLIND:'particl', PART_ANON:'particl', BCH:'bitcoin-cash',
  FIRO:'zcoin', DASH:'dash', PIVX:'pivx', WOW:'wownero',
  DOGE:'dogecoin', DCR:'decred', NAV:'nav-coin', NMC:'namecoin',
  LTC_MWEB:'litecoin',
};

const REFRESH_MS = 5 * 60 * 1000;
const TOP_N = 10;
const BOOK_DEFAULT = 6;
const BAR_W = 12;
const SPARK_W = 8;
const RULE_MIN = 45;

const XMR_DONATE = '85QDdyVftCW9zvwiVcR19eG4LhCejpRcM45yQHGLPKnxGs9p2iu5RxEB4C2KXRDFoZFL742gpiUKfGTA1ge1v8cMQRRUbW6';

const ASCII_LOGO = [
  ' ____            _      ____                     ____            ',
  '| __ )  __ _ ___(_) ___/ ___|_      ____ _ _ __ |  _ \\  _____  __',
  '|  _ \\ / _` / __| |/ __\\___ \\ \\ /\\ / / _` | \'_ \\| | | |/ _ \\ \\/ /',
  '| |_) | (_| \\__ \\ | (__ ___) \\ V  V / (_| | |_) | |_| |  __/>  < ',
  '|____/ \\__,_|___/_|\\___|____/ \\_/\\_/ \\__,_| .__/|____/ \\___/_/\\_\\',
  '                                          |_|                    ',
].join('\n');

function isSkynetMode() {
  return window.bsxPlainTheme?.isSkynet?.() ?? document.documentElement.classList.contains('skynet');
}

function sectionLabel(name) {
  if (!isSkynetMode()) return name;
  return '[ ' + String(name).toUpperCase() + ' ]';
}

let latestOrderbook = null;
let allOffers = [];
let latestHealth = null;
let snapshotManifest = [];
let bulletinManifest = [];
let latestPrices = {};
let bookExpanded = false;
let lastPairKey = null;

const KNOWN_MAKERS = {
  PgTfpGmwtXppGVrNUAdJicKAVErZBEK2xo: { name: 'WizardSwap', url: 'https://www.wizardswap.io/faq&page=basicswap' },
};
const WATCH_STORAGE_KEY = 'bsx-plain-watch';
const STALE_WARN_S = 30 * 60;
const STALE_ALERT_S = 2 * 3600;

let cachedSummary = null;

/* ── formatters ── */
const f = {
  fiat(n) {
    if (!isFinite(n)) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  },
  fiatCompact(n) {
    if (!isFinite(n) || n === null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
    if (n === 0) return '$0';
    if (n < 1) return '$' + n.toFixed(2);
    return '$' + Math.round(n).toLocaleString('en-US');
  },
  int(n) { return (n ?? 0).toLocaleString('en-US'); },
  coin(n) {
    if (n === 0 || !isFinite(n)) return '0';
    const d = Math.max(0, 5 - Math.floor(Math.log10(Math.abs(n))) - 1);
    return n.toLocaleString('en-US', { maximumFractionDigits: Math.min(8, Math.max(2, d)) });
  },
  ageShort(s) {
    if (s == null || s < 0) return '—';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  },
  pctDelta(n) {
    if (n == null || !isFinite(n) || n === 0) return '';
    const sign = n > 0 ? '+' : '';
    return ' (' + sign + n.toFixed(1) + '% vs 24h ago)';
  },
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function padRight(s, w) {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function padLeft(s, w) {
  s = String(s);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

const TABLE_GAP = '  ';

function asciiTable(headers, rows, aligns) {
  aligns = aligns || headers.map((_, i) => (i === 0 ? 'l' : 'r'));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length))
  );
  const fmt = (s, i) => {
    s = String(s);
    return aligns[i] === 'l' ? padRight(s, widths[i]) : padLeft(s, widths[i]);
  };
  const out = [headers.map((h, i) => fmt(h, i)).join(TABLE_GAP)];
  out.push(widths.map(w => '-'.repeat(w)).join(TABLE_GAP));
  rows.forEach(r => out.push(r.map((c, i) => fmt(c, i)).join(TABLE_GAP)));
  return out.join('\n');
}

function lineWidth(s) {
  if (!s) return 0;
  return Math.max(0, ...s.split('\n').map(l => l.length));
}

function contentWidth(...parts) {
  return Math.max(RULE_MIN, ...parts.map(lineWidth));
}

function hr(char, width, thin) {
  const cls = thin ? 'rule rule-thin' : 'rule';
  return '<pre class="' + cls + '" aria-hidden="true">' + esc(char.repeat(width)) + '</pre>\n';
}

function kv(label, value, suffix) {
  return label + ' ' + value + (suffix || '');
}

function coinUsd(t) { return latestPrices[COIN_GECKO_IDS[t]] || 0; }
function offerUsdSize(o) {
  const p = coinUsd(o.coin_from);
  return p ? parseFloat(o.amount_from_str || 0) * p : 0;
}
function pairKey(a, b) { return a < b ? a + '/' + b : b + '/' + a; }
function isExpired(o) {
  return (o.timestamp + (o.time_valid || 0)) <= Math.floor(Date.now() / 1000);
}
function liveOffers() { return allOffers.filter(o => !isExpired(o)); }

function spreadWord(p) {
  if (!isFinite(p) || p < 0) return '—';
  if (p < 1) return 'tight';
  if (p <= 3) return 'fair';
  return 'wide';
}

function getBidsAsks(base, quote) {
  const bids = [], asks = [];
  liveOffers().forEach(o => {
    const fa = parseFloat(o.amount_from_str), ta = parseFloat(o.amount_to_str);
    if (!fa || !ta) return;
    if (o.coin_from === base && o.coin_to === quote) {
      asks.push({ price: ta / fa, amount: fa, total: ta, offer: o });
    } else if (o.coin_from === quote && o.coin_to === base) {
      bids.push({ price: fa / ta, amount: ta, total: fa, offer: o });
    }
  });
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return { bids, asks };
}

function topPairs(limit) {
  const totals = {};
  liveOffers().forEach(o => {
    if (!o.coin_from || !o.coin_to) return;
    const k = pairKey(o.coin_from, o.coin_to);
    if (!totals[k]) {
      totals[k] = {
        liq: 0,
        base: o.coin_from < o.coin_to ? o.coin_from : o.coin_to,
        quote: o.coin_from < o.coin_to ? o.coin_to : o.coin_from,
        offers: 0,
      };
    }
    totals[k].liq += offerUsdSize(o);
    totals[k].offers += 1;
  });
  return Object.values(totals).sort((a, b) => b.liq - a.liq).slice(0, limit);
}

function pairSpread(base, quote) {
  const { bids, asks } = getBidsAsks(base, quote);
  if (!bids.length || !asks.length) return null;
  const bid = bids[0].price, ask = asks[0].price;
  return (ask - bid) / ((ask + bid) / 2) * 100;
}

function snapshotAround(targetTs) {
  if (!snapshotManifest.length) return null;
  let best = null, bestDelta = Infinity;
  snapshotManifest.forEach(s => {
    const d = Math.abs((s.ts || 0) - targetTs);
    if (d < bestDelta) { bestDelta = d; best = s; }
  });
  if (Math.abs((best.ts || 0) - targetTs) > 18 * 3600) return null;
  return best;
}

function deltaVs24h(currentValue, snapField) {
  const past = snapshotAround(Math.floor(Date.now() / 1000) - 86400);
  if (!past || past[snapField] == null) return null;
  return currentValue - past[snapField];
}

function parsePairParam(raw) {
  if (!raw) return null;
  raw = raw.trim().toUpperCase();
  const sep = raw.includes('/') ? '/' : raw.includes('-') ? '-' : null;
  if (!sep) return null;
  const [a, b] = raw.split(sep);
  if (!a || !b) return null;
  return { base: a, quote: b };
}

function parseRoute() {
  const params = new URLSearchParams(location.search);
  let pair = parsePairParam(params.get('pair'));
  if (!pair) {
    const parts = location.pathname.replace(/\/$/, '').split('/');
    const last = parts[parts.length - 1];
    if (last && last !== 'plain' && last !== 'index.html') {
      pair = parsePairParam(last.replace(/\.html$/i, ''));
    }
  }
  const watchRaw = params.get('watch');
  const watchlist = watchRaw
    ? watchRaw.split(',').map(s => parsePairParam(s.trim())).filter(Boolean)
    : [];
  const mark = parsePairParam(params.get('mark'));
  return { pair, watchlist, mark };
}

function pairCountAt(snap, base, quote) {
  if (!snap) return 0;
  const pc = snap.pair_counts || {};
  const k = pairKey(base, quote);
  const [a, b] = k.split('/');
  return (pc[a + '/' + b] || 0) + (pc[b + '/' + a] || 0);
}

function pairSparklineSeries(base, quote) {
  if (!snapshotManifest.length) return [];
  const snaps = snapshotManifest.slice(-SPARK_W);
  return snaps.map(s => pairCountAt(s, base, quote));
}

function pairDelta24h(base, quote, currentCount) {
  const past = snapshotAround(Math.floor(Date.now() / 1000) - 86400);
  if (!past) return null;
  return currentCount - pairCountAt(past, base, quote);
}

function asciiSparkline(data) {
  if (!data || data.length < 2) return '·'.repeat(SPARK_W);
  const min = Math.min(...data), max = Math.max(...data);
  const rng = max - min || 1;
  const chars = '·▁▂▃▄▅▆▇█';
  return data.slice(-SPARK_W).map(v => {
    const t = (v - min) / rng;
    return chars[Math.min(7, Math.floor(t * 8))];
  }).join('').padEnd(SPARK_W, '·');
}

function fmtSnapLabel(ts, markNow) {
  const d = new Date(ts * 1000);
  const label = String(d.getUTCDate()).padStart(2, '0') + '/'
    + String(d.getUTCMonth() + 1).padStart(2, '0');
  return markNow ? '*' + label : label;
}

function totalNetworkLiq() {
  let liq = 0;
  liveOffers().forEach(o => { liq += offerUsdSize(o); });
  return liq;
}

function topMakers(limit) {
  const by = {};
  liveOffers().forEach(o => {
    const addr = o.addr_from;
    if (!addr) return;
    if (!by[addr]) by[addr] = { addr, offers: 0, liq: 0, pairs: new Set() };
    by[addr].offers += 1;
    by[addr].liq += offerUsdSize(o);
    by[addr].pairs.add(pairKey(o.coin_from, o.coin_to));
  });
  return Object.values(by)
    .map(m => ({ ...m, pairCount: m.pairs.size }))
    .sort((a, b) => b.liq - a.liq)
    .slice(0, limit);
}

function truncateAddr(addr) {
  if (!addr || addr.length <= 9) return addr || '—';
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

function watchlistKeys(watchlist) {
  return new Set(watchlist.map(w => pairKey(w.base, w.quote)));
}

function knownMakerLabel(addr) {
  if (!addr) return '—';
  const a = String(addr).trim();
  for (const [full, meta] of Object.entries(KNOWN_MAKERS)) {
    if (a === full) return meta.name;
    if (a.length >= 9 && a.startsWith(full.slice(0, 4)) && a.endsWith(full.slice(-4))) return meta.name;
  }
  return truncateAddr(a);
}

function loadStoredWatchlist() {
  try {
    const raw = localStorage.getItem(WATCH_STORAGE_KEY);
    if (!raw) return [];
    return raw.split(',').map(s => parsePairParam(s.trim())).filter(Boolean);
  } catch (e) { return []; }
}

function saveWatchlist(list) {
  try {
    if (!list.length) localStorage.removeItem(WATCH_STORAGE_KEY);
    else localStorage.setItem(WATCH_STORAGE_KEY, list.map(w => w.base + '-' + w.quote).join(','));
  } catch (e) { /* ignore */ }
}

function mergeWatchlists(urlList, stored) {
  const seen = new Set();
  const out = [];
  [...urlList, ...stored].forEach(w => {
    const k = w.base + '|' + w.quote;
    if (!seen.has(k)) { seen.add(k); out.push(w); }
  });
  return out;
}

function snapshotAgeSec() {
  const ts = latestOrderbook?.timestamp;
  return ts ? Math.floor(Date.now() / 1000) - ts : null;
}

function renderStaleBanner(ageSec) {
  if (ageSec == null) return '';
  let cls = 'stale-banner';
  let msg = isSkynetMode()
    ? 'SIGNAL DEGRADED · snapshot ' + f.ageShort(ageSec) + ' old'
    : 'snapshot ' + f.ageShort(ageSec) + ' old';
  if (ageSec >= STALE_ALERT_S) {
    cls += ' stale-alert';
    msg += isSkynetMode() ? ' · DATA STALE' : ' · data may be stale · not a live exchange feed';
  } else if (ageSec >= STALE_WARN_S) {
    cls += ' stale-warn';
    msg += isSkynetMode() ? ' · NOT LIVE FEED' : ' · not a live exchange feed';
  } else return '';
  return '<p class="' + cls + '">' + esc(msg) + '</p>\n';
}

function pairRank(base, quote) {
  const list = topPairs(50);
  const i = list.findIndex(t => t.base === base && t.quote === quote);
  return i >= 0 ? i + 1 : null;
}

function renderPairPager(base, quote) {
  const list = topPairs(TOP_N);
  if (list.length < 2) return '';
  const k = pairKey(base, quote);
  let idx = list.findIndex(t => pairKey(t.base, t.quote) === k);
  if (idx < 0) return '';
  const prev = list[(idx - 1 + list.length) % list.length];
  const next = list[(idx + 1) % list.length];
  return '<nav class="pair-pager muted" aria-label="Pair navigation">'
    + '<a href="' + esc(pairUrl(prev.base, prev.quote)) + '">← ' + esc(prev.base + '/' + prev.quote) + '</a>'
    + ' · '
    + '<a href="' + esc(pairUrl(next.base, next.quote)) + '">' + esc(next.base + '/' + next.quote) + ' →</a>'
    + '</nav>\n';
}

function setMeta(attr, name, content) {
  let el = document.querySelector('meta[' + attr + '="' + name + '"]');
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.content = content;
}

function pageBaseUrl() {
  return location.origin + location.pathname.replace(/index\.html$/i, '').replace(/\/?$/, '/');
}

function updatePageMeta(pairParam, detail) {
  const desc = document.querySelector('meta[name="description"]');
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const ogDesc = document.querySelector('meta[property="og:description"]');
  const base = pageBaseUrl();
  const ogImage = new URL('../images/favicon-32.png', location.href).href;
  if (pairParam && detail) {
    const t = pairParam.base + '/' + pairParam.quote;
    const text = (detail.statsText || '').split('\n').slice(0, 4).join(' · ');
    const title = t + ' · BasicSwap plain stats';
    if (desc) desc.content = t + ' · ' + text;
    if (ogTitle) ogTitle.content = title;
    if (ogDesc) ogDesc.content = text;
    setMeta('property', 'og:url', base + pairUrl(pairParam.base, pairParam.quote));
    setMeta('property', 'og:image', ogImage);
    setMeta('name', 'twitter:card', 'summary');
    setMeta('name', 'twitter:title', title);
    setMeta('name', 'twitter:description', text);
    setMeta('name', 'twitter:image', ogImage);
    let alt = document.querySelector('link[rel="alternate"][data-pair-plain]');
    const slug = pairParam.base + '-' + pairParam.quote;
    if (!alt) {
      alt = document.createElement('link');
      alt.rel = 'alternate';
      alt.type = 'text/plain';
      alt.setAttribute('data-pair-plain', '1');
      document.head.appendChild(alt);
    }
    alt.href = 'pairs/' + slug + '.txt';
    alt.title = t + ' plain text';
  } else {
    const title = 'BasicSwap · plain text market stats';
    const overviewDesc = 'Plain text BasicSwap DEX market stats — liquidity, pairs, makers and order book from the Particl SMSG network.';
    if (desc) desc.content = overviewDesc;
    if (ogTitle) ogTitle.content = title;
    if (ogDesc) ogDesc.content = 'Live liquidity, pairs, makers and order book from the Particl SMSG network.';
    setMeta('property', 'og:url', base);
    setMeta('property', 'og:image', ogImage);
    setMeta('name', 'twitter:card', 'summary');
    setMeta('name', 'twitter:title', title);
    setMeta('name', 'twitter:description', overviewDesc);
    setMeta('name', 'twitter:image', ogImage);
    document.querySelector('link[rel="alternate"][data-pair-plain]')?.remove();
  }
}

function renderCoinLiquidity() {
  const byCoin = {};
  liveOffers().forEach(o => {
    if (!o.coin_from) return;
    byCoin[o.coin_from] = (byCoin[o.coin_from] || 0) + offerUsdSize(o);
  });
  const entries = Object.entries(byCoin).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!entries.length) return '(none)';
  const max = entries[0][1];
  return asciiTable(
    ['Coin', 'Liq', 'Bar'],
    entries.map(([c, v]) => [c, f.fiatCompact(v), asciiBar(v, max, BAR_W)]),
    ['l', 'r', 'l']
  );
}

function renderOfferFreshness() {
  const now = Math.floor(Date.now() / 1000);
  const offers = liveOffers();
  if (!offers.length) return '(none)';
  const buckets = { '<1h': 0, '1–6h': 0, '6–24h': 0, '>24h': 0, 'expiring <6h': 0 };
  offers.forEach(o => {
    const age = now - (o.timestamp || now);
    if (age < 3600) buckets['<1h'] += 1;
    else if (age < 6 * 3600) buckets['1–6h'] += 1;
    else if (age < 86400) buckets['6–24h'] += 1;
    else buckets['>24h'] += 1;
    const left = (o.timestamp || 0) + (o.time_valid || 0) - now;
    if (left > 0 && left < 6 * 3600) buckets['expiring <6h'] += 1;
  });
  return Object.entries(buckets).map(([k, v]) => k + '  ' + v).join('\n');
}

function setupKeyboardNav(pairParam) {
  document.onkeydown = (e) => {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === 'Escape' && pairParam) {
      location.href = './';
      return;
    }
    if (!pairParam) return;
    const list = topPairs(TOP_N);
    const k = pairKey(pairParam.base, pairParam.quote);
    let idx = list.findIndex(t => pairKey(t.base, t.quote) === k);
    if (idx < 0) return;
    if (e.key === '[') {
      const prev = list[(idx - 1 + list.length) % list.length];
      location.href = pairUrl(prev.base, prev.quote);
    } else if (e.key === ']') {
      const next = list[(idx + 1) % list.length];
      location.href = pairUrl(next.base, next.quote);
    }
  };
}

function pairExists(base, quote) {
  return liveOffers().some(o =>
    (o.coin_from === base && o.coin_to === quote) ||
    (o.coin_from === quote && o.coin_to === base)
  );
}

function pairUrl(base, quote) {
  return '?pair=' + encodeURIComponent(base + '-' + quote);
}

function asciiBar(value, max, width) {
  width = width || BAR_W;
  if (!max || max <= 0) return '';
  const n = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '#'.repeat(n);
}

function suffix24h(delta, deltaPct) {
  if (delta != null && delta !== 0) {
    const sign = delta > 0 ? '+' : '−';
    return ' (' + sign + f.int(Math.abs(delta)) + ' vs 24h ago)';
  }
  if (deltaPct != null && isFinite(deltaPct) && deltaPct !== 0) {
    return f.pctDelta(deltaPct);
  }
  return '';
}

function renderNow() {
  const d = latestOrderbook || {};
  const offers = liveOffers();
  let liq = 0;
  offers.forEach(o => { liq += offerUsdSize(o); });

  const pairs = typeof d.unique_pairs === 'number' ? d.unique_pairs : new Set(
    offers.map(o => pairKey(o.coin_from, o.coin_to))
  ).size;
  const makers = typeof d.unique_makers === 'number' ? d.unique_makers
    : new Set(offers.map(o => o.addr_from).filter(Boolean)).size;
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const newest = allOffers.filter(o => (o.timestamp || 0) >= cutoff).length;

  const past = snapshotAround(Math.floor(Date.now() / 1000) - 86400);
  const dLiqPct = past && past.active_offers
    ? ((offers.length - past.active_offers) / past.active_offers) * 100 : null;
  const liveDeltaPct = past
    ? ((offers.length - past.active_offers) / Math.max(1, past.active_offers)) * 100 : null;

  const ts = d.timestamp;
  const age = ts ? Math.floor(Date.now() / 1000) - ts : null;

  return [
    kv('listed liquidity', f.fiatCompact(liq), suffix24h(null, dLiqPct)),
    kv('active pairs', f.int(pairs), suffix24h(deltaVs24h(pairs, 'unique_pairs'))),
    kv('active makers', f.int(makers), suffix24h(deltaVs24h(makers, 'unique_makers'))),
    kv('live offers', f.int(offers.length), suffix24h(null, liveDeltaPct)),
    kv('new offers · 24h', f.int(newest)),
    kv('snapshot age', age != null ? f.ageShort(age) : '—'),
  ].join('\n');
}

function renderTopPairsSection(watchlist, highlightPair) {
  let list = topPairs(TOP_N);
  if (watchlist.length) {
    const keys = watchlistKeys(watchlist);
    list = list.filter(t => keys.has(pairKey(t.base, t.quote)));
    if (!list.length) {
      list = topPairs(50).filter(t => keys.has(pairKey(t.base, t.quote)));
    }
  }
  if (!list.length) return { text: watchlist.length ? '(no live pairs in watchlist)' : '(no live pairs)', html: '' };

  const totalLiq = totalNetworkLiq();
  const shownLiq = list.reduce((s, t) => s + t.liq, 0);
  const maxLiq = list[0].liq;

  const rows = list.map((t, i) => {
    const sp = pairSpread(t.base, t.quote);
    const spStr = sp != null ? spreadWord(sp) + ' ' + sp.toFixed(1) + '%' : '—';
    const pct = totalLiq ? Math.round(t.liq / totalLiq * 100) + '%' : '—';
    const delta = pairDelta24h(t.base, t.quote, t.offers);
    const deltaStr = delta == null ? '—' : (delta === 0 ? '0' : (delta > 0 ? '+' + delta : String(delta)));
    const spark = asciiSparkline(pairSparklineSeries(t.base, t.quote));
    const bar = asciiBar(t.liq, maxLiq, BAR_W);
    return {
      rank: String(i + 1),
      pair: t.base + '/' + t.quote,
      base: t.base,
      quote: t.quote,
      liq: f.fiatCompact(t.liq),
      pct,
      bar,
      spread: spStr,
      n: String(t.offers),
      delta: deltaStr,
      spark,
    };
  });

  const tableRows = rows.map(r => [
    r.rank, r.pair, r.liq, r.pct, r.bar, r.spread, r.n, r.delta, r.spark,
  ]);
  const text = asciiTable(
    ['#', 'Pair', 'Liq', '%', 'Bar', 'Spread', 'N', 'Δ24h', 'Trend'],
    tableRows,
    ['r', 'l', 'r', 'r', 'l', 'r', 'r', 'r', 'l']
  ) + '\n\n' + f.fiatCompact(shownLiq) + ' shown · '
    + f.fiatCompact(totalLiq) + ' total · top ' + list.length + ' pairs';

  const htmlRows = rows.map(r => {
    const isCurrent = highlightPair
      && pairKey(r.base, r.quote) === pairKey(highlightPair.base, highlightPair.quote);
    return '<tr' + (isCurrent ? ' class="current-pair"' : '') + '>'
    + '<td>' + esc(r.rank) + '</td>'
    + '<td><a href="' + esc(pairUrl(r.base, r.quote)) + '">' + esc(r.pair) + '</a></td>'
    + '<td>' + esc(r.liq) + '</td>'
    + '<td>' + esc(r.pct) + '</td>'
    + '<td class="bar-cell">' + esc(r.bar) + '</td>'
    + '<td>' + esc(r.spread) + '</td>'
    + '<td>' + esc(r.n) + '</td>'
    + '<td>' + esc(r.delta) + '</td>'
    + '<td class="spark-cell">' + esc(r.spark) + '</td>'
    + '</tr>';
  }).join('\n');

  const html = '<table class="data-table">'
    + '<thead><tr>'
    + '<th>#</th><th>Pair</th><th>Liq</th><th>%</th><th>Bar</th>'
    + '<th>Spread</th><th>N</th><th>Δ24h</th><th>Trend</th>'
    + '</tr></thead><tbody>' + htmlRows + '</tbody></table>'
    + '<p class="table-foot muted">' + esc(
      f.fiatCompact(shownLiq) + ' shown · ' + f.fiatCompact(totalLiq) + ' total · top ' + list.length + ' pairs'
    ) + '</p>';

  return { text, html };
}

function renderActivityChart() {
  const snaps = snapshotManifest.slice(-12);
  if (snaps.length < 2) return '';

  function series(field) {
    return snaps.map(s => s[field] || 0);
  }

  function pairCountSeries() {
    return snaps.map(s => Object.keys(s.pair_counts || {}).length);
  }

  function chart(vals, height) {
    height = height || 3;
    const min = Math.min(...vals), max = Math.max(...vals);
    const rng = max - min || 1;
    const grid = Array.from({ length: height }, () => Array(snaps.length).fill(' '));
    vals.forEach((v, i) => {
      const row = Math.min(height - 1, Math.floor(((v - min) / rng) * height));
      for (let r = 0; r <= row; r++) grid[height - 1 - r][i] = '#';
    });
    const lines = [];
    for (let r = 0; r < height; r++) {
      const yVal = max - (rng * r / Math.max(1, height - 1));
      lines.push(padLeft(f.int(Math.round(yVal)), 3) + '|' + grid[r].join(''));
    }
    return lines;
  }

  const offers = series('active_offers');
  const totals = series('num_offers');
  const pairs = pairCountSeries();
  const firstTs = snaps[0].ts || 0;
  const lastTs = snaps[snaps.length - 1].ts || 0;
  const spanH = Math.max(1, Math.round((lastTs - firstTs) / 3600));

  const labels = snaps.map((s, i) =>
    fmtSnapLabel(s.ts || 0, i === snaps.length - 1)
  );

  const lines = [
    'last ' + snaps.length + ' snapshots · ~' + spanH + 'h window',
    '',
    'live offers',
    ...chart(offers),
    '',
    'total offers',
    ...chart(totals),
    '',
    'active pairs',
    ...chart(pairs),
    '   +' + '-'.repeat(snaps.length),
    '    ' + labels.map(l => padRight(l, 2)).join(''),
    'now ' + offers[offers.length - 1] + ' live · '
      + totals[totals.length - 1] + ' total · '
      + pairs[pairs.length - 1] + ' pairs',
  ];
  return lines.join('\n');
}

function renderMakersTable() {
  const makers = topMakers(8);
  if (!makers.length) return '(no makers)';
  return asciiTable(
    ['Maker', 'Offers', 'Liq', 'Pairs'],
    makers.map(m => [
      knownMakerLabel(m.addr),
      String(m.offers),
      f.fiatCompact(m.liq),
      String(m.pairCount),
    ]),
    ['l', 'r', 'r', 'r']
  );
}

function renderDiffSection() {
  if (snapshotManifest.length < 2) return '';
  const prev = snapshotManifest[snapshotManifest.length - 2];
  const cur = snapshotManifest[snapshotManifest.length - 1];
  const dOffers = (cur.active_offers || 0) - (prev.active_offers || 0);
  const dTotal = (cur.num_offers || 0) - (prev.num_offers || 0);
  const prevPairs = new Set(Object.keys(prev.pair_counts || {}));
  const curPairs = new Set(Object.keys(cur.pair_counts || {}));
  const gained = [...curPairs].filter(k => !prevPairs.has(k)).sort();
  const lost = [...prevPairs].filter(k => !curPairs.has(k)).sort();

  const lines = [
    'since previous snapshot (' + (prev.file || '?') + ')',
    'live offers  ' + (dOffers >= 0 ? '+' : '') + dOffers
      + '  (' + (prev.active_offers || 0) + ' → ' + (cur.active_offers || 0) + ')',
    'total offers ' + (dTotal >= 0 ? '+' : '') + dTotal
      + '  (' + (prev.num_offers || 0) + ' → ' + (cur.num_offers || 0) + ')',
  ];
  if (gained.length) {
    lines.push('pairs gained  ' + gained.slice(0, 6).join(', ') + (gained.length > 6 ? '…' : ''));
  }
  if (lost.length) {
    lines.push('pairs lost    ' + lost.slice(0, 6).join(', ') + (lost.length > 6 ? '…' : ''));
  }
  if (!gained.length && !lost.length) lines.push('pairs         unchanged');

  const movers = [];
  [...curPairs].forEach(k => {
    if (!prevPairs.has(k)) return;
    const d = (cur.pair_counts[k] || 0) - (prev.pair_counts[k] || 0);
    if (d) movers.push([k, d, prev.pair_counts[k] || 0, cur.pair_counts[k] || 0]);
  });
  movers.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (movers.length) {
    lines.push('');
    lines.push('pair offer churn (top)');
    movers.slice(0, 8).forEach(([k, d, a, b]) => {
      lines.push('  ' + padRight(k, 12) + (d >= 0 ? '+' : '') + d + '  (' + a + ' → ' + b + ')');
    });
  }
  return lines.join('\n');
}

function renderRelatedPairs(base, quote) {
  const current = pairKey(base, quote);
  const related = topPairs(50).filter(t => {
    if (pairKey(t.base, t.quote) === current) return false;
    return t.base === base || t.quote === quote || t.base === quote || t.quote === base;
  }).slice(0, 5);
  if (!related.length) return { text: '', html: '' };

  const rows = related.map(t => {
    const sp = pairSpread(t.base, t.quote);
    return [
      t.base + '/' + t.quote,
      f.fiatCompact(t.liq),
      String(t.offers),
      sp != null ? spreadWord(sp) : '—',
    ];
  });
  const text = asciiTable(['Pair', 'Liq', 'N', 'Spread'], rows, ['l', 'r', 'r', 'r']);
  const htmlRows = related.map(t =>
    '<tr><td><a href="' + esc(pairUrl(t.base, t.quote)) + '">'
    + esc(t.base + '/' + t.quote) + '</a></td>'
    + '<td>' + esc(f.fiatCompact(t.liq)) + '</td>'
    + '<td>' + esc(String(t.offers)) + '</td>'
    + '<td>' + esc(spreadWord(pairSpread(t.base, t.quote))) + '</td></tr>'
  ).join('');
  const html = '<table class="data-table"><thead><tr>'
    + '<th>Pair</th><th>Liq</th><th>N</th><th>Spread</th></tr></thead><tbody>'
    + htmlRows + '</tbody></table>';
  return { text, html };
}

function renderBulletinArchive() {
  if (!bulletinManifest.length) return { text: '', html: '' };
  const items = bulletinManifest.slice(0, 12);
  const text = items.map(b => (b.kind === 'weekly' ? 'week  ' : 'daily ') + b.file).join('\n');
  const html = '<ul class="bulletin-list">' + items.map(b =>
    '<li><span class="muted">' + esc(b.kind) + '</span> '
    + '<a href="bulletins/' + esc(b.file) + '">' + esc(b.file) + '</a></li>'
  ).join('') + '</ul>';
  return { text, html };
}

function embedMarkdown(base, quote, liq) {
  const url = pageBaseUrl() + pairUrl(base, quote);
  const label = base + '/' + quote + ' · ' + f.fiatCompact(liq) + ' on BasicSwap';
  return '[' + label + '](' + url + ')';
}

function asciiBeerHtml() {
  return '<span class="ascii-icon ascii-beer" aria-hidden="true">'
    + '<span class="ascii-stack"><span class="beer-foam">~~</span><br>'
    + '<span class="beer-body">[</span><span class="beer-fill">▓▓</span><span class="beer-body">]</span></span>'
    + '</span>';
}

function asciiCoffeeHtml() {
  return '<span class="ascii-icon ascii-coffee" aria-hidden="true">'
    + '<span class="ascii-stack"><span class="coffee-steam">~ ~</span><br>'
    + '<span class="coffee-cup">(</span><span class="coffee-liquid">~~</span><span class="coffee-cup">)</span></span>'
    + '</span>';
}

function renderNewOffers24h() {
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const byPair = {};
  allOffers.forEach(o => {
    if ((o.timestamp || 0) < cutoff || isExpired(o)) return;
    const k = pairKey(o.coin_from, o.coin_to);
    byPair[k] = (byPair[k] || 0) + 1;
  });
  const entries = Object.entries(byPair).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!entries.length) return '(none in last 24h)';
  return asciiTable(
    ['Pair', 'New'],
    entries.map(([k, n]) => [k, '+' + n]),
    ['l', 'r']
  );
}

function renderOrderBook(asks, bids, base, quote, mid, limit) {
  const row = o => [f.coin(o.price), f.coin(o.amount), f.coin(o.total)];
  const askRows = asks.slice(0, limit).reverse().map(row);
  const bidRows = bids.slice(0, limit).map(row);
  if (!askRows.length && !bidRows.length) return { text: '(empty)', html: '' };

  const headers = ['Price', 'Size', 'Total'];
  const tableRows = [...askRows, ...bidRows];
  let text = asciiTable(headers, tableRows, ['r', 'r', 'r']);
  if (mid != null && (askRows.length || bidRows.length)) {
    const midLine = '--- mid ' + f.coin(mid) + ' ' + quote + ' ---';
    const lines = text.split('\n');
    const insertAt = 2 + askRows.length;
    lines.splice(insertAt, 0, midLine);
    text = lines.join('\n');
  }

  let htmlRows = askRows.map(r =>
    '<tr class="ask-row"><td class="num">' + r[0] + '</td><td class="num">' + r[1]
    + '</td><td class="num">' + r[2] + '</td></tr>'
  ).join('');
  if (mid != null && askRows.length && bidRows.length) {
    htmlRows += '<tr class="mid-row"><td colspan="3">— mid ' + esc(f.coin(mid) + ' ' + quote) + ' —</td></tr>';
  } else if (mid != null && (askRows.length || bidRows.length)) {
    htmlRows += '<tr class="mid-row"><td colspan="3">— mid ' + esc(f.coin(mid) + ' ' + quote) + ' —</td></tr>';
  }
  htmlRows += bidRows.map(r =>
    '<tr class="bid-row"><td class="num">' + r[0] + '</td><td class="num">' + r[1]
    + '</td><td class="num">' + r[2] + '</td></tr>'
  ).join('');

  const html = '<table class="data-table book-table"><thead><tr>'
    + headers.map(h => '<th>' + esc(h) + '</th>').join('')
    + '</tr></thead><tbody>' + htmlRows + '</tbody></table>';

  return { text, html };
}

function renderPairDetail(base, quote) {
  if (!pairExists(base, quote)) {
    return {
      statsText: '(no live offers for this pair)\n',
      bookText: '',
      totalLevels: 0,
    };
  }

  const { bids, asks } = getBidsAsks(base, quote);
  const spread = pairSpread(base, quote);
  const mid = bids.length && asks.length
    ? (bids[0].price + asks[0].price) / 2
    : (bids[0]?.price ?? asks[0]?.price ?? null);

  let liq = 0, count = 0;
  liveOffers().forEach(o => {
    if ((o.coin_from === base && o.coin_to === quote) ||
        (o.coin_from === quote && o.coin_to === base)) {
      liq += offerUsdSize(o);
      count += 1;
    }
  });

  const stats = [];
  const rank = pairRank(base, quote);
  const totalLiq = totalNetworkLiq();
  if (rank != null) {
    const share = totalLiq ? Math.round(liq / totalLiq * 100) : 0;
    stats.push(kv('rank', '#' + rank + ' · ' + share + '% of network'));
  }
  stats.push(
    kv('liquidity', f.fiatCompact(liq)),
    kv('live offers', f.int(count)),
  );

  const delta = pairDelta24h(base, quote, count);
  if (delta != null) {
    stats.push(kv('offers Δ24h', delta === 0 ? '0' : (delta > 0 ? '+' + delta : String(delta))));
  }
  const spark = asciiSparkline(pairSparklineSeries(base, quote));
  if (spark.trim() !== '·'.repeat(SPARK_W)) {
    stats.push(kv('trend', spark));
  }

  if (bids.length) {
    stats.push(kv('best bid', f.coin(bids[0].price) + ' ' + quote));
  }
  if (asks.length) {
    stats.push(kv('best ask', f.coin(asks[0].price) + ' ' + quote));
  }
  if (spread != null) {
    stats.push(kv('spread', spreadWord(spread) + ' · ' + spread.toFixed(2) + '%'));
  }
  if (mid != null) {
    stats.push(kv('mid', f.coin(mid) + ' ' + quote));
  }

  const limit = bookExpanded ? 20 : BOOK_DEFAULT;
  const book = renderOrderBook(asks, bids, base, quote, mid, limit);

  return {
    statsText: stats.join('\n') + '\n',
    bookText: book.text ? book.text + '\n' : '',
    bookHtml: book.html,
    totalLevels: bids.length + asks.length,
  };
}

function renderNetwork() {
  const d = latestOrderbook || {};
  const st = d.stats || {};
  const h = latestHealth || {};
  const msgsIn = st.msgs_received ?? h.msgs_received ?? '—';
  const bsxMsgs = st.offers_parsed ?? h.offers_parsed ?? '—';
  const foreign = (typeof msgsIn === 'number' && typeof st.msgs_decrypted === 'number')
    ? msgsIn - st.msgs_decrypted : '—';

  const lines = [
    kv('SMSGs in', f.int(msgsIn)),
    kv('BSX messages', f.int(bsxMsgs)),
    kv('foreign SMSGs', typeof foreign === 'number' ? f.int(foreign) : foreign),
    kv('scrape duration', h.duration_s != null ? h.duration_s + 's' : '—'),
    kv('msg rate', h.msg_rate_per_s != null ? h.msg_rate_per_s.toFixed(1) + '/s' : '—'),
    kv('last run ok', h.ok === true ? 'yes' : h.ok === false ? 'no' : '—'),
  ];
  return lines.join('\n');
}

function block(label, content) {
  if (!content) return '';
  return '<p class="section">' + esc(sectionLabel(label)) + '</p>\n<pre class="data">' + esc(content) + '</pre>\n';
}

function blockHtml(label, html, note) {
  if (!html) return '';
  const noteHtml = note ? ' <span class="section-note muted">' + esc(note) + '</span>' : '';
  return '<div class="table-wrap"><p class="section">' + esc(sectionLabel(label)) + noteHtml + '</p>\n' + html + '</div>\n';
}

function renderPage() {
  const out = document.getElementById('out');
  if (!out) return;

  const route = parseRoute();
  const pairParam = route.pair;
  const markPair = route.mark;
  const urlWatch = route.watchlist;
  const storedWatch = loadStoredWatchlist();
  const watchlist = urlWatch.length ? mergeWatchlists(urlWatch, storedWatch) : storedWatch;
  const pairKeyNow = pairParam ? pairParam.base + '|' + pairParam.quote : null;
  if (pairKeyNow !== lastPairKey) {
    bookExpanded = false;
    lastPairKey = pairKeyNow;
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: '2-digit',
  }) + ' ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const updated = latestOrderbook?.updated_at || '—';
  const ts = latestOrderbook?.timestamp;
  const age = ts ? f.ageShort(Math.floor(Date.now() / 1000) - ts) : '—';

  const ageSec = snapshotAgeSec();

  if (pairParam) {
    document.title = pairParam.base + '/' + pairParam.quote + ' · BasicSwap plain stats';
  } else {
    document.title = 'BasicSwap · plain text market stats';
  }

  if (!latestOrderbook) {
    out.innerHTML =
      '<p class="tagline">plain text market stats</p>'
      + '<p class="err">Failed to load orderbook</p>'
      + '<p class="nav-top"><a href="../">full markets view</a></p>';
    out.style.maxWidth = '';
    return;
  }

  const nowText = renderNow();
  const topPairsBlock = !pairParam ? renderTopPairsSection(watchlist, markPair) : { text: '', html: '' };
  const topPairsText = topPairsBlock.text;
  const topPairsWidthRef = pairParam ? renderTopPairsSection([]).text : topPairsBlock.text;
  const activityText = !pairParam ? renderActivityChart() : '';
  const newOffersText = !pairParam ? renderNewOffers24h() : '';
  const makersText = !pairParam ? renderMakersTable() : '';
  const diffText = !pairParam ? renderDiffSection() : '';
  const bulletinBlock = !pairParam ? renderBulletinArchive() : { text: '', html: '' };
  const detail = pairParam ? renderPairDetail(pairParam.base, pairParam.quote) : null;
  const relatedBlock = pairParam && detail ? renderRelatedPairs(pairParam.base, pairParam.quote) : { text: '', html: '' };
  const networkText = renderNetwork();
  const footerLine = 'market data last fetched at: ' + updated + ' (' + age + ' ago)';
  const headlineLine = 'BasicSwap · Particl SMSG network  ' + dateStr;
  const pairSectionLabel = pairParam ? pairParam.base + ' / ' + pairParam.quote : '';
  const watchNote = watchlist.length
    ? watchlist.map(w => w.base + '/' + w.quote).join(', ')
    : '';

  const coinLiqText = !pairParam ? renderCoinLiquidity() : '';
  const freshnessText = !pairParam ? renderOfferFreshness() : '';

  const w = contentWidth(
    ASCII_LOGO,
    headlineLine,
    pairParam ? (detail?.statsText || '') : nowText,
    topPairsWidthRef,
    pairParam ? (detail?.bookText || '') : activityText,
    pairParam ? (relatedBlock.text || '') : newOffersText,
    pairParam ? '' : makersText,
    pairParam ? '' : diffText,
    pairParam ? '' : coinLiqText,
    pairParam ? '' : freshnessText,
    networkText,
    footerLine
  );

  updatePageMeta(pairParam, detail);
  setupKeyboardNav(pairParam);

  out.style.maxWidth = w + 'ch';

  let html = '';

  html += '<pre class="logo' + (isSkynetMode() ? ' skynet-logo' : '') + '" aria-hidden="true">'
    + esc(ASCII_LOGO) + '</pre>\n';
  html += '<p class="tagline">' + esc(isSkynetMode() ? 'MARKET INTELLIGENCE · PLAIN MODE' : 'plain text market stats') + '</p>\n';
  html += '<p class="headline">' + esc(isSkynetMode() ? 'PARTSMSG MESH' : 'BasicSwap · Particl SMSG network')
    + '<br>' + esc(dateStr) + '</p>\n';
  html += '<p class="nav-top"><a href="../">full markets view</a> · ' + themeToggleHtml() + '</p>\n';

  if (pairParam) {
    html += '<p class="nav-back muted"><a href="./">← network overview</a></p>\n';
  } else if (watchlist.length) {
    html += '<p class="nav-back muted">watchlist: ' + esc(watchNote)
      + ' · <a href="./">clear</a></p>\n';
  } else if (markPair) {
    html += '<p class="nav-back muted">highlight: ' + esc(markPair.base + '/' + markPair.quote)
      + ' · <a href="./">clear</a></p>\n';
  }

  html += hr('=', w);
  html += renderStaleBanner(ageSec);

  if (pairParam && detail) {
    html += block(pairSectionLabel, detail.statsText.trim());
    if (detail.bookHtml) {
      html += blockHtml('Order book', detail.bookHtml);
    } else if (detail.bookText) {
      html += block('Order book', detail.bookText.trim());
    }
    if (detail.totalLevels > BOOK_DEFAULT * 2) {
      const label = bookExpanded
        ? 'show fewer levels'
        : 'show more levels (' + detail.totalLevels + ' total)';
      html += '<p><button type="button" class="expand-btn" id="book-toggle">» ' + esc(label) + '</button></p>\n';
    }
    if (relatedBlock.html) {
      html += blockHtml('Related pairs', relatedBlock.html);
    } else if (relatedBlock.text) {
      html += block('Related pairs', relatedBlock.text);
    }
    html += renderPairPager(pairParam.base, pairParam.quote);
    const watchKey = pairKey(pairParam.base, pairParam.quote);
    const onWatch = watchlistKeys(watchlist).has(watchKey);
    html += '<p class="watch-actions"><button type="button" class="expand-btn" id="watch-toggle">'
      + (onWatch ? '★ remove from watchlist' : '☆ add to watchlist') + '</button></p>\n';
  } else {
    html += block('Now', nowText);

    html += hr('=', w);
    if (topPairsBlock.html) {
      html += blockHtml('Top pairs', topPairsBlock.html, watchlist.length ? 'filtered' : '');
    } else {
      html += block('Top pairs', topPairsText);
    }
    if (activityText) html += block('Activity', activityText);

    if (coinLiqText) {
      html += hr('=', w);
      html += block('Liquidity by coin', coinLiqText);
    }
    if (freshnessText) html += block('Offer freshness', freshnessText);

    html += hr('=', w);
    html += block('New offers · 24h', newOffersText);

    if (makersText) {
      html += hr('=', w);
      html += block('Makers', makersText);
    }

    if (diffText) {
      html += hr('-', w, true);
      html += block('Since last snapshot', diffText);
      html += '<p class="muted"><a href="diff.html">full diff view →</a></p>\n';
    }

    if (bulletinBlock.html || bulletinBlock.text) {
      html += hr('-', w, true);
      if (bulletinBlock.html) {
        html += blockHtml('Bulletin archive', bulletinBlock.html);
      } else {
        html += block('Bulletin archive', bulletinBlock.text);
      }
    }
  }

  html += hr('=', w);
  html += block('Network', networkText);

  html += hr('-', w, true);
  html += '<footer class="muted">\n'
    + '<p>' + esc(footerLine) + '</p>\n';
  if (pairParam) {
    const shareUrl = pageBaseUrl() + pairUrl(pairParam.base, pairParam.quote);
    html += '<p class="share-line">share: <a href="' + esc(pairUrl(pairParam.base, pairParam.quote)) + '">'
      + esc('?pair=' + pairParam.base + '-' + pairParam.quote) + '</a>'
      + ' · <a href="pairs/' + esc(pairParam.base + '-' + pairParam.quote) + '.txt">txt</a>'
      + ' · <a href="./?mark=' + encodeURIComponent(pairParam.base + '-' + pairParam.quote) + '">highlight</a></p>\n';
    let liq = 0;
    liveOffers().forEach(o => {
      if ((o.coin_from === pairParam.base && o.coin_to === pairParam.quote) ||
          (o.coin_from === pairParam.quote && o.coin_to === pairParam.base)) {
        liq += offerUsdSize(o);
      }
    });
    const md = embedMarkdown(pairParam.base, pairParam.quote, liq);
    html += '<p class="embed-line muted">embed: <code class="embed-code">' + esc(md) + '</code></p>\n';
  }
  html += hr('-', w, true)
    + '<p>data: <a href="../orderbook.json">orderbook.json</a>'
    + ' · <a href="stats.txt">stats.txt</a>'
    + ' · <a href="feed.xml">rss</a>'
    + ' · <a href="feed.json">json feed</a>'
    + ' · <a href="../status.txt">status</a>'
    + ' · <a href="health.html">health</a>'
    + ' · <a href="diff.html">diff</a>'
    + ' · <a href="https://basicswapdex.com">basicswapdex.com</a></p>\n'
    + '<p class="kbd-hint muted">[ ] prev/next pair · Esc overview</p>\n'
    + '<p>© ' + new Date().getFullYear() + ' BasicSwap DEX</p>\n'
    + '<p>made with <span class="heart" aria-hidden="true">♥</span> by '
    + '<a href="https://github.com/gerlofvanek" rel="noopener noreferrer">crz</a></p>\n'
    + '<p class="donate-head">' + asciiBeerHtml() + ' ' + asciiCoffeeHtml()
    + ' buy me a beer or coffee</p>\n'
    + '<p class="donate-xmr"><span class="donate-label">XMR:</span> '
    + '<button type="button" class="donate-btn" id="xmr-donate" title="Click to copy Monero address">'
    + esc(XMR_DONATE) + '</button></p>\n'
    + '</footer>\n';

  out.innerHTML = html;

  window.bsxPlainTheme?.bind();
  window.bsxPlainTheme?.syncToggleState?.();

  document.getElementById('xmr-donate')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const prev = btn.textContent;
    try {
      await navigator.clipboard.writeText(XMR_DONATE);
      btn.textContent = 'Copied!';
    } catch (err) {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => { btn.textContent = prev; }, 1500);
  });

  document.getElementById('book-toggle')?.addEventListener('click', () => {
    bookExpanded = !bookExpanded;
    renderPage();
  });

  document.getElementById('watch-toggle')?.addEventListener('click', () => {
    if (!pairParam) return;
    const w = { base: pairParam.base, quote: pairParam.quote };
    let list = loadStoredWatchlist();
    const k = pairKey(w.base, w.quote);
    const has = list.some(x => pairKey(x.base, x.quote) === k);
    if (has) list = list.filter(x => pairKey(x.base, x.quote) !== k);
    else list.push(w);
    saveWatchlist(list);
    renderPage();
  });
}

async function fetchSummary() {
  try {
    const r = await fetch('summary.json?' + Date.now());
    if (!r.ok) return;
    cachedSummary = await r.json();
    if (cachedSummary?.usd_prices) {
      for (const [ticker, usd] of Object.entries(cachedSummary.usd_prices)) {
        const cid = COIN_GECKO_IDS[ticker];
        if (cid && usd) latestPrices[cid] = usd;
      }
    }
  } catch (e) { /* optional */ }
}

async function fetchPrices() {
  try {
    const ids = [...new Set(Object.values(COIN_GECKO_IDS))].join(',');
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=usd');
    if (!r.ok) return;
    const d = await r.json();
    if (d.status) return;
    for (const [id, val] of Object.entries(d)) {
      if (val?.usd) latestPrices[id] = val.usd;
    }
  } catch (e) { console.warn('Price fetch failed:', e); }
}

async function fetchManifest() {
  try {
    const r = await fetch(DATA.manifest, { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (j?.snapshots) snapshotManifest = j.snapshots.slice(-200);
  } catch (e) { /* optional */ }
}

async function fetchHealth() {
  try {
    const r = await fetch(DATA.health + '?' + Date.now());
    if (r.ok) latestHealth = await r.json();
  } catch (e) { /* optional */ }
}

async function fetchOrderbook() {
  const r = await fetch(DATA.orderbook + '?' + Date.now());
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  latestOrderbook = d;
  allOffers = d.offers || [];
}

async function fetchBulletins() {
  try {
    const r = await fetch('bulletins/manifest.json?' + Date.now());
    if (!r.ok) return;
    const j = await r.json();
    bulletinManifest = j.bulletins || [];
  } catch (e) { /* optional */ }
}

async function loadAll() {
  await Promise.all([fetchManifest(), fetchHealth(), fetchSummary(), fetchBulletins()]);
  try {
    await fetchOrderbook();
  } catch (e) {
    console.error(e);
    latestOrderbook = null;
  }
  await fetchPrices();
  renderPage();
}

loadAll();
setInterval(loadAll, REFRESH_MS);

document.addEventListener('bsx-skynet-change', () => renderPage());
