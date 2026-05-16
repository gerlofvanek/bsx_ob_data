const COIN_GECKO_IDS={BTC:'bitcoin',XMR:'monero',LTC:'litecoin',PART:'particl',PART_BLIND:'particl',PART_ANON:'particl',BCH:'bitcoin-cash',FIRO:'zcoin',DASH:'dash',PIVX:'pivx',WOW:'wownero',DOGE:'dogecoin',DCR:'decred',NAV:'nav-coin',NMC:'namecoin',LTC_MWEB:'litecoin'};
const COIN_NAMES={BTC:'Bitcoin',XMR:'Monero',LTC:'Litecoin',PART:'Particl',PART_BLIND:'Particl Blind',PART_ANON:'Particl Anon',BCH:'Bitcoin Cash',FIRO:'Firo',DASH:'Dash',PIVX:'PIVX',WOW:'Wownero',DOGE:'Dogecoin',DCR:'Decred',NAV:'Navcoin',NMC:'Namecoin',LTC_MWEB:'Litecoin MWEB'};
const COIN_IMG={BTC:'Bitcoin',XMR:'Monero',LTC:'Litecoin',PART:'Particl',PART_BLIND:'Particl-Blind',PART_ANON:'Particl-Anon',BCH:'Bitcoin-Cash',FIRO:'Firo',DASH:'Dash',PIVX:'PIVX',WOW:'Wownero',DOGE:'Dogecoin',DCR:'Decred',NAV:'Navcoin',NMC:'Namecoin',LTC_MWEB:'Litecoin'};
// SwapTypes mirror basicswap/basicswap_util.py SwapTypes IntEnum (auto() => 1-indexed).
// Labels match upstream strSwapDesc() where defined; legacy entries flagged as never observed.
const SWAP_TYPES={1:'Secret Hash',2:'Buyer First (legacy)',3:'Seller First 2-msg (legacy)',4:'Buyer First 2-msg (legacy)',5:'Adaptor Sig',6:'BCH Adaptor'};
// Tooltip text per protocol, surfaced on the chip and on swap-type filter options.
const SWAP_TYPE_DESC={
  'Secret Hash':'Classic HTLC atomic swap: both coins lock funds with a hash preimage. Requires Bitcoin-style scripting on both sides.',
  'Adaptor Sig':'Adaptor-signature atomic swap (a.k.a. XMR swap). Works when one coin has no HTLC support — e.g. Monero, Wownero.',
  'BCH Adaptor':'Adaptor-signature swap tuned for Bitcoin Cash CashScript. BCH-side variant of the XMR swap protocol.',
  'Buyer First (legacy)':'Buyer-locks-first variant of the secret-hash protocol. Defined in the enum but not observed in production offers.',
  'Seller First 2-msg (legacy)':'Two-message variant of the secret-hash protocol. Defined in the enum but not observed in production offers.',
  'Buyer First 2-msg (legacy)':'Two-message buyer-first variant. Defined in the enum but not observed in production offers.'
};
// Friendly short label shown in chips/badges (must round-trip through swap-type filter).
const SWAP_TYPE_OPTIONS=Object.values(SWAP_TYPES).filter((v,i,a)=>a.indexOf(v)===i);

let allOffers=[],latestOrderbook=null,latestPrices={};
// Non-USD CoinGecko price maps. USD is kept as the legacy `latestPrices` global because the
// CSV/JSON exporters and several historical chips reference it by name. All other quote
// currencies (fiat + BTC + sats + XAU gold ounce) live here, keyed by FIAT_META code.
const fiatPriceMaps={
  eur:{},gbp:{},zar:{},cny:{},jpy:{},
  aed:{},ars:{},aud:{},brl:{},cad:{},chf:{},inr:{},krw:{},mxn:{},ngn:{},rub:{},try:{},
  btc:{},sats:{},xau:{},xag:{},
};
let selectedPair='ALL',selectedCoin='ALL',searchQuery='',selectedSwapType='ALL',minUsdFilter=0;
let negotiableOnly=false,watchedOnly=false,compactMode=false,hideExpired=true,liteMode=false,autoAcceptOnly=false;
// Posted-time filter: set by clicking a cell in the activity heatmap. {dow:0-6 Mon..Sun, h:0-23}
let postedFilter=null;
let whaleNotifyUsd=0,notifiedIds=new Set();
// Arbitrage controls: minimum edge % to display and whether to also enumerate 4-hop cycles.
let arbEdgeMin=1, arbHops4=false;
// Lucide icon refresh: after any render that injects new <i data-lucide="..."> placeholders
// we re-scan so they get swapped for real <svg>. Cheap (skips already-processed nodes).
function redrawIcons(){if(window.lucide&&typeof lucide.createIcons==='function')lucide.createIcons();}
// Re-parse the document for emoji glyphs and swap them for Twemoji SVGs. Idempotent — the
// library skips elements it has already processed. Called after init and after any render
// that may have injected new flag emoji (spread bar refresh, ticker re-build, etc.).
function runTwemoji(root){if(window.twemoji&&typeof twemoji.parse==='function')twemoji.parse(root||document.body,{folder:'svg',ext:'.svg'});}
let watchlist=new Set(); // pairs the user has starred; persisted in localStorage
let knownPairs=new Set(); // pairs seen in any prior fetch; persisted in localStorage
let newPairs=new Set();   // pairs in the current snapshot that weren't in knownPairs
// GH Action cadence (cron */15 * * * *). Kept in sync with .github/workflows/orderbook-refresh.yml.
const REFRESH_CADENCE_S=15*60;
let currentSort='timestamp',sortAsc=false,lastFetchTime=0,countdown=300;
let priceChart=null,depthChart=null,histChart=null,countdownInterval=null;
const REFRESH_INTERVAL=300; // Client polls the static snapshot every 5 min (GH Actions cron is */15).
// Decimals per coin. Most are 8 (BTC-style); XMR uses 12, WOW uses 11.
// Mirrors basicswap/chainparams.py (XMR_COIN = 1e12, WOW_COIN = 1e11).
const COIN_DECIMALS={XMR:12,WOW:11};
const STALE_AFTER_S=30*60; // banner kicks in after 30 min of snapshot age

function coinImg(t,s=20){const fz=Math.max(7,Math.round(s*0.42));return `<img src="images/coins/${(COIN_IMG[t]||t).replace(' ','-')}-20.png" alt="${t}" class="rounded-full" width="${s}" height="${s}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="coin-fallback" style="width:${s}px;height:${s}px;font-size:${fz}px;display:none">${t}</span>`;}
// Short relative-age string ("5m", "2h", "3d") for inline use next to absolute timestamps.
function relAge(s){if(!s||s<0)return'';if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';return Math.floor(s/86400)+'d';}
function formatUSD(v){if(!v)return'';return v>=1?'$'+v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}):'$'+v.toFixed(4);}
// Fiat display state. CoinGecko returns prices in every code listed here in a single call; the
// user picks one to drive every "size in fiat" surface (sizes, liquidity, walk-book, heatmap,
// leaderboard, etc.). CSV/JSON exports stay anchored to USD via formatUSD/offerUsdSize for
// deterministic analysis. Distinct sym prefixes (C$/A$/AR$/R$/MX$) disambiguate the many "$"
// currencies. `fmt` override is used for the unit-style codes (BTC/sats/XAU) that don't fit the
// generic "<symbol><number>" pattern.
const FIAT_META={
  usd:{sym:'$',  flag:'🇺🇸',code:'USD',map:()=>latestPrices,    decimals:2},
  eur:{sym:'€',  flag:'🇪🇺',code:'EUR',map:()=>fiatPriceMaps.eur,decimals:2},
  gbp:{sym:'£',  flag:'🇬🇧',code:'GBP',map:()=>fiatPriceMaps.gbp,decimals:2},
  zar:{sym:'R',  flag:'🇿🇦',code:'ZAR',map:()=>fiatPriceMaps.zar,decimals:2},
  cny:{sym:'¥',  flag:'🇨🇳',code:'CNY',map:()=>fiatPriceMaps.cny,decimals:2},
  jpy:{sym:'¥',  flag:'🇯🇵',code:'JPY',map:()=>fiatPriceMaps.jpy,decimals:0},
  // World preset
  aed:{sym:'د.إ',flag:'🇦🇪',code:'AED',map:()=>fiatPriceMaps.aed,decimals:2},
  ars:{sym:'AR$',flag:'🇦🇷',code:'ARS',map:()=>fiatPriceMaps.ars,decimals:2},
  aud:{sym:'A$', flag:'🇦🇺',code:'AUD',map:()=>fiatPriceMaps.aud,decimals:2},
  brl:{sym:'R$', flag:'🇧🇷',code:'BRL',map:()=>fiatPriceMaps.brl,decimals:2},
  cad:{sym:'C$', flag:'🇨🇦',code:'CAD',map:()=>fiatPriceMaps.cad,decimals:2},
  chf:{sym:'Fr.',flag:'🇨🇭',code:'CHF',map:()=>fiatPriceMaps.chf,decimals:2},
  inr:{sym:'₹',  flag:'🇮🇳',code:'INR',map:()=>fiatPriceMaps.inr,decimals:2},
  krw:{sym:'₩',  flag:'🇰🇷',code:'KRW',map:()=>fiatPriceMaps.krw,decimals:0},
  mxn:{sym:'MX$',flag:'🇲🇽',code:'MXN',map:()=>fiatPriceMaps.mxn,decimals:2},
  ngn:{sym:'₦',  flag:'🇳🇬',code:'NGN',map:()=>fiatPriceMaps.ngn,decimals:0},
  rub:{sym:'₽',  flag:'🇷🇺',code:'RUB',map:()=>fiatPriceMaps.rub,decimals:2},
  try:{sym:'₺',  flag:'🇹🇷',code:'TRY',map:()=>fiatPriceMaps.try,decimals:2},
  // Crypto + commodity units (suffix-style; fmt overrides the default "<sym><number>" layout)
  btc: {sym:'₿', flag:'₿', code:'BTC', map:()=>fiatPriceMaps.btc, decimals:8,
        fmt:v=>'₿'+v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})},
  sats:{sym:'',  flag:'⚡',code:'sats',map:()=>fiatPriceMaps.sats,decimals:0,
        fmt:v=>Math.round(v).toLocaleString()+' sats'},
  xau: {sym:'',  flag:'🥇',code:'XAU', map:()=>fiatPriceMaps.xau, decimals:4,
        fmt:v=>v.toLocaleString(undefined,{minimumFractionDigits:4,maximumFractionDigits:4})+' oz'},
  xag: {sym:'',  flag:'🥈',code:'XAG', map:()=>fiatPriceMaps.xag, decimals:2,
        fmt:v=>v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})+' oz'},
};
let selectedFiat='usd';
try{const s=localStorage.getItem('bsx-fiat');if(s&&FIAT_META[s])selectedFiat=s;}catch(e){}
function fiatMeta(){return FIAT_META[selectedFiat]||FIAT_META.usd;}
function fiatPriceMap(){return fiatMeta().map();}
function coinFiat(ticker){return fiatPriceMap()[COIN_GECKO_IDS[ticker]]||0;}
function offerFiatSize(o){const p=coinFiat(o.coin_from);return p?parseFloat(o.amount_from_str)*p:0;}
// USD→active-fiat conversion ratio derived from any coin that has prices in both maps.
// Used for figures (vol-delta, manifest totals) that are stored USD-anchored upstream.
function usdToFiatRatio(){
  if(selectedFiat==='usd')return 1;
  const fm=fiatPriceMap();
  for(const id in latestPrices){const u=latestPrices[id],f=fm[id];if(u&&f)return f/u;}
  return 1;
}
function formatFiat(v){
  if(!v)return'';
  const m=fiatMeta();
  if(m.fmt)return m.fmt(v);
  // Generic prefix-symbol path. Sub-unit amounts get 4 decimals regardless of the currency's
  // normal precision so values like "$0.0042" don't round to "$0.00" / "¥0".
  const dec=v>=1?m.decimals:4;
  return m.sym+v.toLocaleString(undefined,{minimumFractionDigits:dec,maximumFractionDigits:dec});
}
function onFiatChange(v){
  if(!FIAT_META[v])return;
  selectedFiat=v;
  try{localStorage.setItem('bsx-fiat',v);}catch(e){}
  // Re-render every surface that shows a fiat figure or label.
  applyFiatLabels();
  renderAll();renderTicker();updateScorecard&&updateScorecard();
}
// Mirrors the active fiat symbol into all controls that label themselves with one (the "Min size"
// input and the whale-notify threshold). Called on init and on fiat change.
function applyFiatLabels(){
  const m=fiatMeta();
  // Suffix-style codes (sats/XAU) have no prefix symbol; show their code in parentheses so the
  // input label still reads naturally ("Min size (sats)" rather than "Min size ").
  const tag=m.sym?m.sym:('('+m.code+')');
  const ms=document.getElementById('min-usd-label');if(ms)ms.textContent='Min size '+tag;
  const wl=document.getElementById('whale-label');if(wl)wl.textContent='Large offer ≥ '+tag;
  const fs=document.getElementById('fiat-select');if(fs)fs.value=selectedFiat;
}
function formatDuration(s){if(s<=0)return'Expired';const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d>0?d+'d '+h+'h':h>0?h+'h '+m+'m':m+'m';}
// Market premium/discount from the *taker* perspective: they pay coin_to (cost = tv) and
// receive coin_from (received = fv). Positive % = taker gets a deal vs spot, negative = pays premium.
function calcMarketPct(o){const fp=latestPrices[COIN_GECKO_IDS[o.coin_from]],tp=latestPrices[COIN_GECKO_IDS[o.coin_to]];if(!fp||!tp)return null;const fa=parseFloat(o.amount_from_str),ta=parseFloat(o.amount_to_str);if(!fa||!ta)return null;const fv=fa*fp,tv=ta*tp;if(!fv||!tv)return null;return((fv/tv)-1)*100;}
function offerUsdSize(o){const p=latestPrices[COIN_GECKO_IDS[o.coin_from]];return p?parseFloat(o.amount_from_str)*p:0;}
function minBidDisplay(o){const dec=COIN_DECIMALS[o.coin_from]||8;const v=(o.min_bid_amount||0)/Math.pow(10,dec);return v>0?v:0;}
// Convert wire-format fee_rate (smallest-unit per kvB, see basicswap.py:4097
// where ci.make_int(coin_per_kvB) is called) to a human-readable per-byte label.
//   8-decimal coins (BTC,LTC,DOGE,...) → "sat/vB"
//   12-decimal XMR                     → "pn/B" (piconero per byte)
//   11-decimal WOW / others            → "atom/B"
function formatFeeRate(rate,coin){
  if(!rate)return null;
  const dec=COIN_DECIMALS[coin]||8;
  const perByte=rate/1000;
  const unit=dec===8?'sat/vB':coin==='XMR'?'pn/B':'atom/B';
  let val;
  if(perByte>=1000)val=Math.round(perByte).toLocaleString();
  else if(perByte>=100)val=perByte.toFixed(0);
  else if(perByte>=10)val=perByte.toFixed(1);
  else if(perByte>=1)val=perByte.toFixed(2);
  else val=perByte.toFixed(3);
  return val+' '+unit;
}
function isNegotiable(o){return !!(o.amount_negotiable||o.rate_negotiable);}
// Builds the swap-type chip's title attribute: protocol description + lock spec + negotiable flags.
function swapChipTooltip(o,desc){
  const parts=[desc];
  const ls=lockSummary(o);
  if(ls)parts.push('Lock: '+ls);
  const negBits=[];
  if(o.amount_negotiable)negBits.push('amount');
  if(o.rate_negotiable)negBits.push('rate');
  if(negBits.length)parts.push('Negotiable: '+negBits.join(' + '));
  if(o.auto_accept_type)parts.push('Auto-accept: yes');
  return parts.join('\n');
}
// Small ↔ glyph appended to the chip when the maker accepts negotiation. Lucide is loaded once-pass
// so we use the data-lucide attribute and rely on redrawIcons() to swap in the SVG.
function swapChipNegIcon(o){
  if(!isNegotiable(o))return'';
  return' <i data-lucide="arrow-left-right" class="w-3 h-3 inline-block align-text-bottom" title="Negotiable"></i>';
}
// Renders the bid-activity badge for a row. Prefers showing the live highest open bid (size the
// maker would receive) when the scraper has tracked one; otherwise falls back to raw observed count.
function bidBadge(o){
  if(!o)return'';
  const hb=o.highest_bid;
  if(hb&&hb.active_bid_count>0){
    const amt=parseFloat(hb.amount_str)||0;
    const sz=amt>=1?amt.toFixed(4):amt<0.0001?amt.toExponential(2):amt.toFixed(6);
    const exp=hb.expires_in_s>0?formatDuration(hb.expires_in_s):'expired';
    const tip=hb.active_bid_count+' active bid(s) seen for this offer; best bid '+sz+' '+(o.coin_from||'')+' (expires in '+exp+')';
    return ' <span class="badge-bid" title="'+tip+'">'+hb.active_bid_count+'×bid · best '+sz+' '+(o.coin_from||'')+'</span>';
  }
  if(o.bid_count){
    return ' <span class="badge-bid" title="'+o.bid_count+' bid(s) seen for this offer (all expired or terms unknown)">'+o.bid_count+'×bid</span>';
  }
  return'';
}
// Lock-type names mirror basicswap/basicswap_util.py TxLockTypes:
// 1=SEQUENCE_LOCK_BLOCKS, 2=SEQUENCE_LOCK_TIME, 3=ABS_LOCK_BLOCKS, 4=ABS_LOCK_TIME.
const LOCK_TYPES={1:'Seq blocks',2:'Seq time',3:'Abs blocks',4:'Abs time'};
function lockSummary(o){
  if(!o.lock_type)return'';
  const name=LOCK_TYPES[o.lock_type]||('lock '+o.lock_type);
  const v=o.lock_value;
  if(!v)return name;
  // Time-based lock types (2 SEQUENCE_LOCK_TIME and 4 ABS_LOCK_TIME) carry seconds.
  if(o.lock_type===2||o.lock_type===4)return name+' · '+formatDuration(v);
  return name+' · '+v+' blk';
}
// Renders a small inline list of extra-attribute badges. All inputs are optional fields the
// older scraper didn't emit, so this returns '' when none are present.
function offerExtraBadges(o){
  const parts=[];
  if(o.amount_negotiable)parts.push('<span class="neg-badge" title="Maker accepts non-standard amounts">amt neg</span>');
  if(o.rate_negotiable)parts.push('<span class="neg-badge" title="Maker accepts non-standard rates">rate neg</span>');
  const mb=minBidDisplay(o);
  if(mb>0){parts.push('<span class="neg-badge badge-min" title="Smallest bid the maker will accept">min '+(mb<0.0001?mb.toExponential(2):mb.toFixed(4))+' '+o.coin_from+'</span>');}
  const ls=lockSummary(o);
  if(ls)parts.push('<span class="neg-badge badge-lock" title="Swap timeout / lock spec">'+ls+'</span>');
  const ff=formatFeeRate(o.fee_rate_from,o.coin_from);
  if(ff)parts.push('<span class="neg-badge badge-fee" title="Maker-side fee on '+(o.coin_from||'')+' chain (raw: '+o.fee_rate_from+' per kvB)">fee '+o.coin_from+': '+ff+'</span>');
  const ft=formatFeeRate(o.fee_rate_to,o.coin_to);
  if(ft)parts.push('<span class="neg-badge badge-fee" title="Taker-side fee on '+(o.coin_to||'')+' chain (raw: '+o.fee_rate_to+' per kvB)">fee '+o.coin_to+': '+ft+'</span>');
  if(o.auto_accept_type)parts.push('<span class="neg-badge badge-auto" title="Auto-accept enabled">auto-accept</span>');
  if(o.proof_address)parts.push('<span class="neg-badge badge-proof" title="Proof address: '+o.proof_address+'">proof</span>');
  return parts.join(' ');
}
function pairKey(a,b){return a<b?a+'/'+b:b+'/'+a;}
function offerPairKey(o){return pairKey(o.coin_from,o.coin_to);}
function loadWatchlist(){try{const a=JSON.parse(localStorage.getItem('bsx-watchlist')||'[]');watchlist=new Set(Array.isArray(a)?a:[]);}catch(e){watchlist=new Set();}}
function saveWatchlist(){try{localStorage.setItem('bsx-watchlist',JSON.stringify([...watchlist]));}catch(e){}}
function toggleWatch(p,ev){if(ev){ev.stopPropagation();}if(watchlist.has(p))watchlist.delete(p);else watchlist.add(p);saveWatchlist();renderTicker();if(watchedOnly){renderAll();}}

