// ============================================================================
// Cosmic transition overlay — auto-init module.
// ----------------------------------------------------------------------------
// Loaded under the unified shell on the landing page and on every Perfin
// page (when embedded). Scans for [data-atrans] elements, populates
// the per-overlay decorations (twinkling stars + rising particles) and
// binds click handlers that show the matching .atrans-overlay before
// navigating.
// ============================================================================
(function() {
  function populateStars(box) {
    if (box.dataset.populated) return;
    var html = '';
    for (var i = 0; i < 32; i++) {
      var x = Math.random() * 100, y = Math.random() * 100;
      var size = (Math.random() * 1.6 + 1).toFixed(2);
      var delay = (Math.random() * 2.4).toFixed(2);
      var dur = (Math.random() * 1.6 + 1.6).toFixed(2);
      html += '<span style="left:' + x.toFixed(1) + '%;top:' + y.toFixed(1) +
              '%;width:' + size + 'px;height:' + size +
              'px;animation-delay:' + delay + 's;animation-duration:' + dur + 's;"></span>';
    }
    box.innerHTML = html;
    box.dataset.populated = '1';
  }

  // Rising particles, overlay-wide. Parallels Perfin's materialize particle
  // effect but denser (60 vs 20) and using the cosmic gold/purple palette.
  // Each particle gets randomized position, size, color, duration, and delay
  // so the field doesn't pulse in unison.
  function populateParticles(box) {
    if (box.dataset.populated) return;
    var COUNT = 60;
    for (var p = 0; p < COUNT; p++) {
      var dot = document.createElement('div');
      dot.className = 'atrans-particle';
      var size = (1 + Math.random() * 2.2).toFixed(2);
      var leftPct = (Math.random() * 100).toFixed(1);
      var bottomPct = (Math.random() * 60).toFixed(1);
      var dur = (2.6 + Math.random() * 3.5).toFixed(2);
      var delay = (Math.random() * 4.5).toFixed(2);
      // ~65% warm gold, ~35% soft purple — keeps the palette cohesive with
      // the scan line and halo while adding subtle variety.
      var warm = Math.random() < 0.65;
      var color = warm ? 'rgba(212,165,116,0.95)' : 'rgba(168,140,220,0.95)';
      var glowColor = warm ? 'rgba(212,165,116,0.65)' : 'rgba(168,140,220,0.65)';
      var glowSize = (parseFloat(size) * 2.2).toFixed(1);
      dot.style.cssText =
        'left:' + leftPct + '%;' +
        'bottom:' + bottomPct + '%;' +
        'width:' + size + 'px;height:' + size + 'px;' +
        'background:' + color + ';' +
        'box-shadow:0 0 ' + glowSize + 'px ' + glowColor + ';' +
        '--p-dur:' + dur + 's;--p-delay:' + delay + 's;';
      box.appendChild(dot);
    }
    box.dataset.populated = '1';
  }

  function decorateOverlay(overlay) {
    var stars = overlay.querySelector('.atrans-stars');
    if (stars) populateStars(stars);
    var particles = overlay.querySelector('.atrans-particles');
    if (particles) populateParticles(particles);
  }

  function init() {
    // Decorate every overlay present in the DOM (one per page typically).
    document.querySelectorAll('.atrans-overlay').forEach(decorateOverlay);

    // Bind triggers — supports two attribute styles:
    //   data-atrans="cosmic"  → looks up #atrans-cosmic on the page
    //   data-atrans-target="#someId"  → explicit target (future-proofing)
    document.querySelectorAll('[data-atrans]').forEach(function(trigger) {
      trigger.addEventListener('click', function(e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
        var variant = trigger.getAttribute('data-atrans');
        var overlay = document.getElementById('atrans-' + variant);
        if (!overlay) return; // fall through to default link nav
        e.preventDefault();
        overlay.classList.add('active');
        // ~1.35s reveal then navigate; the destination's first paint covers
        // the overlay so a fade-out isn't strictly necessary.
        setTimeout(function() { window.location.href = trigger.href; }, 1350);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
