// ============================================================================
// Per-sistant — Shared Views (CSS, JS, HTML helpers)
// ============================================================================

const { PERFIN_URL } = require("./config");

const CSS_CORE = require("./views/css");
const CSS_COMPONENTS = require("./views/css-components");
const CSS_PAGES = require("./views/css-pages");
const SHARED_CSS = CSS_CORE + CSS_COMPONENTS + CSS_PAGES;
const SHARED_JS = require("./views/js");
const PRIMITIVES_JS = require("./views/primitives");
// Settings-only enhancement that adds a palette picker to the Appearance
// section. Loaded globally; it no-ops off the /settings route.
const SETTINGS_PATCH = require("./views/settings-patch");

function pageHead(title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Per-sistant</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <link rel="apple-touch-icon" href="/icon-192.svg">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#faf7f2">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>${SHARED_CSS}${APPBAR_PICKER_CSS}</style>
  <script>${SHARED_JS}</script>
  <script>${PRIMITIVES_JS}</script>
  <script>${SETTINGS_PATCH}</script>
</head>`;
}

const NAV = [
  { href: "/today",    label: "Today",     id: "today" },
  { href: "/",         label: "Dashboard", id: "dashboard" },
  { href: "/todos",    label: "To-Dos",    id: "todos" },
  { href: "/emails",   label: "Emails",    id: "emails" },
  { href: "/notes",    label: "Notes",     id: "notes" },
  { href: "/contacts", label: "Contacts",  id: "contacts" },
  { href: "/calendar", label: "Calendar",  id: "calendar" },
  { href: "/review",   label: "Review",    id: "review" },
  { href: "/analytics",label: "Analytics", id: "analytics" },
  { href: "/settings", label: "Settings",  id: "settings" },
];

function navIcon(id) {
  const c = 'currentColor', sw = '1.3';
  switch (id) {
    case 'today': return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="${sw}"/><line x1="7" y1="7" x2="7" y2="4" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"/><line x1="7" y1="7" x2="9.5" y2="7" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"/></svg>`;
    case 'dashboard': return `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="1" width="5" height="5" fill="none" stroke="${c}" stroke-width="${sw}"/><rect x="8" y="1" width="5" height="5" fill="none" stroke="${c}" stroke-width="${sw}"/><rect x="1" y="8" width="5" height="5" fill="none" stroke="${c}" stroke-width="${sw}"/><rect x="8" y="8" width="5" height="5" fill="none" stroke="${c}" stroke-width="${sw}"/></svg>`;
    case 'todos': return `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1.5" y="1.5" width="11" height="11" fill="none" stroke="${c}" stroke-width="${sw}"/><path d="M4 7 L6 9 L10 5" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    case 'emails': return `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1.5" y="3" width="11" height="8" fill="none" stroke="${c}" stroke-width="${sw}"/><path d="M1.5 3.5 L7 8 L12.5 3.5" fill="none" stroke="${c}" stroke-width="${sw}"/></svg>`;
    case 'notes': return `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 1.5 L11 1.5 L11 12.5 L3 12.5 Z" fill="none" stroke="${c}" stroke-width="${sw}"/><line x1="5" y1="5" x2="9" y2="5" stroke="${c}" stroke-width="1"/><line x1="5" y1="7.5" x2="9" y2="7.5" stroke="${c}" stroke-width="1"/><line x1="5" y1="10" x2="7.5" y2="10" stroke="${c}" stroke-width="1"/></svg>`;
    case 'contacts': return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="5" r="2.3" fill="none" stroke="${c}" stroke-width="${sw}"/><path d="M2.5 12.5 Q2.5 8.5 7 8.5 Q11.5 8.5 11.5 12.5" fill="none" stroke="${c}" stroke-width="${sw}"/></svg>`;
    case 'calendar': return `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1.5" y="2.5" width="11" height="10" fill="none" stroke="${c}" stroke-width="${sw}"/><line x1="1.5" y1="5.5" x2="12.5" y2="5.5" stroke="${c}" stroke-width="1"/><line x1="4.5" y1="1" x2="4.5" y2="4" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"/><line x1="9.5" y1="1" x2="9.5" y2="4" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"/></svg>`;
    case 'review': return `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="8" width="2" height="5" fill="${c}"/><rect x="6" y="5" width="2" height="8" fill="${c}"/><rect x="10" y="2" width="2" height="11" fill="${c}"/></svg>`;
    case 'analytics': return `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M1.5 11 L5 7 L8 9 L12.5 3" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case 'settings': return `<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="2" fill="none" stroke="${c}" stroke-width="${sw}"/><path d="M7 1 L7 3 M7 11 L7 13 M1 7 L3 7 M11 7 L13 7 M2.8 2.8 L4.2 4.2 M9.8 9.8 L11.2 11.2 M2.8 11.2 L4.2 9.8 M9.8 4.2 L11.2 2.8" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"/></svg>`;
    default: return '';
  }
}

const APPBAR_PICKER_CSS = `
.appbar .ui-controls { display: flex; align-items: center; gap: 10px; }
.appbar .mode-toggle {
  background: transparent; border: 1px solid var(--line); cursor: pointer;
  padding: 5px 10px; border-radius: 2px; color: var(--muted);
  font-family: var(--mono); font-size: 10px; font-weight: 500;
  letter-spacing: 0.1em; text-transform: uppercase;
}
.appbar .mode-toggle:hover { background: var(--paper-2); color: var(--ink); }
@media (max-width: 480px) {
  .appbar .mode-toggle { padding: 4px 8px; font-size: 9px; }
}
`;

