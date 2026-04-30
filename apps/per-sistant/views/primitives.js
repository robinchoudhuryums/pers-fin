// ============================================================================
// Per-sistant — Visual primitives (Sparkline, ScoreDial, RubricBar)
// ============================================================================
// Ported from the UMS Analytics design bundle's primitives.jsx.
// Pure functions returning SVG strings; pages opt in by:
//   - calling PsPrimitives.sparkline(data, opts)  →  SVG markup
//   - or adding data-spark="1,3,2,5,4" to a card; auto-upgraded on load.
//
// All primitives use currentColor + var(--accent) so they inherit the palette.
module.exports = `
(function(){
  function sparkline(data, opts) {
    opts = opts || {};
    var width = opts.width || 80, height = opts.height || 24;
    var stroke = opts.stroke || 'currentColor';
    var clean = data.filter(function(v){ return v != null; });
    if (clean.length < 2) return '';
    var min = Math.min.apply(null, clean), max = Math.max.apply(null, clean);
    var range = (max - min) || 1;
    var step = width / (data.length - 1);
    var d = '';
    for (var i = 0; i < data.length; i++) {
      var v = data[i];
      if (v == null) continue;
      var x = (i * step).toFixed(1);
      var y = (height - ((v - min) / range) * (height - 2) - 1).toFixed(1);
      d += (d ? ' L' : 'M') + x + ',' + y;
    }
    return '<svg width="' + width + '" height="' + height + '" style="display:block">' +
      '<path d="' + d + '" fill="none" stroke="' + stroke + '" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function scoreDial(value, opts) {
    opts = opts || {};
    var size = opts.size || 100, max = opts.max || 10;
    var label = opts.label || 'Score';
    var r = size / 2 - 8, c = 2 * Math.PI * r;
    var pct = Math.max(0, Math.min(1, value / max));
    var off = (c * (1 - pct)).toFixed(2);
    var color = pct >= 0.85 ? 'var(--good)' : pct >= 0.6 ? 'var(--accent)' : 'var(--warn)';
    var labelHtml = label
      ? '<div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.12em;margin-top:-2px;font-family:var(--mono)">' + label + '</div>'
      : '';
    return '<div style="position:relative;width:' + size + 'px;height:' + size + 'px;display:inline-block">' +
      '<svg width="' + size + '" height="' + size + '" style="transform:rotate(-90deg)">' +
        '<circle cx="' + (size/2) + '" cy="' + (size/2) + '" r="' + r + '" fill="none" ' +
          'stroke="var(--line)" stroke-width="3"/>' +
        '<circle cx="' + (size/2) + '" cy="' + (size/2) + '" r="' + r + '" fill="none" ' +
          'stroke="' + color + '" stroke-width="3" stroke-dasharray="' + c.toFixed(2) +
          '" stroke-dashoffset="' + off + '" stroke-linecap="round"/>' +
      '</svg>' +
      '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">' +
        '<div style="font-family:var(--display);font-size:' + (size * 0.30) + 'px;font-weight:500;' +
          'color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:-1px">' +
          (Number.isInteger(value) ? value : value.toFixed(1)) +
        '</div>' +
        labelHtml +
      '</div>' +
    '</div>';
  }

  // Vertical rubric bar (single metric, 0–max)
  function rubricBar(value, opts) {
    opts = opts || {};
    var max = opts.max || 10, height = opts.height || 120, width = opts.width || 16;
    var label = opts.label || '';
    var pct = Math.max(0, Math.min(1, value / max)) * 100;
    var color = pct >= 70 ? 'var(--accent)' : 'var(--warn)';
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:6px">' +
      '<div style="font-family:var(--mono);font-size:11px;color:var(--ink);font-variant-numeric:tabular-nums;font-weight:500">' +
        (Number.isInteger(value) ? value : value.toFixed(1)) +
      '</div>' +
      '<div style="width:' + width + 'px;height:' + height + 'px;background:var(--paper-2);' +
        'border:1px solid var(--line);position:relative">' +
        '<div style="position:absolute;bottom:0;left:0;right:0;height:' + pct + '%;background:' + color + '"></div>' +
      '</div>' +
      (label ? '<div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;text-align:center;max-width:60px;line-height:1.2">' + label + '</div>' : '') +
    '</div>';
  }

  // Auto-upgrade: any .card[data-spark] gets a sparkline appended after .value.
  // Format: data-spark="1,3,2,5,4" — comma-separated numbers (nulls allowed).
  // Optional data-spark-color="var(--good)" for non-default tint.
  function upgradeCards() {
    var cards = document.querySelectorAll('.card[data-spark]');
    cards.forEach(function(card) {
      if (card.querySelector(':scope > .ps-spark')) return; // idempotent
      var raw = card.getAttribute('data-spark') || '';
      var data = raw.split(',').map(function(s){ var n = parseFloat(s); return isNaN(n) ? null : n; });
      if (data.filter(function(v){return v!=null;}).length < 2) return;
      var color = card.getAttribute('data-spark-color') || 'var(--accent)';
      var wrap = document.createElement('div');
      wrap.className = 'ps-spark';
      wrap.style.cssText = 'margin-top:8px;color:' + color + ';';
      wrap.innerHTML = sparkline(data, { width: 100, height: 22, stroke: 'currentColor' });
      var anchor = card.querySelector('.value') || card;
      anchor.insertAdjacentElement('afterend', wrap);
    });
  }

  document.addEventListener('DOMContentLoaded', upgradeCards);

  window.PsPrimitives = {
    sparkline: sparkline,
    scoreDial: scoreDial,
    rubricBar: rubricBar,
    upgradeCards: upgradeCards,
  };
})();
`;