function isExpired(o){const now=Math.floor(Date.now()/1000);return (o.timestamp+(o.time_valid||0))<=now;}
function getFilteredOffers(){
  let o=[...allOffers];
  if(searchQuery){const q=searchQuery.toLowerCase();o=o.filter(x=>(x.msg_id||'').toLowerCase().includes(q)||(x.addr_from||'').toLowerCase().includes(q));}
  if(selectedCoin!=='ALL') o=o.filter(x=>x.coin_from===selectedCoin||x.coin_to===selectedCoin);
  if(selectedPair!=='ALL'){const[b,q]=selectedPair.split('/');o=o.filter(x=>(x.coin_from===b&&x.coin_to===q)||(x.coin_from===q&&x.coin_to===b));}
  if(selectedSwapType!=='ALL') o=o.filter(x=>SWAP_TYPES[x.swap_type]===selectedSwapType);
  if(minUsdFilter>0) o=o.filter(x=>offerFiatSize(x)>=minUsdFilter);
  if(negotiableOnly) o=o.filter(isNegotiable);
  if(autoAcceptOnly) o=o.filter(x=>!!x.auto_accept_type);
  if(watchedOnly&&watchlist.size) o=o.filter(x=>watchlist.has(offerPairKey(x)));
  if(hideExpired) o=o.filter(x=>!isExpired(x));
  if(postedFilter){o=o.filter(x=>{if(!x.timestamp)return false;const d=new Date(x.timestamp*1000);const dw=(d.getUTCDay()+6)%7;return dw===postedFilter.dow&&d.getUTCHours()===postedFilter.h;});}
  return o;
}
// Deterministic HSL colour per maker address (D). Same address → same hue across renders & sessions.
function makerColor(addr){
  if(!addr)return null;
  let h=0;for(let i=0;i<addr.length;i++)h=(h*31+addr.charCodeAt(i))>>>0;
  const hue=h%360;
  return {bg:`hsla(${hue},65%,55%,0.18)`,border:`hsla(${hue},65%,55%,0.55)`,text:`hsl(${hue},75%,72%)`};
}
function makerChipStyle(addr){
  const c=makerColor(addr);if(!c)return '';
  return `background:${c.bg};border:1px solid ${c.border};color:${c.text};padding:1px 5px;border-radius:3px;`;
}
// Track which pairs we've seen across all prior fetches to flag fresh ones (E).
function loadKnownPairs(){try{const a=JSON.parse(localStorage.getItem('bsx-known-pairs')||'[]');knownPairs=new Set(Array.isArray(a)?a:[]);}catch(e){knownPairs=new Set();}}
function saveKnownPairs(){try{localStorage.setItem('bsx-known-pairs',JSON.stringify([...knownPairs]));}catch(e){}}
function recomputeNewPairs(){
  newPairs=new Set();
  const cur=new Set();
  allOffers.forEach(o=>{if(o.coin_from&&o.coin_to)cur.add(pairKey(o.coin_from,o.coin_to));});
  // First-ever fetch (empty knownPairs) → don't flag everything as "new".
  if(knownPairs.size===0){cur.forEach(p=>knownPairs.add(p));saveKnownPairs();return;}
  cur.forEach(p=>{if(!knownPairs.has(p)){newPairs.add(p);knownPairs.add(p);}});
  if(newPairs.size)saveKnownPairs();
}
function onSearchChange(){
  searchQuery=document.getElementById('search-id').value.trim();
  saveFilters();writeHash();renderAllOrders();updateFilterCount();
}
function onSwapTypeChange(v){selectedSwapType=v;saveFilters();writeHash();renderAll();renderTicker();updateFilterCount();}
function onMinUsdChange(v){minUsdFilter=Math.max(0,parseFloat(v)||0);saveFilters();writeHash();renderAll();renderTicker();updateFilterCount();}
function onNegotiableChange(v){negotiableOnly=!!v;saveFilters();writeHash();renderAll();renderTicker();updateFilterCount();}
function onAutoAcceptChange(v){autoAcceptOnly=!!v;saveFilters();writeHash();renderAll();renderTicker();updateFilterCount();}
function onWatchedChange(v){watchedOnly=!!v;saveFilters();writeHash();renderAll();renderTicker();updateFilterCount();}
function onHideExpiredChange(v){hideExpired=!!v;saveFilters();writeHash();renderAll();renderTicker();updateFilterCount();}
function onCompactChange(v){compactMode=!!v;document.body.classList.toggle('compact',compactMode);try{localStorage.setItem('bsx-compact',compactMode?'1':'0');}catch(e){}}
function toggleLite(){liteMode=!liteMode;document.body.classList.toggle('lite',liteMode);try{localStorage.setItem('bsx-lite',liteMode?'1':'0');}catch(e){}}
function onArbEdgeChange(v){arbEdgeMin=parseFloat(v)||1;try{localStorage.setItem('bsx-arb-edge',String(arbEdgeMin));}catch(e){}writeHash();renderTriArb();}
function onArbHopsChange(v){arbHops4=!!v;try{localStorage.setItem('bsx-arb-hops4',v?'1':'0');}catch(e){}writeHash();renderTriArb();}
// Color-blind safe palette toggle: green/red → blue/orange via .cb-safe class on <html>.
function toggleCbSafe(v){
  const on=v===undefined?!document.documentElement.classList.contains('cb-safe'):!!v;
  document.documentElement.classList.toggle('cb-safe',on);
  try{localStorage.setItem('bsx-cb-safe',on?'1':'0');}catch(e){}
  // Charts read palette colors at render time; re-render the ones that show bid/ask.
  if(selectedPair!=='ALL'){const{bids,asks}=getBidsAsks(selectedPair);renderDepthChart(bids,asks,selectedPair);}
  renderTicker&&renderTicker();
}
// Tab title: snapshot freshness + selected pair best bid + count of unseen offers since last focus.
// Updated on every renderAll() and on visibilitychange (focus resets the "unseen" counter).
let tabUnseenBaseline=0; // msg ids count at the moment the tab last had focus
function tabTitleSeenBaseline(){tabUnseenBaseline=allOffers.length;updateTabTitle();}
function updateTabTitle(){
  let prefix='';
  if(document.visibilityState==='hidden'&&allOffers.length>tabUnseenBaseline){
    const n=allOffers.length-tabUnseenBaseline;
    prefix='('+n+' new) ';
  }
  let suffix='BSX Orderbook';
  if(selectedPair!=='ALL'){
    const{bids,asks}=getBidsAsks(selectedPair);
    const bb=bids.length?bids[0].price:0;
    suffix=selectedPair+(bb?' '+bb.toFixed(6):'')+' · BSX';
  }
  document.title=prefix+suffix;
}
function clearFilters(){
  selectedPair='ALL';selectedCoin='ALL';searchQuery='';selectedSwapType='ALL';minUsdFilter=0;
  negotiableOnly=false;watchedOnly=false;hideExpired=true;postedFilter=null;autoAcceptOnly=false;
  document.getElementById('pair-select').value='ALL';
  document.getElementById('search-id').value='';
  document.getElementById('swap-type-filter').value='ALL';
  document.getElementById('min-usd-filter').value='0';
  const ng=document.getElementById('negotiable-filter');if(ng)ng.checked=false;
  const wt=document.getElementById('watched-filter');if(wt)wt.checked=false;
  const aa=document.getElementById('autoaccept-filter');if(aa)aa.checked=false;
  // Hide-expired defaults to true; mirror that into the DOM so the checkbox state matches the var.
  const he=document.getElementById('hide-expired-filter');if(he)he.checked=true;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector('.filter-btn[data-coin="ALL"]').classList.add('active');
  saveFilters();writeHash();renderAll();renderTicker();renderActivityHeatmap();renderPostedChip();updateFilterCount();
}
function updateFilterCount(){
  const total=allOffers.length,shown=getFilteredOffers().length;
  const el=document.getElementById('filter-count');
  if(el)el.textContent=shown===total?'':`Showing ${shown} of ${total}`;
  // Active-count badge on the "More filters" disclosure: lets the user see at a glance how many
  // of the collapsed secondary toggles are on without expanding it.
  const b=document.getElementById('more-filters-badge');if(b){
    let n=0;
    if(negotiableOnly)n++;if(autoAcceptOnly)n++;if(watchedOnly)n++;
    if(!hideExpired)n++; // hide-expired defaults ON, so "off" is the diverging state
    if(compactMode)n++;if(liteMode)n++;
    b.style.display=n?'':'none';b.textContent=n?' ('+n+')':'';
  }
}
function getPairs(){
  const s=new Set();allOffers.forEach(o=>{const a=o.coin_from,b=o.coin_to;s.add(a<b?a+'/'+b:b+'/'+a);});return[...s].sort();
}
function getBidsAsks(pair){
  const[base,quote]=pair.split('/'),bids=[],asks=[];
  allOffers.forEach(o=>{const fa=parseFloat(o.amount_from_str),ta=parseFloat(o.amount_to_str);if(!fa||!ta)return;
    if(o.coin_from===base&&o.coin_to===quote)asks.push({price:ta/fa,amount:fa,total:ta,offer:o});
    else if(o.coin_from===quote&&o.coin_to===base)bids.push({price:fa/ta,amount:ta,total:fa,offer:o});
  });
  bids.sort((a,b)=>b.price-a.price);asks.sort((a,b)=>a.price-b.price);return{bids,asks};
}
// Mid-relative spread is the industry-standard convention: pct = (ask - bid) / mid * 100.
// Same formula used by the per-pair ticker cards (renderTicker), so both views agree.
function computeSpread(bids,asks){
  if(!bids.length||!asks.length)return null;
  const bb=bids[0].price,ba=asks[0].price,abs=ba-bb,mid=(bb+ba)/2;
  return{bestBid:bb,bestAsk:ba,abs,mid,pct:mid>0?(abs/mid)*100:0};
}

