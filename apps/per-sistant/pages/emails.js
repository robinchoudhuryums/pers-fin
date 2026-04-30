const { pageHead, navBar, themeScript } = require("../views");

module.exports = function() {
  return (req, res) => {
  res.send(`${pageHead("Emails")}
<body>
${themeScript()}
${navBar("/emails")}
<div class="container">
  <h1>Emails</h1>
  <p class="subtitle">Draft, schedule, and send emails.</p>

  <div class="actions">
    <button class="btn primary" id="compose-btn">+ Compose</button>
    <button class="btn" id="quick-send-btn">Quick Send</button>
    <button class="btn" id="templates-btn">Templates</button>
    <button class="btn" id="email-select-toggle">Select</button>
  </div>
  <div id="email-bulk-bar" style="display:none;padding:10px 16px;margin-bottom:12px;background:var(--paper-2);border:1px solid var(--line);border-radius:var(--radius);align-items:center;gap:8px;font-size:13px;">
    <span id="email-bulk-count">0 selected</span>
    <button class="btn danger" id="email-bulk-del-btn">Delete</button>
    <button class="btn" id="email-select-all-btn" style="margin-left:auto;">Select All</button>
  </div>

  <div class="filters" id="email-filters">
    <button class="active" data-filter="">All</button>
    <button data-filter="draft">Drafts</button>
    <button data-filter="scheduled">Scheduled</button>
    <button data-filter="sent">Sent</button>
    <button data-filter="failed">Failed</button>
  </div>

  <div class="section">
    <div id="email-list"></div>
  </div>
</div>

<!-- Compose Modal -->
<div class="modal-overlay" id="compose-modal">
  <div class="modal">
    <h2 id="compose-title">Compose Email</h2>
    <input type="hidden" id="e-id">
    <label>Recipient Name</label>
    <input type="text" id="e-name" placeholder="Name (for contact lookup)">
    <label>Recipient Email</label>
    <input type="email" id="e-email" placeholder="email@example.com">
    <label>Subject</label>
    <input type="text" id="e-subject" placeholder="Subject line">
    <label>Body <button class="btn" id="ai-draft-btn" style="float:right;">AI Draft</button></label>
    <textarea id="e-body" style="min-height:160px" placeholder="Write your email..."></textarea>
    <div id="tone-buttons" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center;">
      <span class="mono-label" style="padding:5px 0;">Adjust tone</span>
      <button class="btn tone-btn" data-tone="more formal">Formal</button>
      <button class="btn tone-btn" data-tone="more casual">Casual</button>
      <button class="btn tone-btn" data-tone="shorter">Shorter</button>
      <button class="btn tone-btn" data-tone="friendlier">Friendlier</button>
      <button class="btn tone-btn" data-tone="more direct">Direct</button>
    </div>
    <label>Schedule Send (optional)</label>
    <input type="datetime-local" id="e-schedule">
    <div class="modal-actions">
      <button class="btn" id="close-compose-btn">Cancel</button>
      <button class="btn primary" id="save-email-btn">Save Draft</button>
      <button class="btn" id="schedule-btn" style="color:var(--warn);border-color:var(--warn);">Schedule</button>
      <button class="btn" id="send-now-btn" style="color:var(--good);border-color:var(--good);">Send Now</button>
      <button class="btn danger" id="e-delete-btn" style="display:none">Delete</button>
    </div>
  </div>
</div>

<!-- Quick Send Modal -->
<div class="modal-overlay" id="quick-modal">
  <div class="modal">
    <h2>Quick Send</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">
      Example: "Send an email to Mom Tuesday morning at 9AM about dinner plans"
    </p>
    <label>What would you like to send?</label>
    <textarea id="q-input" style="min-height:80px" placeholder="Send an email to [name] [when] about [topic]..."></textarea>
    <div id="q-preview" style="display:none;margin-top:16px;">
      <div class="section" style="margin-bottom:0">
        <h2>Preview</h2>
        <div id="q-preview-content"></div>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="close-quick-btn">Cancel</button>
      <button class="btn primary" id="parse-quick-btn">Parse & Preview</button>
      <button class="btn primary" id="q-confirm" style="display:none">Confirm & Schedule</button>
    </div>
  </div>
</div>

<script>
var curFilter = '';
var emailSelectMode = false, emailSelectedIds = new Set();
function setFilter(btn, f) { curFilter = f; document.querySelectorAll('#email-filters button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); load(); }

function toggleEmailSelect() {
  emailSelectMode = !emailSelectMode; emailSelectedIds.clear();
  document.getElementById('email-select-toggle').textContent = emailSelectMode ? 'Cancel' : 'Select';
  document.getElementById('email-bulk-bar').style.display = emailSelectMode ? 'flex' : 'none';
  document.querySelectorAll('.email-bulk-check').forEach(el => { el.style.display = emailSelectMode ? 'inline-block' : 'none'; el.checked = false; });
  updateEmailBulkCount();
}
function toggleEmailBulkItem(id, checked) { if (checked) emailSelectedIds.add(id); else emailSelectedIds.delete(id); updateEmailBulkCount(); }
function updateEmailBulkCount() { document.getElementById('email-bulk-count').textContent = emailSelectedIds.size + ' selected'; }
function emailSelectAll() { document.querySelectorAll('.email-bulk-check').forEach(el => { el.checked = true; toggleEmailBulkItem(parseInt(el.dataset.id,10), true); }); }
async function emailBulkAction(action) {
  if (!emailSelectedIds.size) return;
  await fetch('/api/bulk/emails', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:Array.from(emailSelectedIds),action:action})});
  emailSelectedIds.clear(); updateEmailBulkCount(); load();
}

async function load() {
  var q = curFilter ? '?status='+curFilter : '';
  var emails = await fetch('/api/emails'+q).then(r=>r.json());
  if (!emails.length) { document.getElementById('email-list').innerHTML = '<div class="empty-msg">No emails found</div>'; return; }
  document.getElementById('email-list').innerHTML = '<table><thead><tr><th style="width:30px;"></th><th>Status</th><th>To</th><th>Subject</th><th>Scheduled</th><th>Actions</th></tr></thead><tbody>' +
    emails.map(e => '<tr><td><input type="checkbox" class="email-bulk-check" data-id="'+e.id+'" style="display:'+(emailSelectMode?'inline-block':'none')+';accent-color:var(--accent);cursor:pointer;"></td><td><span class="badge '+e.status+'">'+e.status+'</span></td><td>'+esc(e.recipient_name||e.recipient_email)+'</td><td>'+esc(e.subject)+'</td><td>'+(e.scheduled_at?new Date(e.scheduled_at).toLocaleString():'—')+'</td><td><div class="todo-actions"><button data-action="edit-email" data-id="'+e.id+'">&#9998;</button><button class="delete" data-action="delete-email" data-id="'+e.id+'">&#10005;</button></div></td></tr>'
    ).join('') + '</tbody></table>';
}

function openCompose() {
  document.getElementById('compose-title').textContent = 'Compose Email';
  document.getElementById('e-id').value = '';
  document.getElementById('e-name').value = '';
  document.getElementById('e-email').value = '';
  document.getElementById('e-subject').value = '';
  document.getElementById('e-body').value = '';
  document.getElementById('e-schedule').value = '';
  document.getElementById('e-delete-btn').style.display = 'none';
  document.getElementById('compose-modal').classList.add('active');
}

async function openEditEmail(id) {
  var emails = await fetch('/api/emails').then(r=>r.json());
  var e = emails.find(x=>x.id===id);
  if (!e) return;
  document.getElementById('compose-title').textContent = 'Edit Email';
  document.getElementById('e-id').value = id;
  document.getElementById('e-name').value = e.recipient_name||'';
  document.getElementById('e-email').value = e.recipient_email;
  document.getElementById('e-subject').value = e.subject;
  document.getElementById('e-body').value = e.body;
  document.getElementById('e-schedule').value = e.scheduled_at?e.scheduled_at.slice(0,16):'';
  document.getElementById('e-delete-btn').style.display = 'inline-flex';
  document.getElementById('compose-modal').classList.add('active');
}

function closeCompose() { document.getElementById('compose-modal').classList.remove('active'); }

// Lookup contact name to auto-fill email
document.getElementById('e-name').addEventListener('blur', async function() {
  var name = this.value.trim();
  if (!name || document.getElementById('e-email').value) return;
  try {
    var c = await fetch('/api/contacts/lookup/'+encodeURIComponent(name)).then(r=>r.ok?r.json():null);
    if (c) document.getElementById('e-email').value = c.email;
  } catch {}
});

async function saveEmail() {
  var data = getEmailData();
  if (!data) return;
  var id = document.getElementById('e-id').value;
  if (id) await fetch('/api/emails/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  else await fetch('/api/emails', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  closeCompose(); load();
}

async function saveAndSchedule() {
  var data = getEmailData();
  if (!data) return;
  if (!data.scheduled_at) return alert('Set a schedule time first');
  data.status = 'scheduled';
  var id = document.getElementById('e-id').value;
  if (id) await fetch('/api/emails/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  else await fetch('/api/emails', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,scheduled_at:data.scheduled_at})});
  closeCompose(); load();
}

async function sendNow() {
  var id = document.getElementById('e-id').value;
  if (!id) { await saveEmail(); var emails = await fetch('/api/emails').then(r=>r.json()); id = emails[0]?.id; }
  if (!id) return;
  var r = await fetch('/api/emails/'+id+'/send', {method:'POST'}).then(r=>r.json());
  if (r.ok) { alert('Email sent!'); closeCompose(); load(); }
  else alert('Failed: '+(r.error||'Unknown error'));
}

async function deleteEmail() {
  var id = document.getElementById('e-id').value;
  await fetch('/api/emails/'+id, {method:'DELETE'});
  closeCompose(); load();
  showUndo('Email moved to trash','email',id);
}

async function deleteEmailDirect(id) {
  await fetch('/api/emails/'+id, {method:'DELETE'});
  load();
  showUndo('Email moved to trash','email',id);
}

function getEmailData() {
  var data = {
    recipient_name: document.getElementById('e-name').value || null,
    recipient_email: document.getElementById('e-email').value,
    subject: document.getElementById('e-subject').value,
    body: document.getElementById('e-body').value,
  };
  var sched = document.getElementById('e-schedule').value;
  if (sched) data.scheduled_at = new Date(sched).toISOString();
  if (!data.recipient_email || !data.subject || !data.body) { alert('Email, subject, and body are required'); return null; }
  return data;
}

// AI Draft
async function aiDraft() {
  var subject = document.getElementById('e-subject').value;
  var name = document.getElementById('e-name').value;
  var prompt = subject || document.getElementById('e-body').value;
  if (!prompt) { prompt = window.prompt('Describe the email you want to write:'); if (!prompt) return; }
  var btn = event.target; btn.textContent = 'Drafting...'; btn.disabled = true;
  try {
    var r = await fetch('/api/ai/draft-email', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt, recipient_name: name})}).then(r=>r.json());
    if (r.error) { alert(r.error); return; }
    if (r.subject) document.getElementById('e-subject').value = r.subject;
    if (r.body) document.getElementById('e-body').value = r.body;
  } catch (err) { alert('AI draft failed: '+err.message); }
  finally { btn.textContent = 'AI Draft'; btn.disabled = false; }
}

// Tone adjustment
async function adjustTone(tone) {
  var body = document.getElementById('e-body').value;
  if (!body) return alert('Write or draft an email first');
  var btns = document.querySelectorAll('.tone-btn');
  btns.forEach(b => { b.disabled = true; });
  try {
    var r = await fetch('/api/ai/adjust-tone', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body, tone})}).then(r=>r.json());
    if (r.error) { alert(r.error); return; }
    if (r.body) document.getElementById('e-body').value = r.body;
  } catch (err) { alert('Tone adjustment failed: '+err.message); }
  finally { btns.forEach(b => { b.disabled = false; }); }
}

// Templates
async function openTemplates() {
  var templates = await fetch('/api/email-templates').then(r=>r.json());
  var html = '<h2>Email Templates</h2>';
  if (templates.length) {
    html += templates.map(t => '<div class="todo-item" style="cursor:pointer" data-action="use-tpl" data-id="'+t.id+'"><div class="todo-content"><div class="todo-title">'+esc(t.name)+'</div><div class="todo-meta"><span>'+esc(t.subject)+'</span></div></div><div class="todo-actions"><button data-action="delete-tpl" data-id="'+t.id+'">&#10005;</button></div></div>').join('');
  } else { html += '<div class="empty-msg">No templates yet</div>'; }
  html += '<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--line);"><h2>Save Current as Template</h2><input type="text" id="tpl-name" placeholder="Template name" style="width:100%;margin-bottom:8px;"><button class="btn primary" data-action="save-tpl">Save Template</button></div>';
  var overlay = document.createElement('div'); overlay.className = 'modal-overlay active'; overlay.id = 'tpl-modal';
  overlay.innerHTML = '<div class="modal">'+html+'<div class="modal-actions"><button class="btn" data-action="close-tpl">Close</button></div></div>';
  document.body.appendChild(overlay);
}
async function useTemplate(id) {
  var templates = await fetch('/api/email-templates').then(r=>r.json());
  var t = templates.find(x=>x.id===id);
  if (!t) return;
  document.getElementById('e-subject').value = t.subject;
  document.getElementById('e-body').value = t.body;
  var tplModal = document.getElementById('tpl-modal');
  if (tplModal) tplModal.remove();
  openCompose();
}
async function saveAsTemplate() {
  var name = document.getElementById('tpl-name').value;
  var subject = document.getElementById('e-subject').value || 'Untitled';
  var body = document.getElementById('e-body').value || '';
  if (!name) return alert('Template name required');
  await fetch('/api/email-templates', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,subject,body})});
  var tplModal = document.getElementById('tpl-modal');
  if (tplModal) tplModal.remove();
  openTemplates();
}
async function deleteTemplate(id) {
  if (!confirm('Delete template?')) return;
  await fetch('/api/email-templates/'+id, {method:'DELETE'});
  var tplModal = document.getElementById('tpl-modal');
  if (tplModal) tplModal.remove();
  openTemplates();
}

// Quick send — natural language parsing
function openQuick() {
  document.getElementById('q-input').value = '';
  document.getElementById('q-preview').style.display = 'none';
  document.getElementById('q-confirm').style.display = 'none';
  document.getElementById('quick-modal').classList.add('active');
}
function closeQuick() { document.getElementById('quick-modal').classList.remove('active'); }

var parsedQuick = null;
async function parseQuick() {
  var input = document.getElementById('q-input').value.trim();
  if (!input) return;
  // Simple NLP: extract name, time, and topic
  var nameMatch = input.match(/(?:to|email)\\s+(\\w+)/i);
  var name = nameMatch ? nameMatch[1] : null;
  var email = null;
  if (name) {
    try {
      var c = await fetch('/api/contacts/lookup/'+encodeURIComponent(name)).then(r=>r.ok?r.json():null);
      if (c) { email = c.email; name = c.name; }
    } catch {}
  }

  // Parse time expressions
  var schedDate = parseTimeExpr(input);

  // Extract topic
  var topicMatch = input.match(/(?:about|regarding|for|re:?)\\s+(.+?)(?:\\s+(?:on|at|this|next|tomorrow|today)|$)/i);
  var topic = topicMatch ? topicMatch[1] : 'Follow up';

  parsedQuick = {
    recipient_name: name,
    recipient_email: email || (name ? name+'@email.com' : ''),
    subject: topic.charAt(0).toUpperCase() + topic.slice(1),
    body: 'Hi' + (name ? ' '+name : '') + ',\\n\\nI wanted to reach out regarding ' + topic.toLowerCase() + '.\\n\\nBest regards',
    scheduled_at: schedDate ? schedDate.toISOString() : null,
  };

  document.getElementById('q-preview-content').innerHTML =
    '<div style="font-size:13px;"><strong>To:</strong> '+esc(name||'?')+' &lt;'+esc(email||'enter email')+'&gt;<br>'+
    '<strong>Subject:</strong> '+esc(parsedQuick.subject)+'<br>'+
    '<strong>Scheduled:</strong> '+(schedDate?schedDate.toLocaleString():'Not scheduled')+'<br><br>'+
    '<div style="white-space:pre-wrap;color:var(--muted)">'+esc(parsedQuick.body)+'</div></div>';
  document.getElementById('q-preview').style.display = 'block';
  document.getElementById('q-confirm').style.display = 'inline-flex';
}

function parseTimeExpr(text) {
  var now = new Date();
  var days = {sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,
              sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6};
  var dayMatch = text.match(/(?:on\\s+|this\\s+|next\\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)/i);
  var timeMatch = text.match(/(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)/i);
  var morningMatch = text.match(/\\bmorning\\b/i);
  var afternoonMatch = text.match(/\\bafternoon\\b/i);
  var eveningMatch = text.match(/\\bevening\\b/i);
  var tomorrowMatch = text.match(/\\btomorrow\\b/i);

  var target = new Date(now);
  if (tomorrowMatch) { target.setDate(target.getDate()+1); }
  else if (dayMatch) {
    var targetDay = days[dayMatch[1].toLowerCase()];
    var diff = (targetDay - now.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    target.setDate(target.getDate() + diff);
  }

  if (timeMatch) {
    var h = parseInt(timeMatch[1]);
    var m = parseInt(timeMatch[2]||'0');
    if (timeMatch[3].toLowerCase() === 'pm' && h < 12) h += 12;
    if (timeMatch[3].toLowerCase() === 'am' && h === 12) h = 0;
    target.setHours(h, m, 0, 0);
  } else if (morningMatch) { target.setHours(9,0,0,0); }
  else if (afternoonMatch) { target.setHours(14,0,0,0); }
  else if (eveningMatch) { target.setHours(18,0,0,0); }
  else { target.setHours(9,0,0,0); }

  return target > now ? target : null;
}

async function confirmQuick() {
  if (!parsedQuick) return;
  if (!parsedQuick.recipient_email || parsedQuick.recipient_email.includes('@email.com')) {
    var em = prompt('Enter recipient email:');
    if (!em) return;
    parsedQuick.recipient_email = em;
  }
  var status = parsedQuick.scheduled_at ? 'scheduled' : 'draft';
  await fetch('/api/emails', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...parsedQuick, status})});
  closeQuick(); load();
}


bindEvents([
  ['compose-btn','click',openCompose],
  ['quick-send-btn','click',openQuick],
  ['templates-btn','click',openTemplates],
  ['email-select-toggle','click',toggleEmailSelect],
  ['email-bulk-del-btn','click',function(){emailBulkAction('delete');}],
  ['email-select-all-btn','click',emailSelectAll],
  ['ai-draft-btn','click',aiDraft],
  ['close-compose-btn','click',closeCompose],
  ['save-email-btn','click',saveEmail],
  ['schedule-btn','click',saveAndSchedule],
  ['send-now-btn','click',sendNow],
  ['e-delete-btn','click',deleteEmail],
  ['close-quick-btn','click',closeQuick],
  ['parse-quick-btn','click',parseQuick],
  ['q-confirm','click',confirmQuick],
]);
onDelegate('tone-buttons','click','[data-tone]',function(){adjustTone(this.dataset.tone);});
onDelegate('email-filters','click','button[data-filter]',function(){setFilter(this,this.dataset.filter);});
document.addEventListener('click',function(e){
  var btn=e.target.closest('[data-action]');
  if(!btn)return;
  var id=parseInt(btn.dataset.id),act=btn.dataset.action;
  e.stopPropagation();
  if(act==='edit-email')openEditEmail(id);
  else if(act==='delete-email')deleteEmailDirect(id);
  else if(act==='use-tpl')useTemplate(id);
  else if(act==='delete-tpl')deleteTemplate(id);
  else if(act==='save-tpl')saveAsTemplate();
  else if(act==='close-tpl'){var m=document.getElementById('tpl-modal');if(m)m.remove();}
});
document.addEventListener('change',function(e){
  if(e.target.classList.contains('email-bulk-check'))toggleEmailBulkItem(parseInt(e.target.dataset.id),e.target.checked);
});

load();
</script>
</body></html>`);
  };
};
