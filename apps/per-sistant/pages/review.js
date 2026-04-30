const { pageHead, navBar, themeScript } = require("../views");

module.exports = function() {
  return (req, res) => {
    res.send(`${pageHead("Weekly Review")}
<body>
${themeScript()}
${navBar("/review")}
<div class="container">
  <h1>Weekly Review</h1>
  <p class="subtitle" id="review-period"></p>

  <!-- Weekly theme — AI-generated one-liner based on this week's completed tasks -->
  <div id="theme-section" class="section" style="display:none;margin-bottom:20px;">
    <h2>This week's theme</h2>
    <div id="theme-content" style="font-family:var(--display);font-size:20px;font-weight:500;letter-spacing:-0.3px;line-height:1.3;color:var(--ink);"></div>
  </div>

  <div class="top-cards" id="review-cards"></div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
    <div class="section">
      <h2>Completed This Week</h2>
      <div id="completed-list"></div>
    </div>
    <div class="section">
      <h2>Overdue Tasks</h2>
      <div id="overdue-list"></div>
    </div>
  </div>

  <!-- AI Summary -->
  <div id="review-summary-section" style="display:none;margin-top:20px;">
    <div class="section">
      <h2>AI Weekly Summary</h2>
      <div id="review-summary" style="font-size:14px;line-height:1.7;color:var(--ink);"></div>
    </div>
  </div>

  <div class="section" style="margin-top:20px;">
    <h2>Coming Up Next Week</h2>
    <div id="next-week-list"></div>
  </div>
</div>
<script>
async function load() {
  var data = await fetch('/api/review').then(r=>r.json());
  document.getElementById('review-period').textContent =
    'Week of '+new Date(data.week_start).toLocaleDateString()+' — '+new Date(data.week_end).toLocaleDateString();

  document.getElementById('review-cards').innerHTML = [
    {label:'Tasks Completed',value:data.tasks_completed.length,cls:'green'},
    {label:'Tasks Created',value:data.tasks_created_count,cls:'warm'},
    {label:'Emails Sent',value:data.emails_sent_count,cls:'teal'},
    {label:'Notes Created',value:data.notes_created_count,cls:'blue'},
    {label:'Overdue',value:data.overdue_tasks.length,cls:data.overdue_tasks.length>0?'red':'green'},
  ].map(c => '<div class="card"><div class="label">'+c.label+'</div><div class="value '+c.cls+'">'+c.value+'</div></div>').join('');

  document.getElementById('completed-list').innerHTML = data.tasks_completed.length
    ? data.tasks_completed.map(t => '<div class="todo-item"><div class="todo-check done"></div><div class="todo-content"><div class="todo-title done">'+esc(t.title)+'</div><div class="todo-meta"><span class="badge '+t.priority+'">'+t.priority+'</span><span>'+new Date(t.completed_at).toLocaleDateString()+'</span></div></div></div>').join('')
    : '<div class="empty-msg">No tasks completed yet this week</div>';

  document.getElementById('overdue-list').innerHTML = data.overdue_tasks.length
    ? data.overdue_tasks.map(t => '<div class="todo-item"><div class="todo-content"><div class="todo-title" style="color:var(--warn)">'+esc(t.title)+'</div><div class="todo-meta"><span class="badge '+t.priority+'">'+t.priority+'</span><span style="color:var(--warn)">Due: '+new Date(t.due_date).toLocaleDateString()+'</span></div></div></div>').join('')
    : '<div class="empty-msg">No overdue tasks.</div>';

  document.getElementById('next-week-list').innerHTML = data.upcoming_tasks.length
    ? data.upcoming_tasks.map(t => '<div class="todo-item"><div class="todo-content"><div class="todo-title">'+esc(t.title)+'</div><div class="todo-meta"><span class="badge '+t.priority+'">'+t.priority+'</span><span>Due: '+new Date(t.due_date).toLocaleDateString()+'</span></div></div></div>').join('')
    : '<div class="empty-msg">No tasks scheduled for next week</div>';

  // Load AI review summary (non-blocking)
  fetch('/api/ai/review-summary', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stats:{
    tasks_completed: data.tasks_completed.length,
    tasks_created: data.tasks_created_count,
    emails_sent: data.emails_sent_count,
    notes_created: data.notes_created_count,
    overdue: data.overdue_tasks.length,
    completed_titles: data.tasks_completed.map(t=>t.title).join(', ')
  }})}).then(r=>r.json()).then(d => {
    if (d.summary) {
      document.getElementById('review-summary').textContent = d.summary;
      document.getElementById('review-summary-section').style.display = 'block';
    }
  }).catch(function(){});

  // Weekly theme — single-sentence "what was this week about?" via /api/ai/query.
  // Only triggers when there are enough completed tasks to be meaningful (≥3).
  // Uses the ad-hoc query endpoint rather than extending /api/ai/review-summary
  // so the existing endpoint keeps returning its multi-sentence summary.
  if (data.tasks_completed.length >= 3) {
    var titles = data.tasks_completed.map(function(t) { return t.title; }).slice(0, 30).join(' | ');
    fetch('/api/ai/query', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        query: 'In one short sentence (10 words or fewer, no quotes), what was the theme of the work I completed this week? Tasks: ' + titles,
      }),
    }).then(function(r){return r.json();}).then(function(d) {
      if (d && d.answer) {
        var theme = d.answer.trim().replace(/^["'"'']|["'"'']$/g, '');
        document.getElementById('theme-content').textContent = theme;
        document.getElementById('theme-section').style.display = 'block';
      }
    }).catch(function(){});
  }
}

load();
</script>
</body></html>`);
  };
};
