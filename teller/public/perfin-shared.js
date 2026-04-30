// ============================================================================
// Perfin Shared Utilities — esc, apiFetch, showMsg, btnLoading, fmt
// ============================================================================
// Usage: set window.PERFIN_API_KEY before loading this script, or omit for no API key.

(function(win) {
  'use strict';

  // --- Theme init (called inline in <head> for flash prevention) ---
  win.perfinInitTheme = function() {
    document.documentElement.setAttribute('data-theme', localStorage.getItem('perfin-theme') || 'dark');
  };

  // --- HTML escape ---
  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // --- Prefix helper for sub-app mounting ---
  // The unified shell mounts each sub-app under a prefix (e.g. /perfin).
  // Server-rendered HTML sets window.BASE_PATH so client code can prepend
  // it to root-relative URLs (so /api/foo → /perfin/api/foo). When the
  // app runs standalone (no shell), BASE_PATH is unset/"" and this is a
  // no-op — preserves the old behavior exactly.
  //
  // Rules:
  //   - URLs starting with http:// or // are left alone (absolute).
  //   - URLs not starting with / are left alone (relative — caller's choice).
  //   - URLs already starting with the configured BASE_PATH are left alone
  //     (lets callers pre-prefix without us doubling up).
  function withBase(url) {
    var base = win.BASE_PATH || '';
    if (!base) return url;
    if (typeof url !== 'string') return url;
    if (url.charAt(0) !== '/' || url.charAt(1) === '/') return url;
    if (url === base || url.indexOf(base + '/') === 0) return url;
    return base + url;
  }

  // --- API fetch with headers ---
  function apiFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { 'X-Requested-With': 'XMLHttpRequest' });
    var key = win.PERFIN_API_KEY;
    if (key) {
      opts.headers['x-api-key'] = key;
    }
    return fetch(withBase(url), opts);
  }

  // --- Status message ---
  function showMsg(text, ok) {
    var el = document.getElementById('status-msg');
    if (!el) return;
    el.style.display = '';
    el.textContent = text;
    el.className = 'status-msg ' + (ok ? 'success' : 'error');
    if (el._timer) clearTimeout(el._timer);
    el._timer = setTimeout(function() {
      el.className = 'status-msg';
    }, ok ? 5000 : 10000);
  }

  // --- Button loading state ---
  function btnLoading(btn, loading, originalText) {
    if (loading) {
      btn._origText = btn.textContent;
      btn.disabled = true;
      btn.classList.add('btn-loading');
      // Disable sibling buttons in the same action bar to prevent double-submits
      var parent = btn.closest('.actions');
      if (parent) {
        parent.querySelectorAll('button, select').forEach(function(el) {
          if (el !== btn) { el._wasDisabled = el.disabled; el.disabled = true; }
        });
      }
    } else {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
      btn.textContent = originalText || btn._origText || btn.textContent;
      var parent = btn.closest('.actions');
      if (parent) {
        parent.querySelectorAll('button, select').forEach(function(el) {
          if (el !== btn) el.disabled = el._wasDisabled || false;
        });
      }
    }
  }

  // --- Async action wrapper: handles loading state + error display ---
  function asyncAction(btn, fn) {
    if (btn.disabled) return;
    btnLoading(btn, true);
    Promise.resolve(fn()).then(function() {
      btnLoading(btn, false);
    }).catch(function(err) {
      btnLoading(btn, false);
      showMsg(err.message || 'An error occurred', false);
    });
  }

  // --- Formatters ---
  function fmt(n) { return '$' + parseFloat(n || 0).toFixed(2); }
  function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
  }
  function fmtMonth(m) {
    var parts = m.split('-');
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[parseInt(parts[1])-1] + ' ' + parts[0];
  }

  // --- PWA registration ---
  // Service-worker scoping under sub-app mounting is handled in Phase 5;
  // for now we just prefix the URL so /sw.js resolves under the app's
  // mount path when one is set. Standalone behavior is unchanged.
  function registerSW() {
    if ('serviceWorker' in navigator) {
      var swUrl = withBase('/sw.js');
      var scope = (win.BASE_PATH || '') + '/';
      navigator.serviceWorker.register(swUrl, { scope: scope }).catch(function() {});
    }
  }

  // --- Install prompt capture (Phase D) ---
  // Browsers fire `beforeinstallprompt` when the PWA becomes installable;
  // we stash the event so a user-initiated button click can trigger the
  // prompt later. Chrome/Edge/Android support this; iOS Safari does not —
  // there we fall back to Add-to-Home-Screen instructions in the UI.
  win._perfinInstallPrompt = null;
  win.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    win._perfinInstallPrompt = e;
    win.dispatchEvent(new Event('perfin:installable'));
  });
  win.addEventListener('appinstalled', function() {
    win._perfinInstallPrompt = null;
    win.dispatchEvent(new Event('perfin:installed'));
  });
  function perfinPromptInstall() {
    var p = win._perfinInstallPrompt;
    if (!p) return Promise.resolve({ outcome: 'unavailable' });
    p.prompt();
    return p.userChoice.then(function(result) {
      win._perfinInstallPrompt = null;
      return result;
    });
  }
  function perfinIsInstalled() {
    return win.matchMedia && win.matchMedia('(display-mode: standalone)').matches;
  }

  // --- CSP-safe event binding helpers ---
  // Bind multiple [id, event, handler] tuples
  function bindEvents(bindings) {
    bindings.forEach(function(b) {
      var el = typeof b[0] === 'string' ? document.getElementById(b[0]) : b[0];
      if (el) el.addEventListener(b[1], b[2]);
    });
  }
  // Event delegation: listen on parent for clicks/changes matching a selector
  function onDelegate(parentId, event, selector, handler) {
    var parent = document.getElementById(parentId);
    if (parent) parent.addEventListener(event, function(e) {
      var target = e.target.closest(selector);
      if (target) handler.call(target, e);
    });
  }

  // Export to window
  win.esc = esc;
  win.apiFetch = apiFetch;
  win.withBase = withBase;
  win.showMsg = showMsg;
  win.btnLoading = btnLoading;
  win.fmt = fmt;
  win.fmtDate = fmtDate;
  win.fmtMonth = fmtMonth;
  win.asyncAction = asyncAction;
  win.registerSW = registerSW;
  win.bindEvents = bindEvents;
  win.onDelegate = onDelegate;
  win.perfinPromptInstall = perfinPromptInstall;
  win.perfinIsInstalled = perfinIsInstalled;
})(window);
