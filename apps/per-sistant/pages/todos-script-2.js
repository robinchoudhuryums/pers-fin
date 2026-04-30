module.exports = `

async function toggleTodo(id, completed, isRecurring) {
  if (completed && isRecurring) {
    await fetch('/api/todos/'+id+'/complete-recurring', {method:'POST'});
  } else {
    await fetch('/api/todos/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({completed})});
  }
  if (completed) showUndo('Task completed','todo',id,'complete');
  load();
}

async function skipTodo(id) {
  await fetch('/api/todos/'+id+'/skip-recurring', {method:'POST'});
  load();
}

async function snoozeTodo(id) {
  var until = prompt('Snooze until (YYYY-MM-DD):');
  if (!until) return;
  await fetch('/api/todos/'+id+'/snooze', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({until:until})});
  load();
}

async function deleteTodo() {
  var id = document.getElementById('edit-id').value;
  await fetch('/api/todos/'+id, {method:'DELETE'});
  closeModal(); load();
  showUndo('Task moved to trash','todo',id);
}

// Location
function getLocation() {
  if (!navigator.geolocation) { alert('Geolocation not supported'); return; }
  document.getElementById('location-status').textContent = 'Getting location...';
  navigator.geolocation.getCurrentPosition(function(pos) {
    document.getElementById('f-location-lat').value = pos.coords.latitude.toFixed(6);
    document.getElementById('f-location-lng').value = pos.coords.longitude.toFixed(6);
    document.getElementById('location-status').textContent = 'Location set: ' + pos.coords.latitude.toFixed(4) + ', ' + pos.coords.longitude.toFixed(4);
  }, function(err) {
    document.getElementById('location-status').textContent = 'Error: ' + err.message;
  }, {enableHighAccuracy: true});
}

// Check location reminders periodically
function checkLocationReminders() {
  if (!navigator.geolocation || !('Notification' in window) || Notification.permission !== 'granted') return;
  navigator.geolocation.getCurrentPosition(async function(pos) {
    try {
      var todos = await fetch('/api/todos?completed=false').then(r=>r.json());
      todos.filter(t => t.location_lat && t.location_lng).forEach(t => {
        var dist = haversine(pos.coords.latitude, pos.coords.longitude, t.location_lat, t.location_lng);
        if (dist <= (t.location_radius || 200)) {
          new Notification('Per-sistant Reminder', { body: t.title + (t.location_name ? ' (near ' + t.location_name + ')' : ''), icon: '/icon-192.svg' });
        }
      });
    } catch {}
  }, function(){}, {enableHighAccuracy: false, timeout: 5000});
}
function haversine(lat1, lon1, lat2, lon2) {
  var R = 6371000; var p = Math.PI / 180;
  var a = 0.5 - Math.cos((lat2-lat1)*p)/2 + Math.cos(lat1*p)*Math.cos(lat2*p)*(1-Math.cos((lon2-lon1)*p))/2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
if (typeof setInterval !== 'undefined') setInterval(checkLocationReminders, 300000); // every 5 min

// Dependencies
async function loadDeps(todoId) {
  var deps = await fetch('/api/todos/'+todoId+'/dependencies').then(r=>r.json());
  var html = '';
  if (deps.blocked_by.length) {
    html += '<div style="font-size:11px;color:var(--muted);margin-bottom:4px;">Blocked by:</div>';
    deps.blocked_by.forEach(d => {
      html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;"><span class="badge blocked">blocked by</span><span'+(d.completed?' style="text-decoration:line-through;opacity:0.5"':'')+'>'+esc(d.title)+'</span><button data-action="remove-dep" data-dep-id="'+d.dep_id+'" data-todo="'+todoId+'" style="background:none;border:none;color:var(--warn);cursor:pointer;font-size:12px;padding:4px;">&times;</button></div>';
    });
  }
  if (deps.blocking.length) {
    html += '<div style="font-size:11px;color:var(--muted);margin-bottom:4px;margin-top:6px;">Blocking:</div>';
    deps.blocking.forEach(d => {
      html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px;"><span class="badge blocking">blocking</span><span>'+esc(d.title)+'</span></div>';
    });
  }
  if (!deps.blocked_by.length && !deps.blocking.length) html = '<div style="font-size:11px;color:var(--muted);">No dependencies</div>';
  document.getElementById('deps-list').innerHTML = html;
  // Populate select with other todos
  var todos = await fetch('/api/todos?completed=false').then(r=>r.json());
  var existing = new Set(deps.blocked_by.map(d=>d.depends_on_id));
  var sel = document.getElementById('dep-select');
  sel.innerHTML = '<option value="">Select a task this depends on...</option>';
  todos.filter(t => t.id !== parseInt(todoId) && !existing.has(t.id)).forEach(t => {
    sel.innerHTML += '<option value="'+t.id+'">'+esc(t.title)+'</option>';
  });
}
async function addDep() {
  var todoId = document.getElementById('edit-id').value;
  var depId = document.getElementById('dep-select').value;
  if (!depId || !todoId) return;
  var r = await fetch('/api/todos/'+todoId+'/dependencies', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({depends_on_id:parseInt(depId)})}).then(r=>r.json());
  if (r.error) { alert(r.error); return; }
  loadDeps(todoId);
}
async function removeDep(depId, todoId) {
  await fetch('/api/dependencies/'+depId, {method:'DELETE'});
  loadDeps(todoId);
}

// Quick Add (natural language)
function openQuickTodo() {
  document.getElementById('qt-input').value = '';
  document.getElementById('qt-preview').style.display = 'none';
  document.getElementById('qt-confirm').style.display = 'none';
  document.getElementById('quick-todo-modal').classList.add('active');
  document.getElementById('qt-input').focus();
}
function closeQuickTodo() { document.getElementById('quick-todo-modal').classList.remove('active'); }

var parsedTodo = null;
function parseQuickTodo() {
  var input = document.getElementById('qt-input').value.trim();
  if (!input) return;
  var days = {sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6};
  var dateMatch = input.match(/\b(\d{4}-\d{2}-\d{2})\b/) || input.match(/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}(?:,?\s*\d{4})?)\b/i);
  var tomorrowMatch = input.match(/\btomorrow\b/i);
  var dayMatch = input.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  var dueDate = null;
  if (dateMatch) { dueDate = new Date(dateMatch[1]); }
  else if (tomorrowMatch) { dueDate = new Date(); dueDate.setDate(dueDate.getDate()+1); }
  else if (dayMatch) {
    dueDate = new Date();
    var target = days[dayMatch[1].toLowerCase()];
    var diff = (target - dueDate.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    dueDate.setDate(dueDate.getDate() + diff);
  }
  // Extract priority
  var priority = 'medium';
  if (/\burgent\b/i.test(input)) priority = 'urgent';
  else if (/\bhigh\b|\bimportant\b/i.test(input)) priority = 'high';
  else if (/\blow\b/i.test(input)) priority = 'low';
  // Clean title
  var title = input.replace(/\b(tomorrow|today|urgent|high|low|important)\b/gi, '').replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '').replace(/\b(by|on|at|next|this)\b/gi, '').replace(/\s+/g,' ').trim();
  parsedTodo = { title: title, priority: priority, due_date: dueDate ? dueDate.toISOString().split('T')[0] : null, horizon: 'short' };
  document.getElementById('qt-preview-content').innerHTML =
    '<div style="font-size:13px;"><strong>Task:</strong> '+esc(parsedTodo.title)+'<br><strong>Priority:</strong> '+parsedTodo.priority+'<br><strong>Due:</strong> '+(parsedTodo.due_date||'None')+'</div>';
  document.getElementById('qt-preview').style.display = 'block';
  document.getElementById('qt-confirm').style.display = 'inline-block';
}
async function confirmQuickTodo() {
  if (!parsedTodo || !parsedTodo.title) return;
  await fetch('/api/todos', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsedTodo)});
  closeQuickTodo(); load();
}

// AI Task Breakdown
async function aiBreakdown() {
  var title = document.getElementById('f-title').value;
  if (!title) return alert('Enter a task title first');
  var btn = document.getElementById('ai-breakdown-btn');
  btn.textContent = 'Thinking...'; btn.disabled = true;
  try {
    var r = await fetch('/api/ai/task-breakdown', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title, description: document.getElementById('f-desc').value})}).then(r=>r.json());
    if (r.error) { alert(r.error); return; }
    var todoId = document.getElementById('edit-id').value;
    if (todoId) {
      for (var s of r.subtasks) {
        await fetch('/api/todos/'+todoId+'/subtasks', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:s})});
      }
      loadEditSubtasks(todoId);
    } else {
      r.subtasks.forEach(s => editSubtasks.push({title:s, completed:false}));
      renderEditSubtasks();
    }
  } catch (err) { alert('AI breakdown failed: '+err.message); }
  finally { btn.textContent = 'AI Breakdown'; btn.disabled = false; }
}

// AI-enhanced Quick Add
var parsedTodoAI = null;
async function parseQuickTodoAI() {
  var input = document.getElementById('qt-input').value.trim();
  if (!input) return;
  var btn = document.querySelector('#quick-todo-modal .primary');
  btn.textContent = 'Parsing...'; btn.disabled = true;
  try {
    var r = await fetch('/api/ai/parse-todo', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input})}).then(r=>r.json());
    if (r.error) { parseQuickTodo(); return; } // Fallback to regex parsing
    parsedTodo = r;
    document.getElementById('qt-preview-content').innerHTML =
      '<div style="font-size:13px;"><strong>Task:</strong> '+esc(r.title)+'<br><strong>Priority:</strong> '+r.priority+'<br><strong>Horizon:</strong> '+r.horizon+'<br><strong>Category:</strong> '+(r.category||'None')+'<br><strong>Due:</strong> '+(r.due_date||'None')+'</div>';
    document.getElementById('qt-preview').style.display = 'block';
    document.getElementById('qt-confirm').style.display = 'inline-block';
  } catch { parseQuickTodo(); } // Fallback to regex
  finally { btn.textContent = 'Parse'; btn.disabled = false; }
}

// Templates
async function openTemplateList() {
  var templates = await fetch('/api/todo-templates').then(r=>r.json());
  var el = document.getElementById('template-list');
  if (!templates.length) { el.innerHTML = '<div class="empty-msg">No templates yet. Edit a task and click "Save as Template" to create one.</div>'; }
  else {
    el.innerHTML = templates.map(t => {
      var subs = t.subtasks || [];
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--line);"><div style="flex:1;"><div style="font-size:14px;font-weight:400;">'+esc(t.name)+'</div><div style="font-size:11px;color:var(--muted);margin-top:2px;">'+esc(t.title)+' &middot; <span class="badge '+t.priority+'">'+t.priority+'</span> &middot; '+t.horizon+(subs.length?' &middot; '+subs.length+' subtasks':'')+'</div></div><div style="display:flex;gap:6px;"><button data-action="apply-template" data-id="'+t.id+'" class="btn primary">Use</button><button data-action="delete-template" data-id="'+t.id+'" class="btn danger">&#10005;</button></div></div>';
    }).join('');
  }
  document.getElementById('template-modal').classList.add('active');
}
function closeTemplateList() { document.getElementById('template-modal').classList.remove('active'); }
async function applyTemplate(id) {
  await fetch('/api/todo-templates/'+id+'/apply', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
  closeTemplateList();
  load();
}
async function deleteTemplate(id) {
  await fetch('/api/todo-templates/'+id, {method:'DELETE'});
  openTemplateList();
}
async function saveAsTemplate() {
  var name = prompt('Template name:');
  if (!name) return;
  var isRecurring = document.getElementById('f-recurring').checked;
  var data = {
    name: name,
    title: document.getElementById('f-title').value,
    description: document.getElementById('f-desc').value || null,
    priority: document.getElementById('f-priority').value,
    horizon: document.getElementById('f-horizon').value,
    category: (document.getElementById('f-category-select').value === '__custom__' ? document.getElementById('f-category-custom').value : document.getElementById('f-category-select').value) || null,
    recurring: isRecurring,
    recurrence_rule: isRecurring ? document.getElementById('f-recurrence-rule').value : null,
    recurrence_interval: isRecurring ? parseInt(document.getElementById('f-interval').value) || 1 : 1,
    subtasks: editSubtasks.map(s => s.title),
  };
  // If editing existing, get subtasks from the server
  var todoId = document.getElementById('edit-id').value;
  if (todoId) {
    try {
      var subs = await fetch('/api/todos/'+todoId+'/subtasks').then(r=>r.json());
      data.subtasks = subs.map(s => s.title);
    } catch {}
  }
  await fetch('/api/todo-templates', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  alert('Template saved!');
}

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openAdd(); }
  else if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); openQuickTodo(); }
});


bindEvents([
  ['add-task-btn','click',openAdd],
  ['quick-add-btn','click',openQuickTodo],
  ['template-btn','click',openTemplateList],
  ['select-toggle','click',toggleSelectMode],
  ['bulk-complete-btn','click',function(){bulkAction('complete');}],
  ['bulk-delete-btn','click',function(){bulkAction('delete');}],
  ['select-all-btn','click',selectAll],
  ['ai-breakdown-btn','click',aiBreakdown],
  ['add-subtask-btn','click',addSubtask],
  ['get-location-btn','click',getLocation],
  ['add-dep-btn','click',addDep],
  ['cancel-modal-btn','click',closeModal],
  ['modal-close-x','click',closeModal],
  ['save-todo-btn','click',saveTodo],
  ['save-template-btn','click',saveAsTemplate],
  ['delete-btn','click',deleteTodo],
  ['close-template-btn','click',closeTemplateList],
  ['qt-voice-btn','click',function(){startVoiceInput('qt-input');}],
  ['qt-cancel-btn','click',closeQuickTodo],
  ['qt-parse-btn','click',parseQuickTodoAI],
  ['qt-confirm','click',confirmQuickTodo],
]);
document.getElementById('bulk-priority').addEventListener('change',function(){if(this.value){bulkAction('set_priority',{priority:this.value});this.value='';}});
document.getElementById('f-category-select').addEventListener('change',function(){if(this.value==='__custom__'){document.getElementById('f-category-custom').style.display='block';document.getElementById('f-category-custom').focus();}else{document.getElementById('f-category-custom').style.display='none';}});
document.getElementById('f-recurring').addEventListener('change',function(){document.getElementById('f-recurrence').style.display=this.checked?'block':'none';});
document.getElementById('f-recurrence-rule').addEventListener('change',function(){document.getElementById('f-interval-row').style.display=this.value.startsWith('custom')?'flex':'none';});
document.getElementById('qt-input').addEventListener('keydown',function(e){if(e.key==='Enter')parseQuickTodo();});
document.getElementById('filter-horizon').addEventListener('change',function(){setHorizon(this.value);});
document.getElementById('filter-status').addEventListener('change',function(){setStatus(this.value);});
document.getElementById('filter-priority').addEventListener('change',function(){setPriority(this.value);});
document.getElementById('filter-category').addEventListener('change',function(){setCategory(this.value);});
document.addEventListener('click',function(e){
  var btn=e.target.closest('[data-action]');
  if(!btn)return;
  var id=parseInt(btn.dataset.id),act=btn.dataset.action;
  e.stopPropagation();
  if(act==='toggle')toggleTodo(id,btn.dataset.completed==='true',btn.dataset.recurring==='true');
  else if(act==='edit')openEdit(id);
  else if(act==='skip')skipTodo(id);
  else if(act==='snooze')snoozeTodo(id);
  else if(act==='toggle-subtask'){toggleSubtask(id,btn.dataset.completed==='true');}
  else if(act==='edit-subtask'||act==='edit-subtask-btn'){inlineEditSubtask(act==='edit-subtask-btn'?btn.previousElementSibling:btn,id);}
  else if(act==='toggle-edit-sub'){toggleSubtask(id,btn.dataset.completed==='true');loadEditSubtasks(parseInt(btn.dataset.todo));}
  else if(act==='inline-edit-sub'||act==='inline-edit-sub-btn'){inlineEditSubtask(act==='inline-edit-sub-btn'?btn.previousElementSibling:btn,id,parseInt(btn.dataset.todo));}
  else if(act==='delete-sub')deleteSubtask(id,parseInt(btn.dataset.todo));
  else if(act==='edit-new-sub'||act==='edit-new-sub-btn'){inlineEditNewSubtask(act==='edit-new-sub-btn'?btn.previousElementSibling:btn,parseInt(btn.dataset.idx));}
  else if(act==='remove-new-sub'){editSubtasks.splice(parseInt(btn.dataset.idx),1);renderEditSubtasks();}
  else if(act==='remove-dep')removeDep(parseInt(btn.dataset.depId),parseInt(btn.dataset.todo));
  else if(act==='apply-template')applyTemplate(id);
  else if(act==='delete-template')deleteTemplate(id);
});
document.addEventListener('change',function(e){
  if(e.target.classList.contains('bulk-check'))toggleBulkItem(parseInt(e.target.dataset.id),e.target.checked);
});
// Drag-and-drop via event delegation (CSP-safe — no inline handlers)
document.addEventListener('dragstart',function(e){var item=e.target.closest('.todo-item[data-id]');if(item)dragStart(e);});
document.addEventListener('dragover',function(e){var item=e.target.closest('.todo-item[data-id]');if(item)dragOver(e);});
document.addEventListener('drop',function(e){var item=e.target.closest('.todo-item[data-id]');if(item)drop(e);});
document.addEventListener('dragend',function(e){dragEnd(e);});
document.addEventListener('dragleave',function(e){var item=e.target.closest('.todo-item[data-id]');if(item)item.classList.remove('drag-over');});

load();
`;
