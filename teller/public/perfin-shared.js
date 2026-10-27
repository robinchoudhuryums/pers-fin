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
  // F3: escape quotes too. The previous textContent→innerHTML approach escaped
  // & < > but NOT " or ', so values interpolated into double-quoted attribute
  // contexts (e.g. data-name="'+esc(x)+'", aria-label="'+esc(x)+'") could break
  // out of the attribute when a bank-supplied merchant/account name contained a
  // quote. Explicit 5-char escaping is safe in both text and attribute contexts.
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  // --- Empty states (design D2, decision 12) ---
  // One block for every "nothing here yet" message: a title, a line of text and
  // an optional action — { label, href } (a same-app path, joined with
  // withBase) or { label, click } (the id of a button the page already wires:
  // the empty state's button just clicks it, so no new write path exists).
  // Every value is escaped.
  function emptyState(opts) {
    opts = opts || {};
    var html = '<div class="empty-state">';
    if (opts.title) html += '<div class="empty-state-title">' + esc(opts.title) + '</div>';
    if (opts.text) html += '<div class="empty-state-text">' + esc(opts.text) + '</div>';
    var a = opts.action;
    if (a && a.label) {
      // Only a same-app path ("/x", never "//host" or "javascript:") becomes a link.
      if (a.href && a.href.charAt(0) === '/' && a.href.charAt(1) !== '/') {
        html += '<a class="btn btn-sm primary empty-state-action" href="' + esc(withBase(a.href)) + '">' + esc(a.label) + '</a>';
      } else if (a.click) {
        html += '<button type="button" class="btn btn-sm primary empty-state-action" data-empty-click="' + esc(a.click) + '">' + esc(a.label) + '</button>';
      }
    }
    return html + '</div>';
  }
  // The delegated handler for { click } actions (installed once below).
  function emptyStateClick(e) {
    var t = e && e.target && e.target.closest ? e.target.closest('[data-empty-click]') : null;
    if (!t) return false;
    var target = document.getElementById(t.getAttribute('data-empty-click'));
    if (!target) return false;
    target.click();
    return true;
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', emptyStateClick);
  }

  // --- API fetch with headers ---
  // W3: a single in-flight guard so concurrent expired calls trigger one nav.
  var _authRedirecting = false;
  var ON_LOGIN_RE = /\/login(\?|#|$)/;
  function apiFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { 'X-Requested-With': 'XMLHttpRequest' });
    var key = win.PERFIN_API_KEY;
    if (key) {
      opts.headers['x-api-key'] = key;
    }
    return fetch(withBase(url), opts).then(function(res) {
      // Session expiry: the shell answers an unauthenticated API call with a
      // 401 (XHR/POST) or a 302→/login that fetch transparently follows (GET).
      // Without this, callers would render a blank/error state instead of
      // sending the user to re-login (silent degradation under the 60-min idle
      // window). Redirect once to the ROOT /login (shell login when embedded,
      // Perfin login standalone — both un-prefixed); guard against loops.
      var expired = res.status === 401 ||
        (res.redirected && ON_LOGIN_RE.test(res.url || ''));
      if (expired && !_authRedirecting && !ON_LOGIN_RE.test(win.location.pathname)) {
        _authRedirecting = true;
        // F102: carry the page through login (the shell's return_to, PSC-9) —
        // the PIN used to land on the default page instead of where you were.
        win.location.href = '/login?return_to=' + encodeURIComponent(win.location.pathname + win.location.search);
      }
      return res;
    });
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
  // opts.action = { label, run, focus? } adds a button to the toast (e.g.
  // "Undo" — roadmap T2.5 U2): pressing it closes the toast and calls run(). A
  // toast with an action stays 10 s and is never merged with an earlier one.
  // Cycle-8 F56: such a toast waits while it is hovered or holds focus, only its
  // buttons close it (a near miss on its text no longer dismisses it — it has a
  // labelled Dismiss button instead), and action.focus moves focus to the
  // action button so a keyboard user can reach it.
  function showMsg(text, ok, opts) {
    if (!text) return;
    var action = opts && opts.action && typeof opts.action.run === 'function' ? opts.action : null;
    var stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      // Live region so screen readers announce toasts as they appear; the
      // per-toast role (status/alert) refines politeness per message.
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    // Dedupe: most recent toast with same text gets its timer bumped.
    var last = stack.lastElementChild;
    if (!action && last && !last._action && (last._text != null ? last._text : last.textContent) === text) {
      if (last._timer) clearTimeout(last._timer);
      last._timer = setTimeout(function() { removeToast(last); }, ok ? 5000 : 10000);
      return;
    }
    var toast = document.createElement('div');
    toast.className = 'toast ' + (ok ? 'success' : 'error');
    toast.setAttribute('role', ok ? 'status' : 'alert');
    toast._text = text;
    toast._action = !!action;
    if (action) {
      var span = document.createElement('span');
      span.textContent = text;
      toast.appendChild(span);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label || 'Undo';
      btn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (toast._timer) clearTimeout(toast._timer);
        removeToast(toast);
        action.run();
      });
      toast.appendChild(btn);
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'toast-close';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.addEventListener('click', function(ev) {
        ev.stopPropagation();
        if (toast._timer) clearTimeout(toast._timer);
        removeToast(toast);
      });
      toast.appendChild(close);
      var hovered = false, focused = false;
      var hold = function() {
        if (toast._timer) clearTimeout(toast._timer);
        toast._timer = (hovered || focused) ? null : setTimeout(function() { removeToast(toast); }, 10000);
      };
      toast.addEventListener('mouseenter', function() { hovered = true; hold(); });
      toast.addEventListener('mouseleave', function() { hovered = false; hold(); });
      toast.addEventListener('focusin', function() { focused = true; hold(); });
      toast.addEventListener('focusout', function(ev) {
        if (ev && ev.relatedTarget && toast.contains && toast.contains(ev.relatedTarget)) return;
        focused = false; hold();
      });
    } else {
      toast.textContent = text;
      toast.addEventListener('click', function() { removeToast(toast); });
    }
    stack.appendChild(toast);
    toast._timer = setTimeout(function() { removeToast(toast); }, ok && !action ? 5000 : 10000);
    if (action && action.focus && btn.focus) { try { btn.focus({ preventScroll: true }); } catch (e) { /* an old browser: no focus move */ } }
    // Cap at 5 visible toasts — anything older gets dropped so the stack
    // doesn't grow unbounded during a rapid background-task burst. Count only
    // toasts that aren't already animating out, and drop the excess
    // SYNCHRONOUSLY: removeToast() only detaches after 220ms, so the old
    // `while (children.length > 5) removeToast(oldest)` never shrank the stack
    // and a sixth toast hung the tab in an infinite loop (F89).
    var live = [];
    for (var i = 0; i < stack.children.length; i++) {
      if (!stack.children[i].classList.contains('toast-leaving')) live.push(stack.children[i]);
    }
    for (var j = 0; j < live.length - 5; j++) {
      if (live[j]._timer) clearTimeout(live[j]._timer);
      if (live[j].parentNode) live[j].parentNode.removeChild(live[j]);
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
  // Thousands separators so large amounts read clearly and don't visually
  // overflow narrow mobile stat cards ($22,199.52 vs $22199.52). A negative is
  // "-$12.34" (design pass D1 — it used to read "$-12.34"); a value that rounds
  // to zero is "$0.00", never "-$0.00".
  function fmt(n) {
    var x = parseFloat(n || 0);
    var rounded = Math.round(x * 100) / 100;
    var s = '$' + Math.abs(rounded).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return rounded < 0 ? '-' + s : s;
  }
  // Calendar dates (DATE columns) arrive as 'YYYY-MM-DD' or as node-pg's UTC
  // midnight 'YYYY-MM-DDT00:00:00.000Z'. Parsing either with `new Date()` and
  // formatting in the browser's zone showed every date ONE DAY EARLY west of
  // UTC (WUI-2: a Sep 27 purchase read "Sep 26"). parseCalDate turns a calendar
  // date into a LOCAL-midnight Date for that same day; a real timestamp (non-
  // midnight time) is left as an instant.
  var DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/;
  function parseCalDate(d) {
    if (d instanceof Date) return d;
    var m = DATE_ONLY_RE.exec(String(d || ''));
    if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return new Date(d);
  }
  function fmtDate(d) {
    return d ? parseCalDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
  }
  // TODAY as 'YYYY-MM-DD' in the browser's local zone — for date-input
  // defaults and "is today" checks (toISOString() is the UTC date, which is
  // already tomorrow on a US evening — WUI-2).
  function localTodayStr(offsetDays) {
    var d = new Date();
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // Roadmap T3.3 K4: the tax year to open on — LAST year from January to April
  // (filing season), else this year — and whether it is filing season (the
  // dashboard's Tax page link shows only then). One rule for both.
  function taxSeason(today) {
    var t = String(today || localTodayStr());
    var y = parseInt(t.slice(0, 4), 10), m = parseInt(t.slice(5, 7), 10);
    var season = m >= 1 && m <= 4;
    return { year: season ? y - 1 : y, season: season };
  }
  function localDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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

  // WUI-6: the one way a page reports the outcome of a write. Returns true
  // when the response is 2xx; otherwise toasts "<what>: <server error>" and
  // returns false. Writes used to await apiFetch and assume success, so a
  // 400/500 looked exactly like it had worked.
  async function writeOk(res, what) {
    if (res && res.ok) return true;
    var detail = res ? 'HTTP ' + res.status : 'no response';
    try {
      var body = await res.clone().json();
      if (body && body.error) detail = body.error;
    } catch (e) { /* not JSON */ }
    showMsg((what || 'Save failed') + ': ' + detail, false);
    return false;
  }
  // Undelete (roadmap T2.5 U2): POST /api/deleted-transactions/:id/restore,
  // shared by Settings → Deleted transactions and the Activity page's Undo.
  // The outcome is toasted (writeOk on a refusal); resolves to the reply on
  // success, else null.
  var RESTORE_RETURNS_ON = {
    reconcile: 'It comes back with the next sync of its bank — Settings → Sync Health → Reconcile Now fetches it right away.',
    csv_reimport: 'Import its CSV file again to bring it back.',
  };
  function restoreMessage(r) {
    r = r || {};
    if (r.restored) {
      if (r.already_present) return 'That transaction is already in your list.';
      return 'Transaction restored' + (r.splits ? ' with its ' + r.splits + ' split' + (r.splits === 1 ? '' : 's') + '.' : '.') +
        // Cycle-8 F6: the bank changed it while it was deleted.
        (r.stale ? ' Your bank changed it since you deleted it — run Reconcile Now (Plaid) in Settings → Sync Health to bring in the current version.' : '');
    }
    return 'Undeleted. ' + (RESTORE_RETURNS_ON[r.returns_on] || 'It comes back the next time its source is read.');
  }
  async function restoreTransaction(id) {
    var res;
    try {
      res = await apiFetch('/api/deleted-transactions/' + encodeURIComponent(id) + '/restore', { method: 'POST' });
    } catch (e) {
      showMsg("Couldn't restore the transaction — check your connection.", false);
      return null;
    }
    if (!(await writeOk(res, 'Restore'))) return null;
    var r = {};
    try { r = await res.json(); } catch (e) { /* a 2xx without a body still restored */ }
    showMsg(restoreMessage(r), true);
    return r;
  }

  // Parse a money/number entered in a prompt() ("$1,234.50" → 1234.5). NaN
  // when it isn't a number — callers stop instead of sending null (WD-12).
  function parseAmountInput(raw) {
    if (raw == null) return NaN;
    var t = String(raw).trim().replace(/[$,\s]/g, '');
    if (t === '' || !/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
    return parseFloat(t);
  }

  // ---------------------------------------------------------------------
  // IF-1: one dialog behaviour for every modal. openDialog(box, opts) marks
  // the box role="dialog" aria-modal="true" (+ label), remembers the element
  // that had focus, moves focus into the box, keeps Tab / Shift+Tab inside
  // it, runs opts.onClose on Escape, and — when the returned handle is
  // closed — puts focus back where it was. The modals used to have none of
  // this, so keyboard users tabbed into the page behind them.
  // watchDialog(overlay, opts) does the same for an overlay that a page
  // shows/hides itself (style.display / hidden): it opens when the overlay
  // becomes visible and closes when it is hidden, with no change to the
  // page's own open/close code.
  var dialogStack = [];
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function dialogFocusables(box) {
    return Array.prototype.filter.call(box.querySelectorAll(FOCUSABLE), function (el) {
      return el.getClientRects().length > 0;
    });
  }
  function openDialog(box, opts) {
    opts = opts || {};
    if (!box) return { close: function () {} };
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (opts.labelledBy) box.setAttribute('aria-labelledby', opts.labelledBy);
    else if (opts.label && !box.getAttribute('aria-labelledby')) box.setAttribute('aria-label', opts.label);
    if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
    var handle = { box: box, opts: opts, restore: document.activeElement, closed: false };
    handle.close = function () {
      if (handle.closed) return;
      handle.closed = true;
      var i = dialogStack.indexOf(handle);
      if (i !== -1) dialogStack.splice(i, 1);
      var r = handle.restore;
      if (opts.restoreFocus !== false && r && r.isConnected && typeof r.focus === 'function') {
        try { r.focus(); } catch (e) { /* ignore */ }
      }
    };
    dialogStack.push(handle);
    if (!box.contains(document.activeElement)) {
      var first = opts.initialFocus || dialogFocusables(box)[0] || box;
      try { first.focus(); } catch (e) { /* ignore */ }
    }
    return handle;
  }
  document.addEventListener('keydown', function (e) {
    var top = dialogStack[dialogStack.length - 1];
    if (!top) return;
    // A dialog removed or hidden without its handle being closed: release it.
    if (!top.box.isConnected || top.box.getClientRects().length === 0) { top.close(); return; }
    if (e.key === 'Escape') {
      if (typeof top.opts.onClose === 'function') { e.preventDefault(); top.opts.onClose(); }
      return;
    }
    if (e.key !== 'Tab') return;
    var items = dialogFocusables(top.box);
    if (!items.length) { e.preventDefault(); top.box.focus(); return; }
    var firstEl = items[0], lastEl = items[items.length - 1];
    var active = document.activeElement;
    if (e.shiftKey && (active === firstEl || !top.box.contains(active))) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && (active === lastEl || !top.box.contains(active))) { e.preventDefault(); firstEl.focus(); }
  }, true);
  function watchDialog(overlay, opts) {
    if (!overlay || typeof MutationObserver === 'undefined') return;
    opts = opts || {};
    var box = opts.box || overlay.firstElementChild || overlay;
    var handle = null;
    function visible() { return !overlay.hidden && getComputedStyle(overlay).display !== 'none'; }
    function sync() {
      if (visible()) { if (!handle || handle.closed) handle = openDialog(box, opts); }
      else if (handle) { handle.close(); handle = null; }
    }
    new MutationObserver(sync).observe(overlay, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
    sync();
  }

  // Export to window
  // --- Dashboard widget toggles (F96) ---
  // ONE list of dashboard widget keys: Settings renders a toggle per entry and
  // the dashboard hides each entry's element when its key is false. The two
  // used to keep separate lists — five Settings toggles hid nothing and the
  // documented whatsNew / investmentReturns / settlement keys had no toggle.
  // In page order (design D4, decision 6), so Settings lists the toggles as
  // they appear on the dashboard — tests/design-d4.test.js pins it.
  var DASHBOARD_WIDGETS = [
    { key: 'whatsNew', label: 'Since You Last Looked', selector: '#whats-new-widget' },
    { key: 'reviewQueue', label: 'Review Uncategorized', selector: '#review-queue-section' },
    { key: 'charts', label: 'Charts', selector: '.charts-grid' },
    { key: 'accounts', label: 'Account Balances', selector: '#accounts-section' },
    { key: 'cashFlow', label: 'Cash Flow', selector: '#cashflow-section' },
    { key: 'calendar', label: 'Upcoming Bills', selector: '#calendar-widget' },
    { key: 'forecast', label: '30-Day Forecast', selector: '#forecast-section' },
    { key: 'monthlySpend', label: 'Monthly Spending', selector: '[data-collapse-key="monthlySpend"]' },
    { key: 'categories', label: 'Categories', selector: '[data-collapse-key="categories"]' },
    { key: 'merchants', label: 'Top Merchants', selector: '[data-collapse-key="merchants"]' },
    { key: 'upcoming', label: 'Upcoming Charges', selector: '[data-collapse-key="upcoming"]' },
    { key: 'settlement', label: 'Settle Up', selector: '#settlement-section' },
    { key: 'housing', label: 'Rent & Utilities', selector: '#housing-widget-section' },
    { key: 'investments', label: 'Investments', selector: '#investments-section' },
    { key: 'investmentReturns', label: 'Investment Returns', selector: '#investments-performance' },
    { key: 'savingsRate', label: 'Savings Rate', selector: '#savings-rate-section' },
    { key: 'yoy', label: 'Year-over-Year', selector: '#yoy-section' },
    { key: 'pyramid', label: 'Financial Pyramid', selector: '.wellness-section' },
    { key: 'ask', label: 'Ask Perfin (AI Q&A)', selector: '#ask-section' },
    { key: 'aiMemory', label: 'AI Memory', selector: '#ai-memory-section' },
  ];
  // Hide the switched-off widgets with a class (.widget-off is display:none
  // !important), so a loader that later shows its section can't bring it back.
  function applyDashboardWidgets(widgets) {
    var w = widgets || {};
    DASHBOARD_WIDGETS.forEach(function(d) {
      document.querySelectorAll(d.selector).forEach(function(el) {
        el.classList.toggle('widget-off', w[d.key] === false);
      });
    });
  }

  win.DASHBOARD_WIDGETS = DASHBOARD_WIDGETS;
  win.applyDashboardWidgets = applyDashboardWidgets;
  win.openDialog = openDialog;
  win.watchDialog = watchDialog;
  win.writeOk = writeOk;
  win.parseAmountInput = parseAmountInput;
  win.restoreTransaction = restoreTransaction;
  win.restoreMessage = restoreMessage;
  win.esc = esc;
  win.apiFetch = apiFetch;
  win.withBase = withBase;
  win.emptyState = emptyState;
  win.showMsg = showMsg;
  win.btnLoading = btnLoading;
  win.fmt = fmt;
  win.fmtDate = fmtDate;
  win.parseCalDate = parseCalDate;
  win.localTodayStr = localTodayStr;
  win.localDateStr = localDateStr;
  win.taxSeason = taxSeason;
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

// ---------------------------------------------------------------------------
// Pull-to-refresh (standalone PWA mode only). iOS home-screen PWAs don't get
// Safari's native pull-to-refresh, so this fills the gap: drag down from the
// very top of the page past the threshold and release to reload. Inactive in
// regular browser tabs (the browser's own gesture exists there) and while a
// modal/panel is open. Passive listeners only — never blocks scrolling.
// ---------------------------------------------------------------------------
(function initPullToRefresh() {
  // Active in the installed PWA (display-mode: standalone) AND inside the
  // Capacitor iOS wrapper (which reports display-mode: browser but exposes
  // window.Capacitor). Regular Safari tabs keep the native gesture.
  try {
    var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    if (!standalone && !window.Capacitor) return;
  } catch (_) { return; }
  var THRESHOLD = 75, MAX_PULL = 130;
  var startY = 0, startX = 0, dist = 0, active = false, refreshing = false, el = null;
  function indicator() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ptr-indicator';
    el.setAttribute('aria-hidden', 'true');
    var ring = document.createElement('div');
    ring.className = 'ptr-ring';
    el.appendChild(ring);
    document.body.appendChild(el);
    return el;
  }
  document.addEventListener('touchstart', function (e) {
    if (refreshing || e.touches.length !== 1) return;
    var scroller = document.scrollingElement || document.documentElement;
    if (scroller.scrollTop > 0) return;
    // Don't hijack pulls that start inside overlays/panels with their own scroll.
    if (e.target.closest && e.target.closest('.notif-panel, .modal-backdrop, .modal-overlay, dialog, .pyramid-stage, canvas')) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    dist = 0; active = true;
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!active || refreshing) return;
    var dy = e.touches[0].clientY - startY;
    var dx = Math.abs(e.touches[0].clientX - startX);
    if (dy <= 0 || dx > Math.abs(dy)) { if (dy < -10) active = false; return; }
    dist = Math.min(dy, MAX_PULL);
    if (dist > 12) {
      var ind = indicator();
      ind.style.opacity = String(Math.min(1, dist / THRESHOLD));
      ind.style.transform = 'translateX(-50%) translateY(' + (dist * 0.45) + 'px) rotate(' + (dist * 2.2) + 'deg)';
      if (dist >= THRESHOLD) ind.classList.add('ptr-ready');
      else ind.classList.remove('ptr-ready');
    }
  }, { passive: true });
  document.addEventListener('touchend', function () {
    if (!active || refreshing) return;
    active = false;
    if (dist >= THRESHOLD) {
      refreshing = true;
      var ind = indicator();
      ind.classList.add('ptr-refreshing');
      ind.style.transform = 'translateX(-50%) translateY(28px)';
      location.reload();
    } else if (el) {
      el.style.opacity = '0';
      el.classList.remove('ptr-ready');
      el.style.transform = 'translateX(-50%)';
    }
    dist = 0;
  }, { passive: true });
})();
