// Smoke-test for posted-time filter logic in app.js.
//
// app.js was authored for the browser, so we run it inside a stub DOM/window
// vm context, then call the public functions and assert. Exits non-zero on
// any assertion failure so the Python pytest wrapper can surface it.
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContext, runInContext} from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(HERE, '..', 'app.js'), 'utf8');

const stubEl = () => new Proxy({
  value: '', checked: false, textContent: '', innerHTML: '', style: {},
  dataset: {}, attributes: {},
  classList: {add(){}, remove(){}, toggle(){}, contains(){return false;}},
  getAttribute(){return null;}, setAttribute(){}, focus(){}, click(){},
  addEventListener(){}, removeEventListener(){}, appendChild(){},
  scrollIntoView(){}, querySelector(){return stubEl();},
  querySelectorAll(){return [];}, getBoundingClientRect(){return {top:0,left:0,width:0,height:0};},
}, {get(t,k){return k in t?t[k]:undefined;}});

const storage = {};
const ctx = {
  console,
  document: {
    getElementById: () => stubEl(),
    querySelector: () => stubEl(),
    querySelectorAll: () => [],
    addEventListener(){}, createElement: () => stubEl(),
    body: stubEl(), documentElement: stubEl(),
  },
  window: {
    addEventListener(){}, matchMedia: () => ({matches:false,addEventListener(){}}),
    lucide: {createIcons(){}},
  },
  localStorage: {
    getItem: (k) => k in storage ? storage[k] : null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  },
  history: {replaceState(){}},
  location: {hash: '', pathname: '/', search: ''},
  setInterval: () => 0, clearInterval(){},
  setTimeout: () => 0, clearTimeout(){},
  fetch: () => Promise.resolve({ok:false,status:0,json:()=>Promise.resolve({}),text:()=>Promise.resolve('')}),
  URLSearchParams, Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Map, Set, Symbol, parseInt, parseFloat, isNaN, isFinite, Proxy,
  alert(){}, navigator: {clipboard: {writeText:()=>Promise.resolve()}, userAgent:'node'},
  performance: {now: () => Date.now()},
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  matchMedia: () => ({matches:false,addEventListener(){}}),
  // In the browser, anything on `window` is also a top-level global.
  // The vm sandbox doesn't auto-mirror, so add the few names app.js reads bare.
  lucide: {createIcons(){}},
};
ctx.document.documentElement = stubEl();
ctx.globalThis = ctx;
ctx.window.document = ctx.document;
ctx.window.location = ctx.location;
ctx.window.localStorage = ctx.localStorage;
// Test assertions are appended to app.js source so they share lexical scope
// with the let-declared state (allOffers, postedFilter, etc.) — vm contexts
// don't expose let/const bindings via the context object.
const TEST_SUFFIX = `
;(function(){
  const fail = (m) => { console.error('FAIL:', m); throw new Error(m); };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
    fail(m + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };

  // Seed offers in two distinct UTC weekday/hour buckets.
  // 2024-01-01 14:30 UTC = Monday (dow=0), hour=14
  // 2024-01-03 22:05 UTC = Wednesday (dow=2), hour=22
  allOffers = [
    {msg_id:'a', timestamp: Date.UTC(2024,0,1,14,30,0)/1000, coin_from:'BTC', coin_to:'XMR',
      amount_from_str:'1', amount_to_str:'200', swap_type:1, time_valid:7200, addr_from:'a1'},
    {msg_id:'b', timestamp: Date.UTC(2024,0,3,22, 5,0)/1000, coin_from:'BTC', coin_to:'LTC',
      amount_from_str:'1', amount_to_str:'600', swap_type:1, time_valid:7200, addr_from:'a2'},
    {msg_id:'c', timestamp: Date.UTC(2024,0,1,14,55,0)/1000, coin_from:'XMR', coin_to:'BTC',
      amount_from_str:'200', amount_to_str:'1', swap_type:1, time_valid:7200, addr_from:'a3'},
  ];
  hideExpired = false; // 2024 timestamps are long-expired vs "now"

  eq(getFilteredOffers().length, 3, 'baseline: no filter shows all offers');

  filterByHour(0, 14);
  eq(postedFilter, {dow:0,h:14}, 'filterByHour sets postedFilter');
  eq(getFilteredOffers().map(o=>o.msg_id).sort(), ['a','c'], 'Mon 14:00 UTC matches a and c');

  // writeHash round-trip via history.replaceState capture
  let captured = '';
  history.replaceState = (_s, _t, url) => { captured = String(url); };
  writeHash();
  if (!captured.includes('posted=0%3A14') && !captured.includes('posted=0:14'))
    fail('writeHash should include posted=0:14, got "' + captured + '"');

  postedFilter = null;
  location.hash = captured.startsWith('#') ? captured : ('#' + captured.split('#').pop());
  readHash();
  eq(postedFilter, {dow:0,h:14}, 'readHash restores postedFilter from URL');

  // Toggle off via same-cell click
  filterByHour(0, 14);
  eq(postedFilter, null, 'same-cell click clears filter');
  eq(getFilteredOffers().length, 3, 'cleared filter restores all offers');

  // Different cell
  filterByHour(2, 22);
  eq(getFilteredOffers().map(o=>o.msg_id), ['b'], 'Wed 22:00 UTC matches offer b only');

  // Empty bucket: switching from {dow:2,h:22} to {dow:5,h:3} is a different cell, so it sets
  filterByHour(5, 3);
  eq(postedFilter, {dow:5,h:3}, 'switched to Sat 03:00 UTC');
  eq(getFilteredOffers().length, 0, 'empty bucket yields zero offers');

  clearPostedFilter();
  eq(postedFilter, null, 'clearPostedFilter resets state');
  eq(getFilteredOffers().length, 3, 'all offers visible after clear');

  console.log('OK: 11 assertions passed');
})();
`;

createContext(ctx);
try {
  runInContext(APP_JS + TEST_SUFFIX, ctx, {filename: 'app.js+tests'});
} catch (e) {
  console.error(e.stack || String(e));
  process.exit(1);
}
