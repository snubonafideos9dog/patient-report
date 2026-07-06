/* === NATIVE HOST STUB (patched for WPF/WebView2 embed) ===
   원본 Firebase 로그인/reCAPTCHA/Cloudflare 인증 블록을 제거하고
   오프라인 풀권한으로 대체한다. 인터넷/로그인 없이 뷰어·계측 동작. */
(function(){
  window.__NATIVE_HOST__ = true;
  function $(i){ return document.getElementById(i); }
  var ov=$('authOverlay'); if(ov){ ov.classList.add('hide'); ov.style.display='none'; }
  window.JS_LOG   = function(){};
  window.JS_LOGS  = function(){ return Promise.resolve({ forEach:function(){}, docs:[], empty:true, size:0 }); };
  window.JS_FEATPERMS_GET = function(){ return Promise.resolve([]); };
  window.JS_FEATPERMS_SET = function(){ return Promise.resolve(); };
  window.JS_MEMBERS = [];
  window.JS_AUTH = { user:'로컬', email:'local@local', isAdmin:true, isSuper:true, featAllowed:true };
  window.JS_LOGOUT  = function(){};
  window.JS_IDTOKEN = function(){ return Promise.resolve('native'); };
  try{
    var pill=$('userPill'); if(pill) pill.style.display='inline-flex';
    var av=$('uAv'); if(av) av.textContent='로';
    var nm=$('authUserName'); if(nm) nm.textContent='로컬';
    var rt=$('uRole'); if(rt) rt.style.display='none';
    var lo=$('authLogoutBtn'); if(lo) lo.style.display='none';
  }catch(_){}
  function fire(){ try{ if(window.__onJsAuth) window.__onJsAuth(); }catch(_){} }
  if(document.readyState!=='loading') setTimeout(fire,0);
  else document.addEventListener('DOMContentLoaded', function(){ setTimeout(fire,0); });
})();