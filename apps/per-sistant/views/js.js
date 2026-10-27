module.exports = `
// CSRF + base-path: auto-inject X-Requested-With on /api/* calls AND
// transparently prepend window.BASE_PATH to root-relative URLs so
// fetch("/api/foo") resolves to "/per-sistant/api/foo" when the app is
// mounted under the unified shell. Standalone deploys leave BASE_PATH
// unset and the wrapper is a no-op for prefixing.
(function(){
  var _f=window.fetch;
  function withBase(u){
    var b=window.BASE_PATH||'';
    if(!b||typeof u!=='string')return u;
    if(u.charAt(0)!=='/'||u.charAt(1)==='/')return u;
    if(u===b||u.indexOf(b+'/')===0)return u;
    return b+u;
  }
  window.withBase=withBase;
  var _authRedirecting=false;
  // indexOf, not a regex: this whole module is one backtick template literal,
  // so regex backslashes (\\/ , \\?) get eaten by the template string. A plain
  // substring match for '/login' is enough for both the loop guard and the
  // redirect-target check.
  function _isLoginPath(p){return (p||'').indexOf('/login')!==-1;}
  window.fetch=function(url,opts){
    opts=opts||{};
    var u=typeof url==='string'?url:(url&&url.url)||'';
    if(u.startsWith('/api/')){opts.headers=opts.headers||{};if(!opts.headers['X-Requested-With'])opts.headers['X-Requested-With']='XMLHttpRequest';}
    return _f.call(this,typeof url==='string'?withBase(url):url,opts).then(function(res){
      // Session expiry (parallels Perfin INV-61): an unauthenticated /api call
      // gets a 401 (XHR/POST) or a 302->/login that fetch transparently follows
      // (GET). Redirect once to the root /login (shell login when embedded,
      // Per-sistant login standalone -- both un-prefixed), loop-guarded, so an
      // idle-timeout sends the user to re-auth instead of leaving a blank page.
      try{
        var expired=res.status===401||(res.redirected&&_isLoginPath(res.url));
        if(expired&&!_authRedirecting&&!_isLoginPath(window.location.pathname)){
          _authRedirecting=true;
          window.location.href='/login';
        }
      }catch(e){}
      return res;
    });
  };
})();
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
// A DATE column (due_date) as a LOCAL-midnight Date for that calendar day
// (F109, parity with Perfin's WUI-2). The API sends 'YYYY-MM-DD' or node-pg's
// UTC-midnight 'YYYY-MM-DDT00:00:00.000Z'; new Date() reads either as UTC
// midnight, which is the PREVIOUS day west of UTC (a task due on the 1st
// landed on the 30th and fell off the month's calendar). String methods only:
// this module is a template literal (see gotcha).
function parseCalDate(v){
  if (!v) return null;
  if (v instanceof Date) return v;
  var s = String(v);
  var tail = s.slice(10);
  if (s.length >= 10 && s.charAt(4) === '-' && s.charAt(7) === '-' &&
      (tail === '' || tail === 'T00:00:00.000Z' || tail === 'T00:00:00Z')) {
    var y = parseInt(s.slice(0, 4), 10), m = parseInt(s.slice(5, 7), 10), d = parseInt(s.slice(8, 10), 10);
    if (y && m && d) return new Date(y, m - 1, d);
  }
  return new Date(s);
}
// Short display for a DATE value ('' when missing).
function fmtCalDate(v){ var d = parseCalDate(v); return d && !isNaN(d.getTime()) ? d.toLocaleDateString() : ''; }
// 'YYYY-MM-DD' of a Date in the browser's local zone.
function ymdOfLocal(d){ var p = function(n){ return String(n).padStart(2, '0'); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
// ISO timestamp -> <input type=datetime-local> value in the BROWSER's local
// time ("YYYY-MM-DDTHH:MM"). The API returns UTC ISO strings; iso.slice(0,16)
// put UTC wall-time in the field, and the save path's new Date(local)
// re-read it as LOCAL time, so every open+save shifted a scheduled email /
// note reminder by the UTC offset (PUI-1). Backslash/backtick-free (template-
// literal module, see gotcha).
function toLocalDatetimeInput(iso){
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var p = function(n){ return String(n).padStart(2,'0'); };
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());
}
// Attribute-safe escape: like esc() but ALSO encodes " and ' so a value placed
// inside an HTML attribute (title="...", value="...") can't break out of the
// quotes. esc() alone is only safe in element-text context. Use escAttr() for
// any attr="'+VALUE+'" interpolation. (& escaped first to avoid double-encoding.)
function escAttr(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
// Linked tasks (roadmap T2.4): a task another app keeps in step carries a chip
// naming that app, linking its source_url through the app's own mount
// (window.LINKED_APP_BASES — '/perfin' under the shell, PERFIN_URL standalone).
// Only a same-app path on an http(s) or root-relative base becomes a link;
// anything else renders as plain text. No regex with a backslash here (INV-97).
// linkedAppHref(app, path) → { href, external } for a same-app path under the
// app's base, or null (no base, a non-http(s) base, a path that isn't one).
// Shared by the chip and the search results' finance links (X3a).
function linkedAppHref(app,u){
  var bases=window.LINKED_APP_BASES||{};
  var base=Object.prototype.hasOwnProperty.call(bases,app)?bases[app]:null;
  var safePath=typeof u==='string'&&u.length>1&&u.charAt(0)==='/'&&u.charAt(1)!=='/'&&u.indexOf(String.fromCharCode(92))<0;
  var rooted=typeof base==='string'&&base.charAt(0)==='/'&&base.charAt(1)!=='/';
  var external=typeof base==='string'&&/^https?:/i.test(base);
  if(!safePath||!(rooted||external))return null;
  if(base.charAt(base.length-1)==='/')base=base.slice(0,-1);
  return {href:base+u,external:external};
}
function linkedTaskChip(t){
  if(!t||!t.source_app)return '';
  var label=t.source_app==='perfin'?'Perfin':String(t.source_app);
  var link=linkedAppHref(t.source_app,t.source_url);
  var title='Kept in step with '+label;
  if(!link)return '<span class="linked-chip" title="'+escAttr(title)+'">'+esc(label)+'</span>';
  return '<a class="linked-chip" href="'+escAttr(link.href)+'"'+(link.external?' target="_blank" rel="noopener"':'')+' title="'+escAttr(title)+'" aria-label="'+escAttr('Open in '+label+': '+(t.title||''))+'">'+esc(label)+'</a>';
}
// Search results (roadmap T2.4 X3b): ONE renderer for the dashboard search
// widget and the /search page. A Per-sistant row links to its page through
// BASE_PATH; a Perfin row (group 'finance') through linkedAppHref, plain text
// without a safe link; a row of an unknown type is left out. opts.actions adds
// the dashboard's inline Complete / Send Now / Pin buttons (its delegation
// handles them); Perfin rows never get actions.
var SEARCH_PAGES={todo:'/todos',email:'/emails',note:'/notes',contact:'/contacts'};
function renderSearchResults(results,opts){
  opts=opts||{};
  if(!Array.isArray(results)||!results.length)return '<div class="empty-msg">No results</div>';
  var bp=window.BASE_PATH||'';
  var linkStyle=' class="result-item" style="display:block;text-decoration:none;color:inherit;"';
  var html=results.map(function(r){
    if(!r||typeof r!=='object')return '';
    var detail=r.description?'<div style="font-size:11px;color:var(--muted);margin-top:2px;">'+esc(r.description)+'</div>':'';
    if(r.group==='finance'){
      var body='<div class="result-type">'+esc(r.type)+' · Perfin</div><div style="font-size:14px;">'+esc(r.title||'')+'</div>'+detail;
      var link=linkedAppHref(r.app,r.url);
      if(!link)return '<div class="result-item">'+body+'</div>';
      return '<a href="'+escAttr(link.href)+'"'+(link.external?' target="_blank" rel="noopener"':'')+linkStyle+'>'+body+'</a>';
    }
    if(!Object.prototype.hasOwnProperty.call(SEARCH_PAGES,r.type))return '';
    var id=parseInt(r.id,10);
    var actions='';
    if(opts.actions&&id>0){
      if(r.type==='todo'&&!r.completed)actions='<button data-action="search-complete" data-id="'+id+'" data-recurring="'+!!r.recurring+'" class="btn">Complete</button>';
      else if(r.type==='email'&&r.status==='scheduled')actions='<button data-action="search-send" data-id="'+id+'" class="btn primary">Send now</button>';
      else if(r.type==='note')actions='<button data-action="search-pin" data-id="'+id+'" data-pinned="'+!!r.pinned+'" class="btn">'+(r.pinned?'Unpin':'Pin')+'</button>';
      if(actions)actions='<div style="display:flex;gap:6px;margin-top:6px;">'+actions+'</div>';
    }
    return '<a href="'+escAttr(bp+SEARCH_PAGES[r.type])+'"'+linkStyle+'><div class="result-type">'+esc(r.type)+(r.type==='todo'&&r.completed?' (done)':'')+'</div><div style="font-size:14px;">'+esc(r.title||'')+'</div>'+detail+actions+'</a>';
  }).join('');
  return html||'<div class="empty-msg">No results</div>';
}
function renderMd(s){
  if(!s)return'';
  return s
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^### (.+)$/gm,'<h4 style="margin:8px 0 4px;font-size:13px;font-weight:600;">$1</h4>')
    .replace(/^## (.+)$/gm,'<h3 style="margin:8px 0 4px;font-size:14px;font-weight:600;">$1</h3>')
    .replace(/^# (.+)$/gm,'<h2 style="margin:8px 0 4px;font-size:15px;font-weight:600;">$1</h2>')
    .replace(/\\*\\*\\*(.+?)\\*\\*\\*/g,'<strong><em>$1</em></strong>')
    .replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g,'<em>$1</em>')
    .replace(/~~(.+?)~~/g,'<del>$1</del>')
    .replace(/\`([^\`]+)\`/g,'<code style="background:var(--paper-2);padding:1px 5px;border-radius:3px;font-size:11px;">$1</code>')
    .replace(/^- \\[x\\] (.+)$/gm,'<div style="margin:2px 0;"><span style="color:var(--good);margin-right:4px;">&#9745;</span><s style="opacity:0.5;">$1</s></div>')
    .replace(/^- \\[ \\] (.+)$/gm,'<div style="margin:2px 0;"><span style="color:var(--muted);margin-right:4px;">&#9744;</span>$1</div>')
    .replace(/^[*-] (.+)$/gm,'<div style="margin:2px 0;padding-left:12px;">&bull; $1</div>')
    .replace(/^\\d+\\. (.+)$/gm,'<div style="margin:2px 0;padding-left:12px;">$1</div>')
    .replace(/^> (.+)$/gm,'<blockquote style="border-left:2px solid var(--accent);padding-left:10px;margin:4px 0;color:var(--muted);font-style:italic;">$1</blockquote>')
    .replace(/^---$/gm,'<hr style="border:none;border-top:1px solid var(--line);margin:8px 0;">')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,function(m,t,u){var url=String(u).trim();var safe=/^(https?:|mailto:)/i.test(url)?url.replace(/"/g,'%22'):'#';return '<a href="'+safe+'" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:underline;">'+t+'</a>';})
    .replace(/\\n/g,'<br>');
}
// Offline detection and sync
window.addEventListener('online', function() {
  document.body.classList.remove('offline');
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage('sync');
  }
  var offBanner = document.getElementById('offline-banner');
  if (offBanner) offBanner.style.display = 'none';
});
window.addEventListener('offline', function() {
  document.body.classList.add('offline');
  var offBanner = document.getElementById('offline-banner');
  if (!offBanner) {
    offBanner = document.createElement('div');
    offBanner.id = 'offline-banner';
    offBanner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:var(--accent-soft);color:var(--ink);border-bottom:1px solid var(--line);text-align:center;padding:6px;font-size:12px;font-weight:500;z-index:9999;';
    offBanner.textContent = 'You are offline. Changes will sync when reconnected.';
    document.body.appendChild(offBanner);
  }
  offBanner.style.display = 'block';
});
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', function(e) {
    if (e.data === 'synced' && typeof load === 'function') load();
  });
}
var _touchStartX=0,_touchStartY=0;
document.addEventListener('touchstart',function(e){_touchStartX=e.changedTouches[0].screenX;_touchStartY=e.changedTouches[0].screenY;},{passive:true});
document.addEventListener('touchend',function(e){
  // Don't swipe-navigate when a modal is open
  if(document.querySelector('.modal-overlay.active'))return;
  var dx=e.changedTouches[0].screenX-_touchStartX,dy=e.changedTouches[0].screenY-_touchStartY;
  if(Math.abs(dx)>100&&Math.abs(dx)>Math.abs(dy)*1.5){
    var pages=['/','/todos','/emails','/notes','/calendar','/contacts','/review','/analytics','/settings'];
    // Strip BASE_PATH so the lookup matches the bare route table; rejoin
    // it on navigation. Standalone (BASE_PATH === "") this is a no-op.
    var b=window.BASE_PATH||'';
    var path=location.pathname;
    if(b && path.indexOf(b)===0) path=path.slice(b.length)||'/';
    var cur=pages.indexOf(path);if(cur<0)return;
    if(dx<0&&cur<pages.length-1)location.href=b+pages[cur+1];
    else if(dx>0&&cur>0)location.href=b+pages[cur-1];
  }
},{passive:true});
// Voice input (Web Speech API)
function startVoiceInput(targetId, onDone) {
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('Voice input not supported in this browser. Try Chrome or Edge.'); return; }
  var recognition = new SR();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = function(e) {
    var text = e.results[0][0].transcript;
    var target = document.getElementById(targetId);
    if (target) {
      if (target.tagName === 'TEXTAREA') target.value += (target.value ? ' ' : '') + text;
      else target.value = text;
    }
    if (onDone) onDone(text);
  };
  recognition.onerror = function(e) { if (e.error !== 'no-speech') console.error('Voice error:', e.error); };
  recognition.start();
}
function bindEvents(bindings){bindings.forEach(function(b){var el=document.getElementById(b[0]);if(el)el.addEventListener(b[1],b[2]);});}
function onDelegate(parentId,event,selector,handler){var p=document.getElementById(parentId);if(!p)return;p.addEventListener(event,function(e){var t=e.target.closest(selector);if(t&&p.contains(t))handler.call(t,e);});}
var _undoTimer=null;
// showUndo(msg, type, id, action, extra) — action 'delete' (default) restores
// from trash; 'complete' re-opens a task; 'complete-recurring' re-opens a
// recurring task AND removes the next instance its completion generated
// (extra = that instance's id). 'info' shows the message with no Undo — used
// after sending an email, which can't be unsent (PUI-3: "Undo" used to flip a
// delivered email back to draft, so the next Send mailed it twice).
// F113: how every write reports its outcome (parity with Perfin's writeOk) —
// true on 2xx; otherwise a toast "<what>: <server error>" (never an Undo) and
// false, so the caller keeps the modal / form open instead of losing what was
// typed. A null res (the fetch threw, e.g. offline) also reports.
async function writeOk(res, what){
  if (res && res.ok) return true;
  var detail = res ? 'HTTP ' + res.status : 'no connection';
  try { var b = await res.clone().json(); if (b && b.error) detail = b.error; } catch (e) { /* not JSON */ }
  showUndo((what || 'Save failed') + ': ' + detail, '', '', 'info');
  return false;
}
// fetch that resolves to null instead of throwing, for use with writeOk.
function tryFetch(url, opts){ return fetch(url, opts).catch(function(){ return null; }); }
// F111: run fn at most once at a time per key (a double-click on Send Now
// used to create and send two emails). Returns undefined while one is running.
var _pending = {};
async function guardPending(key, fn){
  if (_pending[key]) return undefined;
  _pending[key] = true;
  try { return await fn(); } finally { _pending[key] = false; }
}
// ST3: the ONE "button busy while its action runs" helper. Runs fn single-flight
// under key (guardPending), with btn (an element, a NodeList / array of them, or
// null) disabled + aria-busy and, when busyText is given, relabelled — every
// change restored in a finally. Returns undefined while a run with that key is
// in progress. Pages use this instead of toggling .disabled by hand.
async function withPending(btn, key, fn, busyText){
  var list = !btn ? [] : (btn.tagName ? [btn] : Array.prototype.slice.call(btn));
  return guardPending(key, async function(){
    var saved = list.map(function(b){ return { b: b, text: b.textContent, disabled: b.disabled }; });
    list.forEach(function(b){ b.disabled = true; b.setAttribute('aria-busy', 'true'); if (busyText) b.textContent = busyText; });
    try { return await fn(); }
    finally {
      saved.forEach(function(s){ s.b.disabled = s.disabled; s.b.removeAttribute('aria-busy'); if (busyText) s.b.textContent = s.text; });
    }
  });
}
function showUndo(msg,type,id,action,extra){
  clearTimeout(_undoTimer);
  var el=document.getElementById('undo-toast');
  if(!el){el=document.createElement('div');el.id='undo-toast';el.setAttribute('role','status');el.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--paper-card);border:1px solid var(--line);padding:12px 20px;border-radius:12px;display:flex;align-items:center;gap:12px;z-index:9999;backdrop-filter:blur(20px);font-size:14px;color:var(--ink);box-shadow:0 8px 32px rgba(0,0,0,0.3);';document.body.appendChild(el);}
  var undoAction = action || 'delete';
  if(undoAction==='info'||(undoAction==='complete-recurring'&&!extra)){
    el.innerHTML=esc(msg);
  } else {
    el.innerHTML=esc(msg)+' <button data-undo-type="'+escAttr(type)+'" data-undo-id="'+escAttr(id)+'" data-undo-action="'+escAttr(undoAction)+'" data-undo-extra="'+escAttr(extra==null?'':extra)+'" style="background:var(--accent);color:var(--paper);border:none;padding:4px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;">Undo</button>';
  }
  el.style.display='flex';
  _undoTimer=setTimeout(function(){el.style.display='none';},6000);
}
async function undoAction(type,id,action,extra){
  var r=null;
  if(action==='delete'){
    r=await fetch('/api/trash/'+type+'/'+id+'/restore',{method:'POST'});
  } else if(action==='complete'){
    r=await fetch('/api/todos/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({completed:false})});
  } else if(action==='complete-recurring'){
    r=await fetch('/api/todos/'+id+'/undo-complete-recurring',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({next_id:Number(extra)})});
  }
  var el=document.getElementById('undo-toast');if(el)el.style.display='none';
  if(r&&!r.ok){var j=await r.json().catch(function(){return {};});alert(j.error||'Undo failed.');}
  if(typeof load==='function')load();
}
// Backward compat
function undoDelete(type,id){undoAction(type,id,'delete');}
// Global event delegation
document.addEventListener('click',function(e){
  var ub=e.target.closest('[data-undo-type]');
  if(ub){e.stopPropagation();undoAction(ub.dataset.undoType,ub.dataset.undoId,ub.dataset.undoAction,ub.dataset.undoExtra);}
  var nt=e.target.closest('#nav-toggle-btn');
  if(nt){document.querySelector('.nav-links').classList.toggle('mobile-open');}
  // Close modal on overlay click (click on .modal-overlay but not .modal content)
  if(e.target.classList.contains('modal-overlay')&&e.target.classList.contains('active')){
    e.target.classList.remove('active');
  }
});

// ---------------------------------------------------------------------------
// Keyboard access (PUI-5). Custom controls rendered as divs (the task
// complete check, subtask checks, note cards, metric cards, template rows)
// carry role="button"/"checkbox" + tabindex="0"; Enter or Space on one fires
// its click, so the existing click delegation handles it. Esc closes the
// top-most open modal, the same as clicking its backdrop.
// ---------------------------------------------------------------------------
document.addEventListener('keydown',function(e){
  var key=e.key;
  if(key==='Escape'||key==='Esc'){
    var open=document.querySelectorAll('.modal-overlay.active');
    if(open.length){var top=open[open.length-1];if(top.id==='tpl-modal'){top.remove();}else{top.classList.remove('active');}e.preventDefault();}
    return;
  }
  if(key!=='Enter'&&key!==' '&&key!=='Spacebar')return;
  var t=e.target;
  if(!t||!t.getAttribute)return;
  var role=t.getAttribute('role');
  if((role==='button'||role==='checkbox')&&t.tabIndex>=0&&t.tagName!=='BUTTON'&&t.tagName!=='INPUT'&&t.tagName!=='A'){
    e.preventDefault();
    t.click();
  }
});

// Modal dialogs (PUI-5): every .modal inside a .modal-overlay gets
// role="dialog" + aria-modal and a label from its heading; opening one moves
// focus inside, closing it returns focus to whatever opened it. Pages keep
// opening/closing modals by toggling the overlay's "active" class.
(function(){
  var lastFocus=new WeakMap();
  function prep(overlay){
    var box=overlay.querySelector('.modal');
    if(!box)return null;
    if(!box.getAttribute('role')){
      box.setAttribute('role','dialog');
      box.setAttribute('aria-modal','true');
      var h=box.querySelector('h2,h3');
      if(h&&!box.getAttribute('aria-label'))box.setAttribute('aria-label',h.textContent.trim());
    }
    return box;
  }
  function opened(overlay){
    var box=prep(overlay);if(!box)return;
    lastFocus.set(overlay,document.activeElement);
    setTimeout(function(){
      var f=box.querySelector('input:not([type=hidden]):not([disabled]),textarea,select,button:not([disabled]),[tabindex]:not([tabindex="-1"])');
      if(f&&!box.contains(document.activeElement)){try{f.focus();}catch(_){}}
    },0);
  }
  function closed(overlay){
    var prev=lastFocus.get(overlay);
    lastFocus.delete(overlay);
    if(prev&&prev.focus&&document.contains(prev)){try{prev.focus();}catch(_){}}
  }
  function scan(){
    Array.prototype.forEach.call(document.querySelectorAll('.modal-overlay'),function(o){
      var isOpen=o.classList.contains('active');
      var was=o.getAttribute('data-dlg-open')==='1';
      if(isOpen&&!was){o.setAttribute('data-dlg-open','1');opened(o);}
      else if(!isOpen&&was){o.removeAttribute('data-dlg-open');closed(o);}
      else prep(o);
    });
  }
  function start(){
    scan();
    if(window.MutationObserver){
      new MutationObserver(function(muts){
        for(var i=0;i<muts.length;i++){
          var m=muts[i];
          if(m.type==='childList'){
            for(var j=0;j<m.removedNodes.length;j++){var r=m.removedNodes[j];if(r.nodeType===1&&r.classList&&r.classList.contains('modal-overlay')&&r.getAttribute('data-dlg-open')==='1'){closed(r);}}
          }
        }
        scan();
      }).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
    }
  }
  if(document.body)start();else document.addEventListener('DOMContentLoaded',start);
})();

// ---------------------------------------------------------------------------
// Pull-to-refresh (standalone PWA mode only). iOS home-screen PWAs don't get
// Safari's native pull-to-refresh, so this fills the gap: drag down from the
// very top of the page past the threshold and release to reload. Inactive in
// regular browser tabs (the browser's own gesture exists there) and while a
// modal/panel is open. Passive listeners only — never blocks scrolling.
// ---------------------------------------------------------------------------
(function initPullToRefresh() {
  // Active in the installed PWA (display-mode: standalone) AND inside the
  // Capacitor iOS wrapper (which reports display-mode: browser but exposes
  // window.Capacitor). Regular Safari tabs keep the native gesture.
  try {
    var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    if (!standalone && !window.Capacitor) return;
  } catch (_) { return; }
  var THRESHOLD = 75, MAX_PULL = 130;
  var startY = 0, startX = 0, dist = 0, active = false, refreshing = false, el = null;
  function indicator() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ptr-indicator';
    el.setAttribute('aria-hidden', 'true');
    var ring = document.createElement('div');
    ring.className = 'ptr-ring';
    el.appendChild(ring);
    document.body.appendChild(el);
    return el;
  }
  document.addEventListener('touchstart', function (e) {
    if (refreshing || e.touches.length !== 1) return;
    var scroller = document.scrollingElement || document.documentElement;
    if (scroller.scrollTop > 0) return;
    // Don't hijack pulls that start inside overlays/panels with their own scroll.
    if (e.target.closest && e.target.closest('.notif-panel, .modal-backdrop, .modal-overlay, dialog, .pyramid-stage, canvas')) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    dist = 0; active = true;
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!active || refreshing) return;
    var dy = e.touches[0].clientY - startY;
    var dx = Math.abs(e.touches[0].clientX - startX);
    if (dy <= 0 || dx > Math.abs(dy)) { if (dy < -10) active = false; return; }
    dist = Math.min(dy, MAX_PULL);
    if (dist > 12) {
      var ind = indicator();
      ind.style.opacity = String(Math.min(1, dist / THRESHOLD));
      ind.style.transform = 'translateX(-50%) translateY(' + (dist * 0.45) + 'px) rotate(' + (dist * 2.2) + 'deg)';
      if (dist >= THRESHOLD) ind.classList.add('ptr-ready');
      else ind.classList.remove('ptr-ready');
    }
  }, { passive: true });
  document.addEventListener('touchend', function () {
    if (!active || refreshing) return;
    active = false;
    if (dist >= THRESHOLD) {
      refreshing = true;
      var ind = indicator();
      ind.classList.add('ptr-refreshing');
      ind.style.transform = 'translateX(-50%) translateY(28px)';
      location.reload();
    } else if (el) {
      el.style.opacity = '0';
      el.classList.remove('ptr-ready');
      el.style.transform = 'translateX(-50%)';
    }
    dist = 0;
  }, { passive: true });
})();

// ---------------------------------------------------------------------------
// Ask Per-sistant — global popover triggered from the appbar (#ask-ps-btn).
// Posts to /api/ai/query (the same endpoint the retired dashboard "Ask your
// assistant" card used) so the assistant Q&A is reachable from every page.
// Built lazily on first open; event delegation means it works regardless of
// when the nav renders. Backtick-free (this whole module is a template literal).
// ---------------------------------------------------------------------------
(function initAskPopover() {
  var pop = null, input = null, answer = null, sendBtn = null, trigger = null;
  function build() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'ask-ps-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Ask Per-sistant');
    pop.hidden = true;
    pop.innerHTML =
      '<div class="ask-ps-head"><span class="ask-ps-title">Ask your assistant</span>' +
      '<button type="button" class="ask-ps-close" aria-label="Close">&#10005;</button></div>' +
      '<div class="ask-ps-row"><input type="text" class="ask-ps-input" ' +
      'placeholder="What did I do last week? How many tasks are overdue?">' +
      '<button type="button" class="ask-ps-send btn primary">Ask</button></div>' +
      '<div class="ask-ps-answer" hidden></div>';
    document.body.appendChild(pop);
    input = pop.querySelector('.ask-ps-input');
    answer = pop.querySelector('.ask-ps-answer');
    sendBtn = pop.querySelector('.ask-ps-send');
    pop.querySelector('.ask-ps-close').addEventListener('click', close);
    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    return pop;
  }
  function open() {
    build();
    pop.hidden = false;
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    setTimeout(function () { if (input) input.focus(); }, 30);
  }
  function close() {
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
  function submit() {
    var q = (input.value || '').trim();
    if (!q) return;
    answer.hidden = false;
    answer.textContent = 'Thinking…';
    withPending(sendBtn, 'ask', function () {
      return fetch('/api/ai/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      }).then(function (r) { return r.json(); }).then(function (r) {
        answer.textContent = (r && r.answer) || 'No answer available.';
      }).catch(function (err) {
        answer.textContent = 'Error: ' + ((err && err.message) || 'request failed');
      });
    });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('#ask-ps-btn');
    if (t) { e.preventDefault(); trigger = t; if (pop && !pop.hidden) close(); else open(); return; }
    if (pop && !pop.hidden && !e.target.closest('#ask-ps-popover')) close();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
})();
`;
