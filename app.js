/* ============================================================================
   BasicSwap · Markets · live data layer + renderers
   ----------------------------------------------------------------------------
   Reads:
     orderbook.json         — current snapshot written by scraper.py
     health.json            — last-run telemetry
     snapshots/manifest.json — recent historical snapshots for 24h deltas
     CoinGecko /simple/price — USD reference price per coin
     CoinGecko /coins/{id}/market_chart — price history for the selected pair
   ============================================================================ */

const COIN_GECKO_IDS = {
  BTC:'bitcoin', XMR:'monero', LTC:'litecoin', PART:'particl',
  PART_BLIND:'particl', PART_ANON:'particl', BCH:'bitcoin-cash',
  FIRO:'zcoin', DASH:'dash', PIVX:'pivx', WOW:'wownero',
  DOGE:'dogecoin', DCR:'decred', NAV:'nav-coin', NMC:'namecoin',
  LTC_MWEB:'litecoin',
};

// name + brand colour per coin. Colours mirror the mockup and the project's existing palette.
const COIN_META = {
  BTC:{name:'Bitcoin',       c:'#f7931a'},
  XMR:{name:'Monero',        c:'#ff6600'},
  LTC:{name:'Litecoin',      c:'#345d9d'},
  BCH:{name:'Bitcoin Cash',  c:'#0ac18e'},
  PART:{name:'Particl',      c:'#00e0a4'},
  PART_BLIND:{name:'Particl Blind', c:'#0bbf88'},
  PART_ANON:{name:'Particl Anon',   c:'#0a8f6a'},
  FIRO:{name:'Firo',         c:'#9b1c2e'},
  PIVX:{name:'PIVX',         c:'#5e4778'},
  WOW:{name:'Wownero',       c:'#df3c71'},
  DASH:{name:'Dash',         c:'#008ce7'},
  DOGE:{name:'Dogecoin',     c:'#c2a633'},
  DCR:{name:'Decred',        c:'#2ed6a1'},
  NAV:{name:'Navcoin',       c:'#3399cc'},
  NMC:{name:'Namecoin',      c:'#1A6ABF'},
  LTC_MWEB:{name:'Litecoin MWEB', c:'#345d9d'},
};
function coinMeta(t){ return COIN_META[t] || {name:t, c:'#64748b'}; }

// Mirrors basicswap/basicswap_util.py SwapTypes IntEnum.
const SWAP_TYPES = {1:'Secret Hash',2:'Buyer First (legacy)',3:'Seller First 2-msg (legacy)',
                    4:'Buyer First 2-msg (legacy)',5:'Adaptor Sig',6:'BCH Adaptor'};
const SWAP_TYPE_DESC = {
  'Secret Hash':'Classic HTLC atomic swap: both coins lock funds with a hash preimage. Requires Bitcoin-style scripting on both sides.',
  'Adaptor Sig':'Adaptor-signature atomic swap (a.k.a. XMR swap). Works when one coin has no HTLC support — e.g. Monero, Wownero.',
  'BCH Adaptor':'Adaptor-signature swap tuned for Bitcoin Cash CashScript.',
};

const REFRESH_INTERVAL_MS = 5*60*1000;       // client polls every 5 min (cron is */15)
const STALE_AFTER_S       = 30*60;           // freshness pill flips amber after 30 min
const VERY_STALE_AFTER_S  = 2*60*60;         // …and red after 2 hours
const PRICE_CACHE_KEY     = 'bsx-mkts-prices-v1';
const PRICE_CACHE_TTL_MS  = REFRESH_INTERVAL_MS;
const HIST_CACHE_KEY      = 'bsx-mkts-hist-v1'; // CoinGecko market_chart cache
const HIST_CACHE_TTL_MS   = 30*60*1000;
const TICKER_LIMIT        = 6;               // top-N pairs shown as tickers

/* ============================================================================
   GLOBAL STATE
   ============================================================================ */
let latestOrderbook = null;
let allOffers       = [];
let latestPrices    = {};       // CoinGecko id -> USD
let snapshotManifest = [];      // newest-last
let tipInstances    = [];
let priceChart      = null;
let depthChart      = null;
let sparkCharts     = [];
let unit            = 'usd';            // 'usd' | 'coin'
let resolution      = '1';              // CoinGecko `days` param for market_chart
let CUR             = null;             // {base, quote} of the selected pair
let pollTimer       = null;

/* ============================================================================
   FORMATTERS
   ============================================================================ */
const f = {
  fiat(n){ if(!isFinite(n)) return '—'; return '$'+Math.round(n).toLocaleString('en-US'); },
  fiatCompact(n){
    if(!isFinite(n) || n===null) return '—';
    if(n>=1e9) return '$'+(n/1e9).toFixed(n>=1e10?0:1)+'B';
    if(n>=1e6) return '$'+(n/1e6).toFixed(n>=1e7?0:1)+'M';
    if(n>=1e3) return '$'+(n/1e3).toFixed(n>=1e4?0:1)+'K';
    if(n===0)  return '$0';
    if(n<1)    return '$'+n.toFixed(2);
    return '$'+n.toLocaleString('en-US');
  },
  pct(n){ return (n>0?'+':'')+n.toFixed(2)+'%'; },
  int(n){ return n.toLocaleString('en-US'); },
  coin(n){
    if(n===0 || !isFinite(n)) return '0';
    const d = Math.max(0, 5 - Math.floor(Math.log10(Math.abs(n))) - 1);
    return n.toLocaleString('en-US', {maximumFractionDigits: Math.min(8, Math.max(2,d))});
  },
  coinFull(n){ if(!isFinite(n)) return '0'; return n.toLocaleString('en-US',{maximumFractionDigits:8}); },
  duration(s){
    if(!s || s<0) return '—';
    if(s<60)   return s+'s';
    if(s<3600) return Math.floor(s/60)+'m';
    if(s<86400)return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';
    return Math.floor(s/86400)+'d '+Math.floor((s%86400)/3600)+'h';
  },
  ageShort(s){
    if(s===null || s===undefined || s<0) return '—';
    if(s<60)   return s+'s';
    if(s<3600) return Math.floor(s/60)+'m';
    if(s<86400)return Math.floor(s/3600)+'h';
    return Math.floor(s/86400)+'d';
  },
};

