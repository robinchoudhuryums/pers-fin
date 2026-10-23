// Search page (roadmap T2.4 X3b): the dashboard widget's search on its own page,
// so it doesn't depend on that widget being shown. GET /api/search — tasks,
// emails, notes, contacts and, under the unified shell, Perfin's records
// (X3a) — rendered by the shared renderSearchResults (views/js.js). ?q= prefills
// and runs a search; the box is focused on load and "/" focuses it again. The
// URL follows the query (history.replaceState), so a search can be linked.
const { pageHead, navBar, themeScript, nonceAttr } = require("../views");

module.exports = function() {
  return (req, res) => {
  res.send(`${pageHead("Search")}
<body>
${themeScript()}
${navBar("/search")}
<div class="container">
  <h1>Search</h1>
  <p class="subtitle">Tasks, emails, notes and contacts — and, under the unified shell, Perfin's transactions, subscriptions, bills, goals and accounts.</p>

  <div class="search-bar">
    <span class="search-icon" aria-hidden="true">&#128269;</span>
    <input type="search" id="search-page-input" aria-label="Search everything" placeholder="Search… (press /)" autocomplete="off">
  </div>
  <p class="subtitle" id="search-page-status" role="status" aria-live="polite"></p>
  <div class="section search-results" id="search-page-results"></div>
</div>

<script${nonceAttr()}>
var searchTimer = null, searchSeq = 0;
function setQueryInUrl(q) {
  try {
    var u = new URL(location.href);
    if (q) u.searchParams.set('q', q); else u.searchParams.delete('q');
    history.replaceState(null, '', u.pathname + u.search);
  } catch (e) { /* an old browser keeps the original URL */ }
}
async function runSearch(q) {
  var out = document.getElementById('search-page-results');
  var status = document.getElementById('search-page-status');
  q = (q || '').trim();
  setQueryInUrl(q);
  if (q.length < 2) { searchSeq++; out.innerHTML = ''; status.textContent = q ? 'Type at least 2 characters.' : ''; return; }
  var seq = ++searchSeq;
  status.textContent = 'Searching…';
  var res = await tryFetch('/api/search?q=' + encodeURIComponent(q));
  if (seq !== searchSeq) return; // a newer search is on its way
  if (!res) { status.textContent = 'Search failed — check your connection.'; out.innerHTML = ''; return; }
  var data = await res.json().catch(function() { return null; });
  if (!res.ok) { status.textContent = (data && data.error) || 'Search failed.'; out.innerHTML = ''; return; }
  var n = Array.isArray(data) ? data.length : 0;
  status.textContent = n ? n + ' result' + (n === 1 ? '' : 's') : '';
  out.innerHTML = renderSearchResults(data);
}
function onSearchInput() {
  clearTimeout(searchTimer);
  var v = this.value;
  searchTimer = setTimeout(function() { runSearch(v); }, 300);
}
(function initSearchPage() {
  var input = document.getElementById('search-page-input');
  var q = '';
  try { q = new URLSearchParams(location.search).get('q') || ''; } catch (e) { q = ''; }
  input.value = q;
  input.addEventListener('input', onSearchInput);
  input.focus();
  if (q) runSearch(q);
  document.addEventListener('keydown', function(e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === '/') { e.preventDefault(); input.focus(); input.select(); }
  });
})();
</script>
</body></html>`);
  };
};
