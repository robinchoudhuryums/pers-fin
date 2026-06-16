const { pageHead, navBar, themeScript, nonceAttr } = require("../views");

// Health & Habits page. NOTE: this whole page is one template literal — the
// inline JS below must stay backtick-free (string concat only), same as
// every other page module.
module.exports = function() {
  return (req, res) => {
  res.send(`${pageHead("Health")}
<body>
${themeScript()}
${navBar("/health")}
<div class="container">
  <h1>Health</h1>
  <p class="subtitle">Daily habits, streaks, and measurements.</p>

  <div class="actions">
    <button class="primary" id="btn-add-habit">+ Add Habit</button>
  </div>

  <div class="top-cards" id="health-cards"></div>

  <div class="section" style="margin-bottom:24px;">
    <h2>Today</h2>
    <div id="today-list"></div>
  </div>

  <div class="section" style="margin-bottom:24px;">
    <h2>Last 7 Days</h2>
    <div id="week-grid" style="overflow-x:auto;"></div>
  </div>

  <div class="section" style="margin-bottom:24px;">
    <h2>Consistency (90 Days)</h2>
    <div id="health-heatmap" style="display:flex;flex-wrap:wrap;gap:2px;"></div>
    <div style="display:flex;justify-content:flex-end;align-items:center;gap:6px;margin-top:8px;font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:0.08em;text-transform:uppercase;">
      Less <div style="width:12px;height:12px;border-radius:2px;background:var(--paper-2);"></div>
      <div style="width:12px;height:12px;border-radius:2px;background:color-mix(in oklch, var(--good) 30%, transparent);"></div>
      <div style="width:12px;height:12px;border-radius:2px;background:color-mix(in oklch, var(--good) 60%, transparent);"></div>
      <div style="width:12px;height:12px;border-radius:2px;background:var(--good);"></div> More
    </div>
  </div>

  <div class="section" style="margin-bottom:24px;">
    <h2>Measurements</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;">
      <div><label>Metric</label>
        <select id="m-preset">
          <option value="weight">Weight (lb)</option>
          <option value="sleep">Sleep (hours)</option>
          <option value="steps">Steps</option>
          <option value="water">Water (oz)</option>
          <option value="calories">Calories</option>
          <option value="mood">Mood (1-10)</option>
          <option value="energy">Energy (1-10)</option>
          <option value="custom">Custom&hellip;</option>
        </select>
      </div>
      <div id="m-custom-wrap" style="display:none;"><label>Name</label><input type="text" id="m-custom" placeholder="e.g. resting hr" style="width:130px;"></div>
      <div><label>Value</label><input type="number" id="m-value" step="any" style="width:90px;"></div>
      <div><label>Date</label><input type="date" id="m-date" style="width:150px;"></div>
      <button class="primary" id="btn-log-metric">Log</button>
    </div>
    <div class="top-cards" id="metric-cards"></div>
    <div id="metric-chart-wrap" style="display:none;">
      <h2 id="metric-chart-title" style="margin-top:10px;"></h2>
      <div id="metric-chart"></div>
    </div>
  </div>

  <div class="section" style="margin-bottom:24px;">
    <h2>Archived Habits</h2>
    <div id="archived-list"></div>
  </div>
</div>

<div class="modal-overlay" id="habit-modal">
  <div class="modal">
    <h2 id="h-modal-title">Add Habit</h2>
    <input type="hidden" id="h-id">
    <label>Name</label>
    <input type="text" id="h-name" placeholder="e.g. Morning run">
    <label>Type</label>
    <select id="h-kind">
      <option value="boolean">Check-off (did it / didn't)</option>
      <option value="quantity">Quantity vs target</option>
    </select>
    <div id="h-target-wrap" style="display:none;">
      <label>Target</label>
      <div style="display:flex;gap:8px;">
        <input type="number" id="h-target" step="any" placeholder="8" style="flex:1;">
        <input type="text" id="h-unit" placeholder="unit (glasses, min)" style="flex:1;">
      </div>
    </div>
    <label>Schedule</label>
    <select id="h-schedule">
      <option value="daily">Every day</option>
      <option value="weekdays">Weekdays (Mon&ndash;Fri)</option>
      <option value="custom_days">Specific days</option>
      <option value="weekly">N times per week</option>
    </select>
    <div id="h-days-wrap" style="display:none;margin-top:8px;" class="filters"></div>
    <div id="h-tpw-wrap" style="display:none;">
      <label>Times per week</label>
      <input type="number" id="h-tpw" min="1" max="7" value="3" style="width:80px;">
    </div>
    <div class="modal-actions">
      <button id="btn-cancel-habit">Cancel</button>
      <button class="primary" id="btn-save-habit">Save</button>
      <button class="danger" id="h-archive-btn" style="display:none">Archive</button>
    </div>
  </div>
</div>

<script${nonceAttr()}>
var habits = [], archived = [], latestMetrics = [];
var DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
var UNIT_PRESETS = {weight:'lb', sleep:'hours', steps:'', water:'oz', calories:'kcal', mood:'/10', energy:'/10'};

function todayLocal() { return new Date().toISOString().split('T')[0]; }

function scheduleLabel(h) {
  if (h.schedule === 'weekdays') return 'Weekdays';
  if (h.schedule === 'weekly') return h.times_per_week + 'x / week';
  if (h.schedule === 'custom_days') return (h.schedule_days||[]).map(function(d){return DOW[d];}).join(' ');
  return 'Daily';
}

function streakBadge(h) {
  if (!h.current_streak) return '';
  return '<span class="badge streak" title="Best: '+h.best_streak+'">&#x1F525; '+h.current_streak+'</span>';
}

async function load() {
  var data = await fetch('/api/habits?all=1').then(function(r){return r.json();});
  habits = data.habits || [];
  archived = data.archived || [];
  var summary = await fetch('/api/health/summary').then(function(r){return r.json();});
  latestMetrics = summary.latest_metrics || [];

  // Overview cards
  var due = habits.filter(function(h){return h.due_today;});
  var done = due.filter(function(h){return h.done_today;});
  var bestStreak = habits.reduce(function(m,h){return Math.max(m, h.current_streak);}, 0);
  document.getElementById('health-cards').innerHTML = [
    {label:'Due Today', value: due.length, cls:'warm'},
    {label:'Done Today', value: done.length + '/' + (due.length||0), cls: done.length >= due.length && due.length ? 'green' : 'teal'},
    {label:'Longest Active Streak', value: bestStreak, cls:'green'},
    {label:'Active Habits', value: habits.length, cls:'teal'}
  ].map(function(c){return '<div class="card"><div class="label">'+c.label+'</div><div class="value '+c.cls+'">'+c.value+'</div></div>';}).join('');

  renderToday();
  renderWeekGrid();
  renderArchived();
  renderMetricCards();
  loadHeatmap();
}

function renderToday() {
  var due = habits.filter(function(h){return h.due_today || h.done_today;});
  if (!due.length) {
    document.getElementById('today-list').innerHTML = '<div class="empty-msg">No habits due today. Add one to get started.</div>';
    return;
  }
  document.getElementById('today-list').innerHTML = due.map(function(h) {
    var control;
    if (h.kind === 'quantity') {
      var target = Number(h.target_value) || 0;
      var val = Number(h.today_value) || 0;
      var pct = target ? Math.min(Math.round(val/target*100), 100) : 0;
      control = '<div style="display:flex;align-items:center;gap:8px;">' +
        '<button data-action="dec" data-id="'+h.id+'" aria-label="Decrease">&minus;</button>' +
        '<div style="min-width:90px;text-align:center;"><span style="font-family:var(--mono);font-variant-numeric:tabular-nums;">'+val+' / '+target+(h.unit?' '+esc(h.unit):'')+'</span>' +
        '<div style="height:4px;background:var(--paper-2);border-radius:2px;margin-top:3px;"><div style="height:100%;width:'+pct+'%;background:'+(h.done_today?'var(--good)':'var(--accent)')+';border-radius:2px;"></div></div></div>' +
        '<button data-action="inc" data-id="'+h.id+'" aria-label="Increase">+</button></div>';
    } else {
      control = h.done_today
        ? '<button class="primary" data-action="untick" data-id="'+h.id+'" style="background:var(--good);">&#10003; Done</button>'
        : '<button data-action="tick" data-id="'+h.id+'">Mark done</button>';
    }
    return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);">' +
      '<div style="flex:1;min-width:0;"><div style="font-size:14px;'+(h.done_today?'color:var(--muted);':'')+'">'+esc(h.name)+' '+streakBadge(h)+'</div>' +
      '<div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:2px;letter-spacing:0.04em;">'+scheduleLabel(h)+(h.best_streak?' &middot; best '+h.best_streak:'')+'</div></div>' +
      control +
      '<button data-action="editHabit" data-id="'+h.id+'" aria-label="Edit">&#9998;</button></div>';
  }).join('');
}

function renderWeekGrid() {
  if (!habits.length) { document.getElementById('week-grid').innerHTML = '<div class="empty-msg">No habits yet.</div>'; return; }
  var days = habits[0].week.map(function(c){return c.date;});
  var head = '<tr><th style="text-align:left;">Habit</th>' + days.map(function(d){
    var dt = new Date(d + 'T00:00:00Z');
    return '<th style="text-align:center;font-family:var(--mono);font-size:9px;">'+DOW[dt.getUTCDay()]+'<br>'+d.slice(8)+'</th>';
  }).join('') + '</tr>';
  var rows = habits.map(function(h) {
    return '<tr><td style="font-size:13px;">'+esc(h.name)+'</td>' + h.week.map(function(c) {
      var bg = c.met ? 'var(--good)' : (c.value > 0 ? 'color-mix(in oklch, var(--good) 40%, transparent)' : (c.due ? 'var(--paper-2)' : 'transparent'));
      var border = c.due ? '1px solid var(--line)' : '1px dashed var(--line)';
      var title = c.date + (c.value ? ': ' + c.value : '');
      return '<td style="text-align:center;"><button data-action="cell" data-id="'+h.id+'" data-date="'+escAttr(c.date)+'" data-value="'+escAttr(c.value)+'" title="'+escAttr(title)+'" aria-label="'+escAttr(h.name)+' '+escAttr(title)+'" style="width:22px;height:22px;border-radius:3px;border:'+border+';background:'+bg+';cursor:pointer;padding:0;"></button></td>';
    }).join('') + '</tr>';
  }).join('');
  document.getElementById('week-grid').innerHTML = '<table style="border-collapse:separate;border-spacing:2px;">'+head+rows+'</table>';
}

async function loadHeatmap() {
  var data = await fetch('/api/health/heatmap?days=90').then(function(r){return r.json();});
  var map = {};
  (data.heatmap||[]).forEach(function(h){ map[h.day ? new Date(h.day).toISOString().split('T')[0] : ''] = parseInt(h.count); });
  var max = Math.max.apply(null, (data.heatmap||[]).map(function(h){return parseInt(h.count);}).concat([1]));
  var html = '';
  var today = new Date();
  for (var i = 90; i >= 0; i--) {
    var d = new Date(today); d.setDate(d.getDate() - i);
    var key = d.toISOString().split('T')[0];
    var count = map[key] || 0;
    var intensity = count === 0 ? 0 : count <= max * 0.33 ? 1 : count <= max * 0.66 ? 2 : 3;
    var colors = ['var(--paper-2)', 'color-mix(in oklch, var(--good) 30%, transparent)', 'color-mix(in oklch, var(--good) 60%, transparent)', 'var(--good)'];
    html += '<div title="'+key+': '+count+' habits" style="width:12px;height:12px;border-radius:2px;background:'+colors[intensity]+';"></div>';
  }
  document.getElementById('health-heatmap').innerHTML = html;
}

// ----- Metrics ---------------------------------------------------------------
function renderMetricCards() {
  if (!latestMetrics.length) { document.getElementById('metric-cards').innerHTML = '<div class="empty-msg">No measurements yet.</div>'; return; }
  document.getElementById('metric-cards').innerHTML = latestMetrics.map(function(m) {
    var when = m.recorded_on ? new Date(m.recorded_on).toISOString().split('T')[0] : '';
    return '<div class="card" data-action="showChart" data-metric="'+escAttr(m.metric)+'" style="cursor:pointer;" title="Show trend">' +
      '<div class="label">'+esc(m.metric)+'</div><div class="value teal">'+(+m.value)+(m.unit?' <span style="font-size:12px;color:var(--muted);">'+esc(m.unit)+'</span>':'')+'</div>' +
      '<div style="font-family:var(--mono);font-size:9px;color:var(--muted);">'+when+'</div></div>';
  }).join('');
}

async function showChart(metric) {
  var rows = await fetch('/api/health/metrics?metric='+encodeURIComponent(metric)+'&days=90').then(function(r){return r.json();});
  var wrap = document.getElementById('metric-chart-wrap');
  document.getElementById('metric-chart-title').textContent = metric + ' (90 days)';
  if (!rows.length) { wrap.style.display = 'block'; document.getElementById('metric-chart').innerHTML = '<div class="empty-msg">No data.</div>'; return; }
  var vals = rows.map(function(r){return Number(r.value);});
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  var range = (max - min) || 1;
  var W = 600, H = 140, P = 8;
  var pts = rows.map(function(r, i) {
    var x = P + (rows.length === 1 ? (W-2*P)/2 : i * (W - 2*P) / (rows.length - 1));
    var y = H - P - ((Number(r.value) - min) / range) * (H - 2*P);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  var dots = rows.map(function(r, i) {
    var x = P + (rows.length === 1 ? (W-2*P)/2 : i * (W - 2*P) / (rows.length - 1));
    var y = H - P - ((Number(r.value) - min) / range) * (H - 2*P);
    var when = r.recorded_on ? new Date(r.recorded_on).toISOString().split('T')[0] : '';
    return '<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="2.5" fill="var(--accent)"><title>'+when+': '+r.value+'</title></circle>';
  }).join('');
  document.getElementById('metric-chart').innerHTML =
    '<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;max-width:680px;height:auto;" role="img" aria-label="'+escAttr(metric)+' trend">' +
    '<polyline points="'+pts+'" fill="none" stroke="var(--accent)" stroke-width="1.5"/>'+dots+'</svg>' +
    '<div style="font-family:var(--mono);font-size:10px;color:var(--muted);">min '+min+' &middot; max '+max+' &middot; '+rows.length+' entries</div>';
  wrap.style.display = 'block';
}

async function logMetric() {
  var preset = document.getElementById('m-preset').value;
  var name = preset === 'custom' ? document.getElementById('m-custom').value.trim() : preset;
  var value = document.getElementById('m-value').value;
  if (!name || value === '') return alert('Metric and value are required');
  var body = { metric: name, value: Number(value) };
  if (preset !== 'custom' && UNIT_PRESETS[preset]) body.unit = UNIT_PRESETS[preset];
  var date = document.getElementById('m-date').value;
  if (date) body.date = date;
  var r = await fetch('/api/health/metrics', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  var d = await r.json();
  if (d.error) return alert(d.error);
  document.getElementById('m-value').value = '';
  load();
}

// ----- Logging actions ---------------------------------------------------------
async function postLog(id, body) {
  var r = await fetch('/api/habits/'+id+'/log', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  var d = await r.json();
  if (d.error) alert(d.error);
  load();
}

async function removeLog(id, date) {
  await fetch('/api/habits/'+id+'/log/'+date, {method:'DELETE'});
  load();
}

function findHabit(id) { return habits.find(function(h){return h.id===id;}) || archived.find(function(h){return h.id===id;}); }

function cellClick(id, date, value) {
  var h = findHabit(id);
  if (!h) return;
  if (h.kind === 'quantity') {
    var input = prompt('Value for ' + date + (h.unit ? ' (' + h.unit + ')' : ''), value || '');
    if (input === null) return;
    var v = Number(input);
    if (!isFinite(v) || v < 0) return alert('Enter a non-negative number');
    if (v === 0) return removeLog(id, date);
    postLog(id, { date: date, value: v });
  } else {
    if (value > 0) removeLog(id, date);
    else postLog(id, { date: date, value: 1 });
  }
}

// ----- Habit modal ---------------------------------------------------------------
function renderDayChecks(selected) {
  document.getElementById('h-days-wrap').innerHTML = DOW.map(function(d, i) {
    var on = (selected||[]).indexOf(i) >= 0;
    return '<button type="button" data-action="dayToggle" data-day="'+i+'" class="'+(on?'active':'')+'">'+d+'</button>';
  }).join('');
}

function syncModalVisibility() {
  var kind = document.getElementById('h-kind').value;
  var schedule = document.getElementById('h-schedule').value;
  document.getElementById('h-target-wrap').style.display = kind === 'quantity' ? 'block' : 'none';
  document.getElementById('h-days-wrap').style.display = schedule === 'custom_days' ? 'flex' : 'none';
  document.getElementById('h-tpw-wrap').style.display = schedule === 'weekly' ? 'block' : 'none';
}

function openAdd() {
  document.getElementById('h-modal-title').textContent = 'Add Habit';
  document.getElementById('h-id').value = '';
  document.getElementById('h-name').value = '';
  document.getElementById('h-kind').value = 'boolean';
  document.getElementById('h-target').value = '';
  document.getElementById('h-unit').value = '';
  document.getElementById('h-schedule').value = 'daily';
  document.getElementById('h-tpw').value = '3';
  renderDayChecks([]);
  document.getElementById('h-archive-btn').style.display = 'none';
  syncModalVisibility();
  document.getElementById('habit-modal').classList.add('active');
}

function openEdit(id) {
  var h = findHabit(id);
  if (!h) return;
  document.getElementById('h-modal-title').textContent = 'Edit Habit';
  document.getElementById('h-id').value = id;
  document.getElementById('h-name').value = h.name;
  document.getElementById('h-kind').value = h.kind;
  document.getElementById('h-target').value = h.target_value || '';
  document.getElementById('h-unit').value = h.unit || '';
  document.getElementById('h-schedule').value = h.schedule;
  document.getElementById('h-tpw').value = h.times_per_week || 3;
  renderDayChecks(h.schedule_days || []);
  document.getElementById('h-archive-btn').style.display = h.is_active ? 'inline-block' : 'none';
  syncModalVisibility();
  document.getElementById('habit-modal').classList.add('active');
}

function closeHabit() { document.getElementById('habit-modal').classList.remove('active'); }

async function saveHabit() {
  var schedule = document.getElementById('h-schedule').value;
  var kind = document.getElementById('h-kind').value;
  var body = {
    name: document.getElementById('h-name').value,
    kind: kind,
    schedule: schedule
  };
  if (kind === 'quantity') {
    body.target_value = Number(document.getElementById('h-target').value);
    body.unit = document.getElementById('h-unit').value || null;
  }
  if (schedule === 'custom_days') {
    body.schedule_days = Array.prototype.slice.call(document.querySelectorAll('#h-days-wrap button.active')).map(function(b){return parseInt(b.dataset.day);});
  }
  if (schedule === 'weekly') body.times_per_week = parseInt(document.getElementById('h-tpw').value);
  var id = document.getElementById('h-id').value;
  var r = id
    ? await fetch('/api/habits/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    : await fetch('/api/habits', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  var d = await r.json();
  if (d.error) return alert(d.error);
  closeHabit(); load();
}

async function archiveHabit() {
  var id = document.getElementById('h-id').value;
  if (!confirm('Archive this habit? Its history is kept and it can be restored below.')) return;
  await fetch('/api/habits/'+id, {method:'DELETE'});
  closeHabit(); load();
}

function renderArchived() {
  document.getElementById('archived-list').innerHTML = archived.length
    ? archived.map(function(h) {
        return '<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--line);color:var(--muted);">' +
          '<div style="flex:1;">'+esc(h.name)+' <span style="font-family:var(--mono);font-size:10px;">('+scheduleLabel(h)+')</span></div>' +
          '<button data-action="restore" data-id="'+h.id+'">Restore</button></div>';
      }).join('')
    : '<div class="empty-msg">Nothing archived.</div>';
}

async function restoreHabit(id) {
  await fetch('/api/habits/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_active:true})});
  load();
}

// ----- Wiring --------------------------------------------------------------------
document.getElementById('m-date').value = todayLocal();
load();
bindEvents([
  ['btn-add-habit','click',openAdd],
  ['btn-cancel-habit','click',closeHabit],
  ['btn-save-habit','click',saveHabit],
  ['h-archive-btn','click',archiveHabit],
  ['btn-log-metric','click',logMetric],
  ['h-kind','change',syncModalVisibility],
  ['h-schedule','change',syncModalVisibility],
  ['m-preset','change',function(){document.getElementById('m-custom-wrap').style.display = this.value === 'custom' ? 'block' : 'none';}]
]);
onDelegate('today-list','click','[data-action="tick"]',function(){postLog(parseInt(this.dataset.id),{value:1});});
onDelegate('today-list','click','[data-action="untick"]',function(){removeLog(parseInt(this.dataset.id), todayLocal());});
onDelegate('today-list','click','[data-action="inc"]',function(){var h=findHabit(parseInt(this.dataset.id)); if(h) postLog(h.id,{value:(Number(h.today_value)||0)+1});});
onDelegate('today-list','click','[data-action="dec"]',function(){var h=findHabit(parseInt(this.dataset.id)); if(!h) return; var v=(Number(h.today_value)||0)-1; if(v<=0) removeLog(h.id, todayLocal()); else postLog(h.id,{value:v});});
onDelegate('today-list','click','[data-action="editHabit"]',function(){openEdit(parseInt(this.dataset.id));});
onDelegate('week-grid','click','[data-action="cell"]',function(){cellClick(parseInt(this.dataset.id), this.dataset.date, Number(this.dataset.value));});
onDelegate('metric-cards','click','[data-action="showChart"]',function(){showChart(this.dataset.metric);});
onDelegate('archived-list','click','[data-action="restore"]',function(){restoreHabit(parseInt(this.dataset.id));});
onDelegate('h-days-wrap','click','[data-action="dayToggle"]',function(){this.classList.toggle('active');});
</script>
</body></html>`);
  };
};
