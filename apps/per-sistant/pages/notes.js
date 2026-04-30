const { pageHead, navBar, themeScript } = require("../views");

module.exports = function() {
  return (req, res) => {
  res.send(`${pageHead("Notes")}
<body>
${themeScript()}
${navBar("/notes")}
<div class="container">
  <h1>Notes</h1>
  <p class="subtitle">Quick notes and reminders.</p>

  <div class="actions">
    <button class="btn primary" id="new-note-btn">+ New Note</button>
    <button class="btn" id="note-select-toggle">Select</button>
  </div>
  <div id="note-bulk-bar" style="display:none;padding:10px 16px;margin-bottom:12px;background:var(--paper-2);border:1px solid var(--line);border-radius:var(--radius);align-items:center;gap:8px;font-size:13px;">
    <span id="note-bulk-count">0 selected</span>
    <button class="btn danger" id="note-bulk-del-btn">Delete</button>
    <button class="btn" id="note-select-all-btn" style="margin-left:auto;">Select All</button>
  </div>

  <div class="notes-grid" id="notes-grid"></div>
</div>

<!-- Note Modal -->
<div class="modal-overlay" id="note-modal">
  <div class="modal">
    <h2 id="note-modal-title">New Note</h2>
    <input type="hidden" id="n-id">
    <label>Title</label>
    <input type="text" id="n-title" placeholder="Optional title">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:4px;">
      <label style="margin:0;">Content</label>
      <label style="display:inline;cursor:pointer;font-size:11px;margin:0;">
        <input type="checkbox" id="n-markdown" style="width:auto;margin-right:4px;"> Markdown
      </label>
      <button class="btn" id="n-preview-btn" style="display:none;">Preview</button>
    </div>
    <div style="position:relative;">
      <textarea id="n-content" style="min-height:200px" placeholder="Write your note... (supports **bold**, *italic*, - lists, > quotes, [links](url))"></textarea>
      <button id="note-voice-btn" title="Voice input" style="position:absolute;top:10px;right:10px;padding:6px 10px;font-size:14px;border:1px solid var(--line);border-radius:2px;cursor:pointer;background:var(--paper-card);color:var(--accent);z-index:1;">&#127908;</button>
    </div>
    <div id="n-md-preview" style="display:none;min-height:100px;max-height:300px;overflow-y:auto;padding:12px 16px;background:var(--paper-card);border:1px solid var(--line);border-radius:var(--radius);font-size:13px;line-height:1.6;margin-bottom:12px;"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div><label>Color</label>
        <select id="n-color"><option value="default">Default</option><option value="warm">Warm</option><option value="teal">Teal</option><option value="green">Green</option><option value="blue">Blue</option></select>
      </div>
      <div><label>Reminder</label>
        <input type="datetime-local" id="n-reminder"></div>
    </div>
    <div style="margin-top:12px;">
      <label style="display:inline;cursor:pointer">
        <input type="checkbox" id="n-pinned" style="width:auto;margin-right:6px;"> Pin to top
      </label>
    </div>
    <div style="margin-top:12px;">
      <label>Tags <button class="btn" id="suggest-tags-btn" style="float:right;">AI Suggest</button></label>
      <div id="n-tags-list" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;"></div>
      <div style="display:flex;gap:8px;">
        <input type="text" id="n-tag-input" placeholder="Add tag..." style="flex:1">
        <button class="btn primary" id="add-tag-btn">Add</button>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="close-note-btn">Cancel</button>
      <button class="btn primary" id="save-note-btn">Save</button>
      <button class="btn danger" id="n-delete-btn" style="display:none">Delete</button>
    </div>
  </div>
</div>

<script>
var colorMap = {warm:'var(--accent)',teal:'var(--accent)',green:'var(--good)',blue:'var(--accent)',default:'var(--line)'};
var currentTags = [];
var noteSelectMode = false, noteSelectedIds = new Set();
function toggleNoteSelect() {
  noteSelectMode = !noteSelectMode; noteSelectedIds.clear();
  document.getElementById('note-select-toggle').textContent = noteSelectMode ? 'Cancel' : 'Select';
  document.getElementById('note-bulk-bar').style.display = noteSelectMode ? 'flex' : 'none';
  document.querySelectorAll('.note-bulk-check').forEach(el => { el.style.display = noteSelectMode ? 'block' : 'none'; el.checked = false; });
  updateNoteBulkCount();
}
function toggleNoteBulkItem(id, checked, ev) { ev.stopPropagation(); if (checked) noteSelectedIds.add(id); else noteSelectedIds.delete(id); updateNoteBulkCount(); }
function updateNoteBulkCount() { document.getElementById('note-bulk-count').textContent = noteSelectedIds.size + ' selected'; }
function noteSelectAll() { document.querySelectorAll('.note-bulk-check').forEach(el => { el.checked = true; toggleNoteBulkItem(parseInt(el.dataset.id,10), true, {stopPropagation:function(){}}); }); }
async function noteBulkAction(action) {
  if (!noteSelectedIds.size) return;
  await fetch('/api/bulk/notes', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:Array.from(noteSelectedIds),action:action})});
  noteSelectedIds.clear(); updateNoteBulkCount(); load();
}

function renderTags() {
  document.getElementById('n-tags-list').innerHTML = currentTags.map((t,i) =>
    '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:2px;font-family:var(--mono);font-size:10px;font-weight:500;background:var(--paper-2);border:1px solid var(--line);color:var(--muted);letter-spacing:0.04em;">'+esc(t)+'<span data-action="remove-tag" data-idx="'+i+'" style="cursor:pointer;color:var(--warn);font-size:12px;">&times;</span></span>'
  ).join('');
}
function addTag() {
  var input = document.getElementById('n-tag-input');
  var tag = input.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (tag && !currentTags.includes(tag)) { currentTags.push(tag); renderTags(); }
  input.value = '';
}
function removeTag(i) { currentTags.splice(i, 1); renderTags(); }

async function suggestTags() {
  var content = document.getElementById('n-content').value;
  var title = document.getElementById('n-title').value;
  if (!content) return alert('Write some content first');
  var btn = document.getElementById('suggest-tags-btn');
  btn.textContent = 'Thinking...'; btn.disabled = true;
  try {
    var r = await fetch('/api/ai/suggest-tags', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title, content})}).then(r=>r.json());
    if (r.error) { alert(r.error); return; }
    r.tags.forEach(t => { if (!currentTags.includes(t)) currentTags.push(t); });
    renderTags();
  } catch (err) { alert('Failed: '+err.message); }
  finally { btn.textContent = 'AI Suggest'; btn.disabled = false; }
}

async function load() {
  var notes = await fetch('/api/notes').then(r=>r.json());
  if (!notes.length) { document.getElementById('notes-grid').innerHTML = '<div class="empty-msg" style="grid-column:1/-1">No notes yet. Create your first note!</div>'; return; }
  document.getElementById('notes-grid').innerHTML = notes.map(n => {
    var borderStyle = n.pinned ? 'border-left-color:'+(colorMap[n.color]||'var(--accent)') : (n.color!=='default'?'border-left:2px solid '+colorMap[n.color]:'');
    var tagsHtml = n.tags && n.tags.length ? '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px;">'+n.tags.map(t=>'<span style="padding:2px 8px;border-radius:2px;font-family:var(--mono);font-size:9px;background:var(--paper-2);border:1px solid var(--line);color:var(--muted);letter-spacing:0.04em;">'+esc(t)+'</span>').join('')+'</div>' : '';
    return '<div class="note-card'+(n.pinned?' pinned':'')+'" style="position:relative;'+borderStyle+'" data-action="open-note" data-id="'+n.id+'">'+
      '<input type="checkbox" class="note-bulk-check" data-id="'+n.id+'" style="display:'+(noteSelectMode?'block':'none')+';position:absolute;top:10px;right:10px;accent-color:var(--accent);cursor:pointer;z-index:2;">'+
      (n.pinned?'<div style="font-family:var(--mono);font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:0.12em;margin-bottom:6px;">&#128204; Pinned</div>':'')+
      (n.title?'<div class="note-title">'+esc(n.title)+(n.format==='markdown'?'<span class="md-badge">MD</span>':'')+'</div>':(!n.title && n.format==='markdown'?'<div style="margin-bottom:4px;"><span class="md-badge">MD</span></div>':''))+
      '<div class="note-preview'+(n.format==='markdown'?' md':'')+'">'+(n.format==='markdown'?renderMd(n.content):esc(n.content))+'</div>'+
      tagsHtml+
      '<div class="note-date">'+new Date(n.updated_at).toLocaleDateString()+
      (n.reminder_at?' &bull; Reminder: '+new Date(n.reminder_at).toLocaleString():'')+
      '</div></div>';
  }).join('');
}

function toggleMdPreview() {
  var isMd = document.getElementById('n-markdown').checked;
  var previewBtn = document.getElementById('n-preview-btn');
  var previewEl = document.getElementById('n-md-preview');
  previewBtn.style.display = isMd ? 'inline-flex' : 'none';
  if (isMd && previewEl.style.display !== 'none') {
    previewEl.innerHTML = renderMd(document.getElementById('n-content').value);
  } else if (!isMd) {
    previewEl.style.display = 'none';
  }
  if (isMd && previewBtn.textContent === 'Preview') {
    previewEl.style.display = 'block';
    previewEl.innerHTML = renderMd(document.getElementById('n-content').value);
    previewBtn.textContent = 'Edit';
  } else if (previewBtn.textContent === 'Edit') {
    previewEl.style.display = 'none';
    previewBtn.textContent = 'Preview';
  }
}

function openNote() {
  document.getElementById('note-modal-title').textContent = 'New Note';
  document.getElementById('n-id').value = '';
  document.getElementById('n-title').value = '';
  document.getElementById('n-content').value = '';
  document.getElementById('n-color').value = 'default';
  document.getElementById('n-reminder').value = '';
  document.getElementById('n-pinned').checked = false;
  document.getElementById('n-markdown').checked = false;
  document.getElementById('n-preview-btn').style.display = 'none';
  document.getElementById('n-md-preview').style.display = 'none';
  document.getElementById('n-delete-btn').style.display = 'none';
  currentTags = []; renderTags();
  document.getElementById('note-modal').classList.add('active');
}

async function openEditNote(id) {
  var notes = await fetch('/api/notes').then(r=>r.json());
  var n = notes.find(x=>x.id===id);
  if (!n) return;
  document.getElementById('note-modal-title').textContent = 'Edit Note';
  document.getElementById('n-id').value = id;
  document.getElementById('n-title').value = n.title||'';
  document.getElementById('n-content').value = n.content;
  document.getElementById('n-color').value = n.color||'default';
  document.getElementById('n-reminder').value = n.reminder_at?n.reminder_at.slice(0,16):'';
  document.getElementById('n-pinned').checked = n.pinned;
  document.getElementById('n-markdown').checked = n.format === 'markdown';
  document.getElementById('n-preview-btn').style.display = n.format === 'markdown' ? 'inline-flex' : 'none';
  document.getElementById('n-preview-btn').textContent = 'Preview';
  document.getElementById('n-md-preview').style.display = 'none';
  document.getElementById('n-delete-btn').style.display = 'inline-flex';
  currentTags = n.tags || []; renderTags();
  document.getElementById('note-modal').classList.add('active');
}

function closeNote() { document.getElementById('note-modal').classList.remove('active'); }

async function saveNote() {
  var data = {
    title: document.getElementById('n-title').value || null,
    content: document.getElementById('n-content').value,
    color: document.getElementById('n-color').value,
    pinned: document.getElementById('n-pinned').checked,
    reminder_at: document.getElementById('n-reminder').value ? new Date(document.getElementById('n-reminder').value).toISOString() : null,
    tags: currentTags.length ? currentTags : null,
    format: document.getElementById('n-markdown').checked ? 'markdown' : 'plain',
  };
  if (!data.content) return alert('Content is required');
  var id = document.getElementById('n-id').value;
  if (id) await fetch('/api/notes/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  else await fetch('/api/notes', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  closeNote(); load();
}

async function deleteNote() {
  var id = document.getElementById('n-id').value;
  await fetch('/api/notes/'+id, {method:'DELETE'});
  closeNote(); load();
  showUndo('Note moved to trash','note',id);
}


load();
bindEvents([
  ['new-note-btn','click',openNote],
  ['note-select-toggle','click',toggleNoteSelect],
  ['note-bulk-del-btn','click',function(){noteBulkAction('delete');}],
  ['note-select-all-btn','click',noteSelectAll],
  ['n-markdown','change',toggleMdPreview],
  ['n-preview-btn','click',toggleMdPreview],
  ['note-voice-btn','click',function(){startVoiceInput('n-content');}],
  ['suggest-tags-btn','click',suggestTags],
  ['add-tag-btn','click',addTag],
  ['close-note-btn','click',closeNote],
  ['save-note-btn','click',saveNote],
  ['n-delete-btn','click',deleteNote],
]);
document.getElementById('n-tag-input').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();addTag();}});
document.addEventListener('click',function(e){
  var btn=e.target.closest('[data-action]');
  if(!btn)return;
  var act=btn.dataset.action,id=parseInt(btn.dataset.id);
  if(act==='open-note'){openEditNote(id);}
  else if(act==='remove-tag'){removeTag(parseInt(btn.dataset.idx));}
});
document.addEventListener('change',function(e){
  if(e.target.classList.contains('note-bulk-check')){e.stopPropagation();toggleNoteBulkItem(parseInt(e.target.dataset.id),e.target.checked,{stopPropagation:function(){}});}
});
</script>
</body></html>`);
  };
};
