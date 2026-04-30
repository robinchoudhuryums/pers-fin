const { pageHead, navBar, themeScript } = require("../views");

module.exports = function() {
  return (req, res) => {
  res.send(`${pageHead("Calendar")}
<body>
${themeScript()}
${navBar("/calendar")}
<div class="container">
  <h1>Calendar</h1>
  <p class="subtitle">Tasks, emails, and reminders at a glance.</p>

  <div class="actions" style="align-items:center;">
    <button id="btn-prev-month">&larr; Previous</button>
    <span id="cal-title" class="mono-label" style="padding:0 10px;font-size:12px;color:var(--ink);"></span>
    <button id="btn-next-month">Next &rarr;</button>
    <div style="flex:1"></div>
    <a href="/api/calendar.ics" class="btn" download>Export iCal</a>
    <button id="btn-today">Today</button>
  </div>

  <div class="section">
    <div class="cal-grid">
      <div class="cal-header">Mon</div><div class="cal-header">Tue</div><div class="cal-header">Wed</div>
      <div class="cal-header">Thu</div><div class="cal-header">Fri</div><div class="cal-header">Sat</div><div class="cal-header">Sun</div>
    </div>
    <div class="cal-grid" id="cal-days"></div>
  </div>
</div>
<script>
var calMonth = new Date().getMonth();
var calYear = new Date().getFullYear();
function prevMonth() { calMonth--; if (calMonth<0){calMonth=11;calYear--;} load(); }
function nextMonth() { calMonth++; if (calMonth>11){calMonth=0;calYear++;} load(); }
function goToday() { calMonth=new Date().getMonth(); calYear=new Date().getFullYear(); load(); }

async function load() {
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('cal-title').textContent = months[calMonth]+' '+calYear;
  var events = await fetch('/api/calendar?month='+(calMonth+1)+'&year='+calYear).then(r=>r.json());
  var firstDay = new Date(calYear, calMonth, 1).getDay();
  var startOffset = firstDay === 0 ? 6 : firstDay - 1; // Monday start
  var daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
  var today = new Date(); today.setHours(0,0,0,0);
  var html = '';
  // Previous month padding
  var prevDays = new Date(calYear, calMonth, 0).getDate();
  for (var i = startOffset-1; i >= 0; i--) {
    html += '<div class="cal-day other-month"><div class="cal-day-num">'+(prevDays-i)+'</div></div>';
  }
  for (var d = 1; d <= daysInMonth; d++) {
    var date = new Date(calYear, calMonth, d);
    var isToday = date.getTime() === today.getTime();
    var dayEvents = events.filter(e => {
      var ed = new Date(e.event_date);
      return ed.getFullYear()===calYear && ed.getMonth()===calMonth && ed.getDate()===d;
    });
    html += '<div class="cal-day'+(isToday?' today':'')+'"><div class="cal-day-num">'+d+'</div>';
    dayEvents.slice(0,3).forEach(e => {
      html += '<div class="cal-event '+e.type+(e.recurring_projection?' recurring-proj':'')+'">'+( e.recurring_projection?'&#x1F501; ':'')+esc(e.title)+'</div>';
    });
    if (dayEvents.length > 3) html += '<div style="font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:0.04em;">+'+(dayEvents.length-3)+' more</div>';
    html += '</div>';
  }
  // Next month padding
  var totalCells = startOffset + daysInMonth;
  var remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (var i = 1; i <= remaining; i++) {
    html += '<div class="cal-day other-month"><div class="cal-day-num">'+i+'</div></div>';
  }
  document.getElementById('cal-days').innerHTML = html;
}

load();
bindEvents([
  ['btn-prev-month','click',prevMonth],
  ['btn-next-month','click',nextMonth],
  ['btn-today','click',goToday]
]);
</script>
</body></html>`);
  };
};
