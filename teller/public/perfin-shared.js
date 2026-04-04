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

  // --- API fetch with headers ---
  function apiFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { 'X-Requested-With': 'XMLHttpRequest' });
    var key = win.PERFIN_API_KEY;
    if (key) {
      opts.headers['x-api-key'] = key;
    }
    return fetch(url, opts);
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
    return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '\u2014';
  }
  function fmtMonth(m) {
    var parts = m.split('-');
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[parseInt(parts[1])-1] + ' ' + parts[0];
  }

  // --- PWA registration ---
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function() {});
    }
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
  win.showMsg = showMsg;
  win.btnLoading = btnLoading;
  win.fmt = fmt;
  win.fmtDate = fmtDate;
  win.fmtMonth = fmtMonth;
  win.asyncAction = asyncAction;
  win.registerSW = registerSW;
  win.bindEvents = bindEvents;
  win.onDelegate = onDelegate;
})(window);
