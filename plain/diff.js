function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hr(ch, w) {
  return '<p class="rule">' + ch.repeat(w) + '</p>\n';
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

async function loadDiff() {
  const out = document.getElementById('out');
  const [full, offers] = await Promise.all([
    fetchText('diff.txt'),
    fetchText('diff-offers.txt'),
  ]);

  const w = 45;
  let html = ''
    + '<p class="tagline">snapshot diff</p>\n'
    + '<p class="nav-top"><a href="./">← plain stats</a> · <a href="../">full markets</a> · '
    + themeToggleHtml() + '</p>\n'
    + hr('=', w);

  if (!full && !offers) {
    html += '<p class="err">No diff data yet — need at least two snapshots in history.</p>\n';
  } else {
    if (full) {
      html += '<p class="section">Since last snapshot</p>\n'
        + '<pre class="data">' + esc(full) + '</pre>\n';
    }
    if (offers && offers !== full) {
      html += hr('=', w)
        + '<p class="section">Offer-level churn</p>\n'
        + '<pre class="data">' + esc(offers) + '</pre>\n';
    }
    html += '<p class="muted">plain: <a href="diff.txt">diff.txt</a>'
      + (offers ? ' · <a href="diff-offers.txt">diff-offers.txt</a>' : '')
      + '</p>\n';
  }

  html += hr('-', w)
    + '<footer class="muted"><p>generated on each scrape · compare snapshots with <code>scripts/diff_snapshots.py</code></p></footer>\n';
  out.innerHTML = html;
  window.bsxPlainTheme?.bind();
}

loadDiff();