function chartColors(){
  const dk=document.documentElement.classList.contains('dark');
  return{text:dk?'#d1d5db':'#4b5563',grid:dk?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)',bidFill:'rgba(16,185,129,.3)',bidLine:'#10b981',askFill:'rgba(239,68,68,.3)',askLine:'#ef4444',line:dk?'#3b82f6':'#2563eb',lineFill:dk?'rgba(59,130,246,.1)':'rgba(37,99,235,.1)'};
}
function renderDepthChart(bids,asks,pair){
  const w=document.getElementById('depth-chart-wrap');
  if(!bids.length&&!asks.length){w.style.display='none';return;}
  w.style.display='';const c=chartColors();
  const [base,quote]=(pair||'/').split('/');
  let cb=[],ca=[],v=0;
  for(const b of bids){v+=b.amount;cb.push({x:b.price,y:v});}cb.reverse();
  v=0;for(const a of asks){v+=a.amount;ca.push({x:a.price,y:v});}
  if(depthChart)depthChart.destroy();
  depthChart=new Chart(document.getElementById('depthChart'),{type:'line',data:{datasets:[
    {label:'Bids',data:cb,borderColor:c.bidLine,backgroundColor:c.bidFill,fill:true,stepped:'after',pointRadius:0,borderWidth:2},
    {label:'Asks',data:ca,borderColor:c.askLine,backgroundColor:c.askFill,fill:true,stepped:'before',pointRadius:0,borderWidth:2}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
    scales:{x:{type:'linear',title:{display:true,text:'Price ('+(quote||'')+'/'+(base||'')+')',color:c.text,font:{size:10}},ticks:{color:c.text,font:{size:9}},grid:{color:c.grid}},
            y:{title:{display:true,text:'Cumulative '+(base||''),color:c.text,font:{size:10}},ticks:{color:c.text,font:{size:9}},grid:{color:c.grid}}},
    interaction:{mode:'nearest',intersect:false}}});
}
function renderHistogram(offers){
  const w=document.getElementById('histogram-wrap');
  const sizes=offers.map(o=>offerFiatSize(o)).filter(v=>v>0);
  if(!sizes.length){w.style.display='none';return;}w.style.display='';const c=chartColors();
  const minV=Math.min(...sizes),maxV=Math.max(...sizes);
  // Adaptive bin count via Sturges, capped 4..12; further reduced on narrow viewports
  // so labels remain legible (~50 px per bin on mobile).
  const vw=(w&&w.clientWidth)||window.innerWidth||800;
  const bnCap=Math.max(4,Math.min(12,Math.floor(vw/50)));
  const bn=Math.min(bnCap,Math.max(4,Math.ceil(Math.log2(sizes.length)+1)));
  const useLog=sizes.length>3&&maxV/Math.max(minV,0.01)>100;
  const edges=[];
  if(useLog){
    const lmin=Math.log10(Math.max(minV,1)),lmax=Math.log10(Math.max(maxV,10));
    const step=(lmax-lmin)/bn;
    for(let i=0;i<=bn;i++)edges.push(Math.pow(10,lmin+i*step));
    edges[0]=0; // include any sub-$1 offers in the first bin
  }else{
    const step=maxV/bn;
    for(let i=0;i<=bn;i++)edges.push(i*step);
  }
  const buckets=new Array(bn).fill(0),labels=[];
  sizes.forEach(v=>{
    let i=bn-1;
    for(let j=0;j<bn;j++){if(v<=edges[j+1]){i=j;break;}}
    buckets[i]++;
  });
  const sym=fiatMeta().sym;
  const fmt=n=>n>=1000?sym+(n>=10000?Math.round(n/1000):(n/1000).toFixed(1))+'k':sym+Math.round(n);
  for(let i=0;i<bn;i++)labels.push(fmt(edges[i])+'–'+fmt(edges[i+1]));
  if(histChart)histChart.destroy();
  histChart=new Chart(document.getElementById('histogramChart'),{type:'bar',data:{labels,datasets:[{label:'Orders',data:buckets,backgroundColor:'rgba(59,130,246,.5)',borderColor:'#3b82f6',borderWidth:1}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:items=>items[0].label+(useLog?' (log)':'')}}},
      scales:{x:{ticks:{color:c.text,font:{size:8},maxRotation:45},grid:{display:false}},y:{ticks:{color:c.text,font:{size:9},stepSize:1},grid:{color:c.grid}}}}});
}
async function fetchPriceHistory(days='1'){
  document.querySelectorAll('.ph-btn').forEach(b=>{b.classList.remove('bg-blue-500','text-white');b.classList.add('bg-bsx-600','text-gray-300');});
  const btn=document.querySelector(`.ph-btn[data-d="${days}"]`);
  if(btn){btn.classList.add('bg-blue-500','text-white');btn.classList.remove('bg-bsx-600','text-gray-300');}
  const w=document.getElementById('price-chart-wrap');
  let coinId=null;
  if(selectedPair!=='ALL')coinId=COIN_GECKO_IDS[selectedPair.split('/')[0]];
  else if(selectedCoin!=='ALL')coinId=COIN_GECKO_IDS[selectedCoin];
  if(!coinId){w.style.display='none';return;}w.style.display='';
  try{const r=await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`);const d=await r.json();
    renderPriceChart(d.prices||[]);
    // Re-use the same payload for the inline mini-chart in the spread bar (1d only).
    if(days==='1'&&selectedPair!=='ALL')renderSpreadMiniChart(d.prices||[]);
  }catch(e){console.warn('Price history failed:',e);}
}
// Inline SVG sparkline of the BASE coin's 24h USD spot, with horizontal dashed lines for the
// current best-bid and best-ask (converted to USD via the quote coin's spot price). Pure SVG —
// no Chart.js instance — because the spread bar is sticky and Chart canvases are heavyweight.
function renderSpreadMiniChart(prices){
  const wrap=document.getElementById('spread-mini-wrap'),svg=document.getElementById('spread-mini');
  if(!wrap||!svg||selectedPair==='ALL'||!prices.length){if(wrap)wrap.style.display='none';return;}
  const[base,quote]=selectedPair.split('/');
  const{bids,asks}=getBidsAsks(selectedPair);
  // Single-sided book \u2014 spread cannot be computed, so the sparkline (whose value is the
  // bid/ask overlay) loses its context. Hide the whole strip to match the "spread cannot be
  // computed" notice rendered just above.
  if(!bids.length||!asks.length){wrap.style.display='none';return;}
  const bb=bids[0].price,ba=asks[0].price;
  const pQuote=latestPrices[COIN_GECKO_IDS[quote]];
  // Best-bid/ask are in quote-coin units; convert to USD to share the chart's Y axis.
  const bbUsd=bb&&pQuote?bb*pQuote:null,baUsd=ba&&pQuote?ba*pQuote:null;
  const ys=prices.map(p=>p[1]);const ymin=Math.min(...ys,bbUsd||Infinity,baUsd||Infinity);
  const ymax=Math.max(...ys,bbUsd||0,baUsd||0);
  if(!isFinite(ymin)||!isFinite(ymax)||ymax===ymin){wrap.style.display='none';return;}
  const W=240,H=44,pad=2;const xs=prices.map(p=>p[0]);const xmin=Math.min(...xs),xmax=Math.max(...xs);
  const sx=t=>pad+(W-pad*2)*(t-xmin)/(xmax-xmin||1);
  const sy=v=>pad+(H-pad*2)*(1-(v-ymin)/(ymax-ymin||1));
  const path=prices.map((p,i)=>(i?'L':'M')+sx(p[0]).toFixed(1)+' '+sy(p[1]).toFixed(1)).join(' ');
  const c=chartColors();
  const dk=document.documentElement.classList.contains('dark');
  const cb=document.documentElement.classList.contains('cb-safe');
  const bidColor=cb?'#60a5fa':(dk?'#4ade80':'#15803d');
  const askColor=cb?'#f97316':(dk?'#f87171':'#b91c1c');
  let extra='';
  if(bbUsd!=null){const y=sy(bbUsd).toFixed(1);extra+=`<line x1="${pad}" x2="${W-pad}" y1="${y}" y2="${y}" stroke="${bidColor}" stroke-width="1" stroke-dasharray="3 2" opacity=".8"><title>Best bid: $${bbUsd.toFixed(2)}</title></line>`;}
  if(baUsd!=null){const y=sy(baUsd).toFixed(1);extra+=`<line x1="${pad}" x2="${W-pad}" y1="${y}" y2="${y}" stroke="${askColor}" stroke-width="1" stroke-dasharray="3 2" opacity=".8"><title>Best ask: $${baUsd.toFixed(2)}</title></line>`;}
  const last=prices[prices.length-1][1];
  svg.innerHTML=`<path d="${path}" fill="none" stroke="${c.line}" stroke-width="1.2"/>${extra}<text x="${W-pad-2}" y="10" text-anchor="end" font-size="9" fill="${c.text}">$${last.toFixed(2)}</text><text x="${pad+2}" y="10" font-size="9" fill="${c.text}">${base}/USD 24h</text>`;
  wrap.style.display='';
}
function renderPriceChart(prices){
  if(!prices.length)return;const c=chartColors();
  const data=prices.map(([t,p])=>({x:t,y:p}));
  if(priceChart)priceChart.destroy();
  priceChart=new Chart(document.getElementById('priceChart'),{type:'line',data:{datasets:[{label:'Price (USD)',data,borderColor:c.line,backgroundColor:c.lineFill,fill:true,pointRadius:0,borderWidth:1.5,tension:.1}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
      scales:{x:{type:'linear',ticks:{color:c.text,font:{size:9},callback:v=>new Date(v).toLocaleDateString(undefined,{month:'short',day:'numeric'})},grid:{color:c.grid}},
              y:{ticks:{color:c.text,font:{size:9},callback:v=>'$'+v.toLocaleString()},grid:{color:c.grid}}},
      interaction:{mode:'nearest',intersect:false}}});
}

function renderBuySell(bids,asks,pair){
  const[base,quote]=pair.split('/');
  const bn=COIN_NAMES[base]||base,qn=COIN_NAMES[quote]||quote;
  document.getElementById('bid-count').textContent=bids.length+' orders';
  document.getElementById('ask-count').textContent=asks.length+' orders';
  // Update buy/sell headers with coin names
  document.querySelector('#buysell-wrap .text-green-400').innerHTML=`Buy ${bn} <span class="text-green-300 text-xs font-normal">(Bids — paying ${qn})</span>`;
  document.querySelector('#buysell-wrap .text-red-400').innerHTML=`Sell ${bn} <span class="text-red-300 text-xs font-normal">(Asks — receiving ${qn})</span>`;
  // Column headers: show units (price=quote/base, amount=base, total=quote)
  ['bid','ask'].forEach(s=>{
    document.getElementById(s+'-price-th').textContent='Price ('+quote+')';
    document.getElementById(s+'-amount-th').textContent='Amount ('+base+')';
    document.getElementById(s+'-total-th').textContent='Total ('+quote+')';
  });
  const bb=document.getElementById('bids-body'),mbt=bids.reduce((m,b)=>Math.max(m,b.total),0);
  const pu=coinFiat(base);
  // Bid row: amount is in BASE; min_bid_amount is in coin_from (=QUOTE for bids), shown as tooltip
  bb.innerHTML=bids.slice(0,50).map(b=>{
    const p=mbt?(b.total/mbt*100):0;
    const usd=pu?' <span class="text-gray-400 dark:text-gray-500">('+formatFiat(b.amount*pu)+')</span>':'';
    const mb=minBidDisplay(b.offer);
    const minTip=mb>0?` title="Min bid: ${mb} ${b.offer.coin_from}"`:'';
    const minTag=mb>0?`<div class="text-[10px] text-gray-400 dark:text-gray-500">min ${mb.toFixed(4)} ${b.offer.coin_from}</div>`:'';
    return`<tr class="vol-bar hover:bg-green-900/10"${minTip}><td class="py-1.5 px-2 text-green-400 whitespace-nowrap">${b.price.toFixed(8)} <span class="text-gray-400 dark:text-gray-500">${quote}</span></td><td class="py-1.5 px-2 text-right text-gray-700 dark:text-gray-100 whitespace-nowrap">${b.amount.toFixed(4)}${usd}${minTag}</td><td class="py-1.5 px-2 text-right text-gray-500 dark:text-gray-300 whitespace-nowrap" style="background:linear-gradient(to left,rgba(16,185,129,.15) ${p}%,transparent ${p}%)">${b.total.toFixed(4)}</td></tr>`;
  }).join('')||`<tr><td colspan="3" class="py-4 text-center text-gray-400 text-xs">No buy orders for ${bn}. Try clearing filters or selecting another pair.</td></tr>`;
  const ab=document.getElementById('asks-body'),mat=asks.reduce((m,a)=>Math.max(m,a.total),0);
  // Ask row: amount is in BASE; min_bid_amount is in coin_from (=BASE for asks)
  ab.innerHTML=asks.slice(0,50).map(a=>{
    const p=mat?(a.total/mat*100):0;
    const usd=pu?' <span class="text-gray-400 dark:text-gray-500">('+formatFiat(a.amount*pu)+')</span>':'';
    const mb=minBidDisplay(a.offer);
    const minTip=mb>0?` title="Min bid: ${mb} ${a.offer.coin_from}"`:'';
    const minTag=mb>0?`<div class="text-[10px] text-gray-400 dark:text-gray-500">min ${mb.toFixed(4)} ${a.offer.coin_from}</div>`:'';
    return`<tr class="vol-bar hover:bg-red-900/10"${minTip}><td class="py-1.5 px-2 text-red-400 whitespace-nowrap">${a.price.toFixed(8)} <span class="text-gray-400 dark:text-gray-500">${quote}</span></td><td class="py-1.5 px-2 text-right text-gray-700 dark:text-gray-100 whitespace-nowrap">${a.amount.toFixed(4)}${usd}${minTag}</td><td class="py-1.5 px-2 text-right text-gray-500 dark:text-gray-300 whitespace-nowrap" style="background:linear-gradient(to left,rgba(239,68,68,.15) ${p}%,transparent ${p}%)">${a.total.toFixed(4)}</td></tr>`;
  }).join('')||`<tr><td colspan="3" class="py-4 text-center text-gray-400 text-xs">No sell orders for ${bn}. Try clearing filters or selecting another pair.</td></tr>`;
}

function renderAllOrders(){
  let offers=getFilteredOffers();
  // Precompute display-unit values; raw amount_*/rate are atomic ints with per-coin decimals,
  // so cross-pair sorting on them is meaningless. Use display amounts within a pair, USD across pairs.
  const isMultiPair=selectedPair==='ALL';
  offers.forEach(o=>{
    const af=parseFloat(o.amount_from_str)||0,at=parseFloat(o.amount_to_str)||0;
    const pf=latestPrices[COIN_GECKO_IDS[o.coin_from]],pt=latestPrices[COIN_GECKO_IDS[o.coin_to]];
    o._mktPct=calcMarketPct(o)||0;
    o._dispRate=af?at/af:0;
    o._sortAmtFrom=isMultiPair&&pf?af*pf:af;
    o._sortAmtTo=isMultiPair&&pt?at*pt:at;
  });
  const sortKeyMap={market_pct:'_mktPct',rate:'_dispRate',amount_from:'_sortAmtFrom',amount_to:'_sortAmtTo'};
  const sk=sortKeyMap[currentSort]||currentSort;
  offers.sort((a,b)=>sortAsc?(a[sk]||0)-(b[sk]||0):(b[sk]||0)-(a[sk]||0));
  const tbody=document.getElementById('offers-body');
  if(!offers.length){tbody.innerHTML='<tr><td colspan="8" class="py-16 text-center text-gray-400 dark:text-gray-300 text-sm">No offers match filter.<br><button data-action="clear-filters" class="mt-3 text-xs px-3 py-1.5 rounded bg-blue-500 text-white hover:bg-blue-400">Clear filters</button></td></tr>';return;}
  // Find best deal (highest positive market %)
  let bestIdx=-1,bestPct=-Infinity;
  offers.forEach((o,i)=>{const m=o._mktPct;if(m>0&&m>bestPct){bestPct=m;bestIdx=i;}});
  let totalUSD=0;const now=Math.floor(Date.now()/1000);
  tbody.innerHTML=offers.map((o,idx)=>{
    const fs=o.coin_from,ts=o.coin_to,fd=COIN_NAMES[fs]||fs,td=COIN_NAMES[ts]||ts;
    const fi=(COIN_IMG[fs]||fs).replace(' ','-')+'.png',ti=(COIN_IMG[ts]||ts).replace(' ','-')+'.png';
    const af=parseFloat(o.amount_from_str)||0,at=parseFloat(o.amount_to_str)||0;
    const rate=af?at/af:0,inv=rate?1/rate:0,sl=SWAP_TYPES[o.swap_type]||'Swap';
    const stt=SWAP_TYPE_DESC[sl]||('Unknown swap-type id '+o.swap_type+' — protocol upgrade not yet mapped in this UI.');
    const sttFull=swapChipTooltip(o,stt),sttNeg=swapChipNegIcon(o);
    const pf=coinFiat(fs),pt=coinFiat(ts);
    const usdFrom=pf?(af*pf):0,usdTo=pt?(at*pt):0;
    const fm=fiatMeta();
    const ru=pt&&rate?fm.sym+(rate*pt).toFixed(2)+' '+fm.code:'N/A';
    const usdFromStr=usdFrom?formatFiat(usdFrom):'';
    const usdToStr=usdTo?formatFiat(usdTo):'';
    totalUSD+=usdFrom;
    const mp=calcMarketPct(o);let ms='—',mc='text-gray-400';
    if(mp!==null){ms=(mp>=0?'+':'')+mp.toFixed(2)+'%';mc=mp>0?'text-green-400':mp<0?'text-red-400':'text-gray-400';}
    // Age badge
    const age=now-o.timestamp;
    const isNew=age<3600;
    const newBadge=isNew?'<span class="badge-new">NEW</span>':'';
    // Expiry
    const pd=new Date(o.timestamp*1000);
    // Posted timestamp: show relative age + absolute local HH:MM on one line. Full UTC ISO in tooltip.
    const psAbs=pd.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
    const psRel=relAge(age);
    const ps=(psRel?psRel+' ago · ':'')+psAbs;
    // time_valid defaults to 0 to match scraper (older snapshots also wrote 0); show "—" when absent.
    const tv=Number(o.time_valid)||0;
    const tl=tv?(o.expire_at||(o.timestamp+tv))-now:null;
    // Clock-icon stroke colour: green default, blue near expiry, grey when expired/unknown.
    let sc='#10B981';
    if(tl===null)sc='#9CA3AF';
    else if(tl<=300)sc='#9CA3AF';
    else if(tl<=1800)sc='#3B82F6';
    const expireWarn=tl!==null&&tl<=300&&tl>0?' <i data-lucide="alert-triangle" class="w-3 h-3 inline-block align-text-bottom"></i>':'';
    // Best deal highlight
    const isBest=idx===bestIdx;
    const expired=tl!==null&&tl<=0;
    // Muted styling (F): expired rows kept visible (when hide-expired toggle is OFF) but de-emphasised.
    const rowCls=`text-gray-700 dark:text-gray-100 hover:bg-coolGray-200 dark:hover:bg-bsx-600 border-b border-gray-200 dark:border-white/5${isBest?' best-deal':''}${expired?' row-expired':''}`;
    const expireHtml=tl===null?'<span class="text-gray-400" title="No time_valid in offer">—</span>'
      :tl>0?formatDuration(tl)+expireWarn:'<span class="text-red-400">Expired</span>';
    // Full UTC tooltip on the timestamp for cross-timezone users.
    const psTitle='Posted at '+pd.toISOString();
    return`<tr class="${rowCls}">
      <td class="desk-cell py-3 pl-3 pr-2 text-xs whitespace-nowrap"><div class="flex items-center gap-2"><svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24"><g stroke-linecap="round" stroke-width="2" fill="none" stroke="${sc}" stroke-linejoin="round"><circle cx="12" cy="12" r="11"/><polyline points="12,6 12,12 18,12" stroke="${sc}"/></g></svg><div><div class="text-xs dark:text-gray-100"><span class="bold">Posted:</span> <span title="${psTitle}">${ps}</span>${newBadge}${bidBadge(o)}</div><div class="text-xs text-gray-500 dark:text-gray-400"><span class="bold">Expires:</span> ${expireHtml}</div><div class="text-xs text-gray-400 dark:text-gray-500 monospace" title="SMSG: ${o.msg_id||''}\nAddr: ${o.addr_from||''} (click to filter)">${(o.msg_id||'').slice(0,10)}… <span class="cursor-pointer hover:underline" style="${makerChipStyle(o.addr_from)}" data-maker="${o.addr_from||''}">${(o.addr_from||'').slice(0,8)}…</span></div></div></div></td>
      <td class="desk-cell p-0"><div class="py-2 px-3 text-left monospace"><div class="text-sm font-semibold text-gray-800 dark:text-white">${at.toFixed(4)} <span class="text-xs font-normal text-gray-500 dark:text-gray-400">${ts}</span></div>${usdToStr?'<div class="text-xs text-gray-400 dark:text-gray-500">'+usdToStr+'</div>':''}</div></td>
      <td class="desk-cell py-0 px-0 text-center"><div class="flex items-center justify-evenly"><img class="h-10" src="images/coins/${ti}" alt="${td}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="coin-fallback" style="width:40px;height:40px;font-size:13px;display:none">${ts}</span><svg class="w-5 h-5 mx-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" class="text-gray-400 dark:text-gray-300"/></svg><img class="h-10" src="images/coins/${fi}" alt="${fd}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="coin-fallback" style="width:40px;height:40px;font-size:13px;display:none">${fs}</span></div></td>
      <td class="desk-cell p-0"><div class="py-2 px-3 text-right monospace"><div class="text-sm font-semibold text-gray-800 dark:text-white">${af.toFixed(4)} <span class="text-xs font-normal text-gray-500 dark:text-gray-400">${fs}</span></div>${usdFromStr?'<div class="text-xs text-gray-400 dark:text-gray-500">'+usdFromStr+'</div>':''}</div></td>
      <td class="desk-cell py-3 px-3 text-center monospace"><span class="text-sm font-semibold text-gray-700 dark:text-gray-100">${usdToStr||'<span class="text-gray-400 dark:text-gray-500 font-normal">—</span>'}</span></td>
      <td class="desk-cell py-3 px-2 text-right monospace text-xs"><div class="flex flex-col items-end"><span class="text-sm bold text-gray-800 dark:text-white">${ru}</span><span class="bold text-gray-700 dark:text-gray-200">${rate.toFixed(8)}</span><span class="text-gray-500 dark:text-gray-400">${ts}/${fs}</span></div></td>
      <td class="desk-cell py-3 px-2 text-center monospace"><span class="text-sm font-bold ${mc}">${ms}${isBest?' <i data-lucide="star" class="w-3 h-3 inline-block align-text-bottom" style="fill:currentColor"></i>':''}</span></td>
      <td class="desk-cell py-3 px-2 text-center swap-type-cell"><div class="swap-type-stack"><span class="swap-type-chip" title="${sttFull}">${sl}${sttNeg}</span>${(()=>{const x=offerExtraBadges(o);return x?'<div class="swap-type-badges">'+x+'</div>':'';})()}</div></td>
      <td class="mob-card-wrap" colspan="8" style="display:none">
        <div class="p-3 border-b border-gray-200 dark:border-white/6${isBest?' best-deal':''}">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24"><g stroke-linecap="round" stroke-width="2" fill="none" stroke="${sc}" stroke-linejoin="round"><circle cx="12" cy="12" r="11"/><polyline points="12,6 12,12 18,12" stroke="${sc}"/></g></svg>
              <span title="${psTitle}">${ps}</span>${newBadge}${bidBadge(o)}
            </div>
            <div class="flex items-center gap-2">
              <span class="text-xs font-bold ${mc}">${ms}${isBest?' <i data-lucide="star" class="w-3 h-3 inline-block align-text-bottom" style="fill:currentColor"></i>':''}</span>
              <span class="swap-type-chip sm" title="${sttFull}">${sl}${sttNeg}</span>
            </div>
          </div>
          <div class="flex items-center justify-between gap-2 mb-2">
            <div class="flex-1">
              <div class="text-xs text-gray-400 dark:text-gray-500 mb-0.5">You send</div>
              <div class="flex items-center gap-1.5">
                <img class="w-5 h-5 rounded-full" src="images/coins/${ti}" alt="${td}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="coin-fallback" style="width:20px;height:20px;font-size:8px;display:none">${ts}</span>
                <span class="monospace font-semibold text-sm text-gray-800 dark:text-white">${at.toFixed(4)}</span>
                <span class="text-xs text-gray-500 dark:text-gray-400">${ts}</span>
              </div>
              ${usdToStr?'<div class="text-xs text-gray-400 dark:text-gray-500 ml-6.5">'+usdToStr+'</div>':''}
            </div>
            <svg class="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6"/></svg>
            <div class="flex-1 text-right">
              <div class="text-xs text-gray-400 dark:text-gray-500 mb-0.5">You get</div>
              <div class="flex items-center gap-1.5 justify-end">
                <span class="text-xs text-gray-500 dark:text-gray-400">${fs}</span>
                <span class="monospace font-semibold text-sm text-gray-800 dark:text-white">${af.toFixed(4)}</span>
                <img class="w-5 h-5 rounded-full" src="images/coins/${fi}" alt="${fd}" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="coin-fallback" style="width:20px;height:20px;font-size:8px;display:none">${fs}</span>
              </div>
              ${usdFromStr?'<div class="text-xs text-gray-400 dark:text-gray-500">'+usdFromStr+'</div>':''}
            </div>
          </div>
          <div class="flex items-center justify-between text-xs monospace">
            <span class="text-gray-500 dark:text-gray-400">${expireHtml}</span>
            <span class="text-gray-700 dark:text-gray-200">${ru} <span class="text-gray-400 dark:text-gray-500">· ${rate.toFixed(6)} ${ts}/${fs}</span></span>
          </div>
          ${(()=>{const x=offerExtraBadges(o);return x?'<div class="mt-1.5 pt-1.5 border-t border-gray-100 dark:border-white/5 flex flex-wrap gap-1">'+x+'</div>':'';})()}
          <div class="text-xs monospace text-gray-400 dark:text-gray-500 mt-1.5 pt-1.5 border-t border-gray-100 dark:border-white/5">
            <div class="truncate" title="${o.msg_id||''}">ID: ${o.msg_id||''}</div>
            ${o.addr_from?'<div class="truncate cursor-pointer hover:underline" title="Click to filter by this maker" data-maker="'+o.addr_from+'" style="'+makerChipStyle(o.addr_from)+'">Addr: '+o.addr_from+'</div>':''}
          </div>
        </div>
      </td>
    </tr>`;}).join('');
  const volStr=totalUSD>0?formatFiat(totalUSD):'—';
  const tv=document.getElementById('totalVolume');if(tv)tv.textContent=volStr;
  const hv=document.getElementById('header-volume');if(hv)hv.textContent='Est. Vol: '+volStr;
  redrawIcons();
}

// Volume-weighted average price for a one-sided book; capped to top-N levels
// so a single fat resting order at the back of the book can't dominate the average.
const VWAP_TOP_N=10;
function vwap(side){
  let num=0,den=0;
  const n=Math.min(side.length,VWAP_TOP_N);
  for(let i=0;i<n;i++){const e=side[i];num+=e.price*e.amount;den+=e.amount;}
  return den>0?num/den:0;
}
// Per-pair listing-count series for ticker sparklines. Pulls from snapshotManifest entries
// that carry pair_counts (scraper-written), then merges any in-session bsx-history entries
// that carry byPair. Returns [{ts,count}, …] sorted by ts; empty when no data exists yet.
function getPairHistory(pair){
  const out=[];
  if(snapshotManifest&&snapshotManifest.length){
    snapshotManifest.forEach(s=>{
      const c=s&&s.pair_counts&&s.pair_counts[pair];
      if(typeof c==='number')out.push({ts:s.ts,count:c});
    });
  }
  try{
    const h=JSON.parse(localStorage.getItem('bsx-history')||'null');
    if(h&&Array.isArray(h.snapshots)){
      h.snapshots.forEach(s=>{
        if(s&&s.byPair&&typeof s.byPair[pair]==='number')out.push({ts:s.ts,count:s.byPair[pair]});
      });
    }
  }catch(e){}
  out.sort((a,b)=>a.ts-b.ts);
  return out;
}
// Minimal inline-SVG sparkline. Returns '' when fewer than 2 data points exist so cards stay
// quiet during early data collection.
function buildSparkline(series,w=60,h=14){
  if(!series||series.length<2)return '';
  const vals=series.map(p=>p.count);
  const min=Math.min(...vals),max=Math.max(...vals),rng=max-min||1;
  const n=vals.length;
  const pts=vals.map((v,i)=>{
    const x=(i/(n-1))*w;
    const y=h-((v-min)/rng)*h;
    return x.toFixed(1)+','+y.toFixed(1);
  }).join(' ');
  const last=vals[n-1],first=vals[0];
  const dir=last>first?'#22c55e':last<first?'#ef4444':'#6b7280';
  const title='Listings: '+first+' → '+last+' over '+n+' snapshot'+(n===1?'':'s');
  return '<svg viewBox="0 0 '+w+' '+h+'" width="'+w+'" height="'+h+'" preserveAspectRatio="none" class="inline-block align-middle" style="overflow:visible"><title>'+title+'</title><polyline fill="none" stroke="'+dir+'" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" points="'+pts+'"/></svg>';
}
// Pair summary ticker cards
function renderTicker(){
  let pairs=getPairs();
  // When "Watched only" is on, restrict tickers to starred pairs (still show all stars below).
  if(watchedOnly&&watchlist.size)pairs=pairs.filter(p=>watchlist.has(p));
  const container=document.getElementById('ticker-cards');
  if(!pairs.length){container.innerHTML='<div class="text-xs text-gray-400 px-2 py-3">No pairs match current filter.</div>';return;}
  // Sort: watched first, then by total listings desc.
  pairs.sort((a,b)=>{
    const wa=watchlist.has(a)?1:0,wb=watchlist.has(b)?1:0;
    if(wa!==wb)return wb-wa;
    const ca=getBidsAsks(a),cb=getBidsAsks(b);
    return (cb.bids.length+cb.asks.length)-(ca.bids.length+ca.asks.length);
  });
  container.innerHTML=pairs.map(p=>{
    const[b,q]=p.split('/');
    const{bids,asks}=getBidsAsks(p);
    const total=bids.length+asks.length;
    const negCount=[...bids,...asks].filter(e=>isNegotiable(e.offer)).length;
    const bestBid=bids.length?bids[0].price:0,bestAsk=asks.length?asks[0].price:0;
    const mid=bestBid&&bestAsk?(bestBid+bestAsk)/2:0;
    const sp=bestBid&&bestAsk?((bestAsk-bestBid)/(mid||1)*100).toFixed(2):'—';
    const crossed=bestBid&&bestAsk&&bestBid>bestAsk;
    const vb=vwap(bids),va=vwap(asks);
    const pb=coinFiat(b),pq=coinFiat(q);
    const pbStr=pb?formatFiat(pb):'—', pqStr=pq?formatFiat(pq):'—';
    const isSelected=selectedPair===p;
    const vwapLine=(vb||va)?`<div class="text-[10px] monospace text-gray-500 dark:text-gray-400">VWAP bid ${vb?vb.toFixed(6):'—'} · ask ${va?va.toFixed(6):'—'}</div>`:'';
    const spreadCls=crossed?'text-orange-400 font-semibold':parseFloat(sp)>5?'text-yellow-500':'text-gray-500 dark:text-gray-400';
    const crossedTag=crossed?' <i data-lucide="alert-triangle" class="w-3 h-3 inline-block align-text-bottom"></i>':'';
    const negTag=negCount?` <span class="neg-badge" title="${negCount} negotiable">N×${negCount}</span>`:'';
    const starOn=watchlist.has(p);
    const star=`<span class="watch-star ${starOn?'on':''}" onclick="toggleWatch('${p}',event)" title="${starOn?'Unwatch':'Watch'} ${p}"><i data-lucide="star" class="w-3.5 h-3.5 inline-block align-text-bottom" style="${starOn?'fill:currentColor':''}"></i></span>`;
    // Rate-alert bell: filled blue when a threshold is set for this pair, hollow grey otherwise.
    const raOn=!!rateAlerts[p];
    const bell=`<span class="rate-bell ${raOn?'on':''}" data-action="rate-alert" data-pair="${p}" onclick="event.stopPropagation()" title="${raOn?'Rate alert set \u2014 click to edit':'Set rate alert for '+p}"><i data-lucide="bell" class="w-3 h-3 inline-block align-text-bottom"></i></span>`;
    const spark=buildSparkline(getPairHistory(p));
    return`<div onclick="selectPair('${p}')" class="flex-shrink-0 px-3 py-2 rounded-lg cursor-pointer transition ${isSelected?'bg-blue-500/20 border border-blue-500/40':'bg-gray-100 dark:bg-bsx-500 border border-gray-300 dark:border-transparent hover:border-gray-400 dark:hover:border-bsx-400'}">
      <div class="flex items-center gap-1.5 mb-1">
        ${star}
        <img src="images/coins/${(COIN_IMG[b]||b).replace(' ','-')}-20.png" class="w-4 h-4 rounded-full" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="coin-fallback" style="width:16px;height:16px;font-size:7px;display:none">${b}</span>
        <img src="images/coins/${(COIN_IMG[q]||q).replace(' ','-')}-20.png" class="w-4 h-4 rounded-full" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="coin-fallback" style="width:16px;height:16px;font-size:7px;display:none">${q}</span>
        <span class="text-sm font-semibold text-gray-800 dark:text-white">${p}</span>
        <span class="text-xs text-gray-500 dark:text-gray-400 bg-gray-200 dark:bg-bsx-400 px-1.5 rounded-full">${total}</span>${negTag}
        ${spark?'<span class="ml-1" title="Listings count, recent snapshots">'+spark+'</span>':''}
        ${bell}
      </div>
      <div class="text-xs monospace text-gray-700 dark:text-gray-200">${b}: ${pbStr} · ${q}: ${pqStr}</div>
      <div class="text-xs text-gray-500 dark:text-gray-400">Spread: <span class="${spreadCls}">${sp}%${crossedTag}</span></div>
      ${vwapLine}
    </div>`;
  }).join('');
  redrawIcons();
}

// Liquidity heatmap
function renderHeatmap(){
  const coins=[...new Set(allOffers.flatMap(o=>[o.coin_from,o.coin_to]))].sort();
  if(coins.length<2){document.getElementById('heatmap-wrap').style.display='none';return;}
  document.getElementById('heatmap-wrap').style.display='';
  const vol={},cnt={};
  allOffers.forEach(o=>{
    const k=o.coin_from+'→'+o.coin_to;
    const p=coinFiat(o.coin_from);
    vol[k]=(vol[k]||0)+(p?parseFloat(o.amount_from_str)*p:0);
    cnt[k]=(cnt[k]||0)+1;
  });
  const maxVol=Math.max(...Object.values(vol),1);
  // Full-width table
  let html='<table class="w-full" style="border-collapse:separate;border-spacing:3px"><tr><td></td>';
  coins.forEach(c=>{html+=`<td class="text-center text-xs font-bold text-gray-600 dark:text-gray-300 pb-1">${c}</td>`;});
  html+='</tr>';
  coins.forEach(from=>{
    html+=`<tr><td class="text-xs font-bold text-gray-600 dark:text-gray-300 pr-2 whitespace-nowrap text-right">${from}</td>`;
    coins.forEach(to=>{
      if(from===to){html+='<td><div class="heatmap-cell bg-gray-200 dark:bg-bsx-600 text-gray-400 dark:text-gray-500">—</div></td>';return;}
      const k=from+'→'+to,v=vol[k]||0,n=cnt[k]||0;
      const intensity=v>0?Math.max(0.2,Math.pow(v/maxVol,0.5)):0;
      const bg=v>0?`rgba(59,130,246,${intensity.toFixed(2)})`:'rgba(128,128,128,0.08)';
      const isDark=document.documentElement.classList.contains('dark');
      const textColor=intensity>0.5?'#fff':v>0?(isDark?'#93c5fd':'#1e3a8a'):(isDark?'#666':'#9ca3af');
      const pair=from<to?from+'/'+to:to+'/'+from;
      const sym=fiatMeta().sym;
      const cellLbl=v>0?(v>=10000?sym+Math.round(v/1000)+'k':v>=1000?sym+(v/1000).toFixed(1)+'k':sym+Math.round(v)):'·';
      const newMark=newPairs.has(pair)?' <span style="background:rgba(34,197,94,.85);color:#000;font-size:8px;font-weight:700;padding:0 3px;border-radius:2px;vertical-align:top">NEW</span>':'';
      html+=`<td><div class="heatmap-cell monospace" style="background:${bg};color:${textColor}" onclick="selectPair('${pair}')" title="${from} → ${to}: ${n} offer${n!==1?'s':''}, ${v>0?formatFiat(v):'no volume'}">${cellLbl}${newMark}</div></td>`;
    });
    html+='</tr>';
  });
  html+='</table>';
  document.getElementById('heatmap-grid').innerHTML=html;
}

function renderAll(){
  const offers=getFilteredOffers();
  // Section heading for pair analytics: visible only when a pair (or coin) is selected.
  const pah=document.getElementById('pair-analytics-h');
  const pap=document.getElementById('pair-analytics-pair');
  const pairFocus=selectedPair!=='ALL'||selectedCoin!=='ALL';
  if(pah)pah.style.display=pairFocus?'':'none';
  if(pap)pap.textContent=pairFocus?'· '+(selectedPair!=='ALL'?selectedPair:selectedCoin):'';
  if(selectedPair!=='ALL'){
    const{bids,asks}=getBidsAsks(selectedPair);
    const[base,quote]=selectedPair.split('/');
    document.getElementById('buysell-wrap').style.display='';
    renderBuySell(bids,asks,selectedPair);renderDepthChart(bids,asks,selectedPair);renderHistogram(offers);
    const sp=computeSpread(bids,asks),bar=document.getElementById('spread-bar');
    // Spread bar is always visible when a pair is selected; the bid/ask row and fiat row
    // toggle independently so single-sided pairs still get the fiat-context line.
    bar.style.display='';
    const baRow=document.getElementById('spread-bid-ask-row');
    const oneSide=document.getElementById('spread-one-side');
    const pq=coinFiat(quote);
    const fiatTag=(coinPrice,unitPrice)=>coinPrice&&unitPrice?'<span class="text-gray-400 dark:text-gray-500">(≈'+formatFiat(coinPrice*unitPrice)+')</span>':'';
    if(sp){
      baRow.style.display='';oneSide.style.display='none';
      document.getElementById('best-bid').textContent=sp.bestBid.toFixed(8)+' '+quote;
      document.getElementById('best-ask').textContent=sp.bestAsk.toFixed(8)+' '+quote;
      document.getElementById('best-bid-fiat').innerHTML=fiatTag(pq,sp.bestBid);
      document.getElementById('best-ask-fiat').innerHTML=fiatTag(pq,sp.bestAsk);
      document.getElementById('spread-abs').textContent=sp.abs.toFixed(8)+' '+quote;
      document.getElementById('spread-pct').textContent=sp.pct.toFixed(2)+'%';
      document.getElementById('crossed-warn').style.display=sp.abs<0?'':'none';
      const sideTop=(rows)=>{
        const m={};rows.forEach(e=>{const a=e.offer.addr_from||'';if(a)m[a]=(m[a]||0)+1;});
        const tot=Object.values(m).reduce((a,b)=>a+b,0);
        const t=Object.entries(m).sort((a,b)=>b[1]-a[1])[0];
        return t?{addr:t[0],n:t[1],tot,pct:t[1]/tot*100}:null;
      };
      const tb=sideTop(bids),ta=sideTop(asks);
      const mcEl=document.getElementById('maker-concentration');
      const fmtSide=(label,t)=>{
        if(!t)return '';
        const cls=t.pct>=50?'text-orange-400':t.pct>=30?'text-yellow-500':'text-gray-400';
        return `<span class="mr-3">${label} <span class="${cls} monospace cursor-pointer hover:underline" data-maker="${t.addr}" title="${t.addr}">${t.addr.slice(0,8)}…</span> (${t.n}/${t.tot} = ${t.pct.toFixed(0)}%)</span>`;
      };
      if(tb||ta){mcEl.innerHTML=fmtSide('Top bid:',tb)+fmtSide('Top ask:',ta);}
      else{mcEl.textContent='';}
    }else{
      // Only one side present (or none): hide the comparison row but keep the bar so the
      // fiat-context line still renders. Tell the user which side is missing.
      baRow.style.display='none';
      if(!bids.length&&!asks.length){oneSide.textContent='No bids or asks for '+selectedPair+' in this snapshot.';oneSide.style.display='';}
      else if(!asks.length){oneSide.innerHTML='Only bids in this snapshot ('+bids.length+' bid'+(bids.length===1?'':'s')+', 0 asks) \u2014 spread cannot be computed. Best bid: <strong class="text-green-400 monospace">'+bids[0].price.toFixed(8)+' '+quote+'</strong> '+fiatTag(pq,bids[0].price);oneSide.style.display='';}
      else{oneSide.innerHTML='Only asks in this snapshot ('+asks.length+' ask'+(asks.length===1?'':'s')+', 0 bids) \u2014 spread cannot be computed. Best ask: <strong class="text-red-400 monospace">'+asks[0].price.toFixed(8)+' '+quote+'</strong> '+fiatTag(pq,asks[0].price);oneSide.style.display='';}
    }
    // Fiat prices for base coin: render unconditionally so the user always gets context
    // (was previously gated behind `sp` and disappeared for single-sided pairs).
    const gid=COIN_GECKO_IDS[base],bn=COIN_NAMES[base]||base;
    document.getElementById('fiat-coin-label').textContent='1 '+bn+' =';
    const fmt=(v,s,d=2)=>v?s+v.toLocaleString(undefined,{maximumFractionDigits:d}):'—';
    document.getElementById('spread-usd').textContent=fmt(latestPrices[gid],'$');
    document.getElementById('spread-eur').textContent=fmt(fiatPriceMaps.eur[gid],'€');
    document.getElementById('spread-gbp').textContent=fmt(fiatPriceMaps.gbp[gid],'£');
    document.getElementById('spread-zar').textContent=fmt(fiatPriceMaps.zar[gid],'R');
    document.getElementById('spread-cny').textContent=fmt(fiatPriceMaps.cny[gid],'¥');
    document.getElementById('spread-jpy').textContent=fmt(fiatPriceMaps.jpy[gid],'¥',0);
    fetchPriceHistory('1');
  }else{
    document.getElementById('buysell-wrap').style.display='none';
    document.getElementById('depth-chart-wrap').style.display='none';
    document.getElementById('spread-bar').style.display='none';
    if(selectedCoin!=='ALL'){fetchPriceHistory('1');renderHistogram(offers);}
    else{document.getElementById('price-chart-wrap').style.display='none';document.getElementById('histogram-wrap').style.display='none';}
  }
  renderAllOrders();updateFilterCount();updateTabTitle();
}

function buildFilters(){
  const coins=[...new Set(allOffers.flatMap(o=>[o.coin_from,o.coin_to]))].sort();
  document.getElementById('coin-filters').innerHTML=coins.map(c=>
    `<button class="filter-btn px-2 py-1 text-xs font-semibold rounded border flex items-center gap-1" data-coin="${c}" onclick="setCoinFilter('${c}',this)">${coinImg(c,16)} ${c}</button>`
  ).join('');
  const pairs=getPairs(),sel=document.getElementById('pair-select');
  // Pairs flagged by recomputeNewPairs() (E) get a · NEW marker in the dropdown.
  sel.innerHTML='<option value="ALL">All Pairs</option>'+pairs.map(p=>`<option value="${p}"${p===selectedPair?' selected':''}>${p}${newPairs.has(p)?' · NEW':''}</option>`).join('');
  // Populate swap-type filter from observed (not all theoretical) swap types so the dropdown
  // never offers a value that yields zero rows. Falls back to SWAP_TYPE_OPTIONS when offers absent.
  const observed=[...new Set(allOffers.map(o=>SWAP_TYPES[o.swap_type]).filter(Boolean))];
  const stOpts=observed.length?observed.sort():SWAP_TYPE_OPTIONS;
  const ss=document.getElementById('swap-type-filter');
  if(ss){ss.innerHTML='<option value="ALL">All Swap Types</option>'+stOpts.map(v=>`<option value="${v}"${v===selectedSwapType?' selected':''} title="${(SWAP_TYPE_DESC[v]||'').replace(/"/g,'&quot;')}">${v}</option>`).join('');}
  // Stale-pair fallback: if a previously-bookmarked pair no longer exists in this snapshot,
  // surface a small notice so the user understands why the table is empty.
  const conflict=document.getElementById('filter-conflict');
  if(conflict){
    let msg='';
    if(selectedPair!=='ALL'&&!pairs.includes(selectedPair)){
      msg='<i data-lucide="alert-triangle" class="w-3.5 h-3.5 inline-block align-text-bottom"></i> Pair '+selectedPair+' is not in the current snapshot. <a class="underline cursor-pointer" data-action="reset-pair">Reset</a>';
    }else if(watchedOnly&&selectedPair!=='ALL'&&!watchlist.has(selectedPair)){
      msg='Watched-only is hiding the selected pair. <a class="underline cursor-pointer" data-action="watch-current">Add to watchlist</a> or <a class="underline cursor-pointer" data-action="clear-watched">turn off Watched only</a>';
    }
    conflict.innerHTML=msg;conflict.style.display=msg?'':'none';
  }
}
function setCoinFilter(coin,btn){
  selectedCoin=coin;selectedPair='ALL';document.getElementById('pair-select').value='ALL';
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
  saveFilters();writeHash();renderAll();renderTicker();
}
function selectPair(pair){
  document.getElementById('pair-select').value=pair;
  onPairChange(pair);
}
function onPairChange(pair){
  selectedPair=pair;if(pair!=='ALL')selectedCoin='ALL';
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  if(pair==='ALL')document.querySelector('.filter-btn[data-coin="ALL"]').classList.add('active');
  saveFilters();writeHash();renderAll();renderTicker();
}
// Collapsible section state (persisted in localStorage). User-collapsed state is
// orthogonal to the existing display:none "no-data" toggling done by render code.
function loadSectionStates(){
  // v2 cache key: bumped when the default-collapsed list changes so existing visitors
  // (whose v1 cache pinned buysell-wrap closed) pick up the new defaults on next load.
  let stored;try{stored=JSON.parse(localStorage.getItem('bsx-sections-collapsed-v2')||'null');}catch(e){}
  // First-visit defaults: keep Buy/Sell + Order-Size + Markets Overview open so a new
  // visitor sees the high-signal panels immediately. Only the heavier analytics blocks start collapsed.
  if(!Array.isArray(stored))stored=['pair-analytics-h','activity-wrap','feed-wrap'];
  stored.forEach(id=>{const el=document.getElementById(id);if(el)el.classList.add('section-collapsed');});
}
function saveSectionStates(){
  const ids=[...document.querySelectorAll('.collapsible-section.section-collapsed')].map(e=>e.id);
  try{localStorage.setItem('bsx-sections-collapsed-v2',JSON.stringify(ids));}catch(e){}
}
function toggleSection(id){const el=document.getElementById(id);if(!el)return;el.classList.toggle('section-collapsed');saveSectionStates();}
function expandSection(id){const el=document.getElementById(id);if(!el||!el.classList.contains('section-collapsed'))return;el.classList.remove('section-collapsed');saveSectionStates();}
function filterByMaker(addr){
  if(!addr)return;
  document.getElementById('search-id').value=addr;
  searchQuery=addr;
  saveFilters();renderAllOrders();updateFilterCount();
  // Scroll to the table so the user sees the filter applied
  document.getElementById('offers-body').scrollIntoView({behavior:'smooth',block:'start'});
}
function sortBy(field){
  if(currentSort===field)sortAsc=!sortAsc;else{currentSort=field;sortAsc=false;}
  // Clear arrow + active state on every header, then mark the active one.
  document.querySelectorAll('.sort-icon').forEach(el=>{el.textContent='';el.classList.remove('sort-icon-active');});
  document.querySelectorAll('th[onclick^="sortBy"] > div').forEach(d=>d.classList.remove('sort-th-active'));
  const icon=document.getElementById('sort-'+field);
  if(icon){icon.textContent=sortAsc?'▲':'▼';icon.classList.add('sort-icon-active');
    const th=icon.closest('th');if(th){const inner=th.querySelector(':scope > div');if(inner)inner.classList.add('sort-th-active');}}
  renderAllOrders();
}

