// ============================================================================
// Per-sistant — Dashboard client-side script
// ============================================================================
// Extracted from pages/dashboard.js so the big JS blob can be pushed
// independently of the HTML shell. Exports a template string injected
// inside <script> tags at page-render time.
//
// Tree/dragon/work-mode removed (warm-paper refresh); legacy --warm/--teal/
// --red/--blue/--green tokens swapped to --accent/--good/--warn.
module.exports = `
var searchTimeout = null;
function doSearch(q) {
  clearTimeout(searchTimeout);
  if (!q || q.length < 2) { document.getElementById('search-results').style.display='none'; return; }
  searchTimeout = setTimeout(async function() {
    var results = await fetch('/api/search?q='+encodeURIComponent(q)).then(r=>r.json());
    if (!results.length) { document.getElementById('search-results').innerHTML='<div class="empty-msg">No results</div>'; }
    else {
      document.getElementById('search-results').innerHTML = results.map(r => {
        var href = r.type==='todo'?'/todos':r.type==='email'?'/emails':r.type==='note'?'/notes':'/contacts';
        var actions = '';
        if (r.type === 'todo' && !r.completed) {
          actions = '<div style="display:flex;gap:6px;margin-top:6px;"><button data-action="search-complete" data-id="'+r.id+'" data-recurring="'+!!r.recurring+'" class="btn">Complete</button></div>';
        } else if (r.type === 'email' && r.status === 'scheduled') {
          actions = '<div style="display:flex;gap:6px;margin-top:6px;"><button data-action="search-send" data-id="'+r.id+'" class="btn primary">Send Now</button></div>';
        } else if (r.type === 'note') {
          actions = '<div style="display:flex;gap:6px;margin-top:6px;"><button data-action="search-pin" data-id="'+r.id+'" data-pinned="'+!!r.pinned+'" class="btn">'+(r.pinned?'Unpin':'Pin')+'</button></div>';
        }
        return '<a href="'+href+'" class="result-item" style="display:block;text-decoration:none;color:inherit;"><div class="result-type">'+r.type+(r.type==='todo'&&r.completed?' (done)':'')+'</div><div style="font-size:14px;">'+esc(r.title||'')+'</div>'+(r.description?'<div style="font-size:11px;color:var(--muted);margin-top:2px;">'+esc(r.description)+'</div>':'')+actions+'</a>';
      }).join('');
    }
    document.getElementById('search-results').style.display='block';
  }, 300);
}

var dashView = 'all';
var allTodos = [];
function setDashView(btn, v) { dashView = v; document.querySelectorAll('#dash-task-filters button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); renderDashTasks(); }

function renderDashTasks() {
  var container = document.getElementById('dash-tasks');
  if (!allTodos.length) { container.innerHTML = '<div class="empty-msg">No pending tasks</div>'; return; }
  var html = '';
  if (dashView === 'category') {
    var cats = {};
    allTodos.forEach(t => { var c = t.category || 'Uncategorized'; if (!cats[c]) cats[c] = []; cats[c].push(t); });
    Object.keys(cats).sort().forEach(c => {
      html += '<div style="margin-bottom:16px;"><div class="mono-label" style="margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--line);">'+esc(c)+' ('+cats[c].length+')</div>';
      cats[c].slice(0,5).forEach(t => { html += renderDashTodo(t); });
      if (cats[c].length > 5) html += '<div style="font-family:var(--mono);font-size:10px;color:var(--muted);padding:4px 0;letter-spacing:0.04em;">+'+(cats[c].length-5)+' more</div>';
      html += '</div>';
    });
  } else if (dashView === 'urgency') {
    ['urgent','high','medium','low'].forEach(p => {
      var items = allTodos.filter(t=>t.priority===p);
      if (!items.length) return;
      html += '<div style="margin-bottom:16px;"><div class="mono-label" style="margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--line);">'+p+' ('+items.length+')</div>';
      items.slice(0,5).forEach(t => { html += renderDashTodo(t); });
      if (items.length > 5) html += '<div style="font-family:var(--mono);font-size:10px;color:var(--muted);padding:4px 0;letter-spacing:0.04em;">+'+(items.length-5)+' more</div>';
      html += '</div>';
    });
  } else if (dashView === 'due') {
    var withDue = allTodos.filter(t=>t.due_date).sort((a,b)=>new Date(a.due_date)-new Date(b.due_date));
    if (!withDue.length) { container.innerHTML = '<div class="empty-msg">No tasks with due dates</div>'; return; }
    withDue.slice(0,10).forEach(t => { html += renderDashTodo(t); });
  } else {
    allTodos.slice(0,10).forEach(t => { html += renderDashTodo(t); });
    if (allTodos.length > 10) html += '<div style="font-size:11px;color:var(--muted);padding:8px 0;text-align:center;"><a href="/todos">View all '+allTodos.length+' tasks &rarr;</a></div>';
  }
  container.innerHTML = html;
}

function renderDashTodo(t) {
  var overdue = t.due_date && new Date(t.due_date) <= new Date() ? ' style="color:var(--warn)"' : '';
  var completeBtn = t.recurring
    ? '<button data-action="dash-complete-recurring" data-id="'+t.id+'" title="Complete & create next" style="background:none;border:1px solid var(--good);color:var(--good);width:22px;height:22px;border-radius:2px;cursor:pointer;font-size:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;">&#10003;</button>'
    : '<button data-action="dash-complete" data-id="'+t.id+'" title="Mark complete" style="background:none;border:1px solid var(--good);color:var(--good);width:22px;height:22px;border-radius:2px;cursor:pointer;font-size:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;">&#10003;</button>';
  var streakBadge = t.recurring && t.streak_count > 0 ? '<span class="badge streak">&#x1F525; '+t.streak_count+'</span>' : '';
  return '<div class="todo-item" style="display:flex;align-items:center;gap:10px;">'+completeBtn+'<div class="todo-content" style="flex:1;"><div class="todo-title">'+esc(t.title)+'</div><div class="todo-meta"><span class="badge '+t.priority+'">'+t.priority+'</span>'+(t.category?'<span>'+esc(t.category)+'</span>':'')+(t.due_date?'<span'+overdue+'>Due: '+new Date(t.due_date).toLocaleDateString()+'</span>':'')+(t.recurring?'<span class="badge recurring">recurring</span>':'')+streakBadge+'</div></div></div>';
}

async function dashComplete(id) {
  await fetch('/api/todos/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({completed:true})});
  allTodos = allTodos.filter(t=>t.id!==id);
  renderDashTasks();
  showUndo('Task completed','todo',id,'complete');
}

async function dashCompleteRecurring(id) {
  await fetch('/api/todos/'+id+'/complete-recurring', {method:'POST'});
  allTodos = await fetch('/api/todos?completed=false&limit=50').then(r=>r.json());
  renderDashTasks();
}

async function dashSendEmail(id) {
  var r = await fetch('/api/emails/'+id+'/send', {method:'POST'}).then(r=>r.json());
  if (r.ok) { showUndo('Email sent','email',id,'send'); load(); } else { alert('Failed: '+(r.error||'Unknown error')); }
}

async function searchComplete(id, isRecurring) {
  if (isRecurring) await fetch('/api/todos/'+id+'/complete-recurring', {method:'POST'});
  else await fetch('/api/todos/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({completed:true})});
  showUndo('Task completed','todo',id,'complete');
  document.getElementById('search-results').style.display='none';
  document.getElementById('global-search').value='';
  load();
}
async function searchSendEmail(id) {
  var r = await fetch('/api/emails/'+id+'/send', {method:'POST'}).then(r=>r.json());
  if (r.ok) { showUndo('Email sent','email',id,'send'); }
  document.getElementById('search-results').style.display='none';
  document.getElementById('global-search').value='';
  load();
}
async function searchTogglePin(id, pinned) {
  await fetch('/api/notes/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({pinned:pinned})});
  document.getElementById('search-results').style.display='none';
  document.getElementById('global-search').value='';
  load();
}

async function load() {
  const stats = await fetch('/api/stats').then(r=>r.json());
  document.getElementById('cards').innerHTML = [
    {label:'Pending Tasks',value:stats.todos.pending,cls:'warm'},
    {label:'Urgent',value:stats.todos.urgent,cls:'red'},
    {label:'Overdue',value:stats.todos.overdue,cls:stats.todos.overdue > 0 ? 'red' : 'green'},
    {label:'Completed',value:stats.todos.done,cls:'green'},
    {label:'Email Drafts',value:stats.emails.drafts,cls:'teal'},
    {label:'Scheduled',value:stats.emails.scheduled,cls:'warm'},
    {label:'Emails Sent',value:stats.emails.sent,cls:'green'},
    {label:'Notes',value:stats.notes.total,cls:'teal'},
  ].map(c => '<div class="card"><div class="label">'+c.label+'</div><div class="value '+c.cls+'">'+c.value+'</div></div>').join('');

  renderMiniCal();

  allTodos = await fetch('/api/todos?completed=false&limit=50').then(r=>r.json());
  renderDashTasks();

  const upcoming = allTodos.filter(t=>t.due_date).sort((a,b)=>new Date(a.due_date)-new Date(b.due_date)).slice(0,5);
  document.getElementById('upcoming-tasks').innerHTML = upcoming.length
    ? upcoming.map(t => '<div class="todo-item"><div class="todo-content"><div class="todo-title">'+esc(t.title)+'</div><div class="todo-meta"><span class="badge '+t.priority+'">'+t.priority+'</span>'+(t.recurring?'<span class="badge recurring">recurring</span>':'')+'<span>Due: '+new Date(t.due_date).toLocaleDateString()+'</span></div></div></div>').join('')
    : '<div class="empty-msg">No upcoming tasks with due dates</div>';

  const emails = await fetch('/api/emails?status=scheduled').then(r=>r.json());
  document.getElementById('scheduled-emails').innerHTML = emails.length
    ? emails.slice(0,5).map(e => '<div class="todo-item" style="display:flex;align-items:center;gap:10px;"><button data-action="dash-send-email" data-id="'+e.id+'" title="Send now" class="btn primary">Send</button><div class="todo-content" style="flex:1;"><div class="todo-title">'+esc(e.subject)+'</div><div class="todo-meta"><span>To: '+esc(e.recipient_name||e.recipient_email)+'</span><span>'+new Date(e.scheduled_at).toLocaleString()+'</span></div></div></div>').join('')
    : '<div class="empty-msg">No scheduled emails</div>';

  try {
    var perfin = await fetch('/api/perfin/stats').then(r=>r.json());
    if (perfin.connected) {
      document.getElementById('perfin-section').style.display='block';
      var html = '<div class="top-cards" style="margin-bottom:0">';
      html += '<div class="card"><div class="label">Active Subscriptions</div><div class="value teal">'+perfin.total_subscriptions+'</div></div>';
      html += '<div class="card"><div class="label">Monthly Cost</div><div class="value warm">$'+perfin.monthly_cost+'</div></div>';
      html += '<div class="card"><div class="label">Renewing This Week</div><div class="value '+(perfin.upcoming_this_week>0?'red':'green')+'">'+perfin.upcoming_this_week+'</div></div>';
      html += '</div>';
      if (perfin.upcoming && perfin.upcoming.length) {
        html += '<div style="margin-top:16px;">';
        perfin.upcoming.forEach(s => {
          html += '<div class="todo-item"><div class="todo-content"><div class="todo-title">'+esc(s.display_name||s.merchant_key)+'</div><div class="todo-meta"><span>$'+parseFloat(s.amount).toFixed(2)+'</span><span>Due: '+new Date(s.next_expected).toLocaleDateString()+'</span></div></div></div>';
        });
        html += '</div>';
      }
      document.getElementById('perfin-data').innerHTML = html;
    }
  } catch {}

  fetch('/api/notifications/check').then(r=>r.json()).then(d => {
    if (d.notifications && d.notifications.length && 'Notification' in window && Notification.permission === 'granted') {
      var important = d.notifications.filter(n => n.type === 'overdue' || n.type === 'streak_at_risk');
      important.slice(0,3).forEach(n => {
        new Notification('Per-sistant', { body: (n.type==='overdue'?'Overdue: ':'Streak at risk: ')+n.title, icon: '/icon-192.svg' });
      });
    }
  }).catch(function(){});

  fetch('/api/ai/daily-briefing').then(r=>r.json()).then(d => {
    if (d.briefing) {
      document.getElementById('briefing-content').textContent = d.briefing;
      document.getElementById('briefing-section').style.display = 'block';
    }
  }).catch(function(){});

  fetch('/api/ai/smart-suggestions').then(r=>r.json()).then(d => {
    if (d.suggestions && d.suggestions.length) {
      document.getElementById('suggestions-content').innerHTML = d.suggestions.map(s =>
        '<div style="padding:10px 0;border-bottom:1px solid var(--line);font-size:13px;line-height:1.55;color:var(--ink);">'+
        '<span style="color:var(--accent);margin-right:8px;">&#9733;</span>'+esc(s.suggestion)+'</div>'
      ).join('');
      document.getElementById('suggestions-section').style.display = 'block';
    }
  }).catch(function(){});
}

async function askAI() {
  var input = document.getElementById('ai-query-input');
  var q = input.value.trim();
  if (!q) return;
  var answerEl = document.getElementById('ai-query-answer');
  answerEl.textContent = 'Thinking...';
  answerEl.style.display = 'block';
  try {
    var r = await fetch('/api/ai/query', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q})}).then(r=>r.json());
    answerEl.textContent = r.answer || 'No answer available.';
  } catch (err) { answerEl.textContent = 'Error: '+err.message; }
}

// Widget customization
var widgetNames = {search:'Search',cards:'Stats Cards',briefing:'AI Briefing',suggestions:'Smart Suggestions',ai_query:'Ask AI',tasks:'Task Overview',upcoming_emails:'Upcoming & Emails',mini_cal:'Mini Calendar',perfin:'Perfin',shortcuts:'Shortcuts'};
var dashLayout = {widgets:['search','cards','briefing','suggestions','ai_query','tasks','upcoming_emails','mini_cal','perfin','shortcuts'],hidden:[]};
var wdragSrcWidget = null;

async function loadLayout() {
  try {
    var settings = await fetch('/api/settings').then(r=>r.json());
    if (settings.dashboard_layout) {
      dashLayout = settings.dashboard_layout;
      // Drop any retired widgets (tree) from saved layout
      dashLayout.widgets = dashLayout.widgets.filter(function(id){ return id !== 'tree'; });
      dashLayout.hidden = (dashLayout.hidden || []).filter(function(id){ return id !== 'tree'; });
      var allWidgetIds = Array.from(document.querySelectorAll('.dash-widget')).map(function(w){return w.dataset.widget;});
      allWidgetIds.forEach(function(id) {
        if (dashLayout.widgets.indexOf(id) === -1) dashLayout.widgets.push(id);
      });
    }
  } catch {}
  applyLayout();
}

function applyLayout() {
  var container = document.getElementById('dash-widgets');
  var widgets = container.querySelectorAll('.dash-widget');
  var map = {};
  widgets.forEach(w => { map[w.dataset.widget] = w; });
  dashLayout.widgets.forEach(id => { if (map[id]) container.appendChild(map[id]); });
  widgets.forEach(w => {
    w.style.display = dashLayout.hidden.includes(w.dataset.widget) ? 'none' : 'block';
  });
  renderToggles();
}

function renderToggles() {
  var html = '';
  dashLayout.widgets.forEach(id => {
    var hidden = dashLayout.hidden.includes(id);
    html += '<button data-toggle-widget="'+id+'" class="btn'+(hidden?'':' primary')+'">'+(widgetNames[id]||id)+'</button>';
  });
  document.getElementById('widget-toggles').innerHTML = html;
}

function toggleWidget(id) {
  var idx = dashLayout.hidden.indexOf(id);
  if (idx > -1) dashLayout.hidden.splice(idx, 1);
  else dashLayout.hidden.push(id);
  applyLayout();
  saveLayout();
}

function toggleCustomize() {
  var panel = document.getElementById('customize-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  document.getElementById('customize-btn').textContent = panel.style.display === 'none' ? 'Customize' : 'Done';
}

function resetLayout() {
  dashLayout = {widgets:['search','cards','briefing','suggestions','ai_query','tasks','upcoming_emails','mini_cal','perfin','shortcuts'],hidden:[]};
  applyLayout();
  saveLayout();
}

async function saveLayout() {
  await fetch('/api/settings', {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({dashboard_layout:dashLayout})});
}

function wdragStart(e,w) { wdragSrcWidget = (w||e.target.closest('.dash-widget')).dataset.widget; (w||e.target.closest('.dash-widget')).style.opacity = '0.4'; }
function wdragOver(e) { e.preventDefault(); var w=e.target.closest('.dash-widget'); if(w) w.style.borderTop = '2px solid var(--accent)'; }
function wdragEnd(e) { document.querySelectorAll('.dash-widget').forEach(w => { w.style.opacity = '1'; w.style.borderTop = ''; }); }
function wdrop(e) {
  e.preventDefault(); var el=e.target.closest('.dash-widget'); if(el) el.style.borderTop = '';
  var target = (el||e.currentTarget).dataset.widget;
  if (wdragSrcWidget === target) return;
  var srcIdx = dashLayout.widgets.indexOf(wdragSrcWidget);
  var tgtIdx = dashLayout.widgets.indexOf(target);
  if (srcIdx > -1 && tgtIdx > -1) {
    dashLayout.widgets.splice(srcIdx, 1);
    dashLayout.widgets.splice(tgtIdx, 0, wdragSrcWidget);
    applyLayout();
    saveLayout();
  }
}

// Mini Calendar
var miniCalMonth = new Date().getMonth();
var miniCalYear = new Date().getFullYear();
var miniCalEvents = [];
var miniCalSelectedDay = null;

async function renderMiniCal() {
  var grid = document.getElementById('mini-cal-grid');
  var titleEl = document.getElementById('mini-cal-title');
  if (!grid || !titleEl) return;

  var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  titleEl.textContent = monthNames[miniCalMonth] + ' ' + miniCalYear;

  try {
    miniCalEvents = await fetch('/api/calendar?month='+(miniCalMonth+1)+'&year='+miniCalYear).then(function(r){return r.json();});
  } catch(e) { miniCalEvents = []; }

  var today = new Date();
  var firstDay = new Date(miniCalYear, miniCalMonth, 1).getDay();
  var daysInMonth = new Date(miniCalYear, miniCalMonth + 1, 0).getDate();

  var html = '';
  ['S','M','T','W','T','F','S'].forEach(function(d) {
    html += '<div style="font-family:var(--mono);font-weight:500;color:var(--muted);padding:4px 0;font-size:9px;letter-spacing:0.12em;">'+d+'</div>';
  });

  for (var i = 0; i < firstDay; i++) { html += '<div></div>'; }

  for (var d = 1; d <= daysInMonth; d++) {
    var isToday = (d === today.getDate() && miniCalMonth === today.getMonth() && miniCalYear === today.getFullYear());
    var dateStr = miniCalYear + '-' + String(miniCalMonth+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
    var hasEvents = miniCalEvents.some(function(ev) { return ev.date === dateStr; });
    var style = 'padding:4px 0;cursor:pointer;border-radius:2px;font-family:var(--mono);font-variant-numeric:tabular-nums;';
    if (isToday) style += 'color:var(--accent);font-weight:600;';
    if (hasEvents) style += 'text-decoration:underline;';
    if (miniCalSelectedDay === d) style += 'background:var(--paper-2);';
    html += '<div data-cal-day="'+d+'" style="'+style+'">'+d+'</div>';
  }

  grid.innerHTML = html;

  if (miniCalSelectedDay === null && miniCalMonth === today.getMonth() && miniCalYear === today.getFullYear()) {
    showMiniCalEvents(today.getDate());
  } else if (miniCalSelectedDay !== null) {
    showMiniCalEvents(miniCalSelectedDay);
  } else {
    document.getElementById('mini-cal-events').innerHTML = '';
  }
}

function showMiniCalEvents(day) {
  miniCalSelectedDay = day;
  var dateStr = miniCalYear + '-' + String(miniCalMonth+1).padStart(2,'0') + '-' + String(day).padStart(2,'0');
  var eventsEl = document.getElementById('mini-cal-events');
  var dayEvents = miniCalEvents.filter(function(ev) { return ev.date === dateStr; });

  var grid = document.getElementById('mini-cal-grid');
  if (grid) {
    grid.querySelectorAll('[data-cal-day]').forEach(function(cell) {
      if (parseInt(cell.dataset.calDay) === day) cell.style.background = 'var(--paper-2)';
      else cell.style.background = '';
    });
  }

  if (!dayEvents.length) {
    eventsEl.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:4px 0;font-style:italic;">No events on this day</div>';
    return;
  }
  eventsEl.innerHTML = dayEvents.slice(0, 5).map(function(ev) {
    var typeColor = ev.type === 'todo' ? 'var(--accent)' : ev.type === 'email' ? 'var(--warn)' : 'var(--good)';
    return '<div style="padding:4px 0;font-size:11px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:6px;"><span style="width:6px;height:6px;border-radius:50%;background:'+typeColor+';flex-shrink:0;"></span><span>'+esc(ev.title||'Untitled')+'</span></div>';
  }).join('');
  if (dayEvents.length > 5) {
    eventsEl.innerHTML += '<div style="font-family:var(--mono);font-size:9px;color:var(--muted);padding:4px 0;letter-spacing:0.08em;">+'+(dayEvents.length-5)+' more</div>';
  }
}

function miniCalPrev() {
  miniCalMonth--;
  if (miniCalMonth < 0) { miniCalMonth = 11; miniCalYear--; }
  miniCalSelectedDay = null;
  renderMiniCal();
}

function miniCalNext() {
  miniCalMonth++;
  if (miniCalMonth > 11) { miniCalMonth = 0; miniCalYear++; }
  miniCalSelectedDay = null;
  renderMiniCal();
}

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.key === '/') { e.preventDefault(); document.getElementById('global-search').focus(); }
  else if (e.key === 'n' || e.key === 'N') { location.href = '/todos'; }
  else if (e.key === 'e' || e.key === 'E') { location.href = '/emails'; }
  else if (e.key === 'c' || e.key === 'C') { location.href = '/calendar'; }
  else if (e.key === 'r' || e.key === 'R') { location.href = '/review'; }
});

bindEvents([
  ['customize-btn','click',toggleCustomize],
  ['reset-layout-btn','click',resetLayout],
  ['ask-ai-btn','click',askAI],
  ['mini-cal-prev','click',miniCalPrev],
  ['mini-cal-next','click',miniCalNext],
]);
var searchInput=document.getElementById('global-search');
if(searchInput)searchInput.addEventListener('input',function(){doSearch(this.value);});
var aiInput=document.getElementById('ai-query-input');
if(aiInput)aiInput.addEventListener('keydown',function(e){if(e.key==='Enter')askAI();});
onDelegate('dash-task-filters','click','button[data-view]',function(){setDashView(this,this.dataset.view);});
onDelegate('widget-toggles','click','[data-toggle-widget]',function(e){e.stopPropagation();toggleWidget(this.dataset.toggleWidget);});
onDelegate('mini-cal-grid','click','[data-cal-day]',function(){showMiniCalEvents(parseInt(this.dataset.calDay));});
(function(){var c=document.getElementById('dash-widgets');if(!c)return;c.addEventListener('dragstart',function(e){var w=e.target.closest('.dash-widget');if(w)wdragStart(e,w);});c.addEventListener('dragover',wdragOver);c.addEventListener('dragend',wdragEnd);c.addEventListener('drop',wdrop);})();
document.addEventListener('click',function(e){
  var btn=e.target.closest('[data-action]');
  if(!btn)return;
  var id=parseInt(btn.dataset.id),act=btn.dataset.action;
  e.preventDefault();e.stopPropagation();
  if(act==='dash-complete')dashComplete(id);
  else if(act==='dash-complete-recurring')dashCompleteRecurring(id);
  else if(act==='dash-send-email')dashSendEmail(id);
  else if(act==='search-complete')searchComplete(id,btn.dataset.recurring==='true');
  else if(act==='search-send')searchSendEmail(id);
  else if(act==='search-pin')searchTogglePin(id,btn.dataset.pinned==='true');
});

loadLayout().then(load);
`;
