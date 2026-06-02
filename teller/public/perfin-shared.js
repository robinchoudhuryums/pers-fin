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

  // --- Toast stack ---
  // Stacks multiple feedback messages instead of overwriting a single
  // element. Identical consecutive messages dedupe (just refresh the timer)
  // so a tight retry loop doesn't pile up 12 of the same toast.
  function removeToast(el) {
    if (!el || !el.parentNode) return;
    el.classList.add('toast-leaving');
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }
  function showMsg(text, ok) {
    if (!text) return;
    var stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      document.body.appendChild(stack);
    }
    // Dedupe: most recent toast with same text gets its timer bumped.
    var last = stack.lastElementChild;
    if (last && last.textContent === text) {
      if (last._timer) clearTimeout(last._timer);
      last._timer = setTimeout(function() { removeToast(last); }, ok ? 5000 : 10000);
      return;
    }
    var toast = document.createElement('div');
    toast.className = 'toast ' + (ok ? 'success' : 'error');
    toast.setAttribute('role', ok ? 'status' : 'alert');
    toast.textContent = text;
    toast.addEventListener('click', function() { removeToast(toast); });
    stack.appendChild(toast);
    toast._timer = setTimeout(function() { removeToast(toast); }, ok ? 5000 : 10000);
    // Cap at 5 visible toasts — anything older gets dropped so the stack
    // doesn't grow unbounded during a rapid background-task burst.
    while (stack.children.length > 5) {
      var oldest = stack.firstElementChild;
      if (oldest && oldest._timer) clearTimeout(oldest._timer);
      if (oldest) removeToast(oldest);
    }
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

  // ---------------------------------------------------------------------
  // On-screen debug log overlay for mobile debugging without DevTools.
  // Enable by appending ?debug=1 to any URL, or running
  // localStorage.setItem('perfin_debug', '1') in any console. Captures
  // console.log / .warn / .error and shows them in a fixed panel at the
  // bottom of the screen. Tap the X to dismiss.
  // ---------------------------------------------------------------------
  function debugEnabled() {
    try {
      if (new URLSearchParams(win.location.search).get('debug') === '1') return true;
      if (localStorage.getItem('perfin_debug') === '1') return true;
    } catch (e) {}
    return false;
  }
  function initDebugOverlay() {
    if (!debugEnabled()) return;
    var doc = win.document;
    if (!doc || !doc.body) {
      doc.addEventListener('DOMContentLoaded', initDebugOverlay);
      return;
    }
    var panel = doc.createElement('div');
    panel.id = 'perfin-debug-log';
    panel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
      'max-height:40vh;overflow-y:auto;background:rgba(0,0,0,0.88);color:#9fd4ff;' +
      'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px 8px 8px 8px;' +
      'border-top:1px solid #4af;';
    var header = doc.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;' +
      'margin:0 0 6px;color:#fff;font-weight:600;';
    header.innerHTML = '<span>DEBUG LOG</span>' +
      '<span style="display:flex;gap:8px;">' +
      '<button id="perfin-debug-clear" style="background:#333;color:#fff;border:0;padding:2px 8px;border-radius:4px;font:inherit;cursor:pointer;">clear</button>' +
      '<button id="perfin-debug-close" style="background:#666;color:#fff;border:0;padding:2px 8px;border-radius:4px;font:inherit;cursor:pointer;">×</button>' +
      '</span>';
    panel.appendChild(header);
    var logArea = doc.createElement('div');
    logArea.id = 'perfin-debug-log-area';
    panel.appendChild(logArea);
    doc.body.appendChild(panel);

    function add(level, args) {
      var time = new Date().toLocaleTimeString();
      var row = doc.createElement('div');
      var color = level === 'error' ? '#ff8c8c' : level === 'warn' ? '#ffd166' : '#9fd4ff';
      row.style.cssText = 'margin:2px 0;color:' + color + ';white-space:pre-wrap;word-break:break-all;';
      var parts = Array.prototype.slice.call(args).map(function(a) {
        if (a === null) return 'null';
        if (a === undefined) return 'undefined';
        if (typeof a === 'object') {
          try { return JSON.stringify(a, null, 2); }
          catch (e) { return String(a); }
        }
        return String(a);
      });
      row.textContent = '[' + time + '] ' + parts.join(' ');
      logArea.appendChild(row);
      logArea.scrollTop = logArea.scrollHeight;
      // Keep the buffer reasonable.
      while (logArea.children.length > 200) logArea.removeChild(logArea.firstChild);
    }
    ['log', 'warn', 'error'].forEach(function(level) {
      var orig = console[level].bind(console);
      console[level] = function() {
        try { add(level, arguments); } catch (e) {}
        orig.apply(console, arguments);
      };
    });
    // Also capture global errors (uncaught exceptions, unhandled rejections)
    win.addEventListener('error', function(e) {
      add('error', ['window.onerror:', e.message, e.filename + ':' + e.lineno]);
    });
    win.addEventListener('unhandledrejection', function(e) {
      add('error', ['unhandledrejection:', e.reason && e.reason.message || e.reason]);
    });
    doc.getElementById('perfin-debug-clear').addEventListener('click', function() {
      logArea.innerHTML = '';
    });
    doc.getElementById('perfin-debug-close').addEventListener('click', function() {
      panel.style.display = 'none';
    });
    console.log('Debug overlay enabled. URL:', win.location.href);

    // MutationObserver — log every iframe that appears on the page so we
    // can verify whether vendor SDKs (Plaid, Teller) actually attached
    // their modal and inspect its dimensions/z-index/visibility.
    try {
      var observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(m) {
          m.addedNodes && m.addedNodes.forEach(function(n) {
            if (!n.querySelectorAll) return;
            var iframes = n.tagName === 'IFRAME' ? [n] : Array.from(n.querySelectorAll('iframe'));
            iframes.forEach(function(f) {
              function snapshot(label) {
                var cs = win.getComputedStyle(f);
                var rect = f.getBoundingClientRect();
                console.log('iframe ' + label + ':', {
                  src: (f.src || '').substring(0, 80),
                  id: f.id || '(no id)',
                  size: rect.width + 'x' + rect.height,
                  position: cs.position + ' top:' + cs.top + ' left:' + cs.left,
                  zIndex: cs.zIndex,
                  display: cs.display,
                  visibility: cs.visibility,
                  opacity: cs.opacity,
                  transform: cs.transform === 'none' ? 'none' : cs.transform.substring(0, 50),
                });
              }
              setTimeout(function() { snapshot('attached'); }, 100);
              setTimeout(function() { snapshot('after 2s'); }, 2000);
              // ALSO try forcing it visible if it's a Plaid iframe stuck
              // at display:none. We do this only on iPhone where the SDK
              // appears to not transition the iframe out of hidden state.
              if (f.id && f.id.indexOf('plaid-link-open') === 0) {
                setTimeout(function() {
                  var cs = win.getComputedStyle(f);
                  if (cs.display === 'none' || f.getBoundingClientRect().width === 0) {
                    console.warn('Force-revealing Plaid iframe (was display:' + cs.display + ', size:' + f.getBoundingClientRect().width + 'x' + f.getBoundingClientRect().height + ')');
                    f.style.setProperty('display', 'block', 'important');
                    f.style.setProperty('width', '100vw', 'important');
                    f.style.setProperty('height', '100vh', 'important');
                    f.style.setProperty('top', '0', 'important');
                    f.style.setProperty('left', '0', 'important');
                    f.style.setProperty('position', 'fixed', 'important');
                    f.style.setProperty('z-index', '2147483647', 'important');
                    f.style.setProperty('border', '0', 'important');
                    setTimeout(function() { snapshot('after force-reveal'); }, 100);
                  }
                }, 1500);
              }
            });
          });
        });
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    } catch (e) {
      console.error('MutationObserver setup failed:', e.message);
    }
  }
  initDebugOverlay();
  win.perfinDebugEnabled = debugEnabled;
})(window);
