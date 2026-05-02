// ============================================================================
// Cosmic transition overlay — auto-init module.
// ----------------------------------------------------------------------------
// Loaded under the unified shell on the landing page and on every Perfin
// page (when embedded). Scans for [data-atrans] elements, builds the
// per-stage decorations (stars, constellation, shooting stars, tagline)
// and binds click handlers that show the matching .atrans-overlay before
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

  // Two diagonal streaks crossing the backdrop during the reveal — staggered
  // so they don't fire simultaneously. Each one travels from upper-left to
  // lower-right with slight angle variance.
  function spawnShootingStars(stage) {
    if (stage.dataset.shootingPopulated) return;
    for (var i = 0; i < 2; i++) {
      var s = document.createElement('div');
      s.className = 'atrans-shooting-star';
      var startTop = 10 + Math.random() * 40;
      var delay = (0.25 + i * 0.5 + Math.random() * 0.2).toFixed(2);
      var dur = (1.0 + Math.random() * 0.3).toFixed(2);
      s.style.cssText =
        'top:' + startTop + '%;left:-10%;' +
        '--shoot-delay:' + delay + 's;' +
        '--shoot-dur:' + dur + 's;';
      stage.appendChild(s);
    }
    stage.dataset.shootingPopulated = '1';
  }

  // Connect 4-6 nearby star pairs with thin glowing lines drawn via
  // stroke-dashoffset. Picks pairs within a sane distance band so we
  // get visual constellations rather than a tangle.
  function drawConstellation(stage, starsBox) {
    if (stage.dataset.constellationPopulated) return;
    var stars = Array.from(starsBox.querySelectorAll('span'));
    if (stars.length < 4) return;
    var svgNs = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('class', 'atrans-constellation');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');

    var used = {};
    var keyOf = function(a, b) { return Math.min(a, b) + '-' + Math.max(a, b); };
    var lines = 0, attempts = 0;
    while (lines < 5 && attempts < 80) {
      attempts++;
      var i = Math.floor(Math.random() * stars.length);
      var j = Math.floor(Math.random() * stars.length);
      if (i === j) continue;
      var k = keyOf(i, j);
      if (used[k]) continue;
      var ax = parseFloat(stars[i].style.left);
      var ay = parseFloat(stars[i].style.top);
      var bx = parseFloat(stars[j].style.left);
      var by = parseFloat(stars[j].style.top);
      var d = Math.hypot(ax - bx, ay - by);
      if (d < 12 || d > 38) continue;
      var line = document.createElementNS(svgNs, 'line');
      line.setAttribute('x1', ax);
      line.setAttribute('y1', ay);
      line.setAttribute('x2', bx);
      line.setAttribute('y2', by);
      line.setAttribute('pathLength', '1');
      line.style.animationDelay = (0.55 + lines * 0.12).toFixed(2) + 's';
      svg.appendChild(line);
      used[k] = 1;
      lines++;
    }
    stage.appendChild(svg);
    stage.dataset.constellationPopulated = '1';
  }

  // "PER-SISTANT" letter-by-letter under the mask. Each letter gets its own
  // span with a CSS-var index for staggered fade-in via animation-delay.
  function spawnTagline(stage) {
    if (stage.dataset.taglinePopulated) return;
    var text = 'PER–SISTANT'; // en-dash for visual balance
    var el = document.createElement('div');
    el.className = 'atrans-tagline';
    for (var i = 0; i < text.length; i++) {
      var sp = document.createElement('span');
      sp.textContent = text[i] === ' ' ? ' ' : text[i];
      sp.style.setProperty('--i', i);
      el.appendChild(sp);
    }
    stage.appendChild(el);
    stage.dataset.taglinePopulated = '1';
  }

  function decorateOverlay(overlay) {
    var stage = overlay.querySelector('.atrans-stage');
    var stars = overlay.querySelector('.atrans-stars');
    if (stars) populateStars(stars);
    if (stage) {
      spawnShootingStars(stage);
      if (stars) drawConstellation(stage, stars);
      spawnTagline(stage);
    }
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
        // ~1.7s reveal then navigate (tagline finishes fading in around 2.0s
        // so the destination first paint takes over before the tagline's
        // last letter fully settles — feels snappier than waiting for full
        // letter-out).
        setTimeout(function() { window.location.href = trigger.href; }, 1700);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
