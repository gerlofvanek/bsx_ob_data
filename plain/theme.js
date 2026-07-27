/* Shared light/dark theme — uses same localStorage key as the main dashboard. */
(function () {
  const KEY = 'bsx-theme';

  function isDark() {
    return document.documentElement.classList.contains('dark');
  }

  function apply(theme) {
    const dark = theme === 'dark';
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#1a1a1a' : '#f6f6f4';
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    });
  }

  function readTheme() {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (e) { /* ignore */ }
    return 'dark';
  }

  function save(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) { /* ignore */ }
  }

  function init() {
    apply(readTheme());
  }

  function toggle() {
    const next = isDark() ? 'light' : 'dark';
    save(next);
    apply(next);
  }

  function bind() {
    document.querySelectorAll('[data-theme-toggle]:not([data-theme-bound])').forEach(btn => {
      btn.setAttribute('data-theme-bound', '1');
      btn.addEventListener('click', toggle);
    });
  }

  window.bsxPlainTheme = { init, toggle, bind };

  init();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();

function themeToggleHtml() {
  return '<button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle theme" title="Toggle theme">'
    + '<span class="theme-icon theme-icon-moon" aria-hidden="true">☾</span>'
    + '<span class="theme-icon theme-icon-sun" aria-hidden="true">☀</span>'
    + '</button>';
}
