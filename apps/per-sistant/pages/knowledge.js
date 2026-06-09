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

  <div class="section">
    <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">
      <textarea id="k-query" rows="2" placeholder="Ask anything in your knowledge base… e.g. 'what's my car insurance deductible?'" style="flex:1;min-width:240px;min-height:52px;"></textarea>
      <button id="k-mic-btn" class="btn" title="Voice input" aria-label="Voice input" style="font-size:16px;">&#127908;</button>
    </div>
    <div class="actions" style="margin-top:10px;">
      <button class="btn primary" id="k-ask-btn">Ask</button>
      <button class="btn" id="k-search-btn">Search only</button>
      <span id="k-busy" style="display:none;font-family:var(--mono);font-size:11px;color:var(--muted);align-self:center;letter-spacing:0.04em;">Thinking&hellip;</span>
    </div>
  </div>

  <div id="k-answer-wrap" class="section" style="display:none;">
    <h2 style="font-size:14px;">Answer</h2>
    <div id="k-answer" style="font-size:14px;line-height:1.7;"></div>
  </div>

  <div id="k-sources-wrap" class="section" style="display:none;">
    <h2 style="font-size:14px;">Sources</h2>
    <div id="k-sources"></div>
  </div>

  <div id="k-empty" class="section" style="display:none;">
    <div class="empty-msg" id="k-empty-msg"></div>
  </div>
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
    var title = esc(s.title || s.snippet || 'Untitled');
    var snip = s.snippet ? '<div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5;">'+esc(s.snippet.slice(0,220))+(s.snippet.length>220?'…':'')+'</div>' : '';
    return '<div style="padding:10px 0;border-bottom:1px solid var(--line);">'+num+'<span style="font-size:13px;">'+title+'</span>'+kind+snip+'</div>';
  }).join('');
  kShow('k-sources-wrap', true);
}

function kReset(){ kShow('k-answer-wrap', false); kShow('k-sources-wrap', false); kShow('k-empty', false); }

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

bindEvents([
  ['k-ask-btn','click',ask],
  ['k-search-btn','click',searchOnly],
  ['k-mic-btn','click',function(){ startVoiceInput('k-query'); }],
]);
document.getElementById('k-query').addEventListener('keydown',function(e){
  if(e.key==='Enter' && (e.metaKey || e.ctrlKey)){ e.preventDefault(); ask(); }
});
</script>
</body></html>`);
  };
};
