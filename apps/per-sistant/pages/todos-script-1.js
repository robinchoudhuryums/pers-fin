module.exports = `
var curHorizon = '', curStatus = 'pending', curPriority = '', curCategory = '';
var dragSrcId = null;
var selectMode = false, selectedIds = new Set();

function toggleSelectMode() {
  selectMode = !selectMode;
  selectedIds.clear();
  document.getElementById('select-toggle').textContent = selectMode ? 'Cancel' : 'Select';
  document.getElementById('bulk-bar').style.display = selectMode ? 'flex' : 'none';
  document.querySelectorAll('.bulk-check').forEach(el => { el.style.display = selectMode ? 'inline-block' : 'none'; el.checked = false; });
  updateBulkCount();
}
function toggleBulkItem(id, checked) {
  if (checked) selectedIds.add(id); else selectedIds.delete(id);
  updateBulkCount();
}
function updateBulkCount() {
  document.getElementById('bulk-count').textContent = selectedIds.size + ' selected';
}
function selectAll() {
  document.querySelectorAll('.bulk-check').forEach(el => { el.checked = true; toggleBulkItem(parseInt(el.dataset.id,10), true); });
}
async function bulkAction(action, data) {
  if (!selectedIds.size) return;
  await fetch('/api/bulk/todos', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:Array.from(selectedIds),action:action,data:data||{}})});
  selectedIds.clear(); updateBulkCount(); load();
}
function setHorizon(v) { curHorizon = v; load(); }
function setStatus(v) { curStatus = v; load(); }
function setPriority(v) { curPriority = v; load(); }
function setCategory(v) { curCategory = v; load(); }

async function loadCategories() {
  try {
    var cats = await fetch('/api/todo-categories').then(r=>r.json());
    // Populate filter dropdown
    var filterSel = document.getElementById('filter-category');
    var html = '<option value="">All Categories</option>';
    cats.forEach(c => { html += '<option value="'+c+'"'+(curCategory===c?' selected':'')+'>'+c.charAt(0).toUpperCase()+c.slice(1)+'</option>'; });
    filterSel.innerHTML = html;
    // Also populate category select in modal
    var sel = document.getElementById('f-category-select');
    var curVal = sel.value;
    sel.innerHTML = '<option value="">None</option>';
    cats.forEach(c => { sel.innerHTML += '<option value="'+c+'">'+c.charAt(0).toUpperCase()+c.slice(1)+'</option>'; });
    sel.innerHTML += '<option value="__custom__">Custom...</option>';
    sel.value = curVal;
  } catch {}
}

async function load() {
  loadCategories();
  var q = [];
  if (curHorizon) q.push('horizon='+curHorizon);
  if (curStatus === 'pending') q.push('completed=false');
  else if (curStatus === 'done') q.push('completed=true');
  if (curPriority) q.push('priority='+curPriority);
  if (curCategory) q.push('category='+curCategory);
  var todos = await fetch('/api/todos'+(q.length?'?'+q.join('&'):'')).then(r=>r.json());
  if (!todos.length) { document.getElementById('todo-list').innerHTML = '<div class="empty-msg">No tasks found</div>'; return; }

  // Fetch subtasks and dependencies for all todos
  var subtaskMap = {}, depMap = {};
  await Promise.all(todos.map(async t => {
    try { subtaskMap[t.id] = await fetch('/api/todos/'+t.id+'/subtasks').then(r=>r.json()); } catch { subtaskMap[t.id] = []; }
    try { depMap[t.id] = await fetch('/api/todos/'+t.id+'/dependencies').then(r=>r.json()); } catch { depMap[t.id] = {blocked_by:[],blocking:[]}; }
  }));

  document.getElementById('todo-list').innerHTML = todos.map((t, idx) => {
    var dueTxt = t.due_date ? 'Due: '+new Date(t.due_date).toLocaleDateString() : '';
    var overdue = t.due_date && !t.completed && new Date(t.due_date) <= new Date() ? ' style="color:var(--warn)"' : '';
    var subs = subtaskMap[t.id] || [];
    var subDone = subs.filter(s=>s.completed).length;
    var subHtml = '';
    if (subs.length) {
      subHtml = '<div class="subtask-progress"><div class="subtask-progress-fill" style="width:'+(subDone/subs.length*100)+'%"></div></div>';
      subHtml += '<div class="subtask-list">'+subs.map(s =>
        '<div class="subtask-item"><div class="subtask-check'+(s.completed?' done':'')+'" data-action="toggle-subtask" data-id="'+s.id+'" data-completed="'+(!s.completed)+'"></div><span class="subtask-text'+(s.completed?' done':'')+'" data-action="edit-subtask" data-id="'+s.id+'">'+esc(s.title)+'</span><button class="subtask-edit-btn" data-action="edit-subtask-btn" data-id="'+s.id+'">&#9998;</button></div>'
      ).join('')+'</div>';
    }
    var deps = depMap[t.id] || {blocked_by:[],blocking:[]};
    var unblockedBy = deps.blocked_by.filter(d=>!d.completed);
    var isBlocked = unblockedBy.length > 0;
    var depBadges = '';
    if (isBlocked) depBadges += '<span class="badge blocked" title="Blocked by: '+unblockedBy.map(d=>esc(d.title)).join(', ')+'">blocked ('+unblockedBy.length+')</span>';
    if (deps.blocking.length) depBadges += '<span class="badge blocking" title="Blocking: '+deps.blocking.map(d=>esc(d.title)).join(', ')+'">blocking ('+deps.blocking.length+')</span>';
    if (t.streak_count > 0) depBadges += '<span class="badge streak" title="Best: '+t.best_streak+'">&#x1F525; '+t.streak_count+' streak</span>';
    if (t.location_name) depBadges += '<span title="'+esc(t.location_name)+'" style="font-size:10px;color:var(--accent);">&#128205; '+esc(t.location_name)+'</span>';
    if (t.snoozed_until) depBadges += '<span style="font-size:10px;color:var(--warn);" title="Snoozed until '+t.snoozed_until+'">&#128164; snoozed</span>';
    var recurInfo = '';
    if (t.recurring) {
      var ruleLabel = t.recurrence_rule;
      if (t.recurrence_rule && t.recurrence_rule.startsWith('custom') && t.recurrence_interval > 1) {
        var unit = t.recurrence_rule.replace('custom_','');
        ruleLabel = 'every '+t.recurrence_interval+' '+unit;
      }
      recurInfo = '<span class="badge recurring">'+ruleLabel+'</span>';
    }
    var skipSnoozeButtons = t.recurring && !t.completed ? '<button data-action="skip" data-id="'+t.id+'" title="Skip this occurrence" style="font-size:10px;padding:2px 6px;">Skip</button><button data-action="snooze" data-id="'+t.id+'" title="Snooze" style="font-size:10px;padding:2px 6px;">&#128164;</button>' : '';
    return '<div class="todo-item'+(isBlocked?' todo-blocked':'')+'" draggable="true" data-id="'+t.id+'"><input type="checkbox" class="bulk-check" data-id="'+t.id+'" style="display:'+(selectMode?'inline-block':'none')+';accent-color:var(--accent);margin-right:4px;cursor:pointer;"><span class="drag-handle">&#9776;</span><div class="todo-check'+(t.completed?' done':'')+'" data-action="toggle" data-id="'+t.id+'" data-completed="'+(!t.completed)+'" data-recurring="'+!!t.recurring+'"></div><div class="todo-content"><div class="todo-title'+(t.completed?' done':'')+'">'+esc(t.title)+'</div><div class="todo-meta"><span class="badge '+t.priority+'">'+t.priority+'</span><span class="badge '+t.horizon+'">'+t.horizon+'</span>'+recurInfo+depBadges+(t.category?'<span>'+esc(t.category)+'</span>':'')+(dueTxt?'<span'+overdue+'>'+dueTxt+'</span>':'')+(subs.length?'<span>'+subDone+'/'+subs.length+' subtasks</span>':'')+'</div>'+(t.description?'<div style="font-size:12px;color:var(--muted);margin-top:4px;font-weight:300">'+esc(t.description)+'</div>':'')+subHtml+'</div><div class="todo-actions">'+skipSnoozeButtons+'<button data-action="edit" data-id="'+t.id+'">&#9998;</button></div></div>';
  }).join('');
}

// Drag and drop (event delegation — no inline handlers)
function dragStart(e) { var item = e.target.closest('.todo-item[data-id]'); if (!item) return; dragSrcId = item.dataset.id; item.classList.add('dragging'); }
function dragOver(e) { var item = e.target.closest('.todo-item[data-id]'); if (!item) return; e.preventDefault(); item.classList.add('drag-over'); }
function dragEnd(e) { document.querySelectorAll('.todo-item').forEach(el => { el.classList.remove('dragging','drag-over'); }); }
async function drop(e) {
  var item = e.target.closest('.todo-item[data-id]'); if (!item) return;
  e.preventDefault(); item.classList.remove('drag-over');
  var targetId = item.dataset.id;
  if (dragSrcId === targetId) return;
  var items = document.querySelectorAll('.todo-item[data-id]');
  var order = [];
  items.forEach((el, i) => { order.push({id: parseInt(el.dataset.id), sort_order: i}); });
  // Swap
  var srcIdx = order.findIndex(o => o.id === parseInt(dragSrcId));
  var tgtIdx = order.findIndex(o => o.id === parseInt(targetId));
  if (srcIdx > -1 && tgtIdx > -1) {
    var temp = order[srcIdx]; order[srcIdx] = order[tgtIdx]; order[tgtIdx] = temp;
    order.forEach((o, i) => o.sort_order = i);
    await fetch('/api/todos/reorder', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order})});
    load();
  }
}

// Subtasks
async function toggleSubtask(id, completed) {
  await fetch('/api/subtasks/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({completed})});
  load();
}

var editSubtasks = [];
async function addSubtask() {
  var input = document.getElementById('new-subtask');
  var title = input.value.trim();
  if (!title) return;
  var todoId = document.getElementById('edit-id').value;
  if (todoId) {
    await fetch('/api/todos/'+todoId+'/subtasks', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})});
    input.value = '';
    loadEditSubtasks(todoId);
  } else {
    editSubtasks.push({title, completed: false});
    input.value = '';
    renderEditSubtasks();
  }
}
function renderEditSubtasks() {
  document.getElementById('subtask-list-edit').innerHTML = editSubtasks.map((s,i) =>
    '<div class="subtask-item"><span class="subtask-text" data-action="edit-new-sub" data-idx="'+i+'">'+esc(s.title)+'</span><button class="subtask-edit-btn" data-action="edit-new-sub-btn" data-idx="'+i+'" title="Edit">&#9998;</button><button data-action="remove-new-sub" data-idx="'+i+'" style="background:none;border:none;color:var(--warn);cursor:pointer;font-size:12px;padding:8px;-webkit-tap-highlight-color:transparent;touch-action:manipulation;">&#10005;</button></div>'
  ).join('');
}
async function loadEditSubtasks(todoId) {
  var subs = await fetch('/api/todos/'+todoId+'/subtasks').then(r=>r.json());
  document.getElementById('subtask-list-edit').innerHTML = subs.map(s =>
    '<div class="subtask-item"><div class="subtask-check'+(s.completed?' done':'')+'" data-action="toggle-edit-sub" data-id="'+s.id+'" data-completed="'+(!s.completed)+'" data-todo="'+todoId+'"></div><span class="subtask-text'+(s.completed?' done':'')+'" data-action="inline-edit-sub" data-id="'+s.id+'" data-todo="'+todoId+'">'+esc(s.title)+'</span><button class="subtask-edit-btn" data-action="inline-edit-sub-btn" data-id="'+s.id+'" data-todo="'+todoId+'" title="Edit">&#9998;</button><button data-action="delete-sub" data-id="'+s.id+'" data-todo="'+todoId+'" style="background:none;border:none;color:var(--warn);cursor:pointer;font-size:12px;padding:8px;-webkit-tap-highlight-color:transparent;touch-action:manipulation;">&#10005;</button></div>'
  ).join('');
}
async function deleteSubtask(id, todoId) {
  await fetch('/api/subtasks/'+id, {method:'DELETE'});
  loadEditSubtasks(todoId);
}
function inlineEditSubtask(span, id, todoId) {
  if (span.querySelector('input')) return;
  var old = span.textContent;
  var input = document.createElement('input');
  input.type = 'text'; input.value = old;
  input.style.cssText = 'font-size:12px;font-family:inherit;background:var(--paper-2);color:var(--ink);border:1px solid var(--accent);border-radius:4px;padding:2px 6px;width:100%;';
  span.textContent = '';
  span.appendChild(input);
  input.focus(); input.select();
  function save() {
    var val = input.value.trim();
    if (val && val !== old) {
      fetch('/api/subtasks/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:val})}).then(function(){ if(todoId) loadEditSubtasks(todoId); else load(); });
    } else {
      span.textContent = old;
    }
  }
  input.addEventListener('blur', save);
  input.addEventListener('keydown', function(e) { if(e.key==='Enter'){e.preventDefault();input.blur();} if(e.key==='Escape'){input.value=old;input.blur();} });
}
function inlineEditNewSubtask(span, idx) {
  if (span.querySelector('input')) return;
  var old = span.textContent;
  var input = document.createElement('input');
  input.type = 'text'; input.value = old;
  input.style.cssText = 'font-size:12px;font-family:inherit;background:var(--paper-2);color:var(--ink);border:1px solid var(--accent);border-radius:4px;padding:2px 6px;width:100%;';
  span.textContent = '';
  span.appendChild(input);
  input.focus(); input.select();
  function save() {
    var val = input.value.trim();
    if (val) { editSubtasks[idx].title = val; }
    renderEditSubtasks();
  }
  input.addEventListener('blur', save);
  input.addEventListener('keydown', function(e) { if(e.key==='Enter'){e.preventDefault();input.blur();} if(e.key==='Escape'){input.value=old;input.blur();} });
}

function openAdd() {
  document.getElementById('modal-title').textContent = 'New Task';
  document.getElementById('edit-id').value = '';
  document.getElementById('f-title').value = '';
  document.getElementById('f-desc').value = '';
  document.getElementById('f-priority').value = 'medium';
  document.getElementById('f-horizon').value = 'short';
  document.getElementById('f-category-select').value = '';
  document.getElementById('f-category-custom').style.display = 'none';
  document.getElementById('f-category-custom').value = '';
  document.getElementById('f-due').value = '';
  document.getElementById('f-recurring').checked = false;
  document.getElementById('f-recurrence').style.display = 'none';
  document.getElementById('f-recurrence-rule').value = 'weekly';
  document.getElementById('delete-btn').style.display = 'none';
  document.getElementById('save-template-btn').style.display = 'inline-block';
  document.getElementById('subtasks-section').style.display = 'block';
  document.getElementById('deps-section').style.display = 'none';
  document.getElementById('location-section').style.display = 'block';
  document.getElementById('f-location-name').value = '';
  document.getElementById('f-location-lat').value = '';
  document.getElementById('f-location-lng').value = '';
  document.getElementById('f-location-radius').value = 200;
  document.getElementById('location-status').textContent = '';
  editSubtasks = [];
  renderEditSubtasks();
  document.getElementById('modal').classList.add('active');
}

async function openEdit(id) {
  var todos = await fetch('/api/todos').then(r=>r.json());
  var t = todos.find(x=>x.id===id);
  if (!t) return;
  document.getElementById('modal-title').textContent = 'Edit Task';
  document.getElementById('edit-id').value = id;
  document.getElementById('f-title').value = t.title;
  document.getElementById('f-desc').value = t.description||'';
  document.getElementById('f-priority').value = t.priority;
  document.getElementById('f-horizon').value = t.horizon;
  var catSel = document.getElementById('f-category-select');
  var catCustom = document.getElementById('f-category-custom');
  if (t.category && ![...catSel.options].some(o=>o.value===t.category)) {
    catSel.value = '__custom__';
    catCustom.style.display = 'block';
    catCustom.value = t.category;
  } else {
    catSel.value = t.category || '';
    catCustom.style.display = 'none';
    catCustom.value = '';
  }
  document.getElementById('f-due').value = t.due_date?t.due_date.split('T')[0]:'';
  document.getElementById('f-recurring').checked = t.recurring||false;
  document.getElementById('f-recurrence').style.display = t.recurring ? 'block' : 'none';
  document.getElementById('f-recurrence-rule').value = t.recurrence_rule || 'weekly';
  document.getElementById('f-interval').value = t.recurrence_interval || 1;
  document.getElementById('f-interval-row').style.display = (t.recurrence_rule||'').startsWith('custom') ? 'flex' : 'none';
  document.getElementById('delete-btn').style.display = 'inline-block';
  document.getElementById('save-template-btn').style.display = 'inline-block';
  document.getElementById('subtasks-section').style.display = 'block';
  document.getElementById('deps-section').style.display = 'block';
  document.getElementById('location-section').style.display = 'block';
  document.getElementById('f-location-name').value = t.location_name || '';
  document.getElementById('f-location-lat').value = t.location_lat || '';
  document.getElementById('f-location-lng').value = t.location_lng || '';
  document.getElementById('f-location-radius').value = t.location_radius || 200;
  document.getElementById('location-status').textContent = t.location_lat ? 'Location: ' + t.location_lat.toFixed(4) + ', ' + t.location_lng.toFixed(4) : '';
  loadEditSubtasks(id);
  loadDeps(id);
  document.getElementById('modal').classList.add('active');
}

function closeModal() { document.getElementById('modal').classList.remove('active'); }

async function saveTodo() {
  var id = document.getElementById('edit-id').value;
  var isRecurring = document.getElementById('f-recurring').checked;
  var data = {
    title: document.getElementById('f-title').value,
    description: document.getElementById('f-desc').value || null,
    priority: document.getElementById('f-priority').value,
    horizon: document.getElementById('f-horizon').value,
    category: (document.getElementById('f-category-select').value === '__custom__' ? document.getElementById('f-category-custom').value : document.getElementById('f-category-select').value) || null,
    due_date: document.getElementById('f-due').value || null,
    recurring: isRecurring,
    recurrence_rule: isRecurring ? document.getElementById('f-recurrence-rule').value : null,
    recurrence_interval: isRecurring ? (parseInt(document.getElementById('f-interval').value) || 1) : 1,
    location_name: document.getElementById('f-location-name').value || null,
    location_lat: parseFloat(document.getElementById('f-location-lat').value) || null,
    location_lng: parseFloat(document.getElementById('f-location-lng').value) || null,
    location_radius: parseInt(document.getElementById('f-location-radius').value) || 200,
  };
  if (!data.title) return alert('Title is required');
  var result;
  if (id) {
    result = await fetch('/api/todos/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(r=>r.json());
  } else {
    result = await fetch('/api/todos', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(r=>r.json());
    // Create subtasks for new todo
    if (result.id && editSubtasks.length) {
      for (var s of editSubtasks) {
        await fetch('/api/todos/'+result.id+'/subtasks', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:s.title})});
      }
    }
  }
  closeModal(); load();
}
`;
