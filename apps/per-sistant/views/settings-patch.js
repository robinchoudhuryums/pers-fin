// ============================================================================
// Per-sistant — Settings page enhancement (palette picker injection)
// ============================================================================
// Runs only on /settings. Finds the "Appearance" section in the existing page
// markup and appends a palette-swatch row below the theme dropdown.
// This keeps pages/settings.js (40KB+) untouched — the giant file doesn't fit
// in a single tool-call push, so we enhance it client-side instead.
module.exports = `
(function(){
  if (location.pathname !== '/settings') return;
  var PALETTES = [
    { id: 'copper', swatch: '#b5714a', label: 'Copper' },
    { id: 'indigo', swatch: '#4d5bce', label: 'Indigo' },
    { id: 'forest', swatch: '#3f7b5a', label: 'Forest' },
    { id: 'slate',  swatch: '#4e7bc4', label: 'Slate' },
    { id: 'plum',   swatch: '#a0507a', label: 'Plum' },
    { id: 'mono',   swatch: '#0a0a0a', label: 'Mono' },
  ];

  function getUI() { try { return JSON.parse(localStorage.getItem('ps-ui') || '{}'); } catch { return {}; } }
  function setUI(u) { localStorage.setItem('ps-ui', JSON.stringify(u)); }

  function inject() {
    if (document.getElementById('s-palette-row')) return; // idempotent
    var appearanceSec = null;
    document.querySelectorAll('.section').forEach(function(sec) {
      var h = sec.querySelector('h2');
      if (h && h.textContent.trim().toLowerCase() === 'appearance') appearanceSec = sec;
    });
    if (!appearanceSec) return false;

    var row = document.createElement('div');
    row.id = 's-palette-row';
    row.style.cssText = 'display:flex;gap:14px;align-items:center;margin-top:14px;flex-wrap:wrap;';
    row.innerHTML =
      '<label style="margin:0;font-size:13px;color:var(--ink)">Palette</label>' +
      '<div class="palette-picker" id="s-palette-picker">' +
        PALETTES.map(function(p) {
          return '<button data-palette="' + p.id + '" style="background:' + p.swatch + '" ' +
                 'title="' + p.label + '" aria-label="' + p.label + ' palette"></button>';
        }).join('') +
      '</div>';
    appearanceSec.appendChild(row);

    function syncActive() {
      var cur = (getUI().palette) || 'copper';
      row.querySelectorAll('button').forEach(function(b) {
        b.classList.toggle('active', b.dataset.palette === cur);
      });
    }
    syncActive();

    row.addEventListener('click', function(e) {
      var t = e.target.closest('button[data-palette]');
      if (!t) return;
      var p = t.dataset.palette;
      var s = getUI(); s.palette = p; setUI(s);
      document.body.setAttribute('data-palette', p);
      syncActive();
      fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ palette: p }),
      }).catch(function(){});
    });
    return true;
  }

  // Appearance section is static HTML, so one shot at DOMContentLoaded is
  // enough. Still retry briefly in case the page script replaces nodes.
  document.addEventListener('DOMContentLoaded', function() {
    if (inject()) return;
    var tries = 0;
    var iv = setInterval(function() {
      if (inject() || ++tries > 10) clearInterval(iv);
    }, 200);
  });
})();
`;
