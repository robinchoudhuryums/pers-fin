module.exports = `
// CSRF: auto-inject X-Requested-With on same-origin API calls
(function(){var _f=window.fetch;window.fetch=function(url,opts){
  opts=opts||{};var u=typeof url==='string'?url:(url&&url.url)||'';
  if(u.startsWith('/api/')){opts.headers=opts.headers||{};if(!opts.headers['X-Requested-With'])opts.headers['X-Requested-With']='XMLHttpRequest';}
  return _f.call(this,url,opts);
};})();
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
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
    .replace(/\`([^\`]+)\`/g,'<code style="background:var(--surface-2);padding:1px 5px;border-radius:3px;font-size:11px;">$1</code>')
    .replace(/^- \\[x\\] (.+)$/gm,'<div style="margin:2px 0;"><span style="color:var(--green);margin-right:4px;">&#9745;</span><s style="opacity:0.5;">$1</s></div>')
    .replace(/^- \\[ \\] (.+)$/gm,'<div style="margin:2px 0;"><span style="color:var(--text-muted);margin-right:4px;">&#9744;</span>$1</div>')
    .replace(/^[*-] (.+)$/gm,'<div style="margin:2px 0;padding-left:12px;">&bull; $1</div>')
    .replace(/^\\d+\\. (.+)$/gm,'<div style="margin:2px 0;padding-left:12px;">$1</div>')
    .replace(/^> (.+)$/gm,'<blockquote style="border-left:2px solid var(--warm);padding-left:10px;margin:4px 0;color:var(--text-muted);font-style:italic;">$1</blockquote>')
    .replace(/^---$/gm,'<hr style="border:none;border-top:1px solid var(--border);margin:8px 0;">')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank" style="color:var(--teal);text-decoration:underline;">$1</a>')
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
    offBanner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:var(--yellow);color:#000;text-align:center;padding:6px;font-size:12px;font-weight:500;z-index:9999;';
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
    var cur=pages.indexOf(location.pathname);if(cur<0)return;
    if(dx<0&&cur<pages.length-1)location.href=pages[cur+1];
    else if(dx>0&&cur>0)location.href=pages[cur-1];
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
function showUndo(msg,type,id,action){
  clearTimeout(_undoTimer);
  var el=document.getElementById('undo-toast');
  if(!el){el=document.createElement('div');el.id='undo-toast';el.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface-2);border:1px solid var(--border);padding:12px 20px;border-radius:12px;display:flex;align-items:center;gap:12px;z-index:9999;backdrop-filter:blur(20px);font-size:14px;color:var(--text);box-shadow:0 8px 32px rgba(0,0,0,0.3);';document.body.appendChild(el);}
  var undoAction = action || 'delete';
  el.innerHTML=esc(msg)+' <button data-undo-type="'+type+'" data-undo-id="'+id+'" data-undo-action="'+undoAction+'" style="background:var(--warm);color:#fff;border:none;padding:4px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;">Undo</button>';
  el.style.display='flex';
  _undoTimer=setTimeout(function(){el.style.display='none';},6000);
}
async function undoAction(type,id,action){
  if(action==='delete'){
    await fetch('/api/trash/'+type+'/'+id+'/restore',{method:'POST'});
  } else if(action==='complete'){
    await fetch('/api/todos/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({completed:false})});
  } else if(action==='send'){
    // Can't unsend, but mark as draft
    await fetch('/api/emails/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'draft'})});
  }
  var el=document.getElementById('undo-toast');if(el)el.style.display='none';
  if(typeof load==='function')load();
}
// Backward compat
function undoDelete(type,id){undoAction(type,id,'delete');}
// Global event delegation
document.addEventListener('click',function(e){
  var ub=e.target.closest('[data-undo-type]');
  if(ub){e.stopPropagation();undoAction(ub.dataset.undoType,ub.dataset.undoId,ub.dataset.undoAction);}
  var nt=e.target.closest('#nav-toggle-btn');
  if(nt){document.querySelector('.nav-links').classList.toggle('mobile-open');}
  // Close modal on overlay click (click on .modal-overlay but not .modal content)
  if(e.target.classList.contains('modal-overlay')&&e.target.classList.contains('active')){
    e.target.classList.remove('active');
  }
});
`;
