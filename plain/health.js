function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hr(ch, w) {
  return '<p class="rule">' + ch.repeat(w) + '</p>\n';
}

async function loadHealth() {
  const out = document.getElementById('out');
  let status = '(status.txt unavailable)';
  let health = null;
  try {
    const r = await fetch('status.txt?' + Date.now());
    if (r.ok) status = (await r.text()).trim();
  } catch (e) { /* ignore */ }
  try {
    const r = await fetch('../health.json?' + Date.now());
    if (r.ok) health = await r.json();
  } catch (e) { /* ignore */ }

  const w = 45;
  let html = ''
    + '<p class="tagline">scrape health</p>\n'
    + '<p class="nav-top"><a href="./">← plain stats</a> · <a href="../">full markets</a> · '
    + themeToggleHtml() + '</p>\n'
    + hr('=', w)
    + '<p class="section">Status</p>\n'
    + '<pre class="data">' + esc(status) + '</pre>\n'
    + '<p class="muted"><a href="../status.txt">../status.txt</a></p>\n';

  if (health) {
    const lines = [];
    if (health.ok != null) lines.push('ok              ' + health.ok);
    if (health.last_scrape) lines.push('last scrape     ' + health.last_scrape);
    if (health.duration_sec != null) lines.push('duration        ' + health.duration_sec + 's');
    if (health.offers_seen != null) lines.push('offers seen     ' + health.offers_seen);
    if (health.active_offers != null) lines.push('active offers   ' + health.active_offers);
    if (health.errors?.length) lines.push('errors          ' + health.errors.join('; '));
    html += hr('=', w)
      + '<p class="section">health.json</p>\n'
      + '<pre class="data">' + esc(lines.join('\n') || JSON.stringify(health, null, 2)) + '</pre>\n';
  }

  html += hr('-', w)
    + '<footer class="muted"><p>refreshes on load · <a href="../health.json">health.json</a></p></footer>\n';
  out.innerHTML = html;
  window.bsxPlainTheme?.bind();
}

loadHealth();
