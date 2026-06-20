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
    <span id="refresh-status" style="align-self:center;color:var(--muted);font-size:13px;"></span>
  </div>

  <div class="top-cards" id="jr-cards" style="margin-top:14px;"></div>

  <div class="section" style="margin-bottom:24px;">
    <h2>Top matches</h2>
    <div id="jr-main"></div>
  </div>

  <div class="section" style="margin-bottom:24px;">
    <h2>Verify first</h2>
    <p class="subtitle">Borderline trust — confirm legitimacy before applying.</p>
    <div id="jr-verify"></div>
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

function badges(j){
  var out = '';
  if(j.fit_score!=null){ out += '<span class="badge teal" title="Fit score">Fit '+j.fit_score+'</span> '; }
  if(j.trust_score!=null){ var cls = j.trust_score>=60?'green':(j.trust_score>=40?'warm':'danger'); out += '<span class="badge '+cls+'" title="Trust score">Trust '+j.trust_score+'</span> '; }
  if(j.legitimacy && j.legitimacy!=='real'){ out += '<span class="badge danger">'+esc(j.legitimacy)+'</span> '; }
  if(j.remote){ out += '<span class="badge">remote</span> '; }
  return out;
}

function card(j){
  var sal = fmtSalary(j);
  var rationale = j.fit_rationale ? '<div style="color:var(--muted);font-size:13px;margin-top:4px;">'+esc(j.fit_rationale)+'</div>' : '';
  return '<div class="card" style="margin-bottom:10px;">'
    + '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">'
    +   '<div><strong>'+esc(j.title||'(untitled)')+'</strong>'+(j.company?(' &middot; '+esc(j.company)):'')+'</div>'
    +   '<div>'+badges(j)+'</div>'
    + '</div>'
    + '<div style="color:var(--muted);font-size:13px;margin-top:2px;">'+esc(j.location||'')+(sal?(' &middot; '+sal):'')+(j.apply_domain?(' &middot; '+esc(j.apply_domain)):'')+'</div>'
    + rationale
    + '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">'
    +   (j.apply_url?('<a class="btn" href="'+escAttr(j.apply_url)+'" target="_blank" rel="noopener noreferrer">Open</a>'):'')
    +   '<button data-action="save" data-id="'+j.id+'">Save</button>'
    +   '<button data-action="applied" data-id="'+j.id+'">Applied</button>'
    +   '<button class="danger" data-action="dismiss" data-id="'+j.id+'">Dismiss</button>'
    + '</div>'
    + '</div>';
}

async function load(){
  var data = await fetch('/api/jobs').then(function(r){return r.json();});
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

async function setStatus(id, status){
  await fetch('/api/jobs/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:status})});
  load();
}

async function refresh(){
  var s = document.getElementById('refresh-status');
  s.textContent = 'Refreshing...';
  try {
    var r = await fetch('/api/jobs/refresh', {method:'POST'}).then(function(r){return r.json();});
    s.textContent = 'Added '+(r.added||0)+' new of '+(r.seen||0)+' seen'+(r.fit_scored?(', '+r.fit_scored+' scored'):'')+(r.capped?' (AI cap reached)':'');
    load();
  } catch(e){ s.textContent = 'Refresh failed.'; }
}

// ----- Profile modal -------------------------------------------------------
async function openProfile(){
  var p = await fetch('/api/job-profile').then(function(r){return r.json();});
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
  if(r.ok){ closeProfile(); } else { alert('Could not save profile.'); }
}

// ----- Companies modal -----------------------------------------------------
async function openCompanies(){
  await renderCompanies();
  document.getElementById('companies-modal').classList.add('active');
}
function closeCompanies(){ document.getElementById('companies-modal').classList.remove('active'); }
async function renderCompanies(){
  var data = await fetch('/api/job-companies').then(function(r){return r.json();});
  var rows = (data.companies||[]).map(function(c){
    return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;">'
      + '<span>'+esc(c.ats)+' / <strong>'+esc(c.slug)+'</strong>'+(c.active?'':' (off)')+'</span>'
      + '<button class="danger" data-action="delCompany" data-id="'+c.id+'">Remove</button></div>';
  }).join('');
  document.getElementById('companies-list').innerHTML = rows || '<p class="subtitle">None yet.</p>';
}
async function addCompany(){
  var slug = document.getElementById('c-slug').value.trim();
  if(!slug){ return; }
  var body = { slug: slug, ats: document.getElementById('c-ats').value };
  var r = await fetch('/api/job-companies', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r.ok){ document.getElementById('c-slug').value=''; renderCompanies(); } else { alert('Could not add.'); }
}
async function delCompany(id){
  await fetch('/api/job-companies/'+id, {method:'DELETE'});
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
  var on = document.getElementById('jr-enabled').checked;
  await fetch('/api/settings', {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({job_radar_enabled:on})});
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
onDelegate('jr-main','click','[data-action="save"]',function(){setStatus(parseInt(this.dataset.id),'saved');});
onDelegate('jr-main','click','[data-action="applied"]',function(){setStatus(parseInt(this.dataset.id),'applied');});
onDelegate('jr-main','click','[data-action="dismiss"]',function(){setStatus(parseInt(this.dataset.id),'dismissed');});
onDelegate('jr-verify','click','[data-action="save"]',function(){setStatus(parseInt(this.dataset.id),'saved');});
onDelegate('jr-verify','click','[data-action="applied"]',function(){setStatus(parseInt(this.dataset.id),'applied');});
onDelegate('jr-verify','click','[data-action="dismiss"]',function(){setStatus(parseInt(this.dataset.id),'dismissed');});
onDelegate('companies-list','click','[data-action="delCompany"]',function(){delCompany(parseInt(this.dataset.id));});
</script>
</body></html>`);
  };
};
