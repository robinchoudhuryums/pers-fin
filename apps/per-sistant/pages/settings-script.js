// ============================================================================
// Per-sistant — Settings page client-side script
// ============================================================================
// Extracted from pages/settings.js so the shell stays under the stream
// timeout threshold. Legacy --surface/--warm/--teal/--red/--green/--blue
// tokens swapped to --paper-2/--accent/--good/--warn/--muted/--line.
module.exports = `
function applyTheme(t) {
  var effective = t;
  if (t === 'auto') effective = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  if (effective === 'light') document.documentElement.setAttribute('data-theme','light');
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('theme', t);
}
async function load() {
  var s = await fetch('/api/settings').then(r=>r.json());
  document.getElementById('s-theme').value = s.theme || 'dark';
  document.getElementById('s-timeout').value = s.session_timeout_minutes || 15;
  document.getElementById('s-horizon').value = s.default_horizon || 'short';
  document.getElementById('s-perfin').value = s.perfin_url || '';
  document.getElementById('smtp-status').textContent = s.smtp_configured
    ? 'SMTP is configured and ready to send emails.'
    : 'SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env to enable email sending.';
  document.getElementById('ai-status').textContent = s.ai_configured
    ? 'Claude AI is configured. Manage model preferences for each feature below.'
    : 'Not configured. Set ANTHROPIC_API_KEY in .env to enable AI features.';
  if (s.ai_configured) {
    document.getElementById('ai-models-section').style.display = 'block';
    try {
      var models = await fetch('/api/ai/models').then(r=>r.json());
      var features = ['email_draft','task_breakdown','quick_add','review_summary','email_tone','daily_briefing','note_tagging'];
      features.forEach(f => {
        var el = document.getElementById('aim-'+f);
        if (el) el.value = models['ai_model_'+f] || 'off';
      });
    } catch {}
  }
  document.getElementById('s-slack').value = s.slack_webhook_url || '';
  // Keep-alive
  document.getElementById('ka-enabled').checked = !!s.keep_alive_enabled;
  document.getElementById('ka-start').value = s.keep_alive_start != null ? s.keep_alive_start : 6;
  document.getElementById('ka-end').value = s.keep_alive_end != null ? s.keep_alive_end : 0;
  document.getElementById('ka-tz').value = s.keep_alive_timezone || 'America/New_York';
  updateKAEstimate();
  if ('Notification' in window && Notification.permission === 'granted') {
    document.getElementById('notif-btn').textContent = 'Notifications Enabled';
    document.getElementById('notif-btn').disabled = true;
  }

  // Apply theme
  applyTheme(s.theme || 'dark');
}

async function saveSettings() {
  var data = {
    theme: document.getElementById('s-theme').value,
    session_timeout_minutes: parseInt(document.getElementById('s-timeout').value) || 15,
    default_horizon: document.getElementById('s-horizon').value,
    perfin_url: document.getElementById('s-perfin').value || null,
  };
  await fetch('/api/settings', {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});

  // Apply theme immediately
  applyTheme(data.theme);

  var el = document.getElementById('status');
  el.className = 'status-msg success';
  el.textContent = 'Settings saved.';
  setTimeout(()=>{ el.className = 'status-msg'; }, 3000);
}

async function exportData(type) {
  var data = await fetch('/api/'+type).then(r=>r.json());
  var blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = type+'-export-'+new Date().toISOString().split('T')[0]+'.json';
  a.click();
}

async function saveAIModels() {
  var data = {};
  var features = ['email_draft','task_breakdown','quick_add','review_summary','email_tone','daily_briefing','note_tagging'];
  features.forEach(f => { data['ai_model_'+f] = document.getElementById('aim-'+f).value; });
  await fetch('/api/ai/models', {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  var el = document.getElementById('status');
  el.className = 'status-msg success';
  el.textContent = 'AI model preferences saved.';
  setTimeout(()=>{ el.className = 'status-msg'; }, 3000);
}

async function enableNotifications() {
  if (!('Notification' in window)) return alert('Browser does not support notifications');
  var perm = await Notification.requestPermission();
  if (perm === 'granted') {
    document.getElementById('notif-btn').textContent = 'Notifications Enabled';
    document.getElementById('notif-btn').disabled = true;
    new Notification('Per-sistant', { body: 'Notifications enabled! You will be notified about reminders and overdue tasks.' });
  }
}

async function loadTrash() {
  var items = await fetch('/api/trash').then(r=>r.json());
  var el = document.getElementById('trash-list');
  if (!items.length) { el.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0;">Trash is empty.</div>'; return; }
  el.innerHTML = items.map(function(item) {
    var d = new Date(item.deleted_at).toLocaleDateString();
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px;">'
      +'<div><span style="font-family:var(--mono);color:var(--muted);font-size:10px;margin-right:8px;letter-spacing:0.08em;text-transform:uppercase;">'+item.type+'</span>'+esc(item.title||'Untitled')+'<span style="font-family:var(--mono);color:var(--muted);font-size:10px;margin-left:8px;letter-spacing:0.04em;">deleted '+d+'</span></div>'
      +'<div style="display:flex;gap:6px;">'
      +'<button class="btn" data-action="restore" data-type="'+item.type+'" data-id="'+item.id+'" style="color:var(--good);border-color:var(--good);">Restore</button>'
      +'<button class="btn danger" data-action="perm-delete" data-type="'+item.type+'" data-id="'+item.id+'">Delete</button>'
      +'</div></div>';
  }).join('');
}

async function restoreItem(type, id) {
  await fetch('/api/trash/'+type+'/'+id+'/restore', {method:'POST'});
  loadTrash();
  var el = document.getElementById('status');
  el.className = 'status-msg success'; el.textContent = 'Item restored.';
  setTimeout(function(){ el.className = 'status-msg'; }, 3000);
}

async function permanentDelete(type, id) {
  if (!confirm('Permanently delete this item? This cannot be undone.')) return;
  await fetch('/api/trash/'+type+'/'+id, {method:'DELETE'});
  loadTrash();
}

async function emptyTrash() {
  if (!confirm('Permanently delete all items in trash? This cannot be undone.')) return;
  await fetch('/api/trash/empty', {method:'POST'});
  loadTrash();
  var el = document.getElementById('status');
  el.className = 'status-msg success'; el.textContent = 'Trash emptied.';
  setTimeout(function(){ el.className = 'status-msg'; }, 3000);
}

// Automations
async function loadAutomations() {
  var autos = await fetch('/api/automations').then(r=>r.json());
  var el = document.getElementById('automations-list');
  if (!autos.length) { el.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0;">No automation rules configured.</div>'; return; }
  el.innerHTML = autos.map(a => {
    var condText = '';
    if (a.conditions) {
      var keys = Object.keys(a.conditions).filter(k=>a.conditions[k]);
      condText = keys.length ? ' when ' + keys.map(k=>k+'='+a.conditions[k]).join(' & ') : '';
    }
    var onClass = a.enabled ? 'class="btn" style="color:var(--good);border-color:var(--good);"' : 'class="btn"';
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);font-size:13px;">'
      +'<div style="flex:1;"><div>'+esc(a.name)+'</div>'
      +'<div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:2px;letter-spacing:0.04em;">'+a.trigger_type+condText+' &rarr; '+a.action_type+'</div></div>'
      +'<div style="display:flex;gap:6px;align-items:center;">'
      +'<button '+onClass+' data-action="toggle-auto" data-id="'+a.id+'" data-enabled="'+a.enabled+'">'+(a.enabled?'On':'Off')+'</button>'
      +'<button class="btn" data-action="edit-auto" data-id="'+a.id+'">Edit</button>'
      +'</div></div>';
  }).join('');
}
function openAutoModal() {
  document.getElementById('auto-modal-title').textContent = 'New Automation';
  document.getElementById('auto-id').value = '';
  document.getElementById('auto-name').value = '';
  document.getElementById('auto-trigger').value = 'todo_created';
  document.getElementById('auto-cond-field').value = '';
  document.getElementById('auto-cond-value').value = '';
  document.getElementById('auto-action').value = 'set_priority';
  document.getElementById('auto-action-value').value = '';
  document.getElementById('auto-delete-btn').style.display = 'none';
  document.getElementById('auto-modal').classList.add('active');
}
function closeAutoModal() { document.getElementById('auto-modal').classList.remove('active'); }
async function editAutomation(id) {
  var autos = await fetch('/api/automations').then(r=>r.json());
  var a = autos.find(x=>x.id===id); if (!a) return;
  document.getElementById('auto-modal-title').textContent = 'Edit Automation';
  document.getElementById('auto-id').value = id;
  document.getElementById('auto-name').value = a.name;
  document.getElementById('auto-trigger').value = a.trigger_type;
  var condKeys = Object.keys(a.conditions||{}).filter(k=>a.conditions[k]);
  document.getElementById('auto-cond-field').value = condKeys[0] || '';
  document.getElementById('auto-cond-value').value = condKeys.length ? a.conditions[condKeys[0]] : '';
  document.getElementById('auto-action').value = a.action_type;
  var actData = a.action_data||{};
  document.getElementById('auto-action-value').value = actData[Object.keys(actData)[0]] || '';
  document.getElementById('auto-delete-btn').style.display = 'inline-flex';
  document.getElementById('auto-modal').classList.add('active');
}
async function saveAutomation() {
  var id = document.getElementById('auto-id').value;
  var condField = document.getElementById('auto-cond-field').value;
  var condValue = document.getElementById('auto-cond-value').value;
  var actionType = document.getElementById('auto-action').value;
  var actionValue = document.getElementById('auto-action-value').value;
  var conditions = {};
  if (condField && condValue) conditions[condField] = condValue;
  var actionKey = actionType === 'set_priority' ? 'priority' : actionType === 'set_category' ? 'category' : actionType === 'set_horizon' ? 'horizon' : actionType === 'add_tag' ? 'tag' : 'title';
  var action_data = {}; action_data[actionKey] = actionValue;
  var data = {
    name: document.getElementById('auto-name').value,
    trigger_type: document.getElementById('auto-trigger').value,
    conditions: conditions,
    action_type: actionType,
    action_data: action_data,
  };
  if (!data.name) return alert('Name is required');
  if (id) await fetch('/api/automations/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  else await fetch('/api/automations', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  closeAutoModal(); loadAutomations();
}
async function deleteAutomation() {
  var id = document.getElementById('auto-id').value;
  await fetch('/api/automations/'+id, {method:'DELETE'});
  closeAutoModal(); loadAutomations();
}
async function toggleAutomation(id, enabled) {
  await fetch('/api/automations/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
  loadAutomations();
}
function updateActionFields() {}

// Webhooks
async function loadWebhooks() {
  var whs = await fetch('/api/webhooks').then(r=>r.json());
  var el = document.getElementById('webhooks-list');
  if (!whs.length) { el.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0;">No webhooks configured.</div>'; return; }
  el.innerHTML = whs.map(w =>
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);font-size:13px;">'
    +'<div style="flex:1;"><div>'+esc(w.name)+'</div>'
    +'<div style="font-family:var(--mono);font-size:10px;color:var(--muted);margin-top:2px;letter-spacing:0.04em;">'+esc(w.url.substring(0,50))+(w.url.length>50?'...':'')+'</div>'
    +'<div style="font-family:var(--mono);font-size:9px;color:var(--muted);margin-top:2px;letter-spacing:0.08em;">Events: '+(w.events||[]).join(', ')+(w.last_status?' &middot; Last: '+w.last_status:'')+'</div></div>'
    +'<div style="display:flex;gap:6px;align-items:center;">'
    +'<button class="btn" data-action="test-wh" data-id="'+w.id+'" style="color:var(--accent);border-color:var(--accent);">Test</button>'
    +'<button class="btn" data-action="toggle-wh" data-id="'+w.id+'" data-enabled="'+w.enabled+'"'+(w.enabled?' style="color:var(--good);border-color:var(--good);"':'')+'>'+(w.enabled?'On':'Off')+'</button>'
    +'<button class="btn" data-action="edit-wh" data-id="'+w.id+'">Edit</button>'
    +'</div></div>'
  ).join('');
}
function openWebhookModal() {
  document.getElementById('wh-modal-title').textContent='New Webhook';
  document.getElementById('wh-id').value='';
  document.getElementById('wh-name').value='';
  document.getElementById('wh-url').value='';
  document.querySelectorAll('#wh-events input').forEach(cb=>cb.checked=false);
  document.getElementById('wh-delete-btn').style.display='none';
  document.getElementById('webhook-modal').classList.add('active');
}
function closeWebhookModal() { document.getElementById('webhook-modal').classList.remove('active'); }
async function editWebhook(id) {
  var whs = await fetch('/api/webhooks').then(r=>r.json());
  var w = whs.find(x=>x.id===id); if (!w) return;
  document.getElementById('wh-modal-title').textContent='Edit Webhook';
  document.getElementById('wh-id').value=id;
  document.getElementById('wh-name').value=w.name;
  document.getElementById('wh-url').value=w.url;
  document.querySelectorAll('#wh-events input').forEach(cb=>{cb.checked=(w.events||[]).includes(cb.value);});
  document.getElementById('wh-delete-btn').style.display='inline-flex';
  document.getElementById('webhook-modal').classList.add('active');
}
async function saveWebhook() {
  var events=[];document.querySelectorAll('#wh-events input:checked').forEach(cb=>events.push(cb.value));
  var data={name:document.getElementById('wh-name').value,url:document.getElementById('wh-url').value,events:events};
  if(!data.name||!data.url)return alert('Name and URL required');
  var id=document.getElementById('wh-id').value;
  if(id) await fetch('/api/webhooks/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  else await fetch('/api/webhooks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  closeWebhookModal();loadWebhooks();
}
async function deleteWebhook() {
  var id=document.getElementById('wh-id').value;
  await fetch('/api/webhooks/'+id,{method:'DELETE'});
  closeWebhookModal();loadWebhooks();
}
async function toggleWebhook(id,enabled) {
  await fetch('/api/webhooks/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
  loadWebhooks();
}
async function testWebhook(id) {
  var r=await fetch('/api/webhooks/'+id+'/test',{method:'POST'}).then(r=>r.json());
  alert(r.ok?'Webhook test successful (status: '+r.status+')':'Webhook test failed'+(r.status?' (status: '+r.status+')':''));
  loadWebhooks();
}

// Slack
async function saveSlack() {
  var url=document.getElementById('s-slack').value||null;
  await fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({slack_webhook_url:url})});
  var el=document.getElementById('status');el.className='status-msg success';el.textContent='Slack webhook saved.';
  setTimeout(function(){el.className='status-msg';},3000);
}

async function logout() {
  await fetch('/api/logout', {method:'POST'});
  location.href = '/login';
}

// Keep-alive hour selectors
(function(){
  var startSel=document.getElementById('ka-start');
  var endSel=document.getElementById('ka-end');
  for(var h=0;h<24;h++){
    var label=h===0?'12 AM':h<12?h+' AM':h===12?'12 PM':(h-12)+' PM';
    startSel.innerHTML+='<option value="'+h+'">'+label+'</option>';
    endSel.innerHTML+='<option value="'+h+'">'+label+'</option>';
  }
  startSel.value='6'; endSel.value='0';
})();
function updateKAEstimate(){
  var start=parseInt(document.getElementById('ka-start').value);
  var end=parseInt(document.getElementById('ka-end').value);
  var el=document.getElementById('ka-estimate');
  if(start===end){el.textContent='24/7 — ~103 pings/day';return;}
  var hours=start<end?end-start:24-start+end;
  var pings=Math.ceil(hours*60/14);
  el.textContent=hours+'h active — ~'+pings+' pings/day';
}
document.getElementById('ka-start').addEventListener('change',updateKAEstimate);
document.getElementById('ka-end').addEventListener('change',updateKAEstimate);
async function saveKeepAlive(){
  var data={
    keep_alive_enabled:document.getElementById('ka-enabled').checked,
    keep_alive_start:parseInt(document.getElementById('ka-start').value),
    keep_alive_end:parseInt(document.getElementById('ka-end').value),
    keep_alive_timezone:document.getElementById('ka-tz').value,
  };
  await fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  var el=document.getElementById('status');el.className='status-msg success';el.textContent='Keep-alive settings saved.';
  setTimeout(function(){el.className='status-msg';},3000);
}
load();
loadAutomations();
loadWebhooks();
bindEvents([
  ['s-theme','change',saveSettings],
  ['s-horizon','change',saveSettings],
  ['save-timeout-btn','click',saveSettings],
  ['save-perfin-btn','click',saveSettings],
  ['notif-btn','click',enableNotifications],
  ['view-trash-btn','click',loadTrash],
  ['empty-trash-btn','click',emptyTrash],
  ['new-auto-btn','click',openAutoModal],
  ['new-webhook-btn','click',openWebhookModal],
  ['save-slack-btn','click',saveSlack],
  ['save-keepalive-btn','click',saveKeepAlive],
  ['logout-btn','click',logout],
  ['auto-action','change',updateActionFields],
  ['auto-cancel-btn','click',closeAutoModal],
  ['auto-save-btn','click',saveAutomation],
  ['auto-delete-btn','click',deleteAutomation],
  ['wh-cancel-btn','click',closeWebhookModal],
  ['wh-save-btn','click',saveWebhook],
  ['wh-delete-btn','click',deleteWebhook],
]);
document.querySelectorAll('.aim-select').forEach(function(el){el.addEventListener('change',saveAIModels);});
document.addEventListener('click',function(e){
  var exp=e.target.closest('[data-export]');
  if(exp)exportData(exp.dataset.export);
});
onDelegate('trash-list','click','[data-action]',function(){
  var id=this.dataset.id,type=this.dataset.type;
  if(this.dataset.action==='restore')restoreItem(type,id);
  else if(this.dataset.action==='perm-delete')permanentDelete(type,id);
});
onDelegate('automations-list','click','[data-action]',function(){
  var id=parseInt(this.dataset.id);
  if(this.dataset.action==='toggle-auto')toggleAutomation(id,this.dataset.enabled==='true');
  else if(this.dataset.action==='edit-auto')editAutomation(id);
});
onDelegate('webhooks-list','click','[data-action]',function(){
  var id=parseInt(this.dataset.id);
  if(this.dataset.action==='test-wh')testWebhook(id);
  else if(this.dataset.action==='toggle-wh')toggleWebhook(id,this.dataset.enabled==='true');
  else if(this.dataset.action==='edit-wh')editWebhook(id);
});
`;
