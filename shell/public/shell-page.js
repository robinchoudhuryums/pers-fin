// ============================================================================
// Shell page chrome (login + landing): the clock readout and the gold light
// that follows the pointer. External so the landing page needs no inline
// script; the login page loads it too.
// ============================================================================
(function() {
  function two(n) { return n < 10 ? '0' + n : String(n); }

  function tickClock() {
    var el = document.getElementById('shell-clock');
    if (!el) return;
    var now = new Date();
    var date;
    try {
      date = now.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' });
    } catch (err) { date = now.toDateString(); }
    el.textContent = two(now.getHours()) + ':' + two(now.getMinutes()) + '  ·  ' + date;
  }

  function followPointer() {
    var light = document.getElementById('shell-light');
    if (!light) return;
    try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch (err) {}
    var x = 0, y = 0, queued = false;
    window.addEventListener('pointermove', function(e) {
      if (document.body.classList.contains('is-unlocking')) return;
      x = e.clientX; y = e.clientY;
      if (queued) return;
      queued = true;
      requestAnimationFrame(function() {
        queued = false;
        var w = window.innerWidth || 1, h = window.innerHeight || 1;
        light.style.setProperty('--lx', Math.round((x / w) * 100) + '%');
        light.style.setProperty('--ly', Math.round((y / h) * 100) + '%');
      });
    }, { passive: true });
  }

  function init() {
    tickClock();
    setInterval(tickClock, 20000);
    followPointer();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