function navBar(activePath) {
  const active = (NAV.find(n => n.href === activePath) || {}).id || 'dashboard';
  const links = NAV.map(n => `
    <a href="${n.href}" class="${n.id === active ? 'active' : ''}">
      <span class="icon">${navIcon(n.id)}</span>
      <span class="label">${n.label}</span>
    </a>`).join('');
  const perfinLink = PERFIN_URL
    ? `<a href="${PERFIN_URL}" target="_blank" rel="noopener">
         <span class="icon"><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 4 L7 10 M4 7 L10 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span>
         <span class="label">Perfin</span>
       </a>` : '';
  const here = (NAV.find(n => n.href === activePath) || {}).label || 'Per-sistant';
  return `
<aside class="sidebar">
  <div class="sidebar-brand">
    <div class="glyph">P</div>
    <div>
      <div class="name">Per-sistant</div>
      <div class="tag">personal assistant</div>
    </div>
  </div>
  <nav class="sidebar-nav">
    ${links}
    ${perfinLink ? '<div class="sep"></div>' + perfinLink : ''}
  </nav>
  <div class="sidebar-foot">
    <button id="sidebar-collapse-btn" class="collapse-btn" aria-label="Collapse sidebar">
      <span>&#8249;</span><span class="lbl">Collapse</span>
    </button>
  </div>
</aside>
<header class="appbar">
  <button class="mobile-sidebar-toggle" id="mobile-sidebar-toggle" aria-label="Menu">&#9776;</button>
  <nav class="crumbs">
    <a href="/">Home</a>
    <span class="sep">&rsaquo;</span>
    <span class="here">${here}</span>
  </nav>
  <div class="spacer"></div>
  <div class="ui-controls">
    <button id="mode-toggle" class="mode-toggle" aria-label="Toggle light/dark mode">Light</button>
  </div>
</header>`;
}

function themeScript() {
  return `<script>
  (function(){
    var PALETTES = ['copper','indigo','forest','slate','plum','mono'];
    function getUI() { try { return JSON.parse(localStorage.getItem('ps-ui') || '{}'); } catch { return {}; } }
    function setUI(u) { localStorage.setItem('ps-ui', JSON.stringify(u)); }
    function applyPalette(p) { document.body && document.body.setAttribute('data-palette', p); }
    function applyMode(m) { document.body && document.body.setAttribute('data-mode', m); }
    function applyCollapsed(c) { document.body && document.body.classList.toggle('sidebar-collapsed', !!c); }

    function paint() {
      var s = getUI();
      applyPalette(s.palette || 'copper');
      applyMode(s.mode || 'light');
      applyCollapsed(s.collapsed === true);
    }
    if (document.body) paint();

    function patchServer(field, value) {
      var body = {}; body[field] = value;
      fetch('/api/settings', {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      }).catch(function(){});
    }

    document.addEventListener('DOMContentLoaded', function() {
      paint();
      var mt = document.getElementById('mode-toggle');
      if (mt) mt.textContent = (getUI().mode === 'dark') ? 'Dark' : 'Light';

      var btn = document.getElementById('sidebar-collapse-btn');
      if (btn) btn.addEventListener('click', function() {
        document.body.classList.toggle('sidebar-collapsed');
        var s = getUI();
        s.collapsed = document.body.classList.contains('sidebar-collapsed');
        setUI(s);
      });

      var mob = document.getElementById('mobile-sidebar-toggle');
      if (mob) mob.addEventListener('click', function() {
        document.body.classList.toggle('sidebar-open');
      });

      if (mt) mt.addEventListener('click', function() {
        var s = getUI();
        var next = s.mode === 'dark' ? 'light' : 'dark';
        s.mode = next; setUI(s);
        applyMode(next);
        mt.textContent = next === 'dark' ? 'Dark' : 'Light';
        patchServer('theme', next);
      });
    });

    // Server hydrate — only for first visits (no local choice yet).
    // Once the user has picked a palette/mode locally, localStorage is
    // authoritative; the server PATCH from the picker handlers is the only
    // thing that updates it. This prevents navigation from clobbering a just-
    // set preference when the PATCH hasn't persisted yet (or the column is
    // missing and the server returns a default).
    fetch('/api/settings').then(function(r){return r.json();}).then(function(s){
      if (!s) return;
      var cur = getUI(), changed = false;
      if (!cur.palette && s.palette && PALETTES.indexOf(s.palette) >= 0) {
        cur.palette = s.palette; applyPalette(s.palette); changed = true;
      }
      if (!cur.mode && (s.theme === 'dark' || s.theme === 'light')) {
        cur.mode = s.theme; applyMode(s.theme); changed = true;
      }
      if (changed) {
        setUI(cur);
        var mt = document.getElementById('mode-toggle');
        if (mt) mt.textContent = cur.mode === 'dark' ? 'Dark' : 'Light';
      }
    }).catch(function(){});
  })();
</script>`;
}

module.exports = { SHARED_CSS, SHARED_JS, PRIMITIVES_JS, SETTINGS_PATCH, pageHead, navBar, themeScript };
