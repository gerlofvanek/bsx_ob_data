/* Light/dark (shared with main dashboard) + plain-only SKYNET mode. */
(function () {
  const KEY = 'bsx-theme';
  const SKYNET_KEY = 'bsx-skynet';

  function isDark() {
    return document.documentElement.classList.contains('dark');
  }

  function isSkynet() {
    return document.documentElement.classList.contains('skynet');
  }

  function updateMetaColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    if (isSkynet()) meta.content = '#0a0a0a';
    else meta.content = isDark() ? '#1a1a1a' : '#f6f6f4';
  }

  function apply(theme) {
    const dark = theme === 'dark';
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    });
    updateMetaColor();
  }

  function applySkynet(on) {
    document.documentElement.classList.toggle('skynet', on);
    document.querySelectorAll('[data-skynet-toggle]').forEach(btn => {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('skynet-active', on);
      btn.textContent = 'SKYNET';
      btn.title = on ? 'Disable SKYNET mode' : 'Enable SKYNET mode';
      btn.setAttribute('aria-label', on ? 'Disable SKYNET mode' : 'Enable SKYNET mode');
    });
    if (on && !isDark()) {
      saveTheme('dark');
      apply('dark');
    } else {
      updateMetaColor();
    }
  }

  function readTheme() {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch (e) { /* ignore */ }
    return 'dark';
  }

  function readSkynet() {
    try { return localStorage.getItem(SKYNET_KEY) === '1'; } catch (e) { return false; }
  }

  function saveTheme(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) { /* ignore */ }
  }

  function saveSkynet(on) {
    try { localStorage.setItem(SKYNET_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function init() {
    apply(readTheme());
    applySkynet(readSkynet());
  }

  function toggleTheme() {
    if (isSkynet()) return;
    const next = isDark() ? 'light' : 'dark';
    saveTheme(next);
    apply(next);
  }

  function toggleSkynet() {
    const next = !isSkynet();
    saveSkynet(next);
    applySkynet(next);
    document.dispatchEvent(new CustomEvent('bsx-skynet-change'));
  }

  function bind() {
    document.querySelectorAll('[data-theme-toggle]:not([data-theme-bound])').forEach(btn => {
      btn.setAttribute('data-theme-bound', '1');
      btn.addEventListener('click', toggleTheme);
    });
    document.querySelectorAll('[data-skynet-toggle]:not([data-skynet-bound])').forEach(btn => {
      btn.setAttribute('data-skynet-bound', '1');
      btn.addEventListener('click', toggleSkynet);
    });
    syncToggleState();
  }

  function syncToggleState() {
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      const off = isSkynet();
      btn.disabled = off;
      btn.style.opacity = off ? '0.45' : '';
      btn.title = off ? 'Light/dark locked while SKYNET is on' : (isDark() ? 'Switch to light mode' : 'Switch to dark mode');
    });
    document.querySelectorAll('[data-skynet-toggle]').forEach(btn => {
      btn.textContent = 'SKYNET';
      btn.classList.toggle('skynet-active', isSkynet());
    });
  }

  window.bsxPlainTheme = {
    init, toggle: toggleTheme, toggleSkynet, bind, isSkynet, syncToggleState,
  };

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
    + '</button>'
    + '<button type="button" class="theme-toggle skynet-toggle" data-skynet-toggle aria-label="Toggle SKYNET mode" title="Toggle SKYNET mode">SKYNET</button>';
}
