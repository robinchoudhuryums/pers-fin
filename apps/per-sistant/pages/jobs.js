const { pageHead, navBar, themeScript, nonceAttr } = require("../views");

// Job Radar page. NOTE: this whole module is one template literal — the inline
// JS below must stay backtick-free (string concat only) and avoid regex literals
// (backslashes are eaten by the template string), same as every other page.
module.exports = function () {
  return (req, res) => {
    res.send(`${pageHead("Job Radar")}
<body>
${themeScript()}
${navBar("/jobs")}
<div class="container">
  <h1>Job Radar</h1>
  <p class="subtitle">High-fit, high-trust roles from sanctioned sources. Verify-first leads are listed separately.</p>

  <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
    <label style="margin:0;display:flex;align-items:center;gap:6px;white-space:nowrap;"><input type="checkbox" id="jr-enabled" style="width:auto;"> Enabled</label>
    <button class="primary" id="btn-refresh">Refresh now</button>
    <button id="btn-profile">Edit profile</button>
    <button id="btn-companies">Manage companies</button>
    <span id="refresh-status" role="status" aria-live="polite" style="align-self:center;color:var(--muted);font-size:13px;"></span>
  </div>

  <div id="jr-views" role="group" aria-label="Which listings to show" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:14px;">
    <button data-view="radar" aria-pressed="true">Radar</button>
    <button data-view="saved" aria-pressed="false">Saved</button>
    <button data-view="applied" aria-pressed="false">Applied</button>
    <button data-view="dismissed" aria-pressed="false">Dismissed</button>
  </div>

  <div id="jr-error" role="alert" style="display:none;margin-top:12px;color:var(--danger, #e5534b);"></div>

  <div id="jr-radar">
    <div class="top-cards" id="jr-cards" style="margin-top:14px;"></div>

    <div class="section" style="margin-bottom:24px;">
      <h2>Top matches</h2>
      <div id="jr-main"></div>
    </div>

    <div class="section" style="margin-bottom:24px;">
      <h2>Verify first</h2>
      <p class="subtitle">Borderline trust, not yet fit-scored, or flagged as suspect — confirm before applying.</p>
      <div id="jr-verify"></div>
    </div>
  </div>

  <div id="jr-list-view" class="section" style="display:none;margin:14px 0 24px;">
    <h2 id="jr-list-title"></h2>
    <div id="jr-list"></div>
  </div>
</div>

<div class="modal-overlay" id="profile-modal">
  <div class="modal">
    <h2>Your job profile</h2>
    <label>Preferences (titles, seniority, what you want)</label>
    <textarea id="p-prefs" rows="3" placeholder="Senior backend engineer, remote, Go/Postgres"></textarea>
    <label>Resume / background</label>
    <textarea id="p-resume" rows="5" placeholder="Paste a short resume summary"></textarea>
    <div style="display:flex;gap:8px;">
      <div style="flex:1;"><label>Min salary</label><input type="number" id="p-min-salary" step="1000" style="width:100%;"></div>
      <div style="flex:1;"><label>Remote preference</label>
        <select id="p-remote">
          <option value="any">Any</option>
          <option value="remote">Remote</option>
          <option value="hybrid">Hybrid</option>
          <option value="onsite">Onsite</option>
        </select>
      </div>
    </div>
    <label>Locations (comma-separated)</label>
    <input type="text" id="p-locations" placeholder="Remote, New York, Austin">
    <div class="modal-actions">
      <button id="btn-cancel-profile">Cancel</button>
      <button class="primary" id="btn-save-profile">Save</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="companies-modal">
  <div class="modal">
    <h2>ATS companies to poll</h2>
    <div id="companies-list" style="margin-bottom:12px;"></div>
    <div style="display:flex;gap:8px;align-items:flex-end;">
      <div><label>ATS</label>
        <select id="c-ats">
          <option value="greenhouse">Greenhouse</option>
          <option value="lever">Lever</option>
          <option value="ashby">Ashby</option>
          <option value="workable">Workable</option>
        </select>
      </div>
      <div style="flex:1;"><label>Board slug</label><input type="text" id="c-slug" placeholder="stripe"></div>
      <button class="primary" id="btn-add-company">Add</button>
    </div>
    <div class="modal-actions">
      <button id="btn-close-companies">Close</button>
    </div>
  </div>
</div>

<script${nonceAttr()}>
function money(n){ if(n==null) return ''; return '$'+Number(n).toLocaleString(); }
function fmtSalary(j){ if(j.salary_min||j.salary_max){ return money(j.salary_min)+(j.salary_max?(' - '+money(j.salary_max)):''); } return ''; }
// PUI-7: only http(s) links become an Open button.
function safeUrl(u){ var s = String(u||'').trim(); var l = s.toLowerCase(); return (l.indexOf('https://')===0 || l.indexOf('http://')===0) ? s : ''; }
var currentView = 'radar';

function showError(msg){
  var el = document.getElementById('jr-error');
  if(msg){ el.textContent = msg; el.style.display = 'block'; } else { el.textContent = ''; el.style.display = 'none'; }
}
async function readJson(r){ try { return await r.json(); } catch(e){ return {}; } }

function badges(j){
  var out = '';
  if(j.fit_score!=null){ out += '<span class="badge teal" title="Fit score">Fit '+j.fit_score+'</span> '; }
  else { out += '<span class="badge" title="Not fit-scored yet">Fit ?</span> '; }
  if(j.trust_score!=null){ var cls = j.trust_score>=60?'green':(j.trust_score>=40?'warm':'danger'); out += '<span class="badge '+cls+'" title="Trust score">Trust '+j.trust_score+'</span> '; }
  if(j.legitimacy && j.legitimacy!=='real'){ out += '<span class="badge danger">'+esc(j.legitimacy)+'</span> '; }
  if(j.status==='saved'){ out += '<span class="badge green">saved</span> '; }
  if(j.remote){ out += '<span class="badge">remote</span> '; }
  return out;
}

// Buttons depend on where the listing is now (PUI-4: saved looked identical
// to new, and applied/dismissed listings vanished with no way back).
function actions(j){
  var b = '';
  if(j.status==='saved'){ b += '<button data-action="status" data-status="new" data-id="'+j.id+'">Unsave</button>'; }
  else if(j.status==='new'){ b += '<button data-action="status" data-status="saved" data-id="'+j.id+'">Save</button>'; }
  if(j.status!=='applied'){ b += '<button data-action="status" data-status="applied" data-id="'+j.id+'">Applied</button>'; }
  if(j.status==='dismissed' || j.status==='applied'){ b += '<button data-action="status" data-status="new" data-id="'+j.id+'">Move back to radar</button>'; }
  if(j.status!=='dismissed'){ b += '<button class="danger" data-action="status" data-status="dismissed" data-id="'+j.id+'">Dismiss</button>'; }
  return b;
}

function card(j){
  var sal = fmtSalary(j);
  var url = safeUrl(j.apply_url);
  var rationale = j.fit_rationale ? '<div style="color:var(--muted);font-size:13px;margin-top:4px;">'+esc(j.fit_rationale)+'</div>' : '';
  return '<div class="card" style="margin-bottom:10px;">'
    + '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">'
    +   '<div><strong>'+esc(j.title||'(untitled)')+'</strong>'+(j.company?(' &middot; '+esc(j.company)):'')+'</div>'
    +   '<div>'+badges(j)+'</div>'
    + '</div>'
    + '<div style="color:var(--muted);font-size:13px;margin-top:2px;">'+esc(j.location||'')+(sal?(' &middot; '+sal):'')+(j.apply_domain?(' &middot; '+esc(j.apply_domain)):'')+'</div>'
    + rationale
    + '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">'
    +   (url?('<a class="btn" href="'+escAttr(url)+'" target="_blank" rel="noopener noreferrer">Open</a>'):'')
    +   actions(j)
    + '</div>'
    + '</div>';
}

async function loadRadar(){
  var r = await fetch('/api/jobs');
  var data = await readJson(r);
  if(!r.ok || data.error){
    showError('Could not load Job Radar'+(data.error && data.error !== true ? (': '+data.error) : ' — the server reported an error. Try again shortly.'));
    document.getElementById('jr-cards').innerHTML = '';
    document.getElementById('jr-main').innerHTML = '';
    document.getElementById('jr-verify').innerHTML = '';
    return;
  }
  showError('');
  var counts = data.counts || {main:0,verify_first:0};
  document.getElementById('jr-cards').innerHTML = [
    {label:'Top matches', value: counts.main, cls:'green'},
    {label:'Verify first', value: counts.verify_first, cls:'warm'},
    {label:'Scanned', value: counts.scanned||0, cls:'teal'}
  ].map(function(c){return '<div class="card"><div class="label">'+c.label+'</div><div class="value '+c.cls+'">'+c.value+'</div></div>';}).join('');
  var main = data.main||[], verify = data.verify_first||[];
  document.getElementById('jr-main').innerHTML = main.length ? main.map(card).join('') : '<p class="subtitle">No top matches yet. Set your profile and Refresh.</p>';
  document.getElementById('jr-verify').innerHTML = verify.length ? verify.map(card).join('') : '<p class="subtitle">Nothing to verify.</p>';
}

var VIEW_TITLES = { saved: 'Saved', applied: 'Applied', dismissed: 'Dismissed' };
async function loadList(status){
  var r = await fetch('/api/jobs/list?status='+encodeURIComponent(status));
  var data = await readJson(r);
  document.getElementById('jr-list-title').textContent = VIEW_TITLES[status] || status;
  if(!r.ok){ showError('Could not load '+(VIEW_TITLES[status]||status).toLowerCase()+' listings'+(data.error?(': '+data.error):'.')); document.getElementById('jr-list').innerHTML=''; return; }
  showError('');
  var rows = data.listings || [];
  document.getElementById('jr-list').innerHTML = rows.length ? rows.map(card).join('') : '<p class="subtitle">Nothing here.</p>';
}

async function load(){
  var radar = currentView === 'radar';
  document.getElementById('jr-radar').style.display = radar ? '' : 'none';
  document.getElementById('jr-list-view').style.display = radar ? 'none' : '';
  Array.prototype.forEach.call(document.querySelectorAll('#jr-views [data-view]'), function(b){
    b.setAttribute('aria-pressed', b.dataset.view === currentView ? 'true' : 'false');
    b.classList.toggle('primary', b.dataset.view === currentView);
  });
  try {
    if(radar) await loadRadar(); else await loadList(currentView);
  } catch(e){ showError('Could not reach the server.'); }
}

async function setStatus(id, status){
  try {
    var r = await fetch('/api/jobs/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:status})});
    if(!r.ok){ var d = await readJson(r); alert('Could not update the listing'+(d.error?(': '+d.error):'.')); }
  } catch(e){ alert('Could not reach the server.'); }
  load();
}

async function refresh(){
  var s = document.getElementById('refresh-status');
  var btn = document.getElementById('btn-refresh');
  if(btn.disabled) return;
  btn.disabled = true;
  s.textContent = 'Refreshing...';
  try {
    var resp = await fetch('/api/jobs/refresh?force=1', {method:'POST'});
    var r = await readJson(resp);
    if(!resp.ok || r.ok === false){
      s.textContent = 'Refresh failed'+(r.error?(': '+r.error):'.');
    } else {
      s.textContent = 'Added '+(r.added||0)+' new of '+(r.seen||0)+' seen'+(r.fit_scored?(', '+r.fit_scored+' scored'):'')+(r.capped?' (AI cap reached)':'');
    }
    load();
  } catch(e){ s.textContent = 'Refresh failed — could not reach the server.'; }
  finally { btn.disabled = false; }
}

// ----- Profile modal -------------------------------------------------------
async function openProfile(){
  var r = await fetch('/api/job-profile');
  if(!r.ok){ alert('Could not load your profile.'); return; }
  var p = await readJson(r);
  document.getElementById('p-prefs').value = p.preferences_text || '';
  document.getElementById('p-resume').value = p.resume_text || '';
  document.getElementById('p-min-salary').value = p.min_salary != null ? p.min_salary : '';
  document.getElementById('p-remote').value = p.remote_pref || 'any';
  document.getElementById('p-locations').value = (p.locations||[]).join(', ');
  document.getElementById('profile-modal').classList.add('active');
}
function closeProfile(){ document.getElementById('profile-modal').classList.remove('active'); }
async function saveProfile(){
  var locs = document.getElementById('p-locations').value.split(',').map(function(s){return s.trim();}).filter(Boolean);
  var minSal = document.getElementById('p-min-salary').value;
  var body = {
    preferences_text: document.getElementById('p-prefs').value,
    resume_text: document.getElementById('p-resume').value,
    remote_pref: document.getElementById('p-remote').value,
    locations: locs,
    min_salary: minSal === '' ? null : Number(minSal)
  };
  var r = await fetch('/api/job-profile', {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  var d = await readJson(r);
  if(r.ok){
    closeProfile();
    // PB-4: a profile change clears the fit scores — say so.
    if(d.rescore_needed){ document.getElementById('refresh-status').textContent = 'Profile saved. Refresh to re-score matches against it.'; load(); }
  } else { alert('Could not save profile'+(d.error?(': '+d.error):'.')); }
}

// ----- Companies modal -----------------------------------------------------
async function openCompanies(){
  await renderCompanies();
  document.getElementById('companies-modal').classList.add('active');
}
function closeCompanies(){ document.getElementById('companies-modal').classList.remove('active'); }
async function renderCompanies(){
  var r = await fetch('/api/job-companies');
  var data = await readJson(r);
  if(!r.ok){ document.getElementById('companies-list').innerHTML = '<p class="subtitle">Could not load companies.</p>'; return; }
  var rows = (data.companies||[]).map(function(c){
    return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;">'
      + '<span>'+esc(c.ats)+' / <strong>'+esc(c.slug)+'</strong>'+(c.active?'':' (off)')+'</span>'
      + '<button class="danger" data-action="delCompany" data-id="'+c.id+'" aria-label="Stop polling '+escAttr(c.ats+' / '+c.slug)+'">Remove</button></div>';
  }).join('');
  document.getElementById('companies-list').innerHTML = rows || '<p class="subtitle">None yet.</p>';
}
async function addCompany(){
  var slug = document.getElementById('c-slug').value.trim();
  if(!slug){ return; }
  var body = { slug: slug, ats: document.getElementById('c-ats').value };
  var r = await fetch('/api/job-companies', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r.ok){ document.getElementById('c-slug').value=''; renderCompanies(); }
  else { var d = await readJson(r); alert('Could not add'+(d.error?(': '+d.error):'.')); }
}
async function delCompany(id){
  var r = await fetch('/api/job-companies/'+id, {method:'DELETE'});
  if(!r.ok){ var d = await readJson(r); alert('Could not remove'+(d.error?(': '+d.error):'.')); }
  renderCompanies();
}

// ----- Enable toggle -------------------------------------------------------
async function loadEnabled(){
  try {
    var s = await fetch('/api/settings').then(function(r){return r.json();});
    document.getElementById('jr-enabled').checked = !!s.job_radar_enabled;
  } catch(e){}
}
async function toggleEnabled(){
  var box = document.getElementById('jr-enabled');
  var on = box.checked;
  try {
    var r = await fetch('/api/settings', {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({job_radar_enabled:on})});
    if(r.ok) return;
    var d = await readJson(r);
    alert('Could not save'+(d.error?(': '+d.error):'.'));
  } catch(e){ alert('Could not reach the server.'); }
  box.checked = !on; // the checkbox must not claim a state that wasn't saved
}

// ----- Wiring --------------------------------------------------------------
loadEnabled();
load();
bindEvents([
  ['jr-enabled','change',toggleEnabled],
  ['btn-refresh','click',refresh],
  ['btn-profile','click',openProfile],
  ['btn-cancel-profile','click',closeProfile],
  ['btn-save-profile','click',saveProfile],
  ['btn-companies','click',openCompanies],
  ['btn-close-companies','click',closeCompanies],
  ['btn-add-company','click',addCompany]
]);
onDelegate('jr-views','click','[data-view]',function(){ currentView = this.dataset.view; load(); });
['jr-main','jr-verify','jr-list'].forEach(function(pid){
  onDelegate(pid,'click','[data-action="status"]',function(){ setStatus(parseInt(this.dataset.id, 10), this.dataset.status); });
});
onDelegate('companies-list','click','[data-action="delCompany"]',function(){delCompany(parseInt(this.dataset.id));});
</script>
</body></html>`);
  };
};
