const { pageHead, navBar, themeScript } = require("../views");

module.exports = function() {
  return (req, res) => {
    res.send(`${pageHead("Analytics")}
<body>
${themeScript()}
${navBar("/analytics")}
<div class="container">
  <h1>Analytics</h1>
  <p class="subtitle">Productivity insights and trends.</p>

  <div class="filters" id="period-filters">
    <button data-period="week" class="active">This Week</button>
    <button data-period="month">This Month</button>
    <button data-period="quarter">Quarter</button>
    <button data-period="year">Year</button>
  </div>

  <div class="top-cards" id="overview-cards"></div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px;" class="dash-two-col">
    <div class="section">
      <h2>Completion Trend</h2>
      <div id="completion-chart" style="height:200px;display:flex;align-items:flex-end;gap:4px;padding-top:24px;"></div>
    </div>
    <div class="section">
      <h2>Productivity by Day</h2>
      <div id="dow-chart" style="height:200px;display:flex;align-items:flex-end;gap:8px;justify-content:space-around;padding-top:24px;"></div>
    </div>
  </div>

  <div class="section" style="margin-bottom:24px;">
    <h2>Activity Heatmap (90 Days)</h2>
    <div id="heatmap" style="display:flex;flex-wrap:wrap;gap:2px;"></div>
    <div style="display:flex;justify-content:flex-end;align-items:center;gap:6px;margin-top:8px;font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:0.08em;text-transform:uppercase;">
      Less <div style="width:12px;height:12px;border-radius:2px;background:var(--paper-2);"></div>
      <div style="width:12px;height:12px;border-radius:2px;background:color-mix(in oklch, var(--good) 30%, transparent);"></div>
      <div style="width:12px;height:12px;border-radius:2px;background:color-mix(in oklch, var(--good) 60%, transparent);"></div>
      <div style="width:12px;height:12px;border-radius:2px;background:var(--good);"></div> More
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px;" class="dash-two-col">
    <div class="section">
      <h2>Priority Breakdown</h2>
      <div id="priority-chart"></div>
    </div>
    <div class="section">
      <h2>Category Performance</h2>
      <div id="category-chart"></div>
    </div>
  </div>

  <div class="section" style="margin-bottom:24px;">
    <h2>Streak Leaders</h2>
    <div id="streak-leaders"></div>
  </div>
</div>
<script>
var curPeriod = 'week';
function setPeriod(btn, p) { curPeriod = p; document.querySelectorAll('#period-filters button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); load(); }

async function load() {
  var data = await fetch('/api/analytics?period='+curPeriod).then(r=>r.json());

  // Overview cards
  var scoreColor = data.productivity_score >= 70 ? 'green' : data.productivity_score >= 40 ? 'warm' : 'red';
  document.getElementById('overview-cards').innerHTML = [
    {label:'Productivity Score',value:data.productivity_score,cls:scoreColor},
    {label:'Tasks Completed',value:data.total_completed,cls:'green'},
    {label:'Tasks Created',value:data.total_created,cls:'warm'},
    {label:'Completion Rate',value:data.completion_rate+'%',cls:data.completion_rate>=70?'green':data.completion_rate>=40?'warm':'red'},
    {label:'Avg. Completion Time',value:data.avg_completion_hours?data.avg_completion_hours+'h':'N/A',cls:'teal'},
    {label:'Emails Sent',value:data.emails_sent||0,cls:'teal'},
    {label:'Notes Created',value:data.notes_created||0,cls:'warm'},
  ].map(c => '<div class="card"><div class="label">'+c.label+'</div><div class="value '+c.cls+'">'+c.value+'</div></div>').join('');

  // Completion trend bar chart
  var days = data.completed_by_day || [];
  var maxDay = Math.max(...days.map(d=>parseInt(d.count)), 1);
  document.getElementById('completion-chart').innerHTML = days.length
    ? days.map(d => {
        var h = Math.max((parseInt(d.count)/maxDay)*160, 4);
        var label = new Date(d.day).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
        return '<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0;"><div style="background:var(--good);width:100%;max-width:40px;height:'+h+'px;border-radius:2px 2px 0 0;transition:height 0.3s;"></div><div style="font-family:var(--mono);font-size:9px;color:var(--muted);margin-top:4px;text-align:center;white-space:nowrap;letter-spacing:0.04em;">'+label+'</div><div style="font-family:var(--mono);font-size:11px;font-weight:500;margin-top:2px;font-variant-numeric:tabular-nums;">'+d.count+'</div></div>';
      }).join('')
    : '<div class="empty-msg">No data yet</div>';

  // Productivity by day of week
  var dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var dowData = new Array(7).fill(0);
  (data.productivity_by_dow||[]).forEach(d => { dowData[parseInt(d.dow)] = parseInt(d.count); });
  var maxDow = Math.max(...dowData, 1);
  document.getElementById('dow-chart').innerHTML = dowData.map((count,i) => {
    var h = Math.max((count/maxDow)*160, 4);
    return '<div style="display:flex;flex-direction:column;align-items:center;flex:1;"><div style="background:var(--accent);width:100%;max-width:36px;height:'+h+'px;border-radius:2px 2px 0 0;"></div><div style="font-family:var(--mono);font-size:9px;color:var(--muted);margin-top:4px;letter-spacing:0.08em;text-transform:uppercase;">'+dowNames[i]+'</div><div style="font-family:var(--mono);font-size:11px;font-weight:500;margin-top:2px;font-variant-numeric:tabular-nums;">'+count+'</div></div>';
  }).join('');

  // Priority breakdown
  var priColors = {urgent:'var(--warn)',high:'var(--warn)',medium:'var(--accent)',low:'var(--good)'};
  var priTotal = (data.priority_breakdown||[]).reduce((s,p)=>s+parseInt(p.count),0) || 1;
  document.getElementById('priority-chart').innerHTML = (data.priority_breakdown||[]).length
    ? (data.priority_breakdown||[]).map(p => {
        var pct = Math.round(parseInt(p.count)/priTotal*100);
        return '<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--line);"><div style="width:70px;font-size:12px;text-transform:capitalize;">'+p.priority+'</div><div style="flex:1;height:16px;background:var(--paper-2);border-radius:2px;overflow:hidden;"><div style="height:100%;width:'+pct+'%;background:'+priColors[p.priority]+';border-radius:2px;transition:width 0.3s;"></div></div><div style="width:50px;text-align:right;font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums;">'+p.count+'</div></div>';
      }).join('')
    : '<div class="empty-msg">No active tasks</div>';

  // Category breakdown
  document.getElementById('category-chart').innerHTML = (data.category_breakdown||[]).length
    ? (data.category_breakdown||[]).map(c => {
        var total = parseInt(c.count), done = parseInt(c.completed);
        var pct = total > 0 ? Math.round(done/total*100) : 0;
        return '<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--line);"><div style="width:100px;font-size:12px;text-transform:capitalize;">'+esc(c.category)+'</div><div style="flex:1;height:16px;background:var(--paper-2);border-radius:2px;overflow:hidden;"><div style="height:100%;width:'+pct+'%;background:var(--accent);border-radius:2px;"></div></div><div style="width:80px;text-align:right;font-family:var(--mono);font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;">'+done+'/'+total+' ('+pct+'%)</div></div>';
      }).join('')
    : '<div class="empty-msg">No data yet</div>';

  // Streak leaders
  document.getElementById('streak-leaders').innerHTML = (data.streak_leaders||[]).length
    ? (data.streak_leaders||[]).map((s,i) =>
        '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);"><div style="font-family:var(--display);font-size:18px;color:var(--muted);width:30px;text-align:center;font-variant-numeric:tabular-nums;">'+(i+1)+'</div><div style="flex:1;"><div style="font-size:14px;">'+esc(s.title)+'</div><div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:2px;letter-spacing:0.04em;">'+s.recurrence_rule+' &middot; Best: '+s.best_streak+'</div></div><div style="text-align:right;"><span class="badge streak">&#x1F525; '+s.streak_count+'</span></div></div>'
      ).join('')
    : '<div class="empty-msg">No streaks yet. Complete recurring tasks to build streaks.</div>';

  // Heatmap (GitHub-style, 90 days)
  var heatmap = data.heatmap || [];
  var heatmapMap = {};
  heatmap.forEach(h => { heatmapMap[h.day ? new Date(h.day).toISOString().split('T')[0] : ''] = parseInt(h.count); });
  var maxHeat = Math.max(...heatmap.map(h => parseInt(h.count)), 1);
  var heatHtml = '';
  var today = new Date();
  for (var i = 90; i >= 0; i--) {
    var d = new Date(today); d.setDate(d.getDate() - i);
    var key = d.toISOString().split('T')[0];
    var count = heatmapMap[key] || 0;
    var intensity = count === 0 ? 0 : count <= maxHeat * 0.33 ? 1 : count <= maxHeat * 0.66 ? 2 : 3;
    var colors = ['var(--paper-2)', 'color-mix(in oklch, var(--good) 30%, transparent)', 'color-mix(in oklch, var(--good) 60%, transparent)', 'var(--good)'];
    heatHtml += '<div title="'+key+': '+count+' tasks" style="width:12px;height:12px;border-radius:2px;background:'+colors[intensity]+';"></div>';
  }
  document.getElementById('heatmap').innerHTML = heatHtml;
}

load();
onDelegate('period-filters','click','[data-period]',function(){setPeriod(this,this.dataset.period);});
</script>
</body></html>`);
  };
};