function updateRefreshAgo(){
  const ago=Math.floor((Date.now()-lastFetchTime)/1000);
  document.getElementById('refresh-ago').textContent=lastFetchTime?(ago<60?ago+'s ago':Math.floor(ago/60)+'m ago'):'—';
}
function startCountdown(){
  countdown=REFRESH_INTERVAL;if(countdownInterval)clearInterval(countdownInterval);
  countdownInterval=setInterval(()=>{countdown--;
    const m=Math.floor(countdown/60),s=countdown%60;
    document.getElementById('refresh-countdown').textContent='('+m+':'+(s<10?'0':'')+s+')';
    updateRefreshAgo();if(countdown<=0){countdown=REFRESH_INTERVAL;fetchOrderbook();}},1000);
}
async function manualRefresh(){
  document.getElementById('refreshSpinner').classList.add('animate-spin');
  await fetchPrices();await fetchOrderbook();
  document.getElementById('refreshSpinner').classList.remove('animate-spin');
}

// CoinGecko price cache in localStorage. Versioned key (PRICE_CACHE_KEY) so that any change to
// COIN_GECKO_IDS (new coin, renamed id) invalidates older caches that would otherwise serve a
// stale map missing the new ids — fixes the "BCH/WOW shows as —" bug seen after we added coins.
// Bump when the set of fetched vs_currencies changes so v2 caches missing the new codes
// are discarded rather than served as partial data.
const PRICE_CACHE_KEY='bsx-prices-v3';
// All vs_currencies we ask CoinGecko for. Derived from FIAT_META so adding a new currency
// only requires one edit. USD is always first because the per-id sanity check below reads val.usd.
const FIAT_CODES=Object.keys(FIAT_META).filter(k=>k!=='usd');
function expectedPriceIds(){return [...new Set(Object.values(COIN_GECKO_IDS))];}
function loadCachedPrices(){
  try{const c=JSON.parse(localStorage.getItem(PRICE_CACHE_KEY)||'null');
    if(!c||Date.now()-c.ts>REFRESH_INTERVAL*1000)return false;
    // If the cache is missing any currently-expected id (e.g. a coin was added since last fetch)
    // discard it so we trigger an immediate refetch instead of serving partial data.
    const need=expectedPriceIds();
    const have=c.usd||{};
    if(need.some(id=>!(id in have)))return false;
    latestPrices=have;
    FIAT_CODES.forEach(k=>{fiatPriceMaps[k]=c[k]||{};});
    return true;
  }catch(e){return false;}
}
function saveCachedPrices(){
  try{const o={ts:Date.now(),usd:latestPrices};
    FIAT_CODES.forEach(k=>{o[k]=fiatPriceMaps[k];});
    localStorage.setItem(PRICE_CACHE_KEY,JSON.stringify(o));
  }catch(e){}
}
async function fetchPrices(){
  try{const ids=[...new Set(Object.values(COIN_GECKO_IDS))].join(',');
    const vs=['usd'].concat(FIAT_CODES).join(',');
    const r=await fetch('https://api.coingecko.com/api/v3/simple/price?ids='+ids+'&vs_currencies='+vs);
    if(!r.ok){console.warn('CoinGecko API error:',r.status);return;}
    const d=await r.json();
    if(d.status){console.warn('CoinGecko rate limited');return;} // rate limit response has {status:{error_code:429}}
    for(const[id,val]of Object.entries(d)){
      if(!val||!val.usd)continue;
      latestPrices[id]=val.usd;
      FIAT_CODES.forEach(k=>{fiatPriceMaps[k][id]=val[k]||0;});
    }
    saveCachedPrices();
  }catch(e){console.warn('Price fetch failed:',e);}
}
// 24h history tracker (msg_id first-seen + 5-min snapshots) in localStorage, pruned to 7 days
function updateHistory(){
  let h;try{h=JSON.parse(localStorage.getItem('bsx-history')||'null');}catch(e){}
  if(!h||typeof h!=='object'||!h.seen||!h.snapshots)h={seen:{},snapshots:[],lastIds:[]};
  const now=Math.floor(Date.now()/1000);
  const cutoff24h=now-86400,prune=now-7*86400;
  const currentIds=new Set(allOffers.map(o=>o.msg_id));
  // Track first-seen for each offer + capture pair/maker so the Activity Feed can label disappeared
  // offers after they're gone (the feed otherwise only knows their msg_id).
  h.meta=h.meta||{};
  allOffers.forEach(o=>{
    if(!h.seen[o.msg_id])h.seen[o.msg_id]=now;
    h.meta[o.msg_id]={p:(o.coin_to||'?')+'/'+(o.coin_from||'?'),m:(o.addr_from||'').slice(0,10)};
  });
  // Disappeared = previously visible last snapshot but not now
  const goneNow=(h.lastIds||[]).filter(id=>!currentIds.has(id));
  // Compute total listed USD this snapshot + per-pair counts (for ticker sparklines).
  let totalUsd=0;const byPair={};
  allOffers.forEach(o=>{
    totalUsd+=offerUsdSize(o);
    const a=o.coin_from,b=o.coin_to;const k=a<b?a+'/'+b:b+'/'+a;
    byPair[k]=(byPair[k]||0)+1;
  });
  h.snapshots.push({ts:now,count:allOffers.length,total_usd:totalUsd,byPair});
  h.snapshots=h.snapshots.filter(s=>s.ts>=cutoff24h);
  h.lastIds=[...currentIds];
  // Disappeared running total within 24h
  h.gone24h=(h.gone24h||[]).filter(g=>g.ts>=cutoff24h);
  goneNow.forEach(id=>h.gone24h.push({id,ts:now}));
  // Prune very old seen entries (and matching meta so the table doesn't grow unboundedly).
  for(const k in h.seen)if(h.seen[k]<prune){delete h.seen[k];if(h.meta)delete h.meta[k];}
  try{localStorage.setItem('bsx-history',JSON.stringify(h));}catch(e){}
  // Render stats
  const newIn1h=allOffers.filter(o=>h.seen[o.msg_id]>=now-3600).length;
  const newIn24h=allOffers.filter(o=>h.seen[o.msg_id]>=cutoff24h).length;
  const oldest=h.snapshots[0],newest=h.snapshots[h.snapshots.length-1];
  const volDelta=oldest&&newest?newest.total_usd-oldest.total_usd:0;
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  set('sc-new-1h',newIn1h);set('sc-new-24h',newIn24h);
  // Prefer the scraper-side history manifest (real cross-session series) if it has loaded.
  // Falls back to localStorage snapshots otherwise.
  let useDelta=volDelta,useLen=h.snapshots.length,useHrs=h.snapshots.length?Math.round((newest.ts-oldest.ts)/3600):0;
  if(snapshotManifest&&snapshotManifest.length>=2){
    const m=snapshotManifest;const oldS=m[0],newS=m[m.length-1];
    if(newS.total_usd!=null&&oldS.total_usd!=null){useDelta=newS.total_usd-oldS.total_usd;}
    useLen=m.length;useHrs=Math.round((newS.ts-oldS.ts)/3600);
  }
  if(useLen>=2){
    const sign=useDelta>=0?'+':'-';
    const fxDelta=Math.abs(useDelta)*usdToFiatRatio();
    const absStr=fxDelta>=0.01?formatFiat(fxDelta):(fiatMeta().sym+'0.00');
    const suffix=useHrs<24?` <span class="text-[10px] text-gray-500">(collecting · ${useHrs}h)</span>`:'';
    const el=document.getElementById('sc-vol-delta');if(el)el.innerHTML=sign+absStr+suffix;
  }else{set('sc-vol-delta','—');}
}
// Activity feed: NEW / GONE events from the last 24h of localStorage history. Cheap to render —
// reads bsx-history once and reverse-sorts ~hundreds of entries. Rendered as a compact list
// rather than a chart because the dimension here is "what changed and when", not "how much".
function renderActivityFeed(){
  const body=document.getElementById('feed-body');if(!body)return;
  let h;try{h=JSON.parse(localStorage.getItem('bsx-history')||'null');}catch(e){}
  if(!h){body.innerHTML='<div class="text-gray-400">No history yet \u2014 refresh a few times to populate.</div>';return;}
  const now=Math.floor(Date.now()/1000),cutoff=now-86400;
  const meta=h.meta||{};
  const evts=[];
  // NEW events: first-seen timestamps from h.seen, filtered to last 24h.
  Object.keys(h.seen||{}).forEach(id=>{const ts=h.seen[id];if(ts>=cutoff)evts.push({t:'NEW',id,ts,info:meta[id]});});
  // GONE events: explicit gone24h list (id+ts).
  (h.gone24h||[]).forEach(g=>{if(g.ts>=cutoff)evts.push({t:'GONE',id:g.id,ts:g.ts,info:meta[g.id]});});
  evts.sort((a,b)=>b.ts-a.ts);
  const cnt=document.getElementById('feed-count');if(cnt)cnt.textContent=evts.length?evts.length+' events / 24h':'';
  if(!evts.length){body.innerHTML='<div class="text-gray-400">No NEW or GONE events in the last 24h.</div>';return;}
  // Cap at 200 to keep the DOM modest; everything older is implied by the count above.
  const rows=evts.slice(0,200).map(e=>{
    const age=now-e.ts;
    const ageStr=age<60?age+'s':age<3600?Math.floor(age/60)+'m':Math.floor(age/3600)+'h';
    const cls=e.t==='NEW'?'text-green-400':'text-orange-400';
    const pair=e.info&&e.info.p?e.info.p:'?/?';
    const maker=e.info&&e.info.m?'<span class="text-gray-400">\u00b7 '+e.info.m+'\u2026</span>':'';
    return `<div class="row flex items-center gap-2 py-0.5"><span class="${cls} font-semibold" style="width:42px">${e.t}</span><span class="text-gray-300" style="width:48px">${ageStr} ago</span><span style="width:120px">${pair}</span><span class="text-gray-500" title="${e.id}">${(e.id||'').slice(0,12)}\u2026</span> ${maker}</div>`;
  }).join('');
  body.innerHTML=rows;
}
// Snapshot manifest (optional): if scraper writes <history-dir>/manifest.json,
// the UI uses that real cross-session history rather than localStorage-only.
let snapshotManifest=null;
async function fetchSnapshotManifest(){
  try{
    const r=await fetch('snapshots/manifest.json',{cache:'no-store'});
    if(!r.ok)return;
    const j=await r.json();
    if(j&&Array.isArray(j.snapshots))snapshotManifest=j.snapshots.slice(-200);
  }catch(e){/* manifest absent - OK, fall back to localStorage */}
}
// Top scorecard: at-a-glance JSON-derived metrics. Called once per fetchOrderbook().
function renderScorecard(d){
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  if(!d){return;}
  const offers=d.offers||[];
  const now=Math.floor(Date.now()/1000);
  // Prefer top-level fields written by the new scraper; fall back to recompute from offers.
  const active=typeof d.active_offers==='number'?d.active_offers
    :offers.filter(o=>(o.timestamp+(o.time_valid||0))>now).length;
  const makers=typeof d.unique_makers==='number'?d.unique_makers
    :new Set(offers.map(o=>o.addr_from).filter(Boolean)).size;
  const pairs=typeof d.unique_pairs==='number'?d.unique_pairs
    :new Set(offers.filter(o=>o.coin_from&&o.coin_to).map(o=>pairKey(o.coin_from,o.coin_to))).size;
  let liq=0;offers.forEach(o=>{liq+=offerFiatSize(o);});
  set('sc-active',active.toLocaleString());
  set('sc-listed',offers.length.toLocaleString());
  set('sc-pairs',pairs);
  set('sc-makers',makers);
  set('sc-liquidity',liq>0?formatFiat(liq):'—');
  // P2P scraper stats (split into BSX vs foreign SMSGs).
  const s=d.stats||{};
  const r=s.msgs_received||0,dec=s.msgs_decrypted||0;
  // Backward-compat: older snapshots only have decrypt_errors (all MAC mismatches in practice).
  const foreign=typeof s.not_for_us==='number'?s.not_for_us:(s.decrypt_errors||0);
  const parseErr=s.parse_errors||0;
  set('sc-recv',r.toLocaleString());
  set('sc-dec',dec.toLocaleString());
  set('sc-foreign',foreign.toLocaleString());
  set('sc-parse',parseErr.toLocaleString());
  const parseChip=document.getElementById('sc-parse-chip');
  if(parseChip)parseChip.style.display=parseErr>0?'':'none';
  // Non-OFFER message types (bids / accepts) when scraper exposes them.
  // Hide the chip entirely when the scraper has no bid/accept counts to show; the placeholder
  // '— / —' looked like a broken metric otherwise.
  const mtc=s.message_type_counts||{};
  const bids=(mtc.bid||0)+(mtc.BID||0);
  const accepts=(mtc.bid_accept||0)+(mtc.BID_ACCEPT||0);
  const bch=document.getElementById('sc-bids-chip');
  if(bch)bch.style.display=(bids||accepts)?'':'none';
  set('sc-bids',bids?bids.toLocaleString():'—');
  set('sc-accepts',accepts?accepts.toLocaleString():'—');
}
// Stale-data banner: shown when the snapshot timestamp is older than STALE_AFTER_S.
function renderStaleBanner(d){
  const banner=document.getElementById('stale-banner'),ageEl=document.getElementById('stale-age');
  if(!banner)return;
  const ts=d&&d.timestamp;
  if(!ts){banner.style.display='none';return;}
  const ageS=Math.floor(Date.now()/1000)-ts;
  if(ageS>STALE_AFTER_S){
    banner.style.display='';
    if(ageEl)ageEl.textContent='snapshot age: '+formatDuration(ageS);
  }else{banner.style.display='none';}
}
async function fetchOrderbook(){
  try{const r=await fetch('orderbook.json?'+Date.now());const d=await r.json();
    latestOrderbook=d;
    allOffers=d.offers||[];recomputeNewPairs();buildFilters();updateHistory();
    renderScorecard(d);renderStaleBanner(d);updateSnapAge();
    renderAll();renderTicker();renderHeatmap();renderTriArb();renderActivityHeatmap();renderActivityFeed();redrawIcons();
    checkWhaleAlerts();checkRateAlerts();
    document.getElementById('offers-count').textContent=allOffers.length;
    document.getElementById('newEntriesCount').textContent=allOffers.length;
    document.getElementById('activePairs').textContent=getPairs().length;
    const ts=(d&&d.updated_at)||new Date().toLocaleString();
    document.getElementById('lastRefreshTime').textContent=ts;
    lastFetchTime=Date.now();updateRefreshAgo();countdown=REFRESH_INTERVAL;
  }catch(e){console.error('Orderbook fetch failed:',e);
    const tb=document.getElementById('offers-body');
    if(tb)tb.innerHTML='<tr><td colspan="8" class="py-16 text-center text-red-400 text-sm">Failed to load orderbook.json — '+(e.message||e)+'</td></tr>';
  }
}
function toggleTheme(){
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('bsx-theme',document.documentElement.classList.contains('dark')?'dark':'light');
  // Charts cache axis/grid colours at construction time, so a theme flip needs them rebuilt.
  if(selectedPair!=='ALL'){
    const{bids,asks}=getBidsAsks(selectedPair);
    renderDepthChart(bids,asks,selectedPair);
    renderHistogram(getFilteredOffers());
  }else if(selectedCoin!=='ALL'){
    renderHistogram(getFilteredOffers());
  }
  // Heatmap text colour is computed inline from the current theme; redraw to pick it up.
  renderHeatmap();renderActivityHeatmap();redrawIcons();
  // Re-pull the price chart so its line/grid colour matches the new theme.
  if(selectedPair!=='ALL'||selectedCoin!=='ALL')fetchPriceHistory('1');
}
// CSV export of filtered offers
function exportCsv(){
  const offers=getFilteredOffers();
  if(!offers.length){alert('No offers to export with current filters.');return;}
  const cols=['msg_id','timestamp','posted_iso','coin_from','amount_from','coin_to','amount_to','rate','min_bid_amount','min_bid_amount_raw','swap_type','swap_type_label','time_valid','expires_in_s','addr_from','usd_size_from'];
  const now=Math.floor(Date.now()/1000);
  const rows=[cols];
  offers.forEach(o=>{
    const af=parseFloat(o.amount_from_str)||0,at=parseFloat(o.amount_to_str)||0;
    rows.push([o.msg_id,o.timestamp,new Date(o.timestamp*1000).toISOString(),
      o.coin_from,o.amount_from_str,o.coin_to,o.amount_to_str,
      af?(at/af):'',minBidDisplay(o),o.min_bid_amount,o.swap_type,SWAP_TYPES[o.swap_type]||'',
      o.time_valid,(o.timestamp+(o.time_valid||0))-now,o.addr_from,offerUsdSize(o).toFixed(4)]);
  });
  const csv=rows.map(r=>r.map(v=>`"${String(v==null?'':v).replace(/"/g,'""')}"`).join(',')).join('\n');
  downloadBlob(csv,'text/csv;charset=utf-8','bsx-orders-'+new Date().toISOString().replace(/[:.]/g,'-')+'.csv');
}
// JSON export of the currently filtered offers, including derived USD size and decoded swap label.
function exportJson(){
  const offers=getFilteredOffers();
  if(!offers.length){alert('No offers to export with current filters.');return;}
  const out=offers.map(o=>{
    const af=parseFloat(o.amount_from_str)||0,at=parseFloat(o.amount_to_str)||0;
    return Object.assign({},o,{
      posted_iso:new Date(o.timestamp*1000).toISOString(),
      swap_type_label:SWAP_TYPES[o.swap_type]||'',
      rate_display:af?(at/af):0,
      usd_size_from:offerUsdSize(o)
    });
  });
  const payload={exported_at:new Date().toISOString(),source_timestamp:latestOrderbook&&latestOrderbook.timestamp,filters:{pair:selectedPair,coin:selectedCoin,swap:selectedSwapType,min_usd:minUsdFilter,negotiable:negotiableOnly,watched:watchedOnly,search:searchQuery},offers:out};
  downloadBlob(JSON.stringify(payload,null,2),'application/json','bsx-orders-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
}
function downloadBlob(text,mime,name){
  const blob=new Blob([text],{type:mime});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=name;
  document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}
// Whale notification: when a new offer (msg_id never seen before this session) crosses the
// configured USD threshold, fire a Notification (browser permission is requested lazily).
function onWhaleChange(v){
  whaleNotifyUsd=Math.max(0,parseFloat(v)||0);
  try{localStorage.setItem('bsx-whale',String(whaleNotifyUsd));}catch(e){}
  if(whaleNotifyUsd>0&&'Notification'in window&&Notification.permission==='default'){
    Notification.requestPermission().catch(()=>{});
  }
}
function checkWhaleAlerts(){
  if(!whaleNotifyUsd||!('Notification'in window)||Notification.permission!=='granted')return;
  allOffers.forEach(o=>{
    if(notifiedIds.has(o.msg_id))return;
    const sz=offerFiatSize(o);
    if(sz>=whaleNotifyUsd){
      notifiedIds.add(o.msg_id);
      try{new Notification('BSX large offer',{body:o.coin_to+'→'+o.coin_from+' · '+formatFiat(sz),tag:o.msg_id});}catch(e){}
    }
  });
}
// Per-pair rate alerts: notify when the best bid/ask on a watched pair crosses a user-set
// threshold. State shape: rateAlerts[pair] = {above:Number|null, below:Number|null, lastTs:0}.
// Cool-down (RATE_ALERT_COOLDOWN_S) prevents notification storms when the snapshot fluctuates.
let rateAlerts={};const RATE_ALERT_COOLDOWN_S=30*60;
try{const r=JSON.parse(localStorage.getItem('bsx-rate-alerts')||'{}');if(r&&typeof r==='object')rateAlerts=r;}catch(e){}
function saveRateAlerts(){try{localStorage.setItem('bsx-rate-alerts',JSON.stringify(rateAlerts));}catch(e){}}
function openRateAlertModal(pair){
  if(!pair||pair==='ALL')return;
  const cur=rateAlerts[pair]||{};
  const{bids,asks}=getBidsAsks(pair);
  const bb=bids.length?bids[0].price:null,ba=asks.length?asks[0].price:null;
  const[base,quote]=pair.split('/');
  const mkt=bb&&ba?((bb+ba)/2):(bb||ba||0);
  openModal('<h3>Rate alert \u2014 '+pair+'</h3>'
    +'<p class="text-xs text-gray-400 mb-2">Notify when the best price on this pair crosses a threshold. Rate is quoted as <span class="monospace">'+quote+'/'+base+'</span>. Current mid: <span class="monospace">'+(mkt?mkt.toFixed(8):'n/a')+'</span>'+(bb?' \u00b7 bid <span class="monospace">'+bb.toFixed(8)+'</span>':'')+(ba?' \u00b7 ask <span class="monospace">'+ba.toFixed(8)+'</span>':'')+'.</p>'
    +'<label>Alert when ASK \u2264 (you could buy below this price)<input id="ra-below" type="number" step="any" value="'+(cur.below==null?'':cur.below)+'" placeholder="leave blank to disable"></label>'
    +'<label>Alert when BID \u2265 (you could sell above this price)<input id="ra-above" type="number" step="any" value="'+(cur.above==null?'':cur.above)+'" placeholder="leave blank to disable"></label>'
    +'<div class="flex gap-2 mt-2"><button onclick="saveRateAlertFromModal(\''+pair+'\')" class="text-xs px-3 py-1 rounded bg-blue-500 hover:bg-blue-600 text-white">Save</button>'
    +'<button onclick="clearRateAlert(\''+pair+'\')" class="text-xs px-3 py-1 rounded border border-bsx-400 hover:border-red-500">Remove alert</button></div>'
    +'<div class="text-xs text-gray-400 mt-2">Browser notification permission required \u2014 will prompt on save. Cool-down: '+(RATE_ALERT_COOLDOWN_S/60)+' min per pair to avoid storms.</div>');
}
function saveRateAlertFromModal(pair){
  const a=parseFloat(document.getElementById('ra-above').value);
  const b=parseFloat(document.getElementById('ra-below').value);
  const above=isNaN(a)?null:a,below=isNaN(b)?null:b;
  if(above==null&&below==null){clearRateAlert(pair);return;}
  rateAlerts[pair]={above:above,below:below,lastTs:0};
  saveRateAlerts();
  if('Notification'in window&&Notification.permission==='default')Notification.requestPermission().catch(()=>{});
  closeModal();renderTicker();
}
function clearRateAlert(pair){delete rateAlerts[pair];saveRateAlerts();closeModal();renderTicker();}
function checkRateAlerts(){
  if(!('Notification'in window)||Notification.permission!=='granted')return;
  const now=Math.floor(Date.now()/1000);
  Object.keys(rateAlerts).forEach(pair=>{
    const cfg=rateAlerts[pair];if(!cfg)return;
    if(cfg.lastTs&&(now-cfg.lastTs)<RATE_ALERT_COOLDOWN_S)return;
    const{bids,asks}=getBidsAsks(pair);
    const bb=bids.length?bids[0].price:null,ba=asks.length?asks[0].price:null;
    let hit=null;
    if(cfg.below!=null&&ba!=null&&ba<=cfg.below)hit='Ask '+ba.toFixed(8)+' \u2264 '+cfg.below;
    else if(cfg.above!=null&&bb!=null&&bb>=cfg.above)hit='Bid '+bb.toFixed(8)+' \u2265 '+cfg.above;
    if(hit){
      cfg.lastTs=now;saveRateAlerts();
      try{new Notification('BSX rate alert \u2014 '+pair,{body:hit,tag:'rate-'+pair});}catch(e){}
    }
  });
}
// Snapshot age chip: the timestamp of the served orderbook.json. Updated each second so the
// chip reads "12s ago" / "5m ago" without needing a re-fetch.
function updateSnapAge(){
  const el=document.getElementById('sc-snap-age');if(!el)return;
  const ts=latestOrderbook&&latestOrderbook.timestamp;
  if(!ts){el.textContent='—';return;}
  const a=Math.floor(Date.now()/1000)-ts;
  const ageStr=a<60?a+'s':a<3600?Math.floor(a/60)+'m':a<86400?Math.floor(a/3600)+'h':Math.floor(a/86400)+'d';
  // Next-refresh estimate (H): GH cron runs every REFRESH_CADENCE_S; if we're past it,
  // the runner is queued/late so just show "due".
  const nxt=document.getElementById('sc-next-refresh');
  if(nxt){const left=REFRESH_CADENCE_S-a;
    nxt.textContent=left>0?(left<60?left+'s':Math.floor(left/60)+'m '+(left%60)+'s'):'due';
  }
  el.textContent=ageStr;
  const chip=document.getElementById('sc-snap-chip');
  if(chip){chip.classList.toggle('warn',a>STALE_AFTER_S);chip.classList.toggle('ok',a<=STALE_AFTER_S);}
}
// Arbitrage cycle finder: enumerate all 3- (and optionally 4-) coin cycles using best-of-book
// rates. Cycle edge % = product(rates) − 1, where each rate is "how much of next-coin do I get
// per unit of prev-coin" (for an A→B step we look at offers selling B for A and take the best).
// Threshold (percent) and 4-hop opt-in come from the UI controls; min edge defaults to 1% so
// sub-fee noise stays hidden.
function findArbCycles(threshold,includeHops4){
  // best[from][to] = max units of `to` per 1 unit of `from`
  const best={},sizes={};
  allOffers.forEach(o=>{
    const af=parseFloat(o.amount_from_str)||0,at=parseFloat(o.amount_to_str)||0;
    if(!af||!at)return;
    // taker pays coin_to, gets coin_from → from coin_to perspective, rate to receive coin_from = af/at
    const a=o.coin_to,b=o.coin_from,r=af/at;
    best[a]=best[a]||{};
    if(!best[a][b]||r>best[a][b]){best[a][b]=r;sizes[a+'>'+b]=offerFiatSize(o);}
  });
  const coins=Object.keys(best);
  const cycles=[];
  const minProduct=1+(threshold/100);
  const canonRotation=(arr)=>{
    let mi=0;for(let m=1;m<arr.length;m++)if(arr[m]<arr[mi])mi=m;
    return arr.slice(mi).concat(arr.slice(0,mi)).join('>');
  };
  for(let i=0;i<coins.length;i++)for(let j=0;j<coins.length;j++)for(let k=0;k<coins.length;k++){
    if(i===j||j===k||i===k)continue;
    const a=coins[i],b=coins[j],c=coins[k];
    const r1=best[a]&&best[a][b],r2=best[b]&&best[b][c],r3=best[c]&&best[c][a];
    if(!r1||!r2||!r3)continue;
    const product=r1*r2*r3;
    if(product<=minProduct)continue;
    const arr=[a,b,c];
    const minSize=Math.min(sizes[a+'>'+b]||0,sizes[b+'>'+c]||0,sizes[c+'>'+a]||0);
    cycles.push({canon:canonRotation(arr),coins:arr,edge:(product-1)*100,minSize,hops:3});
  }
  if(includeHops4){
    for(let i=0;i<coins.length;i++)for(let j=0;j<coins.length;j++)for(let k=0;k<coins.length;k++)for(let l=0;l<coins.length;l++){
      if(i===j||i===k||i===l||j===k||j===l||k===l)continue;
      const a=coins[i],b=coins[j],c=coins[k],d=coins[l];
      const r1=best[a]&&best[a][b],r2=best[b]&&best[b][c],r3=best[c]&&best[c][d],r4=best[d]&&best[d][a];
      if(!r1||!r2||!r3||!r4)continue;
      const product=r1*r2*r3*r4;
      if(product<=minProduct)continue;
      const arr=[a,b,c,d];
      const minSize=Math.min(sizes[a+'>'+b]||0,sizes[b+'>'+c]||0,sizes[c+'>'+d]||0,sizes[d+'>'+a]||0);
      cycles.push({canon:canonRotation(arr),coins:arr,edge:(product-1)*100,minSize,hops:4});
    }
  }
  const seen=new Set(),uniq=[];
  cycles.sort((x,y)=>y.edge-x.edge).forEach(c=>{if(seen.has(c.canon))return;seen.add(c.canon);uniq.push(c);});
  return uniq.slice(0,20);
}
// Same shape as findArbCycles but returns the single best (possibly negative-edge) cycle so
// the empty-state can explain that the orderbook is mispriced rather than implying a UI bug.
function findBestCycleAnySign(includeHops4){
  // -101% guarantees we collect every cycle (edge can't be < -100% with positive rates).
  // Re-run with a permissive threshold and pick the top by edge.
  const all=findArbCycles(-101,includeHops4);
  return all.length?all[0]:null;
}
// Classifies a best-cycle edge into one of four labels surfaced in the scorecard chip.
// loose = exploitable opportunity (rare); balanced = near break-even; tight = fees-dominated
// (the healthy default); — = not enough pairs to form a cycle.
function arbEfficiencyLabel(best){
  if(!best)return{label:'—',cls:'',title:'No connected 3-coin cycle in this snapshot.'};
  const e=best.edge;
  const path=best.coins.concat([best.coins[0]]).join(' → ');
  const sign=e>=0?'+':'';
  const t='Best '+best.hops+'-hop cycle: '+path+' at '+sign+e.toFixed(2)+'%';
  if(e>=1)return{label:'loose '+sign+e.toFixed(2)+'%',cls:'danger',title:t+' — potential arbitrage (verify fees).'};
  if(e>=0)return{label:'balanced '+sign+e.toFixed(2)+'%',cls:'warn',title:t+' — within typical fee bounds.'};
  if(e>-1)return{label:'balanced '+e.toFixed(2)+'%',cls:'',title:t+' — near break-even after fees.'};
  return{label:'tight '+e.toFixed(2)+'%',cls:'ok',title:t+' — fees dominate, no risk-free loop.'};
}
function renderTriArb(){
  const w=document.getElementById('tri-arb-wrap');const body=document.getElementById('tri-arb-body');
  const cnt=document.getElementById('tri-arb-count');
  const cs=findArbCycles(arbEdgeMin,arbHops4);
  // Always recompute the best-of-book cycle so the scorecard chip reflects market efficiency
  // independent of whether any cycle clears the threshold.
  const best=findBestCycleAnySign(arbHops4);
  const chip=document.getElementById('sc-arb-chip');
  const chipVal=document.getElementById('sc-arb-val');
  if(chip&&chipVal){
    const info=arbEfficiencyLabel(best);
    chipVal.textContent=info.label;
    chip.classList.remove('warn','danger','ok');
    if(info.cls)chip.classList.add(info.cls);
    chip.setAttribute('title',info.title);
  }
  if(!w||!body)return;
  // Hide the full arb table entirely when no cycle clears the threshold — the scorecard chip
  // already conveys efficiency. Section reappears automatically when a positive cycle exists.
  if(!cs.length){w.style.display='none';return;}
  w.style.display='';
  if(cnt)cnt.textContent=cs.length+' cycle'+(cs.length===1?'':'s');
  body.innerHTML=cs.map(c=>{
    const cls=c.edge>=5?'text-red-400':c.edge>=1?'text-orange-400':'text-yellow-400';
    const path=c.coins.concat([c.coins[0]]).join(' → ');
    const hopBadge=c.hops===4?' <span class="neg-badge" title="4-hop cycle">4h</span>':'';
    return`<tr class="border-b border-white/5"><td class="py-1 px-2">${path}${hopBadge}</td><td class="py-1 px-2 text-right ${cls}">+${c.edge.toFixed(2)}%</td><td class="py-1 px-2 text-right text-gray-400">${c.minSize?formatFiat(c.minSize):'—'}</td></tr>`;
  }).join('');
  redrawIcons();
}
// Posting-activity heatmap: bins current offers by UTC (weekday × hour) so users can see when
// makers typically post. Uses only the live snapshot — no historical scan needed.
function renderActivityHeatmap(){
  const grid=document.getElementById('activity-grid');if(!grid)return;
  if(!allOffers.length){grid.innerHTML='<div class="text-gray-400">No data.</div>';return;}
  const counts=Array.from({length:7},()=>Array(24).fill(0));
  let max=0;
  allOffers.forEach(o=>{
    if(!o.timestamp)return;
    const d=new Date(o.timestamp*1000);
    const dow=(d.getUTCDay()+6)%7; // Mon=0 … Sun=6
    const h=d.getUTCHours();
    counts[dow][h]++;
    if(counts[dow][h]>max)max=counts[dow][h];
  });
  const days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const isDark=document.documentElement.classList.contains('dark');
  const cellBg=(n)=>{if(!n)return'transparent';const t=Math.min(1,n/max);return isDark?`rgba(59,130,246,${0.15+t*0.65})`:`rgba(37,99,235,${0.10+t*0.55})`;};
  const cellTxt=(n)=>{if(!n)return isDark?'#475569':'#cbd5e1';const t=Math.min(1,n/max);return t>0.5?'#fff':(isDark?'#cbd5e1':'#1e3a8a');};
  let html='<table style="border-collapse:separate;border-spacing:1px"><thead><tr><th></th>';
  for(let h=0;h<24;h++)html+=`<th class="text-center text-[9px] text-gray-400 font-normal" style="min-width:20px">${String(h).padStart(2,'0')}</th>`;
  html+='</tr></thead><tbody>';
  days.forEach((dn,di)=>{
    html+=`<tr><td class="pr-2 text-gray-500 dark:text-gray-300 text-[10px]">${dn}</td>`;
    for(let h=0;h<24;h++){
      const n=counts[di][h];
      // Cells are always clickable: empty cells are still valid filters (zero matches with explanation in the chip).
      const active=postedFilter&&postedFilter.dow===di&&postedFilter.h===h;
      const cls='cell-cell'+(active?' cell-active':'');
      html+=`<td class="${cls}" data-action="filter-hour" data-dow="${di}" data-hour="${h}" style="background:${cellBg(n)};color:${cellTxt(n)};text-align:center;padding:2px 4px;border-radius:2px;min-width:20px" title="${dn} ${String(h).padStart(2,'0')}:00 UTC — ${n} offer${n!==1?'s':''} (click to filter)">${n||''}</td>`;
    }
    html+='</tr>';
  });
  html+='</tbody></table>';
  grid.innerHTML=html;
}
// Posted-time filter helpers: set by clicking activity-heatmap cells; rendered as a dismissible chip
// in the filter bar and persisted in the URL hash for shareable links.
function renderPostedChip(){
  const c=document.getElementById('posted-filter-chip');if(!c)return;
  if(!postedFilter){c.style.display='none';c.innerHTML='';return;}
  const days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  c.style.display='';
  c.innerHTML=`<i data-lucide="clock" class="w-3 h-3"></i>Posted: ${days[postedFilter.dow]} ${String(postedFilter.h).padStart(2,'0')}:00 UTC <i data-lucide="x" class="w-3 h-3"></i>`;
  redrawIcons();
}
function filterByHour(dow,h){
  if(postedFilter&&postedFilter.dow===dow&&postedFilter.h===h)postedFilter=null;
  else postedFilter={dow:dow,h:h};
  saveFilters();writeHash();renderAll();renderTicker();renderActivityHeatmap();renderPostedChip();updateFilterCount();
}
function clearPostedFilter(){postedFilter=null;saveFilters();writeHash();renderAll();renderTicker();renderActivityHeatmap();renderPostedChip();updateFilterCount();}
// Modal infrastructure: minimal one-of-a-kind overlay used by walk-the-book and help.
// Close paths (must all stay in sync): Esc key (onKey), backdrop click (target===this), the
// header X button, and the footer Close button. role=dialog + aria-modal added for screen readers.
function openModal(html){
  const root=document.getElementById('modal-root');if(!root)return;
  root.style.display='';
  root.innerHTML='<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal-card" role="dialog" aria-modal="true">'
    +'<button class="modal-x" aria-label="Close (Esc)" title="Close (Esc)" onclick="closeModal()">&times;</button>'
    +html
    +'<div class="text-right mt-3"><button class="text-xs px-2 py-1 rounded bg-bsx-600 text-gray-200 hover:bg-blue-500 hover:text-white border border-bsx-400" onclick="closeModal()">Close (Esc)</button></div>'
    +'</div></div>';
}
function closeModal(){const r=document.getElementById('modal-root');if(r){r.style.display='none';r.innerHTML='';}}
function openHelp(){
  openModal('<h3>Keyboard shortcuts</h3><table class="w-full text-xs"><tbody>'+
    '<tr class="row"><td><kbd class="monospace">/</kbd></td><td>Focus search</td></tr>'+
    '<tr class="row"><td><kbd class="monospace">r</kbd></td><td>Refresh now</td></tr>'+
    '<tr class="row"><td><kbd class="monospace">c</kbd></td><td>Toggle compact</td></tr>'+
    '<tr class="row"><td><kbd class="monospace">w</kbd></td><td>Walk-the-book calculator</td></tr>'+
    '<tr class="row"><td><kbd class="monospace">x</kbd></td><td>Clear filters</td></tr>'+
    '<tr class="row"><td><kbd class="monospace">t</kbd></td><td>Toggle theme</td></tr>'+
    '<tr class="row"><td><kbd class="monospace">l</kbd></td><td>Toggle lite mode</td></tr>'+
    '<tr class="row"><td><kbd class="monospace">?</kbd></td><td>This help</td></tr>'+
    '<tr class="row"><td><kbd class="monospace">Esc</kbd></td><td>Close modal</td></tr></tbody></table>');
}
function explainForeign(){
  openModal('<h3>Foreign SMSGs</h3><p class="text-xs leading-relaxed">SMSG is Particl\u2019s peer-to-peer encrypted message bus. The scraper hears every message on the network but can only decrypt those addressed to the BSX shared key. \u201cForeign\u201d messages are encrypted to other recipients (private chats, other apps); they aren\u2019t errors, they\u2019re just not for us.</p>');
}
// Glossary of protocol/UI terms. Surfaced by inline help-circle icons via data-explain="<key>".
const TERM_EXPLAIN={
  smsg:{t:'SMSG',b:'Particl\u2019s encrypted peer-to-peer message bus. Offers are broadcast as SMSG payloads and only addressable recipients can decrypt them.'},
  swap_type:{t:'Swap type',b:'Cryptographic protocol used for the atomic swap. Adaptor-sig is required when one side has no script support (e.g. Monero). Secret-hash is classic HTLC. BCH Adaptor is the Bitcoin-Cash-specific variant.'},
  auto_accept:{t:'Auto-accept',b:'Maker pre-approved any bid that matches the offer terms. No manual confirmation step — your bid is accepted as soon as it arrives, subject to the lock and time_valid windows.'},
  time_valid:{t:'time_valid',b:'How long the offer is valid for, in seconds, from posting. After this window the offer is treated as expired (greyed out / filtered if "Hide expired" is on).'},
  sequence_lock:{t:'Sequence lock',b:'BIP-68 relative timelock measured in blocks. Funds become spendable N blocks after the funding transaction confirms.'},
  absolute_lock:{t:'Absolute lock',b:'CLTV-style timelock measured in seconds since the Unix epoch. Funds become spendable at that wall-clock time, regardless of block height.'},
  highest_bid:{t:'Highest bid',b:'Best (largest) open bid the scraper has observed for this offer. Bids expire on their own time_valid; we filter expired bids before picking the highest.'},
  market_pct:{t:'Market +/-',b:'How the offer\u2019s rate compares to CoinGecko spot. Positive = the maker is asking more than spot (premium); negative = below spot (discount).'},
  fiat_size:{t:'Fiat size',b:'Estimated value of the amount being offered, priced at the current CoinGecko spot rate for that coin in the currently-selected display fiat.'},
};
function explainTerm(key){const e=TERM_EXPLAIN[key];if(!e)return;openModal('<h3>'+e.t+'</h3><p class="text-xs leading-relaxed">'+e.b+'</p>');}
// Populate data-tip (CSS hover popover) from TERM_EXPLAIN and mirror it onto aria-label for
// screen readers. The native title attribute is intentionally removed — otherwise the browser
// would show its own ugly tooltip on top of our styled one (the "double tooltip" bug).
function initExplainTips(){document.querySelectorAll('[data-explain]').forEach(el=>{const e=TERM_EXPLAIN[el.getAttribute('data-explain')];if(!e)return;el.setAttribute('data-tip',e.b);el.setAttribute('aria-label',e.t+': '+e.b);el.removeAttribute('title');});}
// Settings modal. Consolidates global preferences that don't belong in the per-view filter bar:
// notification threshold, color-blind palette toggle, theme, plus the browser Notification status.
function openSettings(){
  const fm=fiatMeta();const tag=fm.sym?fm.sym:'('+fm.code+')';
  const isDark=document.documentElement.classList.contains('dark');
  const cb=document.documentElement.classList.contains('cb-safe');
  const np=('Notification'in window)?Notification.permission:'unsupported';
  const npLine=np==='granted'?'<span class="text-green-400">enabled</span>'
    :np==='denied'?'<span class="text-red-400">blocked by browser</span> \u2014 reset in site settings to re-enable'
    :np==='unsupported'?'<span class="text-gray-400">not supported in this browser</span>'
    :'<span class="text-gray-400">not yet asked</span> \u2014 set a threshold above to prompt';
  const html='<h3>Settings</h3>'
    +'<div class="text-xs leading-relaxed">'
    +'<div class="mb-3"><label>Theme</label><div class="flex items-center gap-2"><button onclick="toggleTheme();closeModal();openSettings();" class="text-xs px-2 py-1 rounded border border-bsx-400 hover:border-blue-500">Switch to '+(isDark?'light':'dark')+'</button></div></div>'
    +'<div class="mb-3"><label title="Switches bid/ask green-red to blue-orange (Bloomberg deuteranopia-friendly).">Color-blind safe palette</label><label class="flex items-center gap-2"><input type="checkbox" '+(cb?'checked':'')+' onchange="toggleCbSafe(this.checked)"> Use blue/orange instead of green/red</label></div>'
    +'<div class="mb-3"><label title="Notify on new offers \u2265 this fiat value. Browser Notification permission required.">Large-offer notification threshold ('+fm.code+')</label>'
    +'<input id="whale-threshold" type="number" min="0" step="100" value="'+(whaleNotifyUsd||0)+'" oninput="onWhaleChange(this.value)" class="w-32 monospace">'
    +'<div class="text-xs text-gray-400 mt-1">Browser notifications: '+npLine+'</div></div>'
    +'<div class="mb-3"><label>Snapshot refresh</label><div class="text-xs text-gray-400">Source snapshot regenerated every 15 min by GitHub Actions. Client polls every '+Math.round(REFRESH_INTERVAL/60)+' min for the freshest static file.</div></div>'
    +'</div>';
  openModal(html);
  // applyFiatLabels will write into the (just-rendered) whale label/inputs on next render.
}
// Maker leaderboard: rank addr_from by total listed-USD across the current snapshot
// plus longest-running snapshot history kept in localStorage by recordHistory.
function openMakerLeaderboard(){
  const totals={},counts={},pairs={};
  allOffers.forEach(o=>{
    const a=o.addr_from;if(!a)return;
    totals[a]=(totals[a]||0)+offerFiatSize(o);
    counts[a]=(counts[a]||0)+1;
    (pairs[a]=pairs[a]||new Set()).add((o.coin_from||'?')+'/'+(o.coin_to||'?'));
  });
  const rows=Object.keys(totals).map(a=>({a,usd:totals[a],n:counts[a],p:pairs[a].size}))
    .sort((x,y)=>y.usd-x.usd).slice(0,20);
  if(!rows.length){openModal('<h3>Top makers</h3><p class="text-xs">No maker data in current snapshot.</p>');return;}
  const html='<h3>Top makers (current snapshot)</h3>'+
    '<table class="w-full text-xs monospace"><thead><tr class="text-gray-400"><th class="text-left">Address</th><th class="text-right">Listings</th><th class="text-right">Pairs</th><th class="text-right">Listed '+fiatMeta().code+'</th></tr></thead><tbody>'+
    rows.map(r=>`<tr class="row"><td><span class="cursor-pointer hover:underline" style="${makerChipStyle(r.a)}" data-maker="${r.a}" title="${r.a}">${r.a.slice(0,12)}…</span></td><td class="text-right">${r.n}</td><td class="text-right">${r.p}</td><td class="text-right">${formatFiat(r.usd)}</td></tr>`).join('')+
    '</tbody></table>';
  openModal(html);
}
// Walk-the-book: simulate a market-buy by walking the ask side until USD budget is exhausted.
function openWalkBook(){
  if(selectedPair==='ALL'){alert('Select a pair first to walk its book.');return;}
  const[base,quote]=selectedPair.split('/');
  openModal('<h3>Walk the book — '+selectedPair+'</h3>'+
    '<label>Side<select id="wb-side"><option value="buy">Buy '+base+' (taker pays '+quote+')</option><option value="sell">Sell '+base+' (taker receives '+quote+')</option></select></label>'+
    '<label>Budget '+fiatMeta().code+'<input id="wb-usd" type="number" min="0" step="100" value="1000"></label>'+
    '<div id="wb-result" class="text-xs"></div>');
  const refresh=()=>walkBook(parseFloat(document.getElementById('wb-usd').value)||0,document.getElementById('wb-side').value);
  document.getElementById('wb-usd').addEventListener('input',refresh);
  document.getElementById('wb-side').addEventListener('change',refresh);
  refresh();
}
function walkBook(usd,side){
  const out=document.getElementById('wb-result');if(!out)return;
  const[base,quote]=selectedPair.split('/');
  const{bids,asks}=getBidsAsks(selectedPair);
  const book=side==='sell'?bids:asks; // selling base hits bids; buying base hits asks
  const pBase=coinFiat(base),pQuote=coinFiat(quote);
  // Budget unit depends on side: buy walks asks consuming quote; sell walks bids consuming base.
  const pBudget=side==='sell'?pBase:pQuote;
  if(!pBudget){out.innerHTML='<div class="text-red-400">No '+fiatMeta().code+' price for '+(side==='sell'?base:quote)+', cannot walk book.</div>';return;}
  let remaining=usd/pBudget,filledBase=0,filledQuote=0;
  const best=book.length?book[0].price:0;
  for(const lvl of book){
    if(side==='sell'){
      // Each level consumes lvl.amount base; we receive lvl.amount * lvl.price quote.
      if(lvl.amount<=remaining){filledBase+=lvl.amount;filledQuote+=lvl.amount*lvl.price;remaining-=lvl.amount;}
      else{filledBase+=remaining;filledQuote+=remaining*lvl.price;remaining=0;break;}
    }else{
      // Each level costs lvl.amount * lvl.price quote and yields lvl.amount base.
      const cost=lvl.amount*lvl.price;
      if(cost<=remaining){filledBase+=lvl.amount;filledQuote+=cost;remaining-=cost;}
      else{const part=remaining/lvl.price;filledBase+=part;filledQuote+=remaining;remaining=0;break;}
    }
  }
  if(filledBase===0){out.innerHTML='<div class="text-yellow-400">Book is empty on this side.</div>';return;}
  const avg=filledQuote/filledBase;
  // Sell-side slippage is negative when avg < best (you got worse price for later units).
  const slip=best>0?((side==='sell'?(best-avg):(avg-best))/best*100):0;
  const unfilledUsd=remaining*pBudget;
  out.innerHTML='<div class="row"><span>'+(side==='sell'?'Sold':'Bought')+' '+base+'</span><span class="monospace">'+filledBase.toFixed(6)+'</span></div>'+
    '<div class="row"><span>'+(side==='sell'?'Received':'Paid')+' '+quote+'</span><span class="monospace">'+filledQuote.toFixed(6)+(pQuote?' ('+formatFiat(filledQuote*pQuote)+')':'')+'</span></div>'+
    '<div class="row"><span>Avg fill price</span><span class="monospace">'+avg.toFixed(8)+' '+quote+'/'+base+'</span></div>'+
    '<div class="row"><span>Best price</span><span class="monospace">'+best.toFixed(8)+'</span></div>'+
    '<div class="row"><span>Slippage vs best</span><span class="monospace '+(Math.abs(slip)>=1?'text-orange-400':'text-gray-300')+'">'+(slip>=0?'-':'+')+Math.abs(slip).toFixed(3)+'%</span></div>'+
    (unfilledUsd>0.01?'<div class="row"><span>Unfilled budget</span><span class="monospace text-yellow-400">'+formatFiat(unfilledUsd)+'</span></div>':'');
}
// Delegated click for data-maker (filter by maker) and data-action (scorecard / banner CTAs).
// Replaces inline onclick attrs which CSP-restricted environments and link-previewers can break.
function delegateClick(e){
  const m=e.target.closest('[data-maker]');
  if(m){const a=m.getAttribute('data-maker');if(a){filterByMaker(a);return;}}
  const t=e.target.closest('[data-action]');if(!t)return;
  const a=t.getAttribute('data-action');
  if(a==='close-modal')return closeModal();
  if(a==='scroll-table'){document.getElementById('orders-table').scrollIntoView({behavior:'smooth'});return;}
  if(a==='open-pairs'){const sel=document.getElementById('pair-select');if(sel){sel.focus();sel.click&&sel.click();}return;}
  if(a==='snap-info'){const ts=latestOrderbook&&latestOrderbook.timestamp;openModal('<h3>Snapshot</h3><div class="text-xs">Source timestamp: '+(ts?new Date(ts*1000).toISOString():'unknown')+'<br>Re-runs every 15 min via GitHub Actions / local cron.</div>');return;}
  if(a==='explain-foreign')return explainForeign();
  if(a==='explain'){const k=t.getAttribute('data-explain');if(k)explainTerm(k);return;}
  if(a==='open-settings')return openSettings();
  if(a==='rate-alert'){const pp=t.getAttribute('data-pair');if(pp)openRateAlertModal(pp);return;}
  if(a==='reset-pair'){selectedPair='ALL';document.getElementById('pair-select').value='ALL';saveFilters();writeHash();renderAll();renderTicker();return;}
  if(a==='watch-current'){if(selectedPair!=='ALL'){watchlist.add(selectedPair);saveWatchlist();renderTicker();renderAll();buildFilters();}return;}
  if(a==='clear-watched'){watchedOnly=false;document.getElementById('watched-filter').checked=false;saveFilters();renderAll();renderTicker();buildFilters();return;}
  if(a==='clear-filters'){clearFilters();return;}
  if(a==='leaderboard'){openMakerLeaderboard();return;}
  if(a==='clear-posted-filter'){clearPostedFilter();return;}
  if(a==='filter-hour'){const dow=parseInt(t.getAttribute('data-dow'),10);const h=parseInt(t.getAttribute('data-hour'),10);if(!isNaN(dow)&&!isNaN(h))filterByHour(dow,h);return;}
  if(a==='scroll-arb'){
    // If the arb section is hidden (no positive cycles), open a brief modal explaining the
    // efficiency reading rather than scrolling to nothing.
    const w=document.getElementById('tri-arb-wrap');
    if(w&&w.style.display!=='none'){w.scrollIntoView({behavior:'smooth'});return;}
    const best=findBestCycleAnySign(arbHops4);
    let body='No connected 3-coin cycle in this snapshot.';
    if(best){
      const path=best.coins.concat([best.coins[0]]).join(' → ');
      const sign=best.edge>=0?'+':'';
      body='Best '+best.hops+'-hop cycle:<br><span class="monospace">'+path+'</span> at <span class="monospace">'+sign+best.edge.toFixed(2)+'%</span>.<br><br>'
        +'<span class="text-gray-400 text-xs">tight = fees dominate (healthy book); loose = potential arbitrage. '
        +'A 3-hop atomic swap typically costs 1–3% in fees + chain time, so edges below ~1% are not actionable.</span>';
    }
    openModal('<h3>Market efficiency</h3><div class="text-xs leading-relaxed">'+body+'</div>');
    return;
  }
}
// Keyboard shortcuts. Honoured only when no input/select/textarea is focused (except Esc).
function onKey(e){
  if(e.key==='Escape'){closeModal();return;}
  const tag=(document.activeElement&&document.activeElement.tagName||'').toLowerCase();
  if(tag==='input'||tag==='select'||tag==='textarea')return;
  if(e.key==='/'){e.preventDefault();const s=document.getElementById('search-id');if(s)s.focus();return;}
  if(e.key==='r'){manualRefresh();return;}
  if(e.key==='c'){const t=document.getElementById('compact-toggle');if(t){t.checked=!t.checked;onCompactChange(t.checked);}return;}
  if(e.key==='w'){openWalkBook();return;}
  if(e.key==='t'){toggleTheme();return;}
  if(e.key==='l'){toggleLite();return;}
  if(e.key==='x'){clearFilters();return;}
  if(e.key==='?'||(e.shiftKey&&e.key==='/')){openHelp();return;}
}
// Filter persistence (localStorage) + URL hash routing for shareable deep-links
function saveFilters(){try{localStorage.setItem('bsx-filters',JSON.stringify({pair:selectedPair,coin:selectedCoin,swap:selectedSwapType,minUsd:minUsdFilter,search:searchQuery,negotiable:negotiableOnly,watched:watchedOnly,hideExpired:hideExpired,posted:postedFilter,autoAccept:autoAcceptOnly}));}catch(e){}}
function loadFilters(){
  try{const f=JSON.parse(localStorage.getItem('bsx-filters')||'null');if(!f)return;
    if(f.pair)selectedPair=f.pair;if(f.coin)selectedCoin=f.coin;
    if(typeof f.hideExpired==='boolean')hideExpired=f.hideExpired;
    if(f.swap)selectedSwapType=f.swap;if(typeof f.minUsd==='number')minUsdFilter=f.minUsd;
    if(f.search)searchQuery=f.search;
    negotiableOnly=!!f.negotiable;watchedOnly=!!f.watched;autoAcceptOnly=!!f.autoAccept;
    if(f.posted&&typeof f.posted.dow==='number'&&typeof f.posted.h==='number')postedFilter=f.posted;
  }catch(e){}
}
function readHash(){
  const h=location.hash.replace(/^#/,'');if(!h)return;
  const p=new URLSearchParams(h);
  if(p.get('pair'))selectedPair=p.get('pair');
  if(p.get('coin'))selectedCoin=p.get('coin');
  if(p.get('swap'))selectedSwapType=p.get('swap');
  if(p.get('min'))minUsdFilter=parseFloat(p.get('min'))||0;
  if(p.get('q'))searchQuery=p.get('q');
  if(p.get('neg')==='1')negotiableOnly=true;
  if(p.get('aa')==='1')autoAcceptOnly=true;
  if(p.get('watch')==='1')watchedOnly=true;
  if(p.get('exp')==='0')hideExpired=false;
  if(p.get('arb')){const v=parseFloat(p.get('arb'));if(!isNaN(v))arbEdgeMin=v;}
  if(p.get('arbh')==='4')arbHops4=true;
  if(p.get('posted')){const m=p.get('posted').match(/^([0-6]):([0-9]{1,2})$/);if(m){const dw=parseInt(m[1],10),hr=parseInt(m[2],10);if(hr>=0&&hr<=23)postedFilter={dow:dw,h:hr};}}
}
function writeHash(){
  const p=new URLSearchParams();
  if(selectedPair!=='ALL')p.set('pair',selectedPair);
  if(selectedCoin!=='ALL')p.set('coin',selectedCoin);
  if(selectedSwapType!=='ALL')p.set('swap',selectedSwapType);
  if(minUsdFilter>0)p.set('min',minUsdFilter);
  if(searchQuery)p.set('q',searchQuery);
  if(negotiableOnly)p.set('neg','1');
  if(autoAcceptOnly)p.set('aa','1');
  if(watchedOnly)p.set('watch','1');
  if(!hideExpired)p.set('exp','0');
  if(arbEdgeMin!==1)p.set('arb',String(arbEdgeMin));
  if(arbHops4)p.set('arbh','4');
  if(postedFilter)p.set('posted',postedFilter.dow+':'+postedFilter.h);
  const s=p.toString();
  history.replaceState(null,'',s?'#'+s:location.pathname+location.search);
}
function applyLoadedFiltersToUI(){
  const ps=document.getElementById('pair-select');if(ps)ps.value=selectedPair;
  const ss=document.getElementById('swap-type-filter');if(ss)ss.value=selectedSwapType;
  const mu=document.getElementById('min-usd-filter');if(mu)mu.value=minUsdFilter;
  const sr=document.getElementById('search-id');if(sr)sr.value=searchQuery;
  const ng=document.getElementById('negotiable-filter');if(ng)ng.checked=negotiableOnly;
  const aa=document.getElementById('autoaccept-filter');if(aa)aa.checked=autoAcceptOnly;
  const wt=document.getElementById('watched-filter');if(wt)wt.checked=watchedOnly;
  const he=document.getElementById('hide-expired-filter');if(he)he.checked=hideExpired;
  const ct=document.getElementById('compact-toggle');if(ct)ct.checked=compactMode;
  applyFiatLabels();
  // Coin filter buttons: sync .active state to selectedCoin (only meaningful when no specific pair)
  document.querySelectorAll('.filter-btn').forEach(b=>{
    const coin=b.dataset.coin||'ALL';
    if(selectedPair==='ALL'&&coin===selectedCoin)b.classList.add('active');
    else b.classList.remove('active');
  });
  const wh=document.getElementById('whale-threshold');if(wh)wh.value=whaleNotifyUsd||0;
  const ae=document.getElementById('arb-edge-min');if(ae)ae.value=String(arbEdgeMin);
  const ah=document.getElementById('arb-hops4');if(ah)ah.checked=arbHops4;
  renderPostedChip();
}
window.addEventListener('hashchange',()=>{readHash();applyLoadedFiltersToUI();renderAll();renderTicker();renderActivityHeatmap();});
document.addEventListener('click',delegateClick);
document.addEventListener('keydown',onKey);
// Tab title: reset "new since last focus" baseline whenever the tab regains visibility.
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')tabTitleSeenBaseline();else updateTabTitle();});
// Sticky filter bar shadow: drop a 1px sentinel above the bar; when it scrolls out of view the
// bar is "stuck" and we add the shadow class. Cheaper than scroll-listener polling.
(function stickyShadow(){
  const fw=document.getElementById('filter-wrap');if(!fw||!('IntersectionObserver'in window))return;
  const s=document.createElement('div');s.style.cssText='height:1px;width:1px;position:absolute;top:0;left:0';
  fw.parentNode.insertBefore(s,fw);
  new IntersectionObserver(([e])=>fw.classList.toggle('is-stuck',!e.isIntersecting),{threshold:[1]}).observe(s);
})();
// Theme: explicit saved preference wins; otherwise honour the OS-level prefers-color-scheme.
(function(){const t=localStorage.getItem('bsx-theme');
  if(t==='light')document.documentElement.classList.remove('dark');
  else if(!t && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches)document.documentElement.classList.remove('dark');
})();
// Persisted UI preferences
loadWatchlist();
try{compactMode=localStorage.getItem('bsx-compact')==='1';}catch(e){}
try{liteMode=localStorage.getItem('bsx-lite')==='1';}catch(e){}
try{whaleNotifyUsd=parseFloat(localStorage.getItem('bsx-whale')||'0')||0;}catch(e){}
try{const _e=parseFloat(localStorage.getItem('bsx-arb-edge')||'1');if(!isNaN(_e))arbEdgeMin=_e;}catch(e){}
try{arbHops4=localStorage.getItem('bsx-arb-hops4')==='1';}catch(e){}
// Color-blind safe palette: switches green/red to blue/orange (Bloomberg deuteranopia-friendly).
try{if(localStorage.getItem('bsx-cb-safe')==='1')document.documentElement.classList.add('cb-safe');}catch(e){}
// URL hash override for shareable lite-view links (e.g. ?...#lite=1).
try{const _h=new URLSearchParams(location.hash.replace(/^#/,''));if(_h.get('lite')==='1')liteMode=true;}catch(e){}
if(compactMode)document.body.classList.add('compact');
if(liteMode)document.body.classList.add('lite');
loadKnownPairs();loadSectionStates();loadFilters();readHash(); // hash overrides storage
loadCachedPrices(); // show cached prices instantly while we fetch fresh ones
// Convert the static <i data-lucide> placeholders in the navbar/filter bar before first paint
// (subsequent renders call redrawIcons() themselves).
redrawIcons();
initExplainTips();
runTwemoji();
// Re-evaluate stale-data banner + snapshot-age chip on a timer so they auto-update without a refresh.
setInterval(()=>{renderStaleBanner(latestOrderbook);updateSnapAge();},60000);
setInterval(updateSnapAge,1000);
(async()=>{await fetchSnapshotManifest();await fetchPrices();await fetchOrderbook();applyLoadedFiltersToUI();startCountdown();})();
setInterval(fetchPrices,REFRESH_INTERVAL*1000);
// Re-fetch the snapshot manifest periodically so the vol-delta chip picks up new entries.
setInterval(fetchSnapshotManifest,5*60*1000);