/* ============================================================================
   PRICING HELPERS
   ============================================================================ */
function coinUsd(t){ return latestPrices[COIN_GECKO_IDS[t]] || 0; }
function offerUsdSize(o){ const p = coinUsd(o.coin_from); return p ? parseFloat(o.amount_from_str||0)*p : 0; }
function pairKey(a,b){ return a<b ? a+'/'+b : b+'/'+a; }
function isExpired(o){ return (o.timestamp + (o.time_valid||0)) <= Math.floor(Date.now()/1000); }
function liveOffers(){ return allOffers.filter(o => !isExpired(o)); }

function coinDot(sym, cls='w-5 h-5 text-[10px]'){
  const m = coinMeta(sym);
  return `<span class="inline-grid place-items-center rounded-full text-white font-bold ${cls}" style="background:${m.c}">${sym[0]}</span>`;
}
function spreadClass(p){
  if(!isFinite(p) || p<0) return {cls:'text-slate-400', word:'—'};
  if(p<1)  return {cls:'text-emerald-500', word:'tight'};
  if(p<=3) return {cls:'text-amber-500',   word:'fair'};
  return    {cls:'text-rose-500',          word:'wide'};
}
function dirChip(dir, good, pct){
  if(dir===null || dir===undefined || isNaN(dir) || dir===0) return '<span class="text-slate-400">no change</span>';
  const up = dir>0;
  const positive = good===undefined ? up : (good ? up : !up);
  const col = positive ? 'text-emerald-500' : 'text-rose-500';
  const val = pct ? Math.abs(dir).toFixed(1)+'%' : (up?'+':'−')+Math.abs(Math.round(dir)).toLocaleString();
  return `<span class="${col} font-semibold">${up?'▲':'▼'} ${val}</span>`;
}


/* ============================================================================
   ORDER-BOOK AGGREGATION
   ----------------------------------------------------------------------------
   For a directional pair (base, quote):
     - asks = offers selling BASE for QUOTE  (coin_from=base, coin_to=quote)
     - bids = offers buying  BASE with QUOTE (coin_from=quote, coin_to=base)
   Price is always expressed as QUOTE per BASE. amount is BASE units.
   ============================================================================ */
function getBidsAsks(base, quote){
  const bids=[], asks=[];
  liveOffers().forEach(o=>{
    const fa = parseFloat(o.amount_from_str), ta = parseFloat(o.amount_to_str);
    if(!fa || !ta) return;
    if(o.coin_from===base && o.coin_to===quote){
      asks.push({price: ta/fa, amount: fa, total: ta, offer: o});
    } else if(o.coin_from===quote && o.coin_to===base){
      bids.push({price: fa/ta, amount: ta, total: fa, offer: o});
    }
  });
  bids.sort((a,b)=> b.price - a.price);
  asks.sort((a,b)=> a.price - b.price);
  const qUsd = coinUsd(quote);
  let cumB=0, cumBu=0; bids.forEach(o=>{ cumB+=o.amount; cumBu+=o.total*qUsd; o.cum=cumB; o.cumUsd=cumBu; });
  let cumA=0, cumAu=0; asks.forEach(o=>{ cumA+=o.amount; cumAu+=o.total*qUsd; o.cum=cumA; o.cumUsd=cumAu; });
  return {bids, asks};
}

function getPairs(){
  const s = new Set();
  liveOffers().forEach(o=>{ if(o.coin_from && o.coin_to) s.add(pairKey(o.coin_from, o.coin_to)); });
  return [...s].sort();
}

// Heatmap aggregate: USD value of all live offers per (from,to) directed pair.
function aggregateHeatmap(){
  const liq = {}, coinSet = new Set();
  liveOffers().forEach(o=>{
    if(!o.coin_from || !o.coin_to) return;
    coinSet.add(o.coin_from); coinSet.add(o.coin_to);
    const k = o.coin_from + '|' + o.coin_to;
    liq[k] = (liq[k]||0) + offerUsdSize(o);
  });
  return { liq, coins: [...coinSet].sort() };
}
function heatLookup(liq, a, b){
  const sum = (liq[a+'|'+b] || 0) + (liq[b+'|'+a] || 0);
  return sum>0 ? sum : undefined;
}

/* ============================================================================
   24h DELTA HELPERS (from snapshot manifest)
   ============================================================================ */
function snapshotAround(targetTs){
  if(!snapshotManifest.length) return null;
  let best=null, bestDelta=Infinity;
  snapshotManifest.forEach(s=>{
    const d = Math.abs((s.ts||0) - targetTs);
    if(d < bestDelta){ bestDelta = d; best = s; }
  });
  // Only useful if the chosen snapshot is at least 6h away from "now" — otherwise it's a
  // noisy short-window delta we'd rather not advertise as "vs last 24h".
  if(Math.abs((best.ts||0) - targetTs) > 18*3600) return null;
  return best;
}
function deltaVs24h(currentValue, snapField){
  const past = snapshotAround(Math.floor(Date.now()/1000) - 86400);
  if(!past || past[snapField]==null) return null;
  return currentValue - past[snapField];
}

/* ============================================================================
   FRESHNESS PILL  (drives the trust signal — green/amber/red)
   ============================================================================ */
function updateFreshnessPill(){
  const pill  = document.getElementById('freshness-pill');
  const label = document.getElementById('freshness-label');
  if(!pill || !label) return;
  const ts = latestOrderbook && latestOrderbook.timestamp;
  pill.classList.remove('pill-fresh','pill-stale','pill-vstale');
  if(!ts){ label.textContent = 'No snapshot'; pill.classList.add('pill-vstale'); return; }
  const age = Math.floor(Date.now()/1000) - ts;
  if(age <= STALE_AFTER_S)           pill.classList.add('pill-fresh');
  else if(age <= VERY_STALE_AFTER_S) pill.classList.add('pill-stale');
  else                               pill.classList.add('pill-vstale');
  label.textContent = 'Updated ' + f.ageShort(age) + ' ago';
}

