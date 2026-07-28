/* Hidden SKYNET ops dashboard — threat overview for scrape + network signals. */

const DATA = {
  ops: 'ops-data.json',
  health: '../../health.json',
  orderbook: '../../orderbook.json',
  summary: '../summary.json',
  diff: '../diff.txt',
  manifest: '../../snapshots/manifest.json',
};

const REFRESH_MS = 2 * 60 * 1000;
const SPARK_W = 12;
const RULE_MIN = 45;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hr(ch, w) {
  return '<p class="rule">' + ch.repeat(w) + '</p>\n';
}

function lineWidth(s) {
  if (!s) return 0;
  return Math.max(0, ...String(s).split('\n').map(l => l.length));
}

function contentWidth() {
  return Math.max(RULE_MIN, ...Array.from(arguments).map(lineWidth));
}

function kv(label, value) {
  const pad = Math.max(1, 16 - label.length);
  return label + ' '.repeat(pad) + value;
}

function intFmt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US');
}

function pctFmt(n, digits) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toFixed(digits == null ? 1 : digits) + '%';
}

function ageFmt(sec) {
  if (sec == null || sec < 0) return '—';
  sec = Math.floor(sec);
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'd';
}

function fiatCompact(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function asciiSparkline(data) {
  if (!data || data.length < 2) return '·'.repeat(SPARK_W);
  const mn = Math.min(...data);
  const mx = Math.max(...data);
  const rng = mx - mn || 1;
  const chars = '·▁▂▃▄▅▆▇█';
  return data.slice(-SPARK_W).map(v => {
    const idx = Math.min(7, Math.floor((v - mn) / rng * 8));
    return chars[idx];
  }).join('').padEnd(SPARK_W, '·');
}

function threatClass(label) {
  if (label === 'HIGH') return 'ops-threat-high';
  if (label === 'ELEVATED') return 'ops-threat-elevated';
  if (label === 'WATCH') return 'ops-threat-watch';
  return 'ops-threat-low';
}

function alertClass(level) {
  if (level === 'critical') return 'ops-alert-critical';
  if (level === 'warn') return 'ops-alert-warn';
  return '';
}

async function fetchJson(path) {
  try {
    const r = await fetch(path + '?' + Date.now());
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function fetchText(path) {
  try {
    const r = await fetch(path + '?' + Date.now());
    if (!r.ok) return '';
    return (await r.text()).trim();
  } catch (e) {
    return '';
  }
}

function renderThreatBanner(ops) {
  const label = ops?.threat_label || 'LOW';
  const cls = threatClass(label);
  const alerts = ops?.alerts || [];
  let html = '<pre class="data ops-threat ' + cls + '">'
    + esc('THREAT: ' + label)
    + (ops?.updated_at ? '  ·  ' + ops.updated_at : '')
    + '</pre>\n';
  if (alerts.length) {
    html += '<pre class="data">\n';
    alerts.forEach(a => {
      const mark = a.level === 'critical' ? '!!' : a.level === 'warn' ? '! ' : '  ';
      html += esc(mark + ' ' + a.msg) + '\n';
    });
    html += '</pre>\n';
  } else {
    html += '<pre class="data ops-ok">' + esc('  all clear — no active alerts') + '</pre>\n';
  }
  return html;
}

function renderScrapeSection(ops, health, now) {
  const h = health || ops?.health || {};
  const lines = [
    kv('ok', h.ok === true ? 'yes' : (h.ok === false ? 'NO' : '—')),
    kv('last run', h.last_run_iso || ops?.updated_at || '—'),
    kv('duration', h.duration_s != null ? h.duration_s + 's' : '—'),
    kv('peers', intFmt(h.peers_scraped)),
    kv('msg rate', h.msg_rate_per_s != null ? h.msg_rate_per_s + '/s' : '—'),
    kv('SMSG in', intFmt(h.msgs_received)),
    kv('decrypted', intFmt(h.msgs_decrypted)),
    kv('parsed', intFmt(h.offers_parsed)),
    kv('merged', intFmt(h.offers_merged_from_previous)),
    kv('buckets', intFmt(h.buckets_requested)),
    kv('wants sent', intFmt(h.wants_sent)),
  ];
  const bsxAge = ops?.market?.last_bsx_msg_ts
    ? ageFmt(now - ops.market.last_bsx_msg_ts) + ' ago'
    : '—';
  lines.push(kv('last BSX msg', bsxAge));
  const med = ops?.scores?.msg_rate_median_14;
  if (med != null && h.msg_rate_per_s != null) {
    const ratio = h.msg_rate_per_s / med;
    lines.push(kv('rate vs med', ratio.toFixed(2) + '× (' + med + '/s)'));
  }
  return lines.join('\n');
}

function renderNetworkSection(stats) {
  const s = stats || {};
  const mtc = s.message_type_counts || {};
  const msgs = s.msgs_received || 0;
  const foreign = s.not_for_us || 0;
  const lines = [
    kv('foreign SMSG', intFmt(foreign) + (msgs ? ' (' + pctFmt(foreign / msgs * 100) + ')' : '')),
    kv('parse errors', intFmt(s.parse_errors)),
    kv('decrypt err', intFmt(s.decrypt_errors)),
    kv('revokes seen', intFmt(s.revokes_seen)),
    kv('matched', intFmt(s.revokes_matched_offer)),
    kv('orphan', intFmt(s.revokes_orphan)),
    kv('invalid sig', intFmt(s.revokes_invalid_sig)),
    kv('dropped', intFmt(s.revoked_offers_dropped)),
  ];
  const types = ['offer', 'bid', 'bid_accept', 'offer_revoke']
    .map(t => t + ' ' + intFmt(mtc[t] || 0))
    .join(' · ');
  lines.push(kv('message types', types || '—'));
  const parsed = s.offers_parsed || 0;
  if (parsed && s.revokes_seen != null) {
    lines.push(kv('revoke ratio', (s.revokes_seen / parsed).toFixed(2) + ' / offer'));
  }
  return lines.join('\n');
}

function renderMarketSection(ops, summary) {
  const m = ops?.market || {};
  const liq = summary?.listed_liquidity_usd;
  const lines = [
    kv('live offers', intFmt(m.active_offers)),
    kv('listed', intFmt(m.num_offers)),
    kv('makers', intFmt(m.unique_makers)),
    kv('pairs', intFmt(m.unique_pairs)),
    kv('liquidity', liq != null ? fiatCompact(liq) : '—'),
    kv('BSX msgs', intFmt(ops?.bsx_messages)),
  ];
  const med = ops?.scores?.active_offers_median_14;
  if (med != null && m.active_offers != null) {
    lines.push(kv('vs 14-run med', intFmt(med) + ' → ' + intFmt(m.active_offers)));
  }
  return lines.join('\n');
}

function renderTrendsSection(ops) {
  const t = ops?.trends || {};
  const lines = [];
  if (t.active_offers?.length) {
    lines.push(kv('active offers', asciiSparkline(t.active_offers) + '  ' + t.active_offers.slice(-1)[0]));
  }
  if (t.msg_rate_per_s?.length) {
    lines.push(kv('msg rate    ', asciiSparkline(t.msg_rate_per_s) + '  ' + t.msg_rate_per_s.slice(-1)[0] + '/s'));
  }
  if (t.invalid_revokes?.length) {
    lines.push(kv('invalid rev ', asciiSparkline(t.invalid_revokes) + '  ' + t.invalid_revokes.slice(-1)[0]));
  }
  return lines.length ? lines.join('\n') : '(need more snapshots for trends)';
}

function renderMakerWatch(makers) {
  if (!makers?.length) return '(no makers)';
  return makers.map(m => {
    const flag = m.flagged ? ' !' : '';
    return esc(m.addr_short + '  ' + m.offers + ' offers  (' + m.pct + '%)' + flag);
  }).join('\n');
}

function renderDiffExcerpt(diff) {
  if (!diff) return '(no diff yet — need 2+ snapshots)';
  const lines = diff.split('\n').slice(0, 18);
  return lines.join('\n');
}

function renderPage(ops, health, summary, diff) {
  const out = document.getElementById('out');
  if (!out) return;

  const now = Math.floor(Date.now() / 1000);
  const stats = ops?.stats || health?.stats || {};
  const scrape = renderScrapeSection(ops, health, now);
  const network = renderNetworkSection(stats);
  const market = renderMarketSection(ops, summary);
  const trends = renderTrendsSection(ops);
  const makers = renderMakerWatch(ops?.maker_watch);
  const diffExcerpt = renderDiffExcerpt(diff);

  const w = contentWidth(
    scrape, network, market, trends, makers, diffExcerpt,
    'THREAT: ' + (ops?.threat_label || 'LOW'),
  );

  let html = ''
    + '<p class="tagline">skynet · network ops</p>\n'
    + '<pre class="logo skynet-logo" aria-hidden="true">' + esc('  ▲ SKYNET OPS ▲') + '</pre>\n'
    + '<p class="nav-top muted">unlisted · refreshes every 2m · '
    + '<a href="../">plain stats</a></p>\n'
    + hr('=', w)
    + '<p class="section">Threat status</p>\n'
    + renderThreatBanner(ops)
    + hr('=', w)
    + '<p class="section">Scrape health</p>\n'
    + '<pre class="data">' + esc(scrape) + '</pre>\n'
    + hr('-', w)
    + '<p class="section">Network telemetry</p>\n'
    + '<pre class="data">' + esc(network) + '</pre>\n'
    + hr('-', w)
    + '<p class="section">Market snapshot</p>\n'
    + '<pre class="data">' + esc(market) + '</pre>\n'
    + hr('-', w)
    + '<p class="section">Trends (recent runs)</p>\n'
    + '<pre class="data">' + esc(trends) + '</pre>\n'
    + hr('-', w)
    + '<p class="section">Maker watch</p>\n'
    + '<pre class="data">' + makers + '</pre>\n'
    + hr('-', w)
    + '<p class="section">Since last snapshot</p>\n'
    + '<pre class="data">' + esc(diffExcerpt) + '</pre>\n'
    + hr('-', w)
    + '<footer class="muted"><p>raw: '
    + '<a href="../../health.json">health.json</a> · '
    + '<a href="../../orderbook.json">orderbook.json</a> · '
    + '<a href="ops-data.json">ops-data.json</a> · '
    + '<a href="../diff.txt">diff.txt</a></p></footer>\n';

  out.innerHTML = html;
}

async function loadOps() {
  const [ops, health, summary, diff] = await Promise.all([
    fetchJson(DATA.ops),
    fetchJson(DATA.health),
    fetchJson(DATA.summary),
    fetchText(DATA.diff),
  ]);
  renderPage(ops, health, summary, diff);
}

loadOps();
setInterval(loadOps, REFRESH_MS);
