const { pageHead, navBar, themeScript } = require("../views");

module.exports = function() {
  return (req, res) => {
  res.send(`${pageHead("Knowledge")}
<body>
${themeScript()}
${navBar("/knowledge")}
<div class="container">
  <h1>Knowledge</h1>
  <p class="subtitle">Ask questions across your notes and documents. Answers cite their sources.</p>

  <div class="section" style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;justify-content:space-between;">
    <span id="k-status-text" style="font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:0.04em;line-height:1.6;">Loading index status&hellip;</span>
    <button class="btn" id="k-reindex-btn">Reindex now</button>
  </div>

  <div class="section">
    <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">
      <textarea id="k-query" rows="2" placeholder="Ask anything in your knowledge base… e.g. 'what's my car insurance deductible?'" style="flex:1;min-width:240px;min-height:52px;"></textarea>
      <button id="k-mic-btn" class="btn" title="Voice input" aria-label="Voice input" style="font-size:16px;">&#127908;</button>
    </div>
    <div class="actions" style="margin-top:10px;">
      <button class="btn primary" id="k-ask-btn">Ask</button>
      <button class="btn" id="k-search-btn">Search only</button>
      <button class="btn" id="k-diagram-btn">Diagram</button>
      <span id="k-busy" style="display:none;font-family:var(--mono);font-size:11px;color:var(--muted);align-self:center;letter-spacing:0.04em;">Thinking&hellip;</span>
    </div>
  </div>

  <div id="k-answer-wrap" class="section" style="display:none;">
    <h2 style="font-size:14px;">Answer</h2>
    <div id="k-answer" style="font-size:14px;line-height:1.7;"></div>
  </div>

  <div id="k-diagram-wrap" class="section" style="display:none;">
    <h2 style="font-size:14px;">Diagram</h2>
    <div id="k-diagram" style="overflow:auto;text-align:center;"></div>
    <details style="margin-top:10px;"><summary style="cursor:pointer;font-size:11px;color:var(--muted);">Mermaid source</summary><pre id="k-diagram-src" style="white-space:pre-wrap;font-family:var(--mono);font-size:11px;background:var(--paper-card);border:1px solid var(--line);border-radius:var(--radius);padding:10px;overflow:auto;"></pre></details>
  </div>

  <div id="k-sources-wrap" class="section" style="display:none;">
    <h2 style="font-size:14px;">Sources</h2>
    <div id="k-sources"></div>
  </div>

  <div id="k-empty" class="section" style="display:none;">
    <div class="empty-msg" id="k-empty-msg"></div>
  </div>

  <details class="section">
    <summary style="cursor:pointer;font-size:14px;font-weight:600;">Capture to vault</summary>
    <p style="font-size:11px;color:var(--muted);margin:8px 0;">Paste an email or jot a note &mdash; it's structured into a note or fact and committed to your vault. Requires a write-scoped token (<code>VAULT_GITHUB_WRITE_TOKEN</code>).</p>
    <textarea id="k-capture-text" rows="3" placeholder="Paste or type something to save to your vault&hellip;" style="width:100%;min-height:64px;"></textarea>
    <div class="actions" style="margin-top:8px;">
      <button class="btn primary" id="k-capture-btn">Capture</button>
      <span id="k-capture-status" style="font-family:var(--mono);font-size:10px;color:var(--muted);align-self:center;line-height:1.5;"></span>
    </div>
  </details>
</div>

<script>
var BP = window.BASE_PATH || '';
function kBusy(on){ document.getElementById('k-busy').style.display = on ? 'inline' : 'none'; }
function kShow(id, on){ document.getElementById(id).style.display = on ? 'block' : 'none'; }

function renderSources(sources){
  if(!sources || !sources.length){ kShow('k-sources-wrap', false); return; }
  document.getElementById('k-sources').innerHTML = sources.map(function(s){
    var num = s.n ? '<span style="font-family:var(--mono);color:var(--accent);margin-right:8px;">['+s.n+']</span>' : '';
    var kind = '<span style="font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-left:8px;">'+esc(s.kind||'')+'</span>';
    var citedBadge = s.cited ? '<span style="font-family:var(--mono);font-size:9px;color:var(--good);margin-left:8px;letter-spacing:0.08em;">&#10003; CITED</span>' : '';
    var title = esc(s.title || s.snippet || 'Untitled');
    var snip = s.snippet ? '<div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5;">'+esc(s.snippet.slice(0,220))+(s.snippet.length>220?'…':'')+'</div>' : '';
    return '<div style="padding:10px 0;border-bottom:1px solid var(--line);">'+num+'<span style="font-size:13px;">'+title+'</span>'+kind+citedBadge+snip+'</div>';
  }).join('');
  kShow('k-sources-wrap', true);
}

function kReset(){ kShow('k-answer-wrap', false); kShow('k-diagram-wrap', false); kShow('k-sources-wrap', false); kShow('k-empty', false); }
function showEmpty(msg){ document.getElementById('k-empty-msg').textContent = msg; kShow('k-empty', true); }

var _mermaid = null;
async function loadMermaid(){
  if(_mermaid) return _mermaid;
  var mod = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
  _mermaid = mod.default;
  _mermaid.initialize({ startOnLoad:false, securityLevel:'strict', theme:'neutral' });
  return _mermaid;
}
async function renderDiagram(code){
  document.getElementById('k-diagram-src').textContent = code;
  kShow('k-diagram-wrap', true);
  try {
    var m = await loadMermaid();
    var out = await m.render('k-mmd-'+Date.now(), code);
    document.getElementById('k-diagram').innerHTML = out.svg;
  } catch(e){
    document.getElementById('k-diagram').innerHTML = '<div class="empty-msg">Could not render the diagram — see the Mermaid source below.</div>';
  }
}
async function diagram(){
  var q = document.getElementById('k-query').value.trim();
  if(!q) return;
  kReset(); kBusy(true);
  try {
    var r = await fetch('/api/rag/diagram', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q})}).then(function(r){return r.json();});
    if(r.error){ showEmpty(r.error); return; }
    if(!r.mermaid){ showEmpty(r.note || 'Could not generate a diagram.'); renderSources(r.sources); return; }
    await renderDiagram(r.mermaid);
    renderSources(r.sources);
  } catch(e){ showEmpty('Something went wrong. Please try again.'); }
  finally { kBusy(false); }
}

async function ask(){
  var q = document.getElementById('k-query').value.trim();
  if(!q) return;
  kReset(); kBusy(true);
  try {
    var r = await fetch('/api/rag/query', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q})}).then(function(r){return r.json();});
    if(r.error){ document.getElementById('k-empty-msg').textContent = r.error; kShow('k-empty', true); return; }
    if(r.answer){
      document.getElementById('k-answer').innerHTML = renderMd(r.answer);
      kShow('k-answer-wrap', true);
    } else if(r.note){
      document.getElementById('k-empty-msg').textContent = r.note;
      kShow('k-empty', true);
    }
    renderSources(r.sources);
  } catch(e){
    document.getElementById('k-empty-msg').textContent = 'Something went wrong. Please try again.';
    kShow('k-empty', true);
  } finally { kBusy(false); }
}

async function searchOnly(){
  var q = document.getElementById('k-query').value.trim();
  if(!q) return;
  kReset(); kBusy(true);
  try {
    var r = await fetch('/api/rag/search?q='+encodeURIComponent(q)).then(function(r){return r.json();});
    if(r.error){ document.getElementById('k-empty-msg').textContent = r.error; kShow('k-empty', true); return; }
    if(!r.results || !r.results.length){
      document.getElementById('k-empty-msg').textContent = 'No matching notes or documents.';
      kShow('k-empty', true); return;
    }
    renderSources(r.results);
  } catch(e){
    document.getElementById('k-empty-msg').textContent = 'Something went wrong. Please try again.';
    kShow('k-empty', true);
  } finally { kBusy(false); }
}

var kPollTimer = null;
async function loadKStatus(){
  try {
    var st = await fetch('/api/rag/status').then(function(r){return r.json();});
    var el = document.getElementById('k-status-text'); if(!el) return;
    var bits = [];
    if(st.reindex && st.reindex.running){ bits.push('Reindexing…'); }
    bits.push(st.vector_ready ? 'Semantic search ready' : 'Keyword search (no vector index)');
    if(!st.embeddings_configured) bits.push('embeddings not configured');
    if(st.counts) bits.push(st.counts.embedded + ' sources embedded');
    if(st.counts && st.counts.facts) bits.push(st.counts.facts + ' facts');
    if(st.vault && st.vault.enabled && st.vault.last_synced_at) bits.push('vault synced ' + new Date(st.vault.last_synced_at).toLocaleString());
    if(st.vault && st.vault.last_error) bits.push('vault error: ' + st.vault.last_error);
    el.textContent = bits.join('  ·  ');
    var btn = document.getElementById('k-reindex-btn');
    if(btn) btn.disabled = !!(st.reindex && st.reindex.running);
    if(st.reindex && st.reindex.running){
      if(!kPollTimer) kPollTimer = setInterval(loadKStatus, 4000);
    } else if(kPollTimer){ clearInterval(kPollTimer); kPollTimer = null; }
  } catch(e){}
}
async function reindex(){
  var btn = document.getElementById('k-reindex-btn');
  btn.disabled = true;
  try {
    var r = await fetch('/api/rag/reindex', {method:'POST'}).then(function(r){return r.json();});
    if(r && r.error){ document.getElementById('k-status-text').textContent = r.error; btn.disabled = false; return; }
    loadKStatus();
  } catch(e){ btn.disabled = false; }
}

async function capture(){
  var t = document.getElementById('k-capture-text').value.trim();
  if(!t) return;
  var st = document.getElementById('k-capture-status');
  var btn = document.getElementById('k-capture-btn');
  st.textContent = 'Saving…'; btn.disabled = true;
  try {
    var r = await fetch('/api/rag/capture', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})}).then(function(r){return r.json();});
    if(r.error){ st.textContent = r.error; return; }
    st.innerHTML = 'Saved as <code>'+esc(r.path)+'</code> ('+esc(r.type)+'). Searchable after the next sync.';
    document.getElementById('k-capture-text').value = '';
    loadKStatus();
  } catch(e){ st.textContent = 'Capture failed.'; }
  finally { btn.disabled = false; }
}

bindEvents([
  ['k-ask-btn','click',ask],
  ['k-search-btn','click',searchOnly],
  ['k-diagram-btn','click',diagram],
  ['k-capture-btn','click',capture],
  ['k-mic-btn','click',function(){ startVoiceInput('k-query'); }],
  ['k-reindex-btn','click',reindex],
]);
loadKStatus();
document.getElementById('k-query').addEventListener('keydown',function(e){
  if(e.key==='Enter' && (e.metaKey || e.ctrlKey)){ e.preventDefault(); ask(); }
});
</script>
</body></html>`);
  };
};