/* ============================================================================
   RENDER · HERO BAND
   ============================================================================ */
function renderHero(){
  const d = latestOrderbook || {};
  const offers = liveOffers();
  let liq = 0; offers.forEach(o=>{ liq += offerUsdSize(o); });
  const pairs  = (typeof d.unique_pairs ==='number') ? d.unique_pairs  : getPairs().length;
  const makers = (typeof d.unique_makers==='number') ? d.unique_makers : new Set(offers.map(o=>o.addr_from).filter(Boolean)).size;
  const cutoff = Math.floor(Date.now()/1000) - 86400;
  const newest = allOffers.filter(o => (o.timestamp||0) >= cutoff).length;

  const dPairs  = deltaVs24h(pairs,  'unique_pairs');
  const dMakers = deltaVs24h(makers, 'unique_makers');
  const past    = snapshotAround(Math.floor(Date.now()/1000) - 86400);
  const dActive = past ? (offers.length - (past.active_offers||0)) : null;
  // Liquidity delta as a percentage of active offer count — no historical USD in manifest.
  const dLiqPct = past && past.active_offers ? ((offers.length - past.active_offers)/past.active_offers)*100 : null;

  const set = (id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=v; };
  set('hl-pairs',  f.int(pairs));
  set('hl-makers', f.int(makers));
  set('hl-new',    f.int(newest));
  set('hl-liq',    f.fiatCompact(liq));

  const cards = [
    { k:'Listed liquidity', v:liq, fmt:'fiat', dir:dLiqPct, dpct:true, good:true,
      tip:'Total USD value of all live (unexpired) offers on the network right now.' },
    { k:'Active pairs', v:pairs, fmt:'int', dir:dPairs, good:true,
      tip:'Distinct coin pairs that currently have at least one live offer.' },
    { k:'Active makers', v:makers, fmt:'int', dir:dMakers, good:true,
      tip:'Unique offer-maker addresses with at least one live offer.' },
    { k:'New offers · 24h', v:newest, fmt:'int', dir:dActive, good:true,
      tip:'Offers whose timestamp is within the last 24h — a freshness / activity signal.' },
  ];
  document.getElementById('hero-cards').innerHTML = cards.map(h=>{
    const val  = h.fmt==='fiat' ? f.fiatCompact(h.v) : f.int(h.v);
    const full = h.fmt==='fiat' ? f.fiat(h.v)        : f.int(h.v);
    return `<div class="rounded-2xl bg-white dark:bg-ink-800 border border-slate-200 dark:border-ink-600 p-5">
      <div class="text-xs text-slate-400 flex items-center gap-1 mb-2">${h.k}
        <span class="info" data-tippy-content="${h.tip}"><svg><use href="#i-info"/></svg></span></div>
      <div class="text-3xl font-bold tabular leading-none" data-tippy-content="${full}">${val}</div>
      <div class="flex items-center gap-3 text-xs mt-4">
        ${dirChip(h.dir, h.good, h.dpct)}
        <span class="text-slate-400">vs&nbsp;last&nbsp;24h</span>
      </div>
    </div>`;
  }).join('');
}

/* ============================================================================
   RENDER · HEATMAP
   ============================================================================ */
function heatColor(v, vMax){
  if(v===0) return 'background:#1e293b33';
  const t = Math.min(1, Math.log10(v+1)/Math.log10(vMax+1));
  const stops = [[30,41,59],[30,58,138],[37,99,235],[34,197,94]];
  const seg = t*(stops.length-1), i = Math.floor(seg), fr = seg-i;
  const a = stops[i], b = stops[Math.min(i+1,stops.length-1)];
  const c = a.map((x,k)=> Math.round(x + (b[k]-x)*fr));
  return `background:rgb(${c[0]},${c[1]},${c[2]})`;
}
function renderHeatmap(){
  const { liq, coins } = aggregateHeatmap();
  const t = document.getElementById('heatmap');
  if(!t) return;
  if(coins.length < 2){
    t.innerHTML = '<tbody><tr><td class="p-4 text-center text-slate-400 text-sm">Not enough live coins to draw a heatmap.</td></tr></tbody>';
    return;
  }
  let vMax = 0; coins.forEach(a => coins.forEach(b => { if(a!==b){ const v = heatLookup(liq,a,b); if(v>vMax) vMax=v; }}));
  const label = c => c.replace('PART_BLIND','P_BLIND').replace('PART_ANON','P_ANON').replace('LTC_MWEB','LTC_MW');
  let html = '<thead><tr><th class="p-1"></th>' +
    coins.map(c=>`<th class="p-1 text-slate-400 font-medium text-[10px]">${label(c)}</th>`).join('') + '</tr></thead><tbody>';
  for(const r of coins){
    html += `<tr><td class="p-1 text-right text-slate-400 font-medium pr-2 text-[10px]">${label(r)}</td>`;
    for(const c of coins){
      if(r===c){ html += '<td class="text-center py-2 text-slate-600">—</td>'; continue; }
      const v = heatLookup(liq, r, c);
      if(v===undefined){ html += '<td class="text-center py-2 text-slate-700/40">·</td>'; continue; }
      const light = v > vMax*0.4 ? '#fff' : '#cbd5e1';
      html += `<td class="text-center py-2 rounded cursor-pointer hover:ring-2 ring-brand transition"
                 style="${heatColor(v, vMax)};color:${light}"
                 data-tippy-content="${r}/${c} · ${f.fiat(v)} live liquidity"
                 data-base="${r}" data-quote="${c}">${f.fiatCompact(v)}</td>`;
    }
    html += '</tr>';
  }
  t.innerHTML = html + '</tbody>';
  t.querySelectorAll('[data-base]').forEach(td => {
    td.addEventListener('click', ()=> selectPair(td.dataset.base, td.dataset.quote));
  });
}

