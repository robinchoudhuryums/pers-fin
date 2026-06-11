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

  // --------------------------------------------------------------------------
  // Particle assembly/disassembly of the app icon. Samples the overlay's
  // .atrans-art <img> (the PWA icon artwork) into ~3k colored particles that
  // fly in from scattered positions to assemble the icon, hold with a subtle
  // shimmer, then burst apart — and navigates just before the burst finishes.
  // Returns false when it can't run (image not ready / canvas tainted), in
  // which case the caller falls back to the original CSS mask reveal.
  // --------------------------------------------------------------------------
  var ASSEMBLE_MS = 950, HOLD_MS = 280, DISPERSE_MS = 520;
  var NAVIGATE_AT = ASSEMBLE_MS + HOLD_MS + DISPERSE_MS - 90;

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInCubic(t) { return t * t * t; }

  function startParticleAssembly(overlay, navigate) {
    var img = overlay.querySelector('.atrans-art img');
    var stage = overlay.querySelector('.atrans-stage');
    if (!img || !stage || !img.complete || !img.naturalWidth) return false;

    var SIZE = 240;       // matches .atrans-stage
    var GRID = 64;        // sample resolution → up to ~4k particles
    var particles = [];
    try {
      var sample = document.createElement('canvas');
      sample.width = GRID; sample.height = GRID;
      var sctx = sample.getContext('2d');
      sctx.drawImage(img, 0, 0, GRID, GRID);
      var data = sctx.getImageData(0, 0, GRID, GRID).data; // throws if tainted
      var cell = SIZE / GRID;
      for (var gy = 0; gy < GRID; gy++) {
        for (var gx = 0; gx < GRID; gx++) {
          var i = (gy * GRID + gx) * 4;
          if (data[i + 3] < 110) continue;
          var angle = Math.random() * Math.PI * 2;
          var dist = 200 + Math.random() * 320;
          particles.push({
            hx: gx * cell + cell / 2,
            hy: gy * cell + cell / 2,
            sx: SIZE / 2 + Math.cos(angle) * dist,
            sy: SIZE / 2 + Math.sin(angle) * dist,
            // disassembly direction: roughly outward from icon center with jitter
            dx: Math.cos(angle + (Math.random() - 0.5)) * (140 + Math.random() * 220),
            dy: Math.sin(angle + (Math.random() - 0.5)) * (140 + Math.random() * 220),
            delay: Math.random() * 0.25,
            color: 'rgb(' + data[i] + ',' + data[i + 1] + ',' + data[i + 2] + ')',
          });
        }
      }
    } catch (err) { return false; }
    if (!particles.length) return false;

    var canvas = document.createElement('canvas');
    canvas.className = 'atrans-canvas';
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr; canvas.height = SIZE * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    stage.appendChild(canvas);
    overlay.classList.add('atrans--particles');

    var dot = SIZE / GRID + 0.4;
    var start = null, navigated = false;
    function frame(now) {
      if (start === null) start = now;
      var t = now - start;
      ctx.clearRect(0, 0, SIZE, SIZE);
      for (var k = 0; k < particles.length; k++) {
        var pt = particles[k];
        var x, y, alpha = 1;
        if (t < ASSEMBLE_MS) {
          // assemble: scattered → home, per-particle stagger
          var ap = Math.min(1, Math.max(0, (t / ASSEMBLE_MS - pt.delay) / (1 - pt.delay)));
          var e1 = easeOutCubic(ap);
          x = pt.sx + (pt.hx - pt.sx) * e1;
          y = pt.sy + (pt.hy - pt.sy) * e1;
          alpha = 0.25 + 0.75 * e1;
        } else if (t < ASSEMBLE_MS + HOLD_MS) {
          // hold: assembled with a faint shimmer
          var ht = (t - ASSEMBLE_MS) / HOLD_MS;
          x = pt.hx + Math.sin((ht * 6 + k) * 1.7) * 0.4;
          y = pt.hy + Math.cos((ht * 6 + k) * 1.3) * 0.4;
        } else {
          // disassemble: burst outward and fade
          var dp = Math.min(1, (t - ASSEMBLE_MS - HOLD_MS) / DISPERSE_MS);
          var e2 = easeInCubic(dp);
          x = pt.hx + pt.dx * e2;
          y = pt.hy + pt.dy * e2;
          alpha = 1 - dp;
        }
        ctx.globalAlpha = alpha;
        ctx.fillStyle = pt.color;
        ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot);
      }
      ctx.globalAlpha = 1;
      if (!navigated && t >= NAVIGATE_AT) { navigated = true; navigate(); }
      if (t < ASSEMBLE_MS + HOLD_MS + DISPERSE_MS + 120) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return true;
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
        function navigate() { window.location.href = trigger.href; }
        // Reduced motion: no animation, straight navigation.
        try {
          if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return navigate();
        } catch (err) {}
        overlay.classList.add('active');
        // Particle assembly/disassembly of the app icon; falls back to the
        // original CSS mask reveal when the engine can't run.
        if (!startParticleAssembly(overlay, navigate)) {
          setTimeout(navigate, 1350);
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
