const { pageHead, navBar, themeScript } = require("../views");

module.exports = function() {
  return (req, res) => {
  res.send(`${pageHead("Today")}
<body>
${themeScript()}
${navBar("/today")}
<div class="container">
  <h1>Today</h1>
  <p class="subtitle" id="today-subtitle">What matters right now.</p>

  <div id="overcommit-warning" class="status-msg"></div>

  <div id="briefing-section" class="section" style="display:none;margin-bottom:20px;">
    <h2>Today's briefing</h2>
    <div id="briefing-content" style="font-size:14px;line-height:1.7;color:var(--ink);"></div>
  </div>

  <div class="top-cards" id="today-stats"></div>

  <div class="section">
    <h2>Overdue</h2>
    <div id="overdue-list"></div>
  </div>

  <div class="section">
    <h2>Due today</h2>
    <div id="today-list"></div>
  </div>

  <div class="section" id="streak-section" style="display:none;">
    <h2>Streak at risk</h2>
    <div id="streak-list"></div>
  </div>

  <div class="section" id="email-section" style="display:none;">
    <h2>Scheduled emails going out soon</h2>
    <div id="email-list"></div>
  </div>
</div>
<script>
// Priority -> duration heuristic in minutes. Used until Sprint 1 adds a real
// estimate_minutes column to todos. When a task carries a value in the
// backend (future), client can use that first and fall back to this.
var PRIORITY_MINUTES = { urgent: 90, high: 60, medium: 30, low: 15 };
function estMin(t) { return (typeof t.estimate_minutes === 'number' && t.estimate_minutes > 0) ? t.estimate_minutes : (PRIORITY_MINUTES[t.priority] || 30); }
function formatMinutes(mins) {
  if (mins < 60) return mins + 'm';
  var h = Math.floor(mins / 60), m = mins % 60;
  return m ? h + 'h ' + m + 'm' : h + 'h';
}

async function load() {
  var now = new Date();
  document.getElementById('today-subtitle').textContent =
    now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  var [todos, emails] = await Promise.all([
    fetch('/api/todos?completed=false').then(r => r.json()).catch(function(){ return []; }),
    fetch('/api/emails?status=scheduled').then(r => r.json()).catch(function(){ return []; }),
  ]);

  var today0 = new Date(); today0.setHours(0,0,0,0);
  var overdue = [], dueToday = [], streakAtRisk = [];
  todos.forEach(function(t) {
    if (!t.due_date) return;
    var d = new Date(t.due_date); d.setHours(0,0,0,0);
    if (d < today0) overdue.push(t);
    else if (d.getTime() === today0.getTime()) dueToday.push(t);
    if (t.recurring && t.streak_count > 0 && d <= today0) streakAtRisk.push(t);
  });

  // Sort overdue worst first, due-today by priority
  var pOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
  overdue.sort(function(a,b) { return new Date(a.due_date) - new Date(b.due_date); });
  dueToday.sort(function(a,b) { return (pOrder[a.priority]||3) - (pOrder[b.priority]||3); });

  var overdueMin = overdue.reduce(function(s,t){ return s + estMin(t); }, 0);
  var todayMin = dueToday.reduce(function(s,t){ return s + estMin(t); }, 0);
  var totalMin = overdueMin + todayMin;

  // Stats cards
  document.getElementById('today-stats').innerHTML = [
    { label: 'Overdue', value: overdue.length, cls: overdue.length > 0 ? 'red' : 'green' },
    { label: 'Due today', value: dueToday.length, cls: 'warm' },
    { label: 'Estimated time', value: formatMinutes(totalMin), cls: totalMin > 480 ? 'red' : totalMin > 300 ? 'warm' : 'green' },
  ].map(function(c){
    return '<div class="card"><div class="label">' + c.label + '</div><div class="value ' + c.cls + '">' + c.value + '</div></div>';
  }).join('');

  // Overcommit heuristic — assume awake hours end at 22:00 (10pm).
  // Before 9am we take the full day; after 10pm we skip the warning.
  var hour = now.getHours();
  var hoursLeft = Math.max(0, 22 - hour);
  if (hour < 9) hoursLeft = 13; // full workday ahead at 9am
  var hoursOfWork = totalMin / 60;
  var warnEl = document.getElementById('overcommit-warning');
  warnEl.className = 'status-msg';
  warnEl.style.cssText = '';
  if (hoursLeft > 0 && hoursOfWork > hoursLeft + 1) {
    warnEl.className = 'status-msg error';
    warnEl.innerHTML = '<strong>Likely overcommitted.</strong> ~' + hoursOfWork.toFixed(1) + 'h of work due today + overdue, but only ~' + hoursLeft + 'h of day remaining. Consider deferring lower-priority items.';
  } else if (hoursLeft > 0 && hoursOfWork > hoursLeft * 0.7 && totalMin > 120) {
    warnEl.style.cssText = 'display:block;padding:12px 14px;border-radius:2px;margin-bottom:16px;font-size:13px;border:1px solid var(--warn);color:var(--warn);background:color-mix(in oklch, var(--warn) 6%, transparent);';
    warnEl.textContent = 'Tight day: ~' + hoursOfWork.toFixed(1) + 'h of work in ~' + hoursLeft + 'h remaining.';
  }

  // Render lists
  document.getElementById('overdue-list').innerHTML = overdue.length
    ? overdue.map(renderTodo).join('')
    : '<div class="empty-msg">Nothing overdue.</div>';
  document.getElementById('today-list').innerHTML = dueToday.length
    ? dueToday.map(renderTodo).join('')
    : '<div class="empty-msg">No tasks due today.</div>';
  if (streakAtRisk.length) {
    document.getElementById('streak-section').style.display = 'block';
    document.getElementById('streak-list').innerHTML = streakAtRisk.map(renderTodo).join('');
  }

  // Scheduled emails going out in the next 2 hours
  var nowT = Date.now();
  var soon = emails.filter(function(e) {
    if (!e.scheduled_at) return false;
    var t = new Date(e.scheduled_at).getTime();
    return t > nowT && (t - nowT) < 2 * 60 * 60 * 1000;
  }).sort(function(a,b){ return new Date(a.scheduled_at) - new Date(b.scheduled_at); });
  if (soon.length) {
    document.getElementById('email-section').style.display = 'block';
    document.getElementById('email-list').innerHTML = soon.map(function(e) {
      var mins = Math.round((new Date(e.scheduled_at) - nowT) / 60000);
      var when = mins < 1 ? 'any moment' : (mins < 60 ? 'in ' + mins + ' min' : 'in ~' + Math.round(mins/60) + 'h');
      return '<div class="todo-item" style="display:flex;align-items:center;gap:10px;">'
        + '<button data-action="today-send-email" data-id="' + e.id + '" title="Send now" class="btn primary">Send</button>'
        + '<div class="todo-content" style="flex:1;">'
        + '<div class="todo-title">' + esc(e.subject) + '</div>'
        + '<div class="todo-meta"><span>To: ' + esc(e.recipient_name || e.recipient_email) + '</span>'
        + '<span style="color:var(--accent);">' + when + '</span></div>'
        + '</div></div>';
    }).join('');
  }

  // AI daily briefing — non-blocking
  fetch('/api/ai/daily-briefing').then(function(r){return r.json();}).then(function(d) {
    if (d && d.briefing) {
      document.getElementById('briefing-content').textContent = d.briefing;
      document.getElementById('briefing-section').style.display = 'block';
    }
  }).catch(function(){});
}

function renderTodo(t) {
  var today0 = new Date(); today0.setHours(0,0,0,0);
  var d = t.due_date ? new Date(t.due_date) : null;
  if (d) d.setHours(0,0,0,0);
  var isOverdue = d && d < today0;
  var dueTxt = d ? (isOverdue ? 'Overdue since ' + d.toLocaleDateString() : 'Due today') : '';
  var overdueStyle = isOverdue ? ' style="color:var(--warn);font-weight:500;"' : '';
  var completeBtn = '<button data-action="today-complete" data-id="' + t.id + '" data-recurring="' + !!t.recurring
    + '" title="Mark complete" style="background:none;border:1px solid var(--good);color:var(--good);width:22px;height:22px;border-radius:2px;cursor:pointer;font-size:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;">&#10003;</button>';
  var streakBadge = t.recurring && t.streak_count > 0 ? '<span class="badge streak">&#x1F525; ' + t.streak_count + '</span>' : '';
  return '<div class="todo-item" style="display:flex;align-items:center;gap:10px;">' + completeBtn
    + '<div class="todo-content" style="flex:1;">'
    + '<div class="todo-title">' + esc(t.title) + '</div>'
    + '<div class="todo-meta">'
    + '<span class="badge ' + t.priority + '">' + t.priority + '</span>'
    + (t.category ? '<span>' + esc(t.category) + '</span>' : '')
    + (dueTxt ? '<span' + overdueStyle + '>' + dueTxt + '</span>' : '')
    + '<span style="font-family:var(--mono);color:var(--muted);letter-spacing:0.04em;">~' + estMin(t) + 'm</span>'
    + streakBadge
    + '</div></div></div>';
}

async function todayComplete(id, isRecurring) {
  if (isRecurring) {
    await fetch('/api/todos/' + id + '/complete-recurring', { method: 'POST' });
  } else {
    await fetch('/api/todos/' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: true }),
    });
  }
  if (typeof showUndo === 'function') showUndo('Task completed', 'todo', id, 'complete');
  load();
}

async function todaySendEmail(id) {
  var r = await fetch('/api/emails/' + id + '/send', { method: 'POST' }).then(function(r){return r.json();});
  if (r && r.ok) { if (typeof showUndo === 'function') showUndo('Email sent', 'email', id, 'send'); load(); }
  else alert('Failed: ' + ((r && r.error) || 'Unknown error'));
}

document.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  var act = btn.dataset.action;
  var id = parseInt(btn.dataset.id);
  if (act === 'today-complete') { e.preventDefault(); e.stopPropagation(); todayComplete(id, btn.dataset.recurring === 'true'); }
  else if (act === 'today-send-email') { e.preventDefault(); e.stopPropagation(); todaySendEmail(id); }
});

// Keyboard shortcut: R refreshes
document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); load(); }
});

load();
</script>
</body></html>`);
  };
};