/* ============================================================================
   RENDER · TICKERS
   ----------------------------------------------------------------------------
   "Top pairs by liquidity". Each card shows base/quote, total USD liquidity in
   the pair, base-coin USD price, 24h base-coin price change (from cached
   CoinGecko history if available), spread tightness, and a sparkline derived
   from the per-pair offer-count series in snapshots/manifest.json.
   ============================================================================ */
function topPairs(limit){
  const totals = {}; // 'A/B' canonical -> {liqUsd, dirBase, dirQuote}
  liveOffers().forEach(o=>{
    if(!o.coin_from || !o.coin_to) return;
    const k = pairKey(o.coin_from, o.coin_to);
    if(!totals[k]) totals[k] = { liq:0, base: o.coin_from < o.coin_to ? o.coin_from : o.coin_to,
                                        quote: o.coin_from < o.coin_to ? o.coin_to   : o.coin_from };
    totals[k].liq += offerUsdSize(o);
  });
  return Object.values(totals).sort((a,b)=> b.liq - a.liq).slice(0, limit);
}
function pairSparklineSeries(canonical){
  // pair_counts is keyed by directional "FROM/TO" in the manifest. Sum the two directions.
  if(!snapshotManifest.length) return [];
  const [a,b] = canonical.split('/');
  return snapshotManifest.map(s=>{
    const pc = s.pair_counts || {};
    return (pc[a+'/'+b]||0) + (pc[b+'/'+a]||0);
  });
}
function miniSpark(canvas, data, up){
  if(!canvas || !data.length) return;
  const c = new Chart(canvas, {
    type:'line',
    data:{ labels:data.map((_,i)=>i), datasets:[{ data, borderColor: up?'#22c55e':'#f43f5e',
      borderWidth:1.5, pointRadius:0, tension:.35, fill:true,
      backgroundColor:(up?'#22c55e':'#f43f5e')+'18' }]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{enabled:false} },
      scales:{ x:{display:false}, y:{display:false} }, animation:false }
  });
  sparkCharts.push(c);
}
function renderTickers(){
  sparkCharts.forEach(c=>c.destroy()); sparkCharts = [];
  const wrap = document.getElementById('tickers');
  if(!wrap) return;
  const list = topPairs(TICKER_LIMIT);
  if(!list.length){
    wrap.innerHTML = '<div class="col-span-full rounded-2xl bg-white dark:bg-ink-800 border border-slate-200 dark:border-ink-600 p-5 text-sm text-slate-400">No live pairs in the current snapshot.</div>';
    return;
  }
  wrap.innerHTML = list.map((t,i)=>{
    const { bids, asks } = getBidsAsks(t.base, t.quote);
    let spreadPct = null;
    if(bids.length && asks.length){
      const mid = (bids[0].price + asks[0].price)/2;
      spreadPct = mid>0 ? ((asks[0].price - bids[0].price)/mid)*100 : null;
    }
    const sp = spreadClass(spreadPct);
    const bUsd = coinUsd(t.base);
    const series = pairSparklineSeries(pairKey(t.base, t.quote));
    const up = series.length>=2 ? series[series.length-1] >= series[0] : true;
    return `<button class="text-left rounded-2xl bg-white dark:bg-ink-800 border border-slate-200 dark:border-ink-600 p-4 hover:border-brand transition w-full"
              data-base="${t.base}" data-quote="${t.quote}">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2 font-semibold">
          <span class="flex -space-x-1">${coinDot(t.base)}${coinDot(t.quote)}</span>
          ${t.base}/${t.quote}
        </div>
        <span class="text-xs text-slate-400">${f.fiatCompact(t.liq)} liq</span>
      </div>
      <div class="flex items-end justify-between gap-3">
        <div>
          <div class="text-lg font-bold tabular">${bUsd ? f.fiat(bUsd) : '—'}</div>
          <div class="text-xs"><span class="${sp.cls}">${spreadPct==null?'spread n/a':sp.word+' '+spreadPct.toFixed(2)+'%'}</span></div>
        </div>
        <div class="w-24 h-10"><canvas id="spark${i}"></canvas></div>
      </div>
    </button>`;
  }).join('');
  list.forEach((t,i)=>{
    const series = pairSparklineSeries(pairKey(t.base, t.quote));
    if(series.length>=2) miniSpark(document.getElementById('spark'+i), series, series[series.length-1]>=series[0]);
  });
  wrap.querySelectorAll('[data-base]').forEach(b=>{
    b.addEventListener('click', ()=> selectPair(b.dataset.base, b.dataset.quote));
  });
}
/* ============================================================================
   RENDER · SELECTED PAIR
   ============================================================================ */
function pickDefaultPair(){
  const list = topPairs(1);
  return list.length ? { base:list[0].base, quote:list[0].quote } : null;
}

function selectPair(base, quote){
  CUR = { base, quote };
  const bm = coinMeta(base), qm = coinMeta(quote);
  const set = (id,v)=>{ const e=document.getElementById(id); if(e) e.textContent = v; };

  set('pair-name', `${base} / ${quote}`);
  set('pair-sub',  `${bm.name} priced in ${qm.name}`);
  const i1 = document.getElementById('pair-i1'), i2 = document.getElementById('pair-i2');
  if(i1){ i1.textContent = base[0]; i1.style.background = bm.c; }
  if(i2){ i2.textContent = quote[0]; i2.style.background = qm.c; }

  const { bids, asks } = getBidsAsks(base, quote);
  window._book = { bids, asks };

  const bestBid = bids[0] ? bids[0].price : null;
  const bestAsk = asks[0] ? asks[0].price : null;
  set('pair-bid', bestBid ? f.coin(bestBid)+' '+quote : '—');
  set('pair-ask', bestAsk ? f.coin(bestAsk)+' '+quote : '—');

  const spreadEl = document.getElementById('pair-spread');
  if(spreadEl){
    if(bestBid && bestAsk){
      const mid = (bestBid + bestAsk)/2;
      const spreadPct = mid>0 ? ((bestAsk - bestBid)/mid)*100 : null;
      const s = spreadClass(spreadPct);
      spreadEl.innerHTML = `<span class="${s.cls}">${s.word} · ${spreadPct.toFixed(2)}%</span>`;
    } else {
      spreadEl.innerHTML = '<span class="text-slate-400">one-sided</span>';
    }
  }
  // mid printed in the order-book panel
  const midEl = document.getElementById('ob-mid');
  if(midEl){
    if(bestBid && bestAsk) midEl.textContent = f.coin((bestBid+bestAsk)/2) + ' ' + quote;
    else if(bestBid)       midEl.textContent = '↓ ' + f.coin(bestBid) + ' ' + quote;
    else if(bestAsk)       midEl.textContent = '↑ ' + f.coin(bestAsk) + ' ' + quote;
    else                   midEl.textContent = '—';
  }
  // size header reflects base unit
  const szLabel = document.getElementById('ob-size-label');
  if(szLabel) szLabel.textContent = 'Size (' + base + ')';

  renderHeaderPrice();
  renderBook();
  renderOffers();
  renderDepthChart();
  renderPriceChart();
  refreshTips();
}

