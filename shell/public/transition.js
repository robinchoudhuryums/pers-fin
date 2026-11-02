// ============================================================================
// The shell dial + the Per-sistant entry transition — auto-init module.
// ----------------------------------------------------------------------------
// Loaded by the shell's login and landing pages and (under the shell) by every
// Perfin page. Two jobs:
//
//   window.ShellDial — builds the dial's SVG into an element (the login page
//   drives it: one inner tick per digit, then the unlock spin).
//
//   [data-atrans="dial"] links — a click shows the matching #atrans-dial
//   overlay: the arc fills, the outer tick ring spins up (transition.css,
//   .is-unlocking), and the browser navigates as the spin settles. It replaced
//   the starfield / particle-assembly effect: the same short "unlocking"
//   moment as the login, light enough for a phone, CSS-driven.
// ============================================================================
(function() {
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var C = 120;                  // centre of the 240 x 240 viewBox
  var INNER = 48;               // inner ticks — the progress ring
  var ARC_R = 84;
  var ARC_LEN = 2 * Math.PI * ARC_R;

  // Tick marks from..to of `count` around the centre, r1 → r2, as one path.
  function ticks(count, r1, r2, from, to) {
    var d = '';
    for (var i = from; i < to; i++) {
      var a = (i / count) * Math.PI * 2;
      d += 'M' + (C + Math.sin(a) * r1).toFixed(2) + ' ' + (C - Math.cos(a) * r1).toFixed(2) +
           'L' + (C + Math.sin(a) * r2).toFixed(2) + ' ' + (C - Math.cos(a) * r2).toFixed(2);
    }
    return d;
  }

  function el(name, attrs, parent) {
    var n = document.createElementNS(SVG_NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // Build the dial into `host` (an element that holds the app icon <img>) and
  // return a small controller. Idempotent: a second mount reuses the first.
  function mount(host) {
    if (!host) return null;
    if (host._dial) return host._dial;
    host.classList.add('dial');
    var svg = el('svg', { 'class': 'dial-svg', width: 240, height: 240, viewBox: '0 0 240 240', 'aria-hidden': 'true', focusable: 'false' });
    var burst = el('g', { 'class': 'dial-burst' }, svg);
    var drift = el('g', { 'class': 'dial-drift' }, burst);
    el('path', { 'class': 'dial-outer', d: ticks(120, 112, 116, 0, 120) }, drift);
    var lit = el('path', { 'class': 'dial-lit', d: '' }, svg);
    var dim = el('path', { 'class': 'dial-dim', d: ticks(INNER, 96, 104, 0, INNER) }, svg);
    el('circle', { 'class': 'dial-track', cx: C, cy: C, r: ARC_R }, svg);
    var arc = el('circle', {
      'class': 'dial-arc', cx: C, cy: C, r: ARC_R,
      'stroke-dasharray': ARC_LEN.toFixed(2), 'stroke-dashoffset': ARC_LEN.toFixed(2),
      transform: 'rotate(-90 120 120)',
    }, svg);
    host.insertBefore(svg, host.firstChild);

    var ctl = {
      // frac 0..1 — the share of inner ticks lit and of the arc drawn.
      setProgress: function(frac) {
        var f = Math.max(0, Math.min(1, frac || 0));
        var n = Math.round(f * INNER);
        lit.setAttribute('d', ticks(INNER, 96, 104, 0, n));
        dim.setAttribute('d', ticks(INNER, 96, 104, n, INNER));
        arc.setAttribute('stroke-dashoffset', (ARC_LEN * (1 - f)).toFixed(2));
      },
      setState: function(state) {
        host.classList.toggle('is-checking', state === 'checking');
        host.classList.toggle('is-error', state === 'error');
      },
    };
    host._dial = ctl;
    return ctl;
  }

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (err) { return false; }
  }

  // Step the inner ticks from 0 to all lit over `ms` (the arc follows its CSS
  // transition). Used by the entry transition, where there is no PIN to type.
  function fill(ctl, ms, done) {
    var start = null;
    function frame(now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / ms);
      ctl.setProgress(t);
      if (t < 1) requestAnimationFrame(frame); else if (done) done();
    }
    requestAnimationFrame(frame);
  }

  // The unlock: fill, spin up, navigate as the spin settles. ~1.2 s in all.
  var FILL_MS = 260, SPIN_NAVIGATE_MS = 950;
  function playEntry(overlay, navigate) {
    var dial = overlay.querySelector('[data-dial]');
    var ctl = mount(dial);
    overlay.classList.remove('is-unlocking');
    if (ctl) ctl.setProgress(0);
    overlay.classList.add('active');
    if (!ctl) return setTimeout(navigate, 600);
    fill(ctl, FILL_MS, function() {
      overlay.classList.add('is-unlocking');
      setTimeout(navigate, SPIN_NAVIGATE_MS);
    });
  }

  function init() {
    document.querySelectorAll('[data-dial]').forEach(mount);

    document.querySelectorAll('[data-atrans]').forEach(function(trigger) {
      trigger.addEventListener('click', function(e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
        var overlay = document.getElementById('atrans-' + trigger.getAttribute('data-atrans'));
        if (!overlay) return; // fall through to default link navigation
        e.preventDefault();
        function navigate() { window.location.href = trigger.href; }
        if (reducedMotion()) return navigate();
        playEntry(overlay, navigate);
      });
    });

    // Back / forward cache: a page restored after the transition navigated
    // away would still show the overlay.
    window.addEventListener('pageshow', function(ev) {
      if (!ev.persisted) return;
      document.querySelectorAll('.atrans-overlay').forEach(function(o) {
        o.classList.remove('active', 'is-unlocking');
      });
    });
  }

  window.ShellDial = { mount: mount, ticks: ticks, fill: fill, playEntry: playEntry, reducedMotion: reducedMotion };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
