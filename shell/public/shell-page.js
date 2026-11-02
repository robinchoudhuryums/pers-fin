// ============================================================================
// Shell page chrome (login + landing): the clock readout. External so the
// landing page needs no inline script; the login page loads it too.
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

  function init() {
    tickClock();
    setInterval(tickClock, 20000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