function renderHeaderPrice(){
  if(!CUR) return;
  const { base, quote } = CUR;
  const bUsd = coinUsd(base), qUsd = coinUsd(quote);
  const midCoin = bUsd && qUsd ? bUsd/qUsd : null;
  const priceEl = document.getElementById('pair-price');
  const subEl   = document.getElementById('pair-priceSub');
  const lblEl   = document.getElementById('chart-unit-label');
  if(unit==='usd'){
    if(priceEl) priceEl.textContent = bUsd ? f.fiat(bUsd) : '—';
    if(subEl)   subEl.innerHTML     = midCoin ? `<span class="text-slate-400">≈ ${f.coin(midCoin)} ${quote}</span>` : '<span class="text-slate-400">price unknown</span>';
  } else {
    if(priceEl) priceEl.textContent = midCoin ? f.coin(midCoin)+' '+quote : '—';
    if(subEl)   subEl.innerHTML     = bUsd ? `<span class="text-slate-400">≈ ${f.fiat(bUsd)}</span>` : '';
  }
  if(lblEl) lblEl.textContent = unit==='usd' ? '(USD equivalent)' : `(in ${quote})`;
}

function renderBook(){
  if(!CUR || !window._book) return;
  const { base, quote } = CUR;
  const { bids, asks } = window._book;
  const qUsd = coinUsd(quote);
  const maxCum = Math.max(bids.length?bids[bids.length-1].cum:0, asks.length?asks[asks.length-1].cum:0) || 1;
  const row = (o, side)=>{
    const pct = (o.cum/maxCum*100).toFixed(1);
    const priceCol = side==='bid' ? 'text-emerald-500' : 'text-rose-500';
    const priceStr = (unit==='usd' && qUsd) ? f.fiat(o.price*qUsd) : f.coin(o.price);
    const priceTip = `${f.coinFull(o.price)} ${quote}${qUsd?' · '+f.fiat(o.price*qUsd):''}`;
    return `<div class="relative grid grid-cols-3 gap-2 px-1 py-0.5 rounded">
      <span class="depthbar ${side==='bid'?'bid-bar':'ask-bar'}" style="width:${pct}%"></span>
      <span class="relative z-10 ${priceCol}" data-tippy-content="${priceTip}">${priceStr}</span>
      <span class="relative z-10 text-right" data-tippy-content="${f.coinFull(o.amount)} ${base}">${f.coin(o.amount)}</span>
      <span class="relative z-10 text-right text-slate-400">${f.coin(o.total)}</span>
    </div>`;
  };
  const asksHtml = asks.length
    ? asks.slice(0, 12).reverse().map(o=>row(o,'ask')).join('')
    : '<div class="px-1 py-2 text-xs text-slate-400">no sell orders</div>';
  const bidsHtml = bids.length
    ? bids.slice(0, 12).map(o=>row(o,'bid')).join('')
    : '<div class="px-1 py-2 text-xs text-slate-400">no buy orders</div>';
  document.getElementById('asks').innerHTML = asksHtml;
  document.getElementById('bids').innerHTML = bidsHtml;
}

/* ============================================================================
   RENDER · OFFERS TABLE  (open offers for the selected pair, both directions)
   ============================================================================ */
