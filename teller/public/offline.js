// Offline fallback page behaviour (F92). External, not inline: the shell's
// CSP is nonce-only for scripts, which also blocks inline onclick/onerror.
(function() {
  var retry = document.getElementById('offline-retry');
  if (retry) retry.addEventListener('click', function() { location.reload(); });
  var logo = document.getElementById('offline-logo');
  if (!logo) return;
  function hide() { logo.style.display = 'none'; }
  // The image may already have failed before this script ran.
  if (logo.complete && logo.naturalWidth === 0) hide();
  else logo.addEventListener('error', hide);
})();