const SWAP_TAG_TIPS = {
  'amt neg':'Amount negotiable — the maker accepts partial or variable amounts.',
  'rate neg':'Rate negotiable — the maker accepts a non-listed exchange rate.',
  'auto-accept':'Maker auto-accepts matching bids without manual approval.',
};
function tag(label, cls){
  const tip = SWAP_TYPE_DESC[label] || SWAP_TAG_TIPS[label] || '';
  return `<span class="px-1.5 py-0.5 rounded text-[10px] ${cls}" data-tippy-content="${tip}">${label}</span>`;
}
function renderOffers(){
  if(!CUR) return;
  const { base, quote } = CUR;
  const rows = liveOffers().filter(o =>
    (o.coin_from===base && o.coin_to===quote) ||
    (o.coin_from===quote && o.coin_to===base)
  );
  const bUsd = coinUsd(base);
  const refRate = (function(){
    // mid of best bid + best ask in QUOTE per BASE (same units as ask.price/bid.price).
    const { bids, asks } = window._book || {bids:[],asks:[]};
    if(bids.length && asks.length) return (bids[0].price + asks[0].price)/2;
    if(bids.length) return bids[0].price;
    if(asks.length) return asks[0].price;
    return null;
  })();
  document.getElementById('offers-count').textContent =
    rows.length ? `· showing ${rows.length} (all live for this pair)` : '· none live';

  const now = Math.floor(Date.now()/1000);
  document.getElementById('offers-body').innerHTML = rows.slice(0, 50).map(o=>{
    const fa = parseFloat(o.amount_from_str)||0, ta = parseFloat(o.amount_to_str)||0;
    const usd = (coinUsd(o.coin_from)*fa) || (coinUsd(o.coin_to)*ta) || 0;
    const rateQuotePerBase = (o.coin_from===base) ? (ta/fa) : (fa/ta);
    let mkt = null;
    if(refRate && rateQuotePerBase){
      const side = (o.coin_from===base) ? 1 : -1;        // asks vs bids
      mkt = ((rateQuotePerBase - refRate)/refRate)*100*side;
    }
    const mktCls = mkt===null ? 'text-slate-400' : (Math.abs(mkt)<1 ? 'text-slate-400' : (mkt>=0?'text-emerald-500':'text-rose-500'));
    const mktStr = mkt===null ? '—' : ((mkt>=0?'▲':'▼')+' '+Math.abs(mkt).toFixed(2)+'%');
    const typeLabel = SWAP_TYPES[o.swap_type] || 'unknown';
    const flags = [];
    if(o.amount_negotiable) flags.push('amt neg');
    if(o.rate_negotiable)   flags.push('rate neg');
    if(o.auto_accept_type)  flags.push('auto-accept');
    const expS = (o.timestamp + (o.time_valid||0)) - now;
    return `<tr class="border-b border-slate-100 dark:border-ink-700/60 hover:bg-slate-50 dark:hover:bg-ink-700/40">
      <td class="py-2"><span class="inline-flex items-center gap-1.5">${coinDot(o.coin_from,'w-4 h-4 text-[8px]')}
        <span data-tippy-content="${f.coinFull(fa)} ${o.coin_from}">${f.coin(fa)} ${o.coin_from}</span></span></td>
      <td class="py-2 text-slate-400">→</td>
      <td class="py-2"><span class="inline-flex items-center gap-1.5">${coinDot(o.coin_to,'w-4 h-4 text-[8px]')}
        <span data-tippy-content="${f.coinFull(ta)} ${o.coin_to}">${f.coin(ta)} ${o.coin_to}</span></span></td>
      <td class="py-2 text-right">${usd?f.fiat(usd):'—'}</td>
      <td class="py-2 text-right text-slate-400" data-tippy-content="${f.coinFull(rateQuotePerBase)} ${quote}/${base}">${f.coin(rateQuotePerBase)}</td>
      <td class="py-2 text-right ${mktCls}">${mktStr}</td>
      <td class="py-2 text-right text-slate-400">${expS>0?f.ageShort(expS):'expired'}</td>
    </tr>
    <tr class="border-b border-slate-100 dark:border-ink-700/60"><td colspan="7" class="pb-2 pl-0">
      <span class="inline-flex gap-1 flex-wrap">${tag(typeLabel,'bg-brand/15 text-brand')}${flags.map(fl=>tag(fl,'bg-slate-200 dark:bg-ink-700 text-slate-500 dark:text-slate-300')).join('')}</span>
    </td></tr>`;
  }).join('') || '<tr><td colspan="7" class="py-8 text-center text-slate-400 text-sm">No live offers for this pair.</td></tr>';
}


/* ============================================================================
   CHARTS
   ============================================================================ */
function chartGrid(){ return document.documentElement.classList.contains('dark') ? '#ffffff10' : '#0000000d'; }
function tickColor(){ return document.documentElement.classList.contains('dark') ? '#94a3b8' : '#64748b'; }

function renderDepthChart(){
  if(!CUR) return;
  const { base, quote } = CUR;
  const { bids, asks } = window._book || { bids:[], asks:[] };
  const qUsd = coinUsd(quote);
  const ctx = document.getElementById('depthChart');
  if(!ctx) return;
  if(depthChart) depthChart.destroy();
  if(!bids.length && !asks.length){
    depthChart = new Chart(ctx, { type:'line', data:{datasets:[]}, options:{plugins:{legend:{display:false}}} });
    return;
  }
  const toX = p => unit==='usd' && qUsd ? p*qUsd : p;
  const bidsPts = bids.map(o=>({ x:toX(o.price), y:o.cumUsd })).sort((a,b)=>a.x-b.x);
  const asksPts = asks.map(o=>({ x:toX(o.price), y:o.cumUsd })).sort((a,b)=>a.x-b.x);
  depthChart = new Chart(ctx, {
    type:'line',
    data:{ datasets:[
      { label:'Bids', data:bidsPts, borderColor:'#22c55e', backgroundColor:'#22c55e22',
        stepped:true, fill:true, borderWidth:1.5, pointRadius:0 },
      { label:'Asks', data:asksPts, borderColor:'#f43f5e', backgroundColor:'#f43f5e22',
        stepped:true, fill:true, borderWidth:1.5, pointRadius:0 },
    ]},
    options:{ responsive:true, maintainAspectRatio:false, parsing:false,
      plugins:{ legend:{display:false},
        tooltip:{ callbacks:{
          title(items){ const x=items[0].parsed.x;
            return `${base} price: ${unit==='usd'?f.fiat(x):f.coin(x)+' '+quote}`; },
          label(ctx2){ return `${ctx2.dataset.label}: ${f.fiat(ctx2.parsed.y)} liquidity`; }}}},
      scales:{
        x:{ type:'linear', grid:{color:chartGrid()},
            title:{display:true, text:`${base} price (${unit==='usd'?'USD':quote})`, color:tickColor(), font:{size:10}},
            ticks:{ color:tickColor(), maxTicksLimit:5,
              callback: v => unit==='usd' ? f.fiatCompact(v) : f.coin(v) }},
        y:{ grid:{color:chartGrid()}, beginAtZero:true,
            title:{display:true, text:'Cumulative liquidity (USD)', color:tickColor(), font:{size:10}},
            ticks:{ color:tickColor(), maxTicksLimit:4, callback: v => f.fiatCompact(v) }}},
      animation:false }
  });
}

/* ----------------------------------------------------------------------------
   Price chart: pulled from CoinGecko market_chart for the BASE coin (in USD).
   Cached in localStorage per (coin, days) for HIST_CACHE_TTL_MS.
   When unit='coin' we re-scale the USD series by the quote-coin USD price.
   ---------------------------------------------------------------------------- */
function histCacheRead(){ try { return JSON.parse(localStorage.getItem(HIST_CACHE_KEY)||'{}'); } catch(e){ return {}; } }
function histCacheWrite(o){ try { localStorage.setItem(HIST_CACHE_KEY, JSON.stringify(o)); } catch(e){} }
async function fetchPriceHistory(coinId, days){
  if(!coinId) return null;
  const key = coinId+'|'+days;
  const cache = histCacheRead();
  const hit = cache[key];
  if(hit && (Date.now() - hit.ts) < HIST_CACHE_TTL_MS) return hit.data;
  try{
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`;
    const r = await fetch(url);
    if(!r.ok) return hit ? hit.data : null;
    const j = await r.json();
    if(!j.prices) return hit ? hit.data : null;
    cache[key] = { ts: Date.now(), data: j.prices };
    histCacheWrite(cache);
    return j.prices;
  } catch(e){ return hit ? hit.data : null; }
}
async function renderPriceChart(){
  if(!CUR) return;
  const { base, quote } = CUR;
  const ctx = document.getElementById('priceChart');
  if(!ctx) return;
  const days = resolution;            // '1' (1D), '7' (1W), '30' (1M)
  const prices = await fetchPriceHistory(COIN_GECKO_IDS[base], days);
  if(priceChart) priceChart.destroy();
  if(!prices || !prices.length){
    priceChart = new Chart(ctx, {
      type:'line', data:{ labels:[], datasets:[] },
      options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false},
        tooltip:{ callbacks:{ title:()=>'No price history available' }}}, scales:{x:{display:false},y:{display:false}} }
    });
    return;
  }
  const qUsd = coinUsd(quote);
  const usdSeries  = prices.map(p => p[1]);
  const labels     = prices.map(p => p[0]);
  const coinSeries = (qUsd ? usdSeries.map(v => v/qUsd) : usdSeries);
  const data = (unit==='usd' || !qUsd) ? usdSeries : coinSeries;
  priceChart = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{ data, borderColor:'#4D84F0', borderWidth:2, pointRadius:0, tension:.3,
      fill:true, backgroundColor:'#4D84F01a' }]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false},
        tooltip:{ callbacks:{
          title(items){ return new Date(items[0].label).toLocaleString(); },
          label(c2){
            const usd = usdSeries[c2.dataIndex], coin = coinSeries[c2.dataIndex];
            return qUsd ? [`${f.fiat(usd)}`, `${f.coin(coin)} ${quote}`] : [`${f.fiat(usd)}`];
          }}}},
      scales:{
        x:{ type:'linear', grid:{display:false}, ticks:{ color:tickColor(), maxTicksLimit:6,
          callback: v => new Date(v).toLocaleDateString(undefined,{month:'short', day:'numeric'}) }},
        y:{ grid:{color:chartGrid()}, ticks:{ color:tickColor(),
          callback: v => (unit==='usd'||!qUsd) ? f.fiatCompact(v) : f.coin(v) }}},
      animation:false }
  });
}

/* ============================================================================
   RENDER · ADVANCED PANEL  (snapshot telemetry from orderbook.json + health.json)
   ============================================================================ */
let latestHealth = null;
function renderAdvanced(){
  const d = latestOrderbook || {};
  const s = d.stats || {};
  const h = latestHealth || {};
  const mtc = s.message_type_counts || {};
  const bsxMessages = (mtc.offer||0) + (mtc.bid||0) + (mtc.bid_accept||0) + (mtc.offer_revoke||0);
  const foreign = typeof s.not_for_us === 'number' ? s.not_for_us : (s.decrypt_errors||0);
  const age = d.timestamp ? Math.floor(Date.now()/1000) - d.timestamp : null;
  // Liquidity-weighted median spread across pairs that have both sides.
  const items = [];
  getPairs().forEach(p=>{
    const [b,q] = p.split('/');
    const { bids, asks } = getBidsAsks(b, q);
    if(!bids.length || !asks.length) return;
    const mid = (bids[0].price + asks[0].price)/2;
    if(!mid) return;
    const spr = ((asks[0].price - bids[0].price)/mid)*100;
    let liq = 0; bids.forEach(o=>liq+=o.cumUsd); asks.forEach(o=>liq+=o.cumUsd);
    items.push({spr, liq});
  });
  items.sort((a,b)=>a.spr-b.spr);
  const totalLiq = items.reduce((a,b)=>a+b.liq,0);
  let medianSpread = null, cum = 0;
  for(const it of items){ cum += it.liq; if(cum >= totalLiq/2){ medianSpread = it.spr; break; } }

  const fields = [
    {k:'SMSGs in',         v: f.int(s.msgs_received||0), tip:'Total secure-message envelopes ingested this snapshot.'},
    {k:'BSX messages',     v: f.int(bsxMessages),        tip:'Messages recognised as BasicSwap offers, revokes, bids and accepts.'},
    {k:'Foreign SMSGs',    v: f.int(foreign),            tip:'Envelopes on shared SMSG channels that are not BasicSwap traffic.'},
    {k:'Snapshot age',     v: age!=null ? f.ageShort(age) : '—', tip:'Time since the public stats snapshot was rebuilt. Refresh cron runs every 15 min.'},
    {k:'Listed offers',    v: f.int(d.num_offers||0),    tip:'All offers in the snapshot, including expired.'},
    {k:'Active offers',    v: f.int(d.active_offers||0), tip:'Unexpired offers — the basis for every figure in this page.'},
    {k:'Offers revoked',   v: f.int(s.revoked_offers_dropped||0), tip:'Offers withdrawn by their maker via a signed revoke message and filtered from this snapshot.'},
    {k:'Invalid revokes',  v: f.int(s.revokes_invalid_sig||0), tip:'Revoke messages whose signature did not match the offer\u2019s maker address — ignored to prevent third-party censorship.'},
    {k:'Median spread',    v: medianSpread!=null ? medianSpread.toFixed(2)+'%' : '—', tip:'Liquidity-weighted median spread across active two-sided pairs.'},
    {k:'Scraper run',      v: h.duration_s!=null ? h.duration_s+'s' : '—', tip:'Wall time of the most recent scraper run (lower is better).'},
  ];
  document.getElementById('adv-body').innerHTML = fields.map(a=>`
    <div class="rounded-xl bg-slate-50 dark:bg-ink-700/50 p-3">
      <div class="text-slate-400 flex items-center gap-1">${a.k}
        <span class="info" data-tippy-content="${a.tip}"><svg><use href="#i-info"/></svg></span></div>
      <div class="font-semibold text-base tabular mt-0.5">${a.v}</div>
    </div>`).join('');
}

/* ============================================================================
   TOOLTIPS  (Tippy.js on every [data-tippy-content])
   ============================================================================ */
function refreshTips(){
  tipInstances.forEach(t => t.destroy && t.destroy());
  if(typeof tippy !== 'function'){ tipInstances = []; return; }
  tipInstances = tippy('[data-tippy-content]', {
    theme: document.documentElement.classList.contains('dark') ? '' : 'light',
    allowHTML:false, maxWidth:280, delay:[120,0], touch:true,
  });
}

/* ============================================================================
   FETCHERS
   ============================================================================ */
function loadCachedPrices(){
  try{
    const c = JSON.parse(localStorage.getItem(PRICE_CACHE_KEY)||'null');
    if(!c || Date.now() - c.ts > PRICE_CACHE_TTL_MS) return false;
    latestPrices = c.usd || {};
    return true;
  } catch(e){ return false; }
}
function saveCachedPrices(){
  try{ localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify({ts:Date.now(), usd:latestPrices})); } catch(e){}
}
async function fetchPrices(){
  try{
    const ids = [...new Set(Object.values(COIN_GECKO_IDS))].join(',');
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids='+ids+'&vs_currencies=usd');
    if(!r.ok){ console.warn('CoinGecko price fetch:', r.status); return; }
    const d = await r.json();
    if(d.status){ console.warn('CoinGecko rate limited'); return; }
    for(const [id, val] of Object.entries(d)){
      if(val && val.usd) latestPrices[id] = val.usd;
    }
    saveCachedPrices();
  } catch(e){ console.warn('Price fetch failed:', e); }
}
async function fetchSnapshotManifest(){
  try{
    const r = await fetch('snapshots/manifest.json', {cache:'no-store'});
    if(!r.ok) return;
    const j = await r.json();
    if(j && Array.isArray(j.snapshots)) snapshotManifest = j.snapshots.slice(-200);
  } catch(e){ /* manifest absent — non-fatal */ }
}
async function fetchHealth(){
  try{
    const r = await fetch('health.json?'+Date.now());
    if(r.ok) latestHealth = await r.json();
  } catch(e){ /* non-fatal */ }
}
async function fetchOrderbook(){
  try{
    const r = await fetch('orderbook.json?'+Date.now());
    const d = await r.json();
    latestOrderbook = d;
    allOffers = d.offers || [];
    renderAll();
  } catch(e){
    console.error('Orderbook fetch failed:', e);
    const ob = document.getElementById('offers-body');
    if(ob) ob.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-rose-500 text-sm">Failed to load orderbook.json — '+(e.message||e)+'</td></tr>';
    updateFreshnessPill();
  }
}

function renderAll(){
  updateFreshnessPill();
  renderHero();
  renderHeatmap();
  renderTickers();
  renderAdvanced();
  // Re-select the same pair if it still exists; otherwise pick the deepest one.
  let next = CUR;
  if(next){
    const still = liveOffers().some(o =>
      (o.coin_from===next.base && o.coin_to===next.quote) ||
      (o.coin_from===next.quote && o.coin_to===next.base)
    );
    if(!still) next = null;
  }
  if(!next) next = pickDefaultPair();
  if(next) selectPair(next.base, next.quote);
  refreshTips();
}

/* ============================================================================
   WIRING
   ============================================================================ */
function setUnit(u){
  unit = u;
  document.getElementById('unit-usd').className  = 'px-2.5 py-1 rounded-md ' + (u==='usd' ?'bg-white dark:bg-ink-600 shadow-sm':'text-slate-500 dark:text-slate-400');
  document.getElementById('unit-coin').className = 'px-2.5 py-1 rounded-md ' + (u==='coin'?'bg-white dark:bg-ink-600 shadow-sm':'text-slate-500 dark:text-slate-400');
  try{ localStorage.setItem('bsx-mkts-unit', u); } catch(e){}
  if(CUR){ renderHeaderPrice(); renderBook(); renderOffers(); renderDepthChart(); renderPriceChart(); refreshTips(); }
}
function wire(){
  document.getElementById('unit-usd').onclick  = ()=> setUnit('usd');
  document.getElementById('unit-coin').onclick = ()=> setUnit('coin');
  document.getElementById('theme-toggle').onclick  = ()=>{
    document.documentElement.classList.toggle('dark');
    try{ localStorage.setItem('bsx-theme', document.documentElement.classList.contains('dark')?'dark':'light'); } catch(e){}
    renderDepthChart(); renderPriceChart(); refreshTips();
  };
  document.querySelectorAll('.res').forEach(b => b.onclick = ()=>{
    document.querySelectorAll('.res').forEach(x => x.className = 'res px-2 py-0.5 rounded text-slate-500 hover:bg-slate-200 dark:hover:bg-ink-700');
    b.className = 'res px-2 py-0.5 rounded bg-brand text-white';
    resolution = b.dataset.res==='1W' ? '7' : b.dataset.res==='1M' ? '30' : '1';
    renderPriceChart();
  });
  const yr = document.getElementById('yr'); if(yr) yr.textContent = new Date().getFullYear();
  // Keep the freshness pill ticking even between fetches.
  setInterval(updateFreshnessPill, 30*1000);
}

/* ============================================================================
   BOOT
   ============================================================================ */
(async function init(){
  try{ const u = localStorage.getItem('bsx-mkts-unit'); if(u==='usd'||u==='coin') unit = u; } catch(e){}
  wire();
  loadCachedPrices();
  await Promise.all([fetchPrices(), fetchSnapshotManifest(), fetchHealth()]);
  await fetchOrderbook();
  setUnit(unit);
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async ()=>{
    await Promise.all([fetchPrices(), fetchSnapshotManifest(), fetchHealth()]);
    await fetchOrderbook();
  }, REFRESH_INTERVAL_MS);
})();
