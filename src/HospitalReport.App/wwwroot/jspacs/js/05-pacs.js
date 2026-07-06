(function(){

const ANNOTATOR="image_annotator_zip.html";
const $=id=>document.getElementById(id);
let entries=[], selEntry=null, dirHandle=null, previewSeq=0, lastPrevUrl=null;
let shownStudies=[];   // 현재 워크리스트에 표시 중인 study 목록(정렬·필터 반영)

/* ---------- IndexedDB (폴더 핸들 저장) ---------- */
let _idbConn=null;
function idb(){ if(_idbConn) return Promise.resolve(_idbConn); return new Promise((res,rej)=>{ const r=indexedDB.open("jsha_pacs",1); r.onupgradeneeded=()=>{ r.result.createObjectStore("kv"); }; r.onsuccess=()=>{ _idbConn=r.result; res(r.result); }; r.onerror=()=>rej(r.error); }); }
async function idbSet(k,v){ try{ const db=await idb(); await new Promise((res,rej)=>{ const t=db.transaction("kv","readwrite"); t.objectStore("kv").put(v,k); t.oncomplete=res; t.onerror=()=>rej(t.error); }); }catch(e){} }
async function idbGet(k){ try{ const db=await idb(); return await new Promise((res,rej)=>{ const t=db.transaction("kv","readonly").objectStore("kv").get(k); t.onsuccess=()=>res(t.result); t.onerror=()=>rej(t.error); }); }catch(e){ return null; } }

/* ---------- DICOM 파일 → 검사 정보 ---------- */
/* 헤더만 읽어 워크리스트 표시용 메타 추출. 픽셀은 미리보기/열기 때만 디코딩 */
/* 메타 캐시(IndexedDB): name+size+lastModified가 같으면 재파싱 생략 */
async function metaCacheGet(key){ try{ return await idbGet("meta:"+key); }catch(_){ return null; } }
async function metaCacheSet(key,val){ try{ await idbSet("meta:"+key, val); }catch(_){ } }
function metaCacheKey(e){ return (e.name||"")+"|"+(e.size!=null?e.size:"?")+"|"+(e.lastModified!=null?e.lastModified:"?"); }

const HEADER_SLICE=262144; // 256KB — 대부분의 DICOM 헤더(환자/검사 정보)는 이 안에 들어감
async function readDicomMeta(entry){
  if(entry._meta) return entry._meta;
  // 0a) 폴더 공유 색인(.jsha_index.json) 우선: 경로의 size/lastModified가 색인과 같으면 파일을 안 열고 즉시 반환
  if(entry.path && folderIndex[entry.path]){ const fi=folderIndex[entry.path];
    if(fi.meta && ("birth" in fi.meta)){
      // 핸들 방식은 아직 size 미확보 → 색인의 size/lastModified를 신뢰(파일 변경 시엔 아래 stat 검증에서 갱신)
      if(entry.size==null){ entry.size=fi.size; entry.lastModified=fi.lastModified; }
      // size를 이미 알고 있으면 일치할 때만 사용
      if(entry.size==null || (entry.size===fi.size && entry.lastModified===fi.lastModified)){
        entry._meta=fi.meta; return fi.meta;
      }
    }
  }
  // 0b) getFile 전에: IndexedDB stat 캐시(경로→size·lastModified)로 메타캐시 우선 조회
  if(entry.size==null && entry.path){ try{ const st=await idbGet("stat:"+entry.path);
    if(st && st.size!=null){ const ck0=(entry.name||"")+"|"+st.size+"|"+(st.lastModified!=null?st.lastModified:"?");
      const c0=await metaCacheGet(ck0);
      if(c0 && ("birth" in c0)){ entry.size=st.size; entry.lastModified=st.lastModified; entry._meta=c0;
        folderIndex[entry.path]={size:st.size,lastModified:st.lastModified,meta:c0}; return c0; }
    } }catch(_){ } }
  const f=await entry.getFile();
  // size/lastModified를 엔트리에 기록 (목록 크기 표시 + 캐시 키) + 경로 stat 캐시 갱신
  if(entry.size==null){ entry.size=f.size; entry.lastModified=f.lastModified; }
  if(entry.path){ try{ idbSet("stat:"+entry.path, {size:f.size, lastModified:f.lastModified}); }catch(_){ } }
  // 1) 캐시 조회 (네트워크/공유 폴더에서 재오픈 시 즉시 반환)
  const ck=metaCacheKey(entry);
  const cached=await metaCacheGet(ck);
  // 'birth' 필드가 없는 낡은 버전 캐시는 무시하고 재파싱 (구버전에서 생성된 캐시 자동 갱신)
  if(cached && ("birth" in cached)){ entry._meta=cached; return cached; }
  // 2) 헤더 앞부분만 읽기 (전체 파일 X) → 네트워크 전송량 대폭 감소
  let ab;
  try{
    const sliceLen=Math.min(HEADER_SLICE, f.size||HEADER_SLICE);
    ab=await f.slice(0, sliceLen).arrayBuffer();
  }catch(_){ ab=await f.arrayBuffer(); }
  let m=parseMetaFromBuffer(ab);
  // 3) 부분 버퍼로 핵심 태그를 못 읽었으면(드문 경우) 전체 읽어 재시도
  if((!m.pid && !m.exam && !m.date) && (f.size||0) > HEADER_SLICE){
    try{ const full=await f.arrayBuffer(); m=parseMetaFromBuffer(full); }catch(_){ }
  }
  entry._meta=m;
  metaCacheSet(ck, m); // IndexedDB 캐시에 저장(비동기, 대기 불필요)
  // 폴더 공유 색인에도 반영(스캔 종료 후 .jsha_index.json으로 저장)
  if(entry.path){ folderIndex[entry.path]={size:entry.size, lastModified:entry.lastModified, meta:m}; folderIndexDirty=true; }
  return m;
}
function parseMetaFromBuffer(ab){
  let m={pid:"",name:"",exam:"",date:null,time:"",doc:"",dateInt:null,supported:true,err:null,sex:"",age:null,seriesNum:"",instNum:"",view:""};
  try{
    const parsed=JSHADICOM.parse(ab);
    const I=parsed.info;
    m.pid=I.patientID||"";
    m.name=JSHADICOM.formatName(I.patientNameRaw)||"";
    m.exam=I.studyDescription||I.seriesDescription||I.bodyPart||"";
    m.date=(I.studyDate||"").slice(0,8)||null;
    m.time=I.studyTime||"";
    m.doc=JSHADICOM.formatName(I.referringPhysician)||JSHADICOM.formatName(I.performingPhysician)||"";
    m.dateInt=m.date?parseInt(m.date,10):null;
    m.supported=JSHADICOM.isSupported(I.transferSyntax);
    m.ts=I.transferSyntax;
    m.modality=I.modality||"";
    m.sex=JSHADICOM.formatSex(I.sex);
    m.age=JSHADICOM.ageFrom(I.patientAge, I.birthDate, I.studyDate);
    m.birth=I.birthDate||"";
    m.seriesNum=I.seriesNumber||"";
    m.instNum=I.instanceNumber||"";
    m.view=I.viewPosition||"";
  }catch(err){ m.err=err.message; m.supported=false; }
  return m;
}
function dateDisp(d){ return d? (d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6,8)) : "—"; }
function timeDisp(t){ if(!t||t.length<4) return ""; return t.slice(0,2)+":"+t.slice(2,4)+(t.length>=6?(":"+t.slice(4,6)):""); }
function dateTimeDisp(d,t){ const dd=dateDisp(d); const tt=timeDisp(t); return tt?(dd+" "+tt):dd; }
function fmtSize(n){ if(n==null) return ""; if(n<1024) return n+" B"; if(n<1048576) return (n/1024).toFixed(1)+" KB"; return (n/1048576).toFixed(2)+" MB"; }
function esc(s){ return (""+s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }
function setFolderInfo(name){ $("folderInfo").textContent = name?("📂 "+name):"No folder selected."; }

/* ---------- 주석 사이드카 파일명 ---------- */
/* 원본:  17711_..._0001.dcm  →  주석: 17711_..._0001.dcm.jsha.json / .annotated.png */
function sidecarJson(name){ return name+".jsha.json"; }
function sidecarPng(name){ return name+".annotated.png"; }
function baseFromSidecar(name){ return name.replace(/\.jsha\.json$/i,"").replace(/\.annotated\.png$/i,""); }

/* ---------- 폴더 열기 ---------- */
async function pickFolder(){
  if(window.showDirectoryPicker){
    try{ const h=await window.showDirectoryPicker({mode:"readwrite"}); dirHandle=h; await idbSet("dirHandle",h); try{localStorage.setItem("jsha_pacs_folder",h.name);}catch(e){} await loadFromHandle(h); setFolderInfo(h.name); $("restore").style.display="none"; clearSelection(); render(); return; }
    catch(e){ if(e&&e.name==="AbortError") return; }
  }
  dirHandle=null; $("dirInput").click();
}
/* DICOM 메타를 미리 읽어 리스트에 채움. 병렬 + 점진 렌더링 */
async function decorate(list, sidecars){
  function findSc(e, scName){
    if(!sidecars) return null;
    const dir=e.dir||"";
    // 같은 폴더(경로)에 있는 사이드카만 매칭 → 다른 폴더의 동명 파일 오매칭 방지
    return sidecars[dir+scName] || null;
  }
  for(const e of list){
    const jName=sidecarJson(e.name), pName=sidecarPng(e.name);
    const jh=findSc(e,jName), ph=findSc(e,pName);
    e.hasAnno = !!jh;
    e.jsonHandle = jh;
    e.annoPngHandle = ph;
  }
  let done=0; const total=list.length;
  setFolderInfo(folderName+"  ·  Reading DICOM 0/"+total);
  // 동시 실행 풀(네트워크/공유 폴더에서 순차보다 훨씬 빠름)
  const CONC=8;
  let idx=0;
  let lastRender=0;
  function maybeRender(){ const now=Date.now(); if(now-lastRender>250){ lastRender=now; try{ buildStudies(list); if(typeof render==="function") render(); }catch(_){ } } }
  async function worker(){
    while(idx<list.length){
      const e=list[idx++];
      try{ const m=await readDicomMeta(e); e.pid=m.pid; e.name_=m.name; e.exam=m.exam; e.date=m.date; e.time=m.time; e.doc=m.doc; e.dateInt=m.dateInt; e.supported=m.supported; e.sex=m.sex; e.age=m.age; e.birth=m.birth; e.instNum=m.instNum; e.view=m.view; }
      catch(_){ e.pid=""; e.name_=""; e.exam=""; e.date=null; e.dateInt=null; e.supported=false; e.sex=""; e.age=null; e.instNum=""; }
      done++;
      if(done%5===0||done===total){ setFolderInfo(folderName+"  ·  Reading DICOM "+done+"/"+total); maybeRender(); }
    }
  }
  const workers=[]; for(let w=0; w<Math.min(CONC,list.length); w++) workers.push(worker());
  await Promise.all(workers);
  setFolderInfo(folderName);
  buildStudies(list);
  return list;
}
/* 그룹 모드: true=같은 병록번호+검사명+검사일시를 한 줄로 묶기, false=파일별 분리 */
let groupMode=true;
/* 워크리스트 정렬 상태: key=null이면 기본(날짜 내림차순), dir: 1=오름차순, -1=내림차순 */
let sortKey=null, sortDir=1;
try{ const _g=localStorage.getItem("jsha_group"); if(_g!=null) groupMode=(_g==="1"); }catch(e){}
let studies=[];
function studyKey(e){
  if(groupMode) return "G|"+(e.pid||"")+"|"+(e.exam||"")+"|"+(e.date||"")+"|"+(e.time||"");  // 병록번호+검사명+검사일+검사시간
  return "F|"+(e.name||Math.random());                                                        // 파일별 분리
}
function buildStudies(list){
  const map=new Map();
  for(const e of list){
    const k=studyKey(e);
    let s=map.get(k);
    if(!s){ s={key:k, pid:e.pid, name_:e.name_, sex:e.sex, age:e.age, birth:e.birth, exam:e.exam, date:e.date, time:e.time, dateInt:e.dateInt, doc:e.doc, files:[]}; map.set(k,s); }
    s.files.push(e);
    // 환자 메타는 첫 유효값 채움 / 날짜는 가장 최근으로
    if(!s.name_&&e.name_) s.name_=e.name_; if(!s.sex&&e.sex) s.sex=e.sex; if(s.age==null&&e.age!=null) s.age=e.age; if(!s.birth&&e.birth) s.birth=e.birth; if(!s.doc&&e.doc) s.doc=e.doc;
    if((e.dateInt||0)>(s.dateInt||0)){ s.dateInt=e.dateInt; s.date=e.date; s.time=e.time; }
  }
  studies=[...map.values()];
  for(const s of studies){
    s.files.sort((a,b)=>{ const ad=(a.dateInt||0),bd=(b.dateInt||0); if(ad!==bd) return ad-bd;
      const ai=parseInt(a.instNum||a._meta&&a._meta.instNum||"0",10)||0, bi=parseInt(b.instNum||"0",10)||0; if(ai!==bi) return ai-bi; return (a.name||"").localeCompare(b.name||""); });
    s.size=s.files.reduce((t,f)=>t+(f.size||0),0);
    s.hasAnno=s.files.some(f=>f.hasAnno);
    s.supported=s.files.every(f=>f.supported!==false);
    s.count=s.files.length;
  }
  return studies;
}
let folderName="";
let dirHandleByPath={}; // prefix(상대폴더경로) → FileSystemDirectoryHandle (하위폴더 저장용)
async function scanDirRecursive(h, dcm, sidecars, prefix, depth){
  // 하위 폴더까지 재귀적으로 DICOM(.dcm) 및 사이드카(.jsha.json/.annotated.png) 수집
  if(depth>12) return; // 비정상적으로 깊은 트리 방어
  dirHandleByPath[prefix]=h; // 이 폴더의 핸들 기억(사이드카를 같은 폴더에 저장하기 위함)
  for await (const [name,handle] of h.entries()){
    if(handle.kind==="directory"){
      try{ await scanDirRecursive(handle, dcm, sidecars, prefix+name+"/", depth+1); }catch(_){ }
      continue;
    }
    if(handle.kind!=="file") continue;
    if(/\.dcm$/i.test(name)) dcm.push({name:name, path:prefix+name, dir:prefix, handle:handle, getFile:()=>handle.getFile()});
    else if(/\.jsha\.json$/i.test(name) || /\.annotated\.png$/i.test(name)){ sidecars[prefix+name]=handle; }
  }
}
/* ===== 폴더 공유 색인(.jsha_index.json) =====
   루트 공유 폴더에 색인을 저장해 여러 PC가 나눠 쓴다.
   구조: { version, updated, entries:{ "상대경로": {size,lastModified,meta:{...}} } } */
let folderIndex={};            // 메모리 적재본 (경로→{size,lastModified,meta})
let folderIndexDirty=false;    // 스캔 중 새로 파싱된 항목이 생기면 true → 저장
const FOLDER_INDEX_NAME=".jsha_index.json";
async function loadFolderIndex(h){
  folderIndex={}; folderIndexDirty=false;
  if(!h) return;
  try{
    const fh=await h.getFileHandle(FOLDER_INDEX_NAME,{create:false});
    const f=await fh.getFile(); const txt=await f.text(); const j=JSON.parse(txt);
    if(j && j.entries && typeof j.entries==="object"){ folderIndex=j.entries; }
  }catch(_){ /* 없거나 못 읽으면 빈 색인으로 시작 */ }
}
async function saveFolderIndex(h){
  if(!h || !folderIndexDirty) return;
  try{
    if(!(await ensureRW(h))) return;           // 쓰기 권한 없으면 조용히 생략
    const payload={ version:1, updated:Date.now(), entries:folderIndex };
    const fh=await h.getFileHandle(FOLDER_INDEX_NAME,{create:true});
    const w=await fh.createWritable(); await w.write(new Blob([JSON.stringify(payload)],{type:"application/json"})); await w.close();
    folderIndexDirty=false;
  }catch(_){ /* 네트워크/권한 문제면 무시 — 색인은 보조 캐시일 뿐 */ }
}
async function loadFromHandle(h){
  folderName=h.name||"folder";
  setFolderInfo(folderName+"  ·  Scanning folder…");
  const dcm=[], sidecars={}; dirHandleByPath={};
  await loadFolderIndex(h);                     // ① 공유 색인 먼저 적재
  await scanDirRecursive(h, dcm, sidecars, "", 0);
  // 파일 size/lastModified는 메타 읽을 때 함께 채움 (업프런트 순차 getFile 제거 → 네트워크 폴더에서 빠름)
  entries=dcm; dirSidecars=sidecars;
  await decorate(dcm, sidecars);
  // 현재 스캔된 경로만 색인에 유지(삭제된 파일 항목 정리) — 변동 있으면 저장
  try{ const live={}; let changed=false;
    for(const e of dcm){ if(e.path && folderIndex[e.path]) live[e.path]=folderIndex[e.path]; }
    if(Object.keys(live).length!==Object.keys(folderIndex).length) changed=true;
    folderIndex=live; if(changed) folderIndexDirty=true;
  }catch(_){ }
  await saveFolderIndex(h);                     // ③ 갱신분 있으면 폴더에 저장(다른 PC와 공유)
}
let dirSidecars={};
$("dirInput").onchange=async()=>{
  const dcm=[], sidecars={};
  // webkitRelativePath = "선택폴더/하위/파일". 최상위 폴더명 제거 후 상대 폴더경로(dir) 산출
  function relDir(rel,fname){ const parts=rel.split("/"); parts.pop(); if(parts.length) parts.shift(); return parts.length?parts.join("/")+"/":""; }
  for(const f of $("dirInput").files){
    const rel=f.webkitRelativePath||f.name;
    const dir=relDir(rel,f.name);
    if(/\.dcm$/i.test(f.name)) dcm.push({name:f.name, path:rel, dir:dir, size:f.size, lastModified:f.lastModified, getFile:()=>Promise.resolve(f)});
    else if(/\.jsha\.json$/i.test(f.name)||/\.annotated\.png$/i.test(f.name)){ sidecars[dir+f.name]={getFile:()=>Promise.resolve(f)}; }
  }
  folderName="(선택한 폴더 · "+dcm.length+"개)";
  await decorate(dcm, sidecars); entries=dcm; dirSidecars=sidecars; dirHandle=null;
  $("restore").style.display="none"; clearSelection(); render();
};
async function refresh(){
  if(dirHandle){ try{ entries.forEach(e=>{ e._meta=null; }); // 캐시 무효화
      await loadFromHandle(dirHandle); clearSelection(); render(); }catch(e){ alert("Refresh failed: "+e.message); } }
  else { $("dirInput").click(); }
}

/* ---------- 설정 복원 ---------- */
async function tryRestore(){
  const h=await idbGet("dirHandle");
  if(!h){ return; }
  try{
    const perm=await h.queryPermission({mode:"readwrite"});
    if(perm==="granted"){ dirHandle=h; await loadFromHandle(h); setFolderInfo(h.name); clearSelection(); render(); return; }
  }catch(e){}
  let nm=""; try{ nm=localStorage.getItem("jsha_pacs_folder")||h.name||""; }catch(e){ nm=h.name||""; }
  $("restoreName").textContent=nm; $("restore").style.display="flex";
  $("restoreBtn").onclick=async()=>{
    try{ const perm=await h.requestPermission({mode:"readwrite"}); if(perm!=="granted"){ alert("Folder access permission is required."); return; }
      dirHandle=h; await loadFromHandle(h); setFolderInfo(h.name); $("restore").style.display="none"; clearSelection(); render();
    }catch(e){ alert("Folder restore failed: "+e.message); }
  };
}
$("restoreX").onclick=()=>{ $("restore").style.display="none"; };

/* ---------- 날짜 ---------- */
function toInt(v){ if(!v) return null; return parseInt(v.replace(/-/g,""),10); }
function todayStr(){ const d=new Date(), p=x=>(""+x).padStart(2,"0"); return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate()); }
function setToday(){ const t=todayStr(); $("startDate").value=t; $("endDate").value=t; render(); }
function setAll(){ $("startDate").value=""; $("endDate").value=""; render(); }

/* ---------- 워크리스트 렌더 (study 단위) ---------- */
function bindSortHeaders(){
  if(window.__sortBound__) return; window.__sortBound__=true;
  document.querySelectorAll('#pacsApp thead th.sortable').forEach(th=>{
    th.addEventListener("click",()=>{ const k=th.getAttribute("data-sort");
      if(sortKey===k){ sortDir=-sortDir; } else { sortKey=k; sortDir=1; }
      render();
    });
  });
}
function updateSortArrows(){
  document.querySelectorAll('#pacsApp thead th.sortable').forEach(th=>{
    const k=th.getAttribute("data-sort");
    th.classList.remove("sortAsc","sortDesc");
    let arrow=th.querySelector(".sortArrow"); if(!arrow){ arrow=document.createElement("span"); arrow.className="sortArrow"; th.appendChild(arrow); }
    if(sortKey===k){ th.classList.add(sortDir>0?"sortAsc":"sortDesc"); arrow.textContent=(sortDir>0?"▲":"▼"); }
    else { arrow.textContent="↕"; }
  });
}
function render(){
  bindSortHeaders();
  const q=($("search").value||"").trim().toLowerCase();
  const s=toInt($("startDate").value), en=toInt($("endDate").value);
  let shown=studies.filter(st=>{
    if(q){ const hay=((st.pid||"")+" "+(st.name_||"")).toLowerCase(); if(!hay.includes(q)) return false; }
    if((s!=null||en!=null) && st.dateInt!=null){ if(s!=null && st.dateInt<s) return false; if(en!=null && st.dateInt>en) return false; }
    return true;
  });
  if(sortKey==null){
    // 기본 정렬: 날짜 내림차순 → 환자번호 → 시간
    shown.sort((a,b)=>{ const ad=a.dateInt||0,bd=b.dateInt||0; if(ad!==bd) return bd-ad;
      if((a.pid||"")!==(b.pid||"")) return (a.pid||"").localeCompare(b.pid||"","ko");
      return (b.time||"").localeCompare(a.time||""); });
  } else {
    const getv=(st)=>{ switch(sortKey){
      case "pid":  return (st.pid||"");
      case "name": return (st.name_||"");
      case "sex":  return (st.sex||"");
      case "age":  return (st.age!=null?+st.age:NaN);
      case "exam": return (st.exam||"");
      case "date": return ((st.dateInt||0)*1000000 + (parseInt((st.time||"0").replace(/\D/g,""))||0));
      case "doc":  return (st.doc||"");
      case "size": return (st.size!=null?+st.size:0);
      default: return "";
    } };
    shown.sort((a,b)=>{ const va=getv(a), vb=getv(b); let c;
      if(typeof va==="number" && typeof vb==="number"){ const na=isNaN(va), nb=isNaN(vb); if(na&&nb)c=0; else if(na)c=1; else if(nb)c=-1; else c=va-vb; }
      else c=String(va).localeCompare(String(vb),"ko",{numeric:true});
      if(c===0){ const ad=a.dateInt||0,bd=b.dateInt||0; c=bd-ad; }   // 동순위는 최신 검사 먼저
      return c*sortDir; });
  }
  const tb=$("rows"); tb.innerHTML="";
  $("empty").style.display = studies.length? "none":"flex";
  const MAXSHOW=300;
  let limited=false;
  if(shown.length>MAXSHOW){
    limited=true;
    if(!window.__warned300__){ window.__warned300__=true; alert("Too many studies to display ("+shown.length+").\nOnly the first "+MAXSHOW+" are shown.\nNarrow down by Patient ID/name search or date range."); }
    shown=shown.slice(0,MAXSHOW);
  } else { window.__warned300__=false; }
  $("count").textContent = studies.length? (shown.length+(limited?("+ / "+studies.length):(" / "+studies.length))+" studies"+(limited?"  (limited to 300)":"")) : "";
  shownStudies=shown;   // 위/아래 화살표 행 이동에 사용
  shown.forEach((st,i)=>{
    const tr=document.createElement("tr"); tr.title=st.files.map(f=>f.name).join(", "); tr.__study=st; if(st===selStudy) tr.classList.add("sel");
    const badge = st.hasAnno? " <span class='annobadge' title='Annotated'>✓</span>":"";
    const warn = (st.supported===false)? " <span class='warnbadge' title='디코딩 미지원 압축'>!</span>":"";
    const multi = st.count>1? " <span class='multibadge' title='"+st.count+" images'>×"+st.count+"</span>":"";
    tr.innerHTML="<td class='cnum'>"+(i+1)+"</td>"+
      "<td class='cpid'>"+esc(st.pid||"—")+"</td>"+
      "<td class='cname'>"+esc(st.name_||"—")+"</td>"+
      "<td class='csex'>"+esc(st.sex||"—")+"</td>"+
      "<td class='cage'>"+(st.age!=null?esc(st.age):"—")+"</td>"+
      "<td class='cexam'>"+esc(st.exam||"—")+multi+badge+warn+"</td>"+
      "<td class='cdate'>"+dateTimeDisp(st.date,st.time)+"</td>"+
      "<td class='cdoc'>"+esc(st.doc||"—")+"</td>"+
      "<td class='csize'>"+fmtSize(st.size)+"</td>";
    tr.onclick=()=>selectStudy(st);
    tr.ondblclick=()=>openStudy(st);
    tb.appendChild(tr);
  });
  if(studies.length>0 && shown.length===0){ const tr=document.createElement("tr"); tr.innerHTML="<td colspan='9' class='none'>No studies match the criteria</td>"; tb.appendChild(tr); }
  updateSortArrows();
}

/* ---------- 선택 / 환자 이력 / 미리보기 ---------- */
let selStudy=null, curIdx=0;
function markSel(){ for(const r of $("rows").children){ if(r.__study) r.classList.toggle("sel", r.__study===selStudy); }
  for(const r of $("histRows").children){ if(r.__study) r.classList.toggle("sel", r.__study===selStudy); } }
function selectStudy(st){ selStudy=st; selEntry=st.files[0]; curIdx=0; markSel(); renderHistory(st.pid); loadPreview(st,0); }
function clearSelection(){ selStudy=null; selEntry=null; curIdx=0; renderHistory(null); clearPreview(); markSel(); }

function renderHistory(pid){
  const hb=$("histRows"); hb.innerHTML="";
  if(!pid){ $("histTitle").textContent="Study history"; $("histEmpty").style.display="flex"; if($("histChkAll")) $("histChkAll").checked=false; return; }
  const hist=studies.filter(st=>st.pid===pid).sort((a,b)=>{ const ad=a.dateInt||0,bd=b.dateInt||0; if(ad!==bd) return bd-ad; return (b.time||"").localeCompare(a.time||""); });
  const pname=(hist[0]&&hist[0].name_)||"";
  const sx=(hist[0]&&hist[0].sex)||"", ag=(hist[0]&&hist[0].age);
  const meta=[pname, sx, (ag!=null?ag+"y":"")].filter(Boolean).join(" · ");
  $("histTitle").textContent="Patient "+pid+(meta?(" · "+meta):"")+" · "+hist.length+" studies";
  $("histEmpty").style.display = hist.length? "none":"flex";
  if($("histChkAll")) $("histChkAll").checked=false;
  hist.forEach((st,i)=>{
    const tr=document.createElement("tr"); tr.title=st.files.map(f=>f.name).join(", "); tr.__study=st; if(st===selStudy) tr.classList.add("sel");
    const badge=st.hasAnno?" <span class='annobadge'>✓</span>":"";
    const multi=st.count>1?" <span class='multibadge'>×"+st.count+"</span>":"";
    tr.innerHTML="<td class='cchk'><input type='checkbox' class='histChk'></td><td class='cnum'>"+(i+1)+"</td><td class='cexam'>"+esc(st.exam||"—")+multi+badge+"</td><td class='cdate'>"+dateTimeDisp(st.date,st.time)+"</td><td class='cdoc'>"+esc(st.doc||"—")+"</td><td class='csize'>"+fmtSize(st.size)+"</td>";
    const chk=tr.querySelector(".histChk"); chk.__study=st;
    chk.onclick=(e)=>e.stopPropagation();
    tr.onclick=(e)=>{ if(e.target&&e.target.classList.contains("histChk")) return; selectStudy(st); };
    tr.ondblclick=()=>openStudy(st);
    hb.appendChild(tr);
  });
}

function setPrevNote(t){ $("prevNote").textContent=t||""; $("prevNote").style.display=t?"block":"none"; }

/* ===== STUDY HISTORY 체크박스 · 분석 ===== */
(function(){
  const all=$("histChkAll");
  if(all) all.addEventListener("change",()=>{ document.querySelectorAll("#histRows .histChk").forEach(c=>{ c.checked=all.checked; }); });
  const btn=$("analyzeBtn"); if(btn) btn.addEventListener("click",()=>runAnalysis());
  try{ window.runAnalysis=runAnalysis; window.collectPatientSeries=collectPatientSeries; window.showAnalysis=showAnalysis; }catch(_){ } // JS VIEWER(팝업)에서 opener로 호출
  const eb=$("exportBtn"); if(eb) eb.addEventListener("click",runExport);
  const cl=$("analyzeClose"); if(cl) cl.addEventListener("click",()=>$("analyzeModal").classList.remove("show"));
  const md=$("analyzeModal"); if(md) md.addEventListener("click",e=>{ if(e.target===md) md.classList.remove("show"); });
  document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&$("analyzeModal").classList.contains("show")) $("analyzeModal").classList.remove("show"); });
  // analyze 전문 소견 생성
  const aaiGo=$("aaiGo");
  if(aaiGo) aaiGo.addEventListener("click",async()=>{
    const ctx=window.__analyzeCtx; if(!ctx){ return; }
    const chart=($("aaiChart").value||"").trim();
    const status=$("aaiStatus"), result=$("aaiResult");
    aaiGo.disabled=true; status.textContent="AI가 측정 결과와 차트를 분석하고 있습니다…";
    try{
      const txt=await generateProComment(chart, ctx);
      result.style.display="block"; result.textContent=txt;
      status.textContent="완료 — 아래 소견은 참고용 초안입니다.";
    }catch(err){ status.textContent="오류: "+(err&&err.message||err); }
    finally{ aaiGo.disabled=false; }
  });
})();
// 저장 meta(.jsha.json) → 측정값(영문 라벨). 0에 가까울수록 정상(goodLow), 골반강 비율만 예외
function metricsFromSavedMeta(meta){
  const out={}; if(!meta) return out;
  const pm=(meta.px_per_mm>0)?meta.px_per_mm:0; const U=pm>0?"mm":"px";
  function cobbAng(cb){ if(!cb||!cb.l0||!cb.l1||!cb.l0.a||!cb.l0.b||!cb.l1.a||!cb.l1.b) return null;
    const a0=Math.atan2(cb.l0.b.y-cb.l0.a.y,cb.l0.b.x-cb.l0.a.x), a1=Math.atan2(cb.l1.b.y-cb.l1.a.y,cb.l1.b.x-cb.l1.a.x);
    let an=Math.abs(a0-a1)*180/Math.PI; an=an%180; if(an>90) an=180-an; return an; }
  (meta.cobbs||[]).forEach((cb,i)=>{ const a=cobbAng(cb); if(a!=null) out["Cobb angle"+((meta.cobbs.length>1)?(" #"+(i+1)):"")]={value:+a.toFixed(1),unit:"°"}; });
  (meta.level_pairs||[]).forEach(pr=>{ if(pr.L&&pr.R){ const d=Math.abs(pr.L.y-pr.R.y); const mm=pm>0?d/pm:d; out[(pr.label||"Level")+" L–R diff"]={value:+mm.toFixed(1),unit:U}; } });
  (meta.rotation||[]).forEach(r=>{ if(r.LB&&r.RB&&r.SP){ const cx=(r.LB.x+r.RB.x)/2, hw=Math.abs(r.RB.x-r.LB.x)/2; if(hw>0){ const pct=Math.abs(r.SP.x-cx)/hw*100; out[r.label+" rotation"]={value:+pct.toFixed(0),unit:"%"}; } } });
  const refX=(meta.pubic_symphysis_x!=null)?meta.pubic_symphysis_x:(meta.centerline_x!=null?meta.centerline_x:null);
  if(refX!=null){
    (meta.points||[]).forEach(p=>{ const off=Math.abs(p.x-refX); const mm=pm>0?off/pm:off; out[(p.label||"Point")+" midline dist"]={value:+mm.toFixed(1),unit:U}; });
    (meta.rotation||[]).forEach(r=>{ const cxv=(r.LB&&r.RB)?((r.LB.x+r.RB.x)/2):(r.SP?r.SP.x:null); if(cxv!=null){ const off=Math.abs(cxv-refX); const mm=pm>0?off/pm:off; out[(r.label||"")+" midline dist"]={value:+mm.toFixed(1),unit:U}; } });
  }
  function spanLR(arr,side){ if(!arr) return null; const a=arr.find(p=>p.side===side&&p.role==="a"), b=arr.find(p=>p.side===side&&p.role==="b"); return (a&&b)?Math.hypot(a.x-b.x,a.y-b.y):null; }
  [["obt","Obturator"],["ltr","LT-IR"]].forEach(kn=>{ const sp=meta.spans&&meta.spans[kn[0]]; const dl=spanLR(sp,"L"), dr=spanLR(sp,"R"); if(dl!=null&&dr!=null){ const d=Math.abs(dl-dr); const mm=pm>0?d/pm:d; out[kn[1]+" L–R diff"]={value:+mm.toFixed(1),unit:U}; } });
  if(meta.pelvis&&meta.pelvis.A&&meta.pelvis.B&&meta.pelvis.C){ const A=meta.pelvis.A,B=meta.pelvis.B,C=meta.pelvis.C; const ax=B.x-A.x,ay=B.y-A.y,al=Math.hypot(ax,ay); if(al>0){ const pp=Math.abs(ax*(C.y-A.y)-ay*(C.x-A.x))/al; out["Pelvic ratio"]={value:+(pp/al).toFixed(2),unit:""}; } }
  // 정면 지표에 group 태깅
  Object.keys(out).forEach(k=>{ if(out[k]&&!out[k].group) out[k].group="ap"; });
  // 측면(sagittal) 지표 — 키는 영문, 표시는 lab()/labEn()에서 한/영 변환
  if(meta.sagittal && meta.sagittal.metrics){ const sm=meta.sagittal.metrics;
    const sadd=(lab,val,unit,normHi,normLo,absMode)=>{ if(val==null) return;
      out[lab]={value:+(+val).toFixed(1),unit:unit,group:"sag",normHi:(normHi!=null?normHi:null),normLo:(normLo!=null?normLo:null),absMode:!!absMode}; };
    sadd("Trunk forward (SVA)",sm.sva_mm,"mm",50,null,true);
    sadd("Head forward (cSVA)",sm.csva_mm,"mm",40,null,true);
    sadd("Lumbar curve (PI-LL)",sm.pi_ll,"°",9,-9,true);
    sadd("Pelvic compensation (PT)",sm.pt,"°",20,null,true);
    sadd("Neck curve (T1S-CL)",sm.t1s_cl,"°",20,null,true);
  }
  return out;
}
async function readStudyMeta(st){
  // study의 첫(혹은 주석 있는) 파일의 .jsha.json 읽기
  for(const f of st.files){ if(f.jsonHandle){ try{ const jf=await f.jsonHandle.getFile(); return JSON.parse(await jf.text()); }catch(_){ } } }
  return null;
}
// study 안 모든 파일(정면·측면 등)의 메타를 읽어 측정값을 병합. 같은 라벨은 측면(sag) 우선 보존.
async function readStudyMetricsMerged(st){
  const merged={}; let any=false;
  for(const f of st.files){ if(!f.jsonHandle) continue;
    try{ const jf=await f.jsonHandle.getFile(); const meta=JSON.parse(await jf.text()); any=true;
      const mm=metricsFromSavedMeta(meta);
      Object.keys(mm).forEach(k=>{ // 충돌 시 측면 지표를 덮어쓰지 않도록: 새 값이 sag이거나 기존이 없으면 채움
        if(!(k in merged) || mm[k].group==="sag") merged[k]=mm[k]; });
    }catch(_){ }
  }
  return any?merged:null;
}
// 환자(pid)의 모든 검사를 시간순으로 모아 series 데이터로 반환(메타 포함). 직렬화 가능한 plain object.
async function collectPatientSeries(pid){
  if(pid==null) return null;
  const sel=studies.filter(st=>st.pid===pid);
  if(!sel.length) return {pid, found:false, series:[]};
  sel.sort((a,b)=>{ const ad=a.dateInt||0,bd=b.dateInt||0; if(ad!==bd) return ad-bd; return (a.time||"").localeCompare(b.time||""); });
  let pname="", sex="", age=null;
  const series=[];
  for(const st of sel){
    const merged=await readStudyMetricsMerged(st);   // study 내 모든 파일(정면·측면) 메타 병합
    if(!pname&&st.name_) pname=st.name_; if(!sex&&st.sex) sex=st.sex; if(age==null&&st.age!=null) age=st.age;
    series.push({ date:st.date, time:st.time, label: dateTimeDisp(st.date,st.time)||st.exam||"—", short:(st.date?(st.date.slice(4,6)+"/"+st.date.slice(6,8)):(st.exam||"")), metrics: merged||{}, hasMeta:!!merged });
  }
  return {pid, found:true, count:sel.length, pname, sex, age, series};
}
// series 데이터로 분석 모달을 채워 표시(현재 창 기준)
function showAnalysis(data){
  if(!data || !data.found){ alert("이 환자의 검사를 찾을 수 없습니다."); return; }
  const {pid, pname, sex, age, series, count}=data;
  $("analyzeTitle").textContent="측정 분석";
  $("analyzeBody").innerHTML="";
  $("analyzeModal").classList.add("show");
  const withSeries=series.filter(s=>s.hasMeta);
  $("analyzeSub").textContent="환자 "+pid+(pname?(" · "+pname):"")+" · 검사 "+(count||series.length)+"개 (오래된 → 최신)"+(withSeries.length<series.length?(" · 측정값 있는 검사 "+withSeries.length+"개"):"");
  if(!withSeries.length){
    $("analyzeBody").innerHTML="<div class='aempty'>저장된 측정값이 없습니다.<br>JS VIEWER에서 계측 후 저장(.jsha.json 생성)하면 그래프가 표시됩니다.</div>";
    return;
  }
  const first=withSeries[0], last=withSeries[withSeries.length-1];
  const html=buildReportHTML({
    pid, pname, sex, age:(age!=null?(age+"세"):""),
    series:withSeries, first, last, graphsOnly:true, showValues:true
  });
  const iframe=document.createElement("iframe");
  iframe.className="aiframe"; iframe.setAttribute("title","Analysis");
  $("analyzeBody").appendChild(iframe);
  const doc=iframe.contentDocument||iframe.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  // AI 전문 소견 섹션: 기능 켜짐 + API 키 있을 때만 노출
  const aiSec=$("analyzeAISection");
  if(aiSec){
    const enabled = isAnalyzeAIEnabled() && aiAvailable();
    aiSec.style.display = enabled? "block" : "none";
    window.__analyzeCtx = { pid, pname, sex, age:(age!=null?(age+"세"):""), series:withSeries };
    if(enabled){ const r=$("aaiResult"); if(r){ r.style.display="none"; r.textContent=""; } const st=$("aaiStatus"); if(st) st.textContent=""; }
  }
}
// ── AI 전송용 비식별 처리: 환자 실명을 외부(API)로 보내지 않기 위함 ──
// 헤더에는 성별/나이만 남기고, 차트 본문에 섞인 실명도 ○○○ 로 가린다.
function deidHeader(ctx){
  if(typeof isAiNoPHI==="function" && isAiNoPHI()) return "환자: (정보 비공개 — 계측 수치만 전송)";
  const meta=[(ctx&&ctx.sex||""),(ctx&&ctx.age||"")].filter(s=>String(s).trim()).join(" ");
  return meta?("환자: ("+meta+")"):"환자: (정보 없음)";
}
function deidChart(chartText, ctx){
  if(typeof isAiNoPHI==="function" && isAiNoPHI()) return "";   // '전송 안 함' 모드: 차트 본문 미전송
  let chart=chartText||"";
  const name=(ctx&&ctx.pname||"").trim();
  if(name && name!=="-"){ try{ chart=chart.split(name).join("○○○"); }catch(_){ } }
  return chart;
}
// ── AI 프록시 호출: Anthropic 키는 서버(Cloudflare Worker)에만. 클라이언트는 로그인 토큰으로 인증 ──
const AI_PROXY_URL="https://js-pacs-api.pinetreecho.workers.dev";
function aiAvailable(){ return !!window.JS_IDTOKEN; }
async function callAI(body){
  if(!window.JS_IDTOKEN) throw new Error("로그인이 필요합니다. (AI 코멘트는 로그인 후 사용)");
  let token; try{ token=await window.JS_IDTOKEN(); }catch(e){ throw new Error("로그인이 필요합니다. 다시 로그인해 주세요."); }
  const resp=await fetch(AI_PROXY_URL,{
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+token },
    body:JSON.stringify(body)
  });
  if(!resp.ok){ let msg="AI "+resp.status; try{ const e=await resp.json(); if(e&&e.error){ msg+=" — "+(e.error.message||e.error); } }catch(_){ }
    if(resp.status===401) msg="인증이 만료되었거나 권한이 없습니다. 다시 로그인해 주세요.";
    if(resp.status===500) msg="서버에 API 키가 아직 설정되지 않았습니다. 관리자에게 문의하세요.";
    throw new Error(msg); }
  const data=await resp.json();
  let out=""; if(data&&data.content){ for(const b of data.content){ if(b.type==="text") out+=b.text; } }
  return out.trim();
}
// ── analyze 전문가 소견 생성 (의료진용 톤) ──
async function generateProComment(chartText, ctx){
  const measureText=metricsToText(ctx.series);
  let sys=[
    "당신은 한국의 정형외과·통증의학과·재활의학과 의료진을 보조하여, 전척추 자세·정렬 분석 결과에 대한 '전문 소견 초안'을 작성하는 임상 보조자입니다. 독자는 의료 전문가이며, 환자용 쉬운 말이 아니라 정확하고 전문적인 용어를 사용합니다.",
    "【대상 독자】 의사·치료사 등 의료진. 전문용어(SVA, cSVA, PI−LL, PT, T1S−CL, Cobb, 관상면/시상면 정렬 등) 사용 권장.",
    "【분석 틀】 시상면은 '결과(SVA·cSVA) ← 원인(PI−LL·T1S−CL) ← 보상(PT)' 축으로 해석하고, 관상면은 Cobb·중심선 편위·좌우 비대칭으로 기술. 정상범위와 비교하고, 시계열이 있으면 변화 추세와 그 임상적 의미를 분석.",
    "【구성】 ① 핵심 요약(현재 정렬 상태와 가장 두드러진 소견). ② 파라미터별 해석(정상/벗어남, 보상 기전 포함). ③ 시계열 변화와 의미(호전/악화/유지). ④ 임상적 고려사항·감별 포인트. ⑤ 권장 평가 또는 치료 방향(일반적 수준). 각 항목은 소제목 없이 자연스러운 단락으로, 또는 간결한 항목 나열로.",
    "【길이·형식】 6~12문장 분량. 마크다운 기호(#, * 등)·이모지 없이 평문으로. 제목·인사말 없이 소견 본문만.",
    "【수치】 측정값과 변화량을 근거로 구체적으로 기술하되, 측정 데이터에 없는 값을 지어내지 말 것.",
    "【안전·윤리】 확정적 진단 단정은 피하고 '~ 소견', '~ 시사', '~ 고려' 수준의 임상 소견 표현 사용. 이 소견은 참고용 초안이며 최종 판단은 담당 의사의 몫임을 전제로 작성."
  ].join("\n");
  const guide=getProGuide();
  if(guide){ sys+="\n\n[의사가 지정한 추가 지침 — 기본 규칙과 충돌 시 아래를 우선]\n"+guide; }
  const usr=deidHeader(ctx)+"\n\n[측정 결과 시계열]\n"+(measureText||"(없음)")+"\n\n[의사 차트 내용]\n"+(deidChart(chartText,ctx)||"(없음)")+"\n\n위 정보를 바탕으로 의료진용 전문 소견 초안을 작성해 주세요.";
  return await callAI({ model:"claude-sonnet-4-6", max_tokens:1500, system:sys, messages:[{role:"user",content:usr}] });
}
async function runAnalysis(forcePid){
  // 체크박스와 무관하게 "현재 선택된 환자"의 모든 스터디를 분석
  // forcePid가 주어지면(JS VIEWER에서 호출) 그 환자를 분석
  let pid=null;
  if(forcePid!=null && forcePid!==""){ pid=forcePid; }
  else if(selStudy){ pid=selStudy.pid; }
  else {
    const firstChk=document.querySelector("#histRows .histChk");
    if(firstChk&&firstChk.__study){ pid=firstChk.__study.pid; }
    else if(studies.length){ pid=studies[0].pid; }
  }
  if(pid==null){ alert("먼저 목록에서 환자를 선택해 주세요."); return; }
  $("analyzeTitle").textContent="측정 분석";
  $("analyzeSub").textContent="환자 "+pid+" · 검사 읽는 중…";
  $("analyzeBody").innerHTML="";
  $("analyzeModal").classList.add("show");
  const data=await collectPatientSeries(pid);
  showAnalysis(data);
}
function renderAnalysis(series){
  const body=$("analyzeBody"); body.innerHTML="";
  // 모든 metric 키 수집(하나라도 값이 있는 항목)
  const keys=[]; const seen={};
  series.forEach(s=>{ Object.keys(s.metrics).forEach(k=>{ if(!seen[k]){ seen[k]=1; keys.push(k); } }); });
  const withData=series.filter(s=>s.hasMeta).length;
  if(!keys.length){ body.innerHTML="<div class='aempty'>No saved measurements found in the selected studies.<br>Open a study in JS VIEWER, measure, and save (creates the .jsha.json) — then analyze.</div>"; return; }
  if(withData<series.length){ const note=document.createElement("div"); note.className="alegend"; note.style.marginBottom="12px"; note.textContent="Note: "+(series.length-withData)+" of "+series.length+" studies have no saved annotation and appear as gaps."; body.appendChild(note); }
  keys.forEach(key=>{
    const pts=series.map((s,i)=>({ i, label:s.short||s.label, full:s.label, v:(s.metrics[key]?s.metrics[key].value:null), unit:(s.metrics[key]?s.metrics[key].unit:"") }));
    const unit=(pts.find(p=>p.unit)||{}).unit||"";
    const wrap=document.createElement("div"); wrap.className="ametric";
    const t=document.createElement("div"); t.className="mt"; t.textContent=key+(unit?(" ("+unit+")"):""); wrap.appendChild(t);
    wrap.insertAdjacentHTML("beforeend", lineChartSVG(pts, unit));
    // 추세 요약
    const valid=pts.filter(p=>p.v!=null);
    if(valid.length>=2){ const first=valid[0].v, last=valid[valid.length-1].v; const diff=last-first;
      // absMode 지표(SVA·cSVA 등)는 |값|이 줄면 호전
      const absMode=series.some(s=>s.metrics[key]&&s.metrics[key].absMode===true);
      const improved = absMode ? (Math.abs(last)<Math.abs(first)) : (diff<0);
      const dir = Math.abs(diff)<1e-9?"변화 없음":(improved?"좋아짐":"늘어남");
      const leg=document.createElement("div"); leg.className="alegend";
      leg.textContent="처음 "+first+unit+" → 최근 "+last+unit+"  ("+(diff>0?"+":"")+(+diff.toFixed(1))+unit+", "+dir+")";
      wrap.appendChild(leg); }
    body.appendChild(wrap);
  });
}
function lineChartSVG(pts, unit){
  const W=1040, H=220, padL=54, padR=20, padT=18, padB=42;
  const vals=pts.filter(p=>p.v!=null).map(p=>p.v);
  if(!vals.length) return "<svg class='achart' viewBox='0 0 "+W+" "+H+"'></svg>";
  let mn=Math.min(...vals), mx=Math.max(...vals); if(mn===mx){ mn-=1; mx+=1; } const span=mx-mn; mn-=span*0.12; mx+=span*0.12;
  const n=pts.length;
  const X=i=> padL + (n<=1? (W-padL-padR)/2 : i*(W-padL-padR)/(n-1));
  const Y=v=> padT + (1-(v-mn)/(mx-mn))*(H-padT-padB);
  const esc=s=>(""+s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  let g="";
  // y 그리드 3선
  for(let k=0;k<=2;k++){ const v=mn+(mx-mn)*k/2; const y=Y(v); g+="<line x1='"+padL+"' y1='"+y.toFixed(1)+"' x2='"+(W-padR)+"' y2='"+y.toFixed(1)+"' stroke='#1c2738' stroke-width='1'/>"; g+="<text x='"+(padL-8)+"' y='"+(y+4).toFixed(1)+"' fill='#6b7d92' font-size='11' text-anchor='end'>"+(+v.toFixed(1))+"</text>"; }
  // 연결선 (null 구간은 끊기)
  let dpath="", started=false;
  pts.forEach((p,i)=>{ if(p.v==null){ started=false; return; } const cmd=started?"L":"M"; dpath+=cmd+X(i).toFixed(1)+" "+Y(p.v).toFixed(1)+" "; started=true; });
  if(dpath) g+="<path d='"+dpath.trim()+"' fill='none' stroke='#46e08a' stroke-width='2.5'/>";
  // 점 + 값 + x라벨
  pts.forEach((p,i)=>{ const x=X(i);
    g+="<text x='"+x.toFixed(1)+"' y='"+(H-padB+18)+"' fill='#8aa0b8' font-size='10.5' text-anchor='middle'>"+esc(p.label||(i+1))+"</text>";
    if(p.v==null){ g+="<text x='"+x.toFixed(1)+"' y='"+(H/2)+"' fill='#5f7188' font-size='10' text-anchor='middle'>—</text>"; return; }
    const y=Y(p.v);
    g+="<circle cx='"+x.toFixed(1)+"' cy='"+y.toFixed(1)+"' r='4' fill='#46e08a' stroke='#0a0f17' stroke-width='1.5'/>";
    g+="<text x='"+x.toFixed(1)+"' y='"+(y-9).toFixed(1)+"' fill='#cfe0f2' font-size='11' font-weight='700' text-anchor='middle'>"+(+p.v)+"</text>";
  });
  return "<svg class='achart' viewBox='0 0 "+W+" "+H+"' preserveAspectRatio='xMidYMid meet'>"+g+"</svg>";
}
async function setPrevData(e){ /* 미리보기 측정데이터 섹션 제거됨 (no-op) */ }
function clearPreview(){ if(lastPrevUrl){ URL.revokeObjectURL(lastPrevUrl); lastPrevUrl=null; } $("prevImg").removeAttribute("src"); $("prevImg").style.transform=""; $("prevWrap").style.display="none"; $("prevEmpty").style.display="flex"; $("prevCap").textContent=""; $("prevCap").className=""; updPrevNav(); }
function updPrevNav(){
  const nav=$("prevNav"); if(!nav) return;
  if(selStudy && selStudy.count>1){ nav.style.display="flex"; $("prevNavLabel").textContent=(curIdx+1)+" / "+selStudy.count; }
  else nav.style.display="none";
}
function prevImage(){ if(selStudy && selStudy.count>1){ curIdx=(curIdx-1+selStudy.count)%selStudy.count; selEntry=selStudy.files[curIdx]; loadPreview(selStudy,curIdx); } }
function nextImage(){ if(selStudy && selStudy.count>1){ curIdx=(curIdx+1)%selStudy.count; selEntry=selStudy.files[curIdx]; loadPreview(selStudy,curIdx); } }

async function readSavedFlip(e){
  // .jsha.json 사이드카에 저장된 flip(좌우 반전) 상태를 읽음
  try{ if(e.jsonHandle){ const jf=await e.jsonHandle.getFile(); const meta=JSON.parse(await jf.text()); return !!meta.flip; } }catch(_){ }
  return false;
}
function applyPrevFlip(flip){
  const img=$("prevImg"); if(!img) return;
  img.style.transform = flip? "scaleX(-1)" : "";
}
/* ===== 보고서 내보내기 ===== */
// study의 첫 파일을 주석·반전 적용해 PNG dataURL로 (보고서용, 폭 maxW로 축소)
async function studyToReportImage(st, maxW, fileIdx){
  const e=st.files[fileIdx||0]; if(!e) return null;
  const meta=await readSavedMeta(e);
  const savedFlip=!!(meta&&meta.flip);
  const f=await e.getFile(); const ab=await f.arrayBuffer();
  let parsed=JSHADICOM.parse(ab);
  if(!JSHADICOM.isSupported(parsed.info.transferSyntax)) throw new Error("Unsupported transfer syntax");
  const base=document.createElement("canvas"); JSHADICOM.renderToCanvas(parsed, base);
  const nW=base.width, nH=base.height;
  const out=document.createElement("canvas"); out.width=nW; out.height=nH; const oc=out.getContext("2d");
  if(savedFlip){ oc.save(); oc.translate(nW,0); oc.scale(-1,1); oc.drawImage(base,0,0); oc.restore(); } else oc.drawImage(base,0,0);
  if(meta){ try{ drawPreviewAnno(oc, meta, nW, 1, savedFlip); }catch(_){ } }
  // 보고서 파일 크기 축소(폭 maxW로 리샘플)
  maxW=maxW||900; let scl=Math.min(1, maxW/nW);
  const small=document.createElement("canvas"); small.width=Math.round(nW*scl); small.height=Math.round(nH*scl);
  small.getContext("2d").drawImage(out,0,0,small.width,small.height);
  return small.toDataURL("image/jpeg",0.85);
}
async function runExport(){
  if(!isReportEnabled()){ alert("레포트 기능이 설정에서 차단되어 있습니다."); return; }
  const checks=[...document.querySelectorAll("#histRows .histChk")].filter(c=>c.checked);
  if(!checks.length){ alert("Check one or more studies in the history list first."); return; }
  const sel=checks.map(c=>c.__study).sort((a,b)=>{ const ad=a.dateInt||0,bd=b.dateInt||0; if(ad!==bd) return ad-bd; return (a.time||"").localeCompare(b.time||""); });
  const eb=$("exportBtn"); const old=eb?eb.textContent:""; if(eb){ eb.disabled=true; eb.textContent="⏳ 준비 중…"; }
  try{
    // 측정값 시계열 (study 내 정면·측면 메타 병합)
    const series=[];
    for(const st of sel){ const m=await readStudyMetricsMerged(st); series.push({ date:st.date, time:st.time, label:dateTimeDisp(st.date,st.time)||st.exam||"—", short:(st.date?(st.date.slice(4,6)+"/"+st.date.slice(6,8)):""), exam:st.exam||"", metrics:m||{}, hasMeta:!!m }); }
    // before/after 이미지 — 각 study의 모든 파일(정면+측면 등)을 배열로
    const first=sel[0], last=sel[sel.length-1];
    async function studyImages(st){ const arr=[]; if(!st||!st.files) return arr;
      for(let i=0;i<st.files.length;i++){ try{ const u=await studyToReportImage(st, 900, i); if(u) arr.push(u); }catch(_){ } } return arr; }
    let imgsBefore=[], imgsAfter=[];
    try{ imgsBefore=await studyImages(first); }catch(_){ }
    try{ imgsAfter = (last!==first)? await studyImages(last) : []; }catch(_){ }
    const imgBefore=imgsBefore[0]||null, imgAfter=imgsAfter[0]||null; // 하위호환(기존 단일 필드)
    const pid=first.pid||"", pname=first.name_||"", sex=first.sex||"", age=(first.age!=null?first.age+"y":"");
    let birth=first.birth||"";
    if(!birth){
      try{
        const fe=first.files&&first.files[0];
        if(fe){ const fobj=await fe.getFile(); const fab=await fobj.arrayBuffer(); const pp=JSHADICOM.parse(fab); if(pp&&pp.info&&pp.info.birthDate){ birth=pp.info.birthDate; first.birth=birth; } }
      }catch(_){ }
    }
    const ctx={pid,pname,sex,age,birth,series,first,last,imgBefore,imgAfter,imgsBefore,imgsAfter};
    if(eb){ eb.disabled=false; eb.textContent=old; }
    // 차트 입력 모달을 띄움 → 사용자가 차트 입력 후 코멘트 생성 또는 건너뛰기
    openChartModal(ctx);
  }catch(err){ alert("Export failed: "+err.message); if(eb){ eb.disabled=false; eb.textContent=old; } }
}
// 측정값을 사람이 읽을 수 있는 요약 텍스트로
function metricsToText(series){
  try{
    const lines=[];
    series.forEach((s,i)=>{
      const when=s.label||("검사"+(i+1));
      const parts=[];
      Object.keys(s.metrics||{}).forEach(k=>{ const m=s.metrics[k]; if(m&&m.value!=null) parts.push(k+": "+m.value+(m.unit||"")); });
      lines.push("["+when+"] "+(parts.length?parts.join(", "):"측정값 없음"));
    });
    return lines.join("\n");
  }catch(e){ return ""; }
}
// 차트+측정값을 Claude에 보내 환자용 코멘트 생성
function getApiKey(){ try{ var v=localStorage.getItem("jsha_anthropic_key"); return (v&&v.trim())?v.trim():""; }catch(e){ return ""; } }
function applyFeatureFlags(){
  // 레포트 내보내기 버튼: 차단 시 숨김
  const eb=$("exportBtn"); if(eb) eb.style.display = isReportEnabled()? "" : "none";
}
function getCommentGuide(){ try{ var v=localStorage.getItem("jsha_comment_guide"); return (v&&v.trim())?v.trim():""; }catch(e){ return ""; } }
function getProGuide(){ try{ var v=localStorage.getItem("jsha_pro_guide"); return (v&&v.trim())?v.trim():""; }catch(e){ return ""; } }
function isReportEnabled(){ try{ return localStorage.getItem("jsha_feat_report")!=="off"; }catch(e){ return true; } }
function isAnalyzeAIEnabled(){ try{ return localStorage.getItem("jsha_feat_analyzeai")!=="off"; }catch(e){ return true; } }
// AI에 환자 정보 전송 안 함: on이면 성별·나이·차트 본문을 빼고 계측 수치만 전송(기본=off, 이름은 항상 자동 가림)
function isAiNoPHI(){ try{ return localStorage.getItem("jsha_ai_no_phi")==="on"; }catch(e){ return false; } }
// 관리자 전용 동작(주석잠금·허용명단 편집) 권한 확인.
// 동선앱 관리자/최고관리자 역할(window.JS_AUTH.isAdmin) 기준. 로컬 비밀번호 방식은 폐지.
function requireAdmin(actionLabel){
  if(window.JS_AUTH){
    if(window.JS_AUTH.isAdmin) return true;
    alert("이 설정은 관리자 계정만 변경할 수 있습니다.\n(동선앱에서 관리자로 지정된 계정으로 로그인하세요.)");
    return false;
  }
  return true; // 계정정보 없음(임베드/오프라인) — 차단할 컨텍스트 아님
}
// '기능 사용 설정' 변경 권한: 관리자 또는 관리자가 아이디별로 허용한 계정만.
function requireFeaturePerm(){
  if(window.JS_AUTH){
    if(window.JS_AUTH.isAdmin || window.JS_AUTH.featAllowed) return true;
    alert("이 기능 설정은 관리자가 허용한 계정만 변경할 수 있습니다.\n(설정 변경 권한이 필요하면 관리자에게 요청하세요.)");
    return false;
  }
  return true; // 계정정보 없음(임베드/오프라인) — 차단할 컨텍스트 아님
}
async function generatePatientComment(chartText, ctx){
  const measureText=metricsToText(ctx.series);
  let sys=[
    "당신은 한국의 정형외과·통증의학과·재활의학과 의원에서 환자에게 전달할 '자세 검사 결과 코멘트'를 작성하는 보조자입니다. 의사가 검토 후 환자에게 전달하므로, 환자가 읽고 안심하면서도 치료의 지속성을 담보하는 동기부여를 받을 수 있도록 해야 합니다.",
    "【대상 독자】 의학 지식이 없는 일반 환자. 초등학교 고학년도 이해할 수준의 쉬운 말. 전문용어(SVA, Cobb, PI−LL 등)는 쓰지 말고, 꼭 필요하면 쉬운 말로 풀어 설명(예: \"몸이 옆에서 봤을 때 앞으로 쏠린 정도\").",
    "【길이·형식】 3~5문장, 한 문단. 머리말·인사말·제목·따옴표·마크다운·이모지 없이 코멘트 본문만 출력.",
    "【내용 구성】 ① 이번 결과를 한두 문장으로 요약(좋아진 점 먼저). ② 살펴볼 점이 있으면 부드럽게 언급하되 겁주지 않기. ③ 일상에서 할 수 있는 일반적 권고로는 운동적 치료가 있는데, 저희가 알려드리는 운동을 열심히 하시라는 식으로만 언급하고, 막연히 '운동을 하세요'라고만 하는 것은 지양하기. ④ 차트에 나오는 내용을 참고하여 최대한 차트 내용과 연계하여 작성하되, 차트에 담긴 환자의 증상을 설명에 잘 녹여내기. ⑤ 언제 follow up(다음 경과 관찰)인지를 차트에서 확인하여, '치료 종결'이면 '치료 받으시느라 고생하셨습니다' 정도로 마무리하고, 종결이 아니고 이후 follow up이 잡혀 있으면 다음에 경과 보며 더 좋아질 수 있도록 함께 힘내자는 식으로 마무리.",
    "【수치 사용】 측정값의 변화 방향(좋아짐/비슷함/조금 더 봐야 함)을 근거로 설명하되, 구체적 숫자 나열은 최소화하고 의미 중심으로 전달. 정상범위를 벗어났어도 \"비정상\", \"이상\", \"질환\" 같은 단정적 표현 금지.",
    "【안전·윤리】 \"완치\", \"교정 보장\", \"반드시 좋아진다\" 같은 보장성·과장 표현 금지. 불안을 키우는 표현 금지. 치료를 강권하지 말고 권유 수준으로. 응급·심각 소견이 의심되면 \"담당 의사와 상의\" 권유로 안내.",
    "【말투】 따뜻하고 차분하며 존중하는 존댓말. 환자를 탓하지 않기."
  ].join("\n");
  const guide=getCommentGuide();
  if(guide){ sys+="\n\n[의사가 지정한 추가 지침 — 아래 지침이 위 기본 규칙과 충돌하면 아래 지침을 우선하세요]\n"+guide; }
  const usr=deidHeader(ctx)+"\n\n[측정 결과 시계열]\n"+(measureText||"(없음)")+"\n\n[의사 차트 내용]\n"+(deidChart(chartText,ctx)||"(없음)")+"\n\n※ 위 차트 내용에서 환자의 증상과, 다음 경과 관찰(follow up) 일정 또는 '치료 종결' 여부를 찾아 코멘트에 반영해 주세요. 차트에 follow up 관련 정보가 없으면 마무리 문장은 다음 경과를 함께 지켜보자는 톤으로 작성하세요.\n\n위 정보를 바탕으로 환자용 코멘트를 작성해 주세요.";
  return await callAI({ model:"claude-sonnet-4-6", max_tokens:1000, system:sys, messages:[{role:"user",content:usr}] });
}
// 실제 레포트 생성 + 다운로드 (autoComment: 미리 채울 코멘트)
async function doExport(ctx, autoComment){
  const eb=$("exportBtn"); const old=eb?eb.textContent:""; if(eb){ eb.disabled=true; eb.textContent="⏳ Exporting…"; }
  try{
    const clinicPw=(typeof window!=="undefined"&&window.getClinicPw)?window.getClinicPw():"qksemtgks";
    const html=buildReportHTML({pid:ctx.pid,pname:ctx.pname,sex:ctx.sex,age:ctx.age,birth:ctx.birth,clinicPw,series:ctx.series,first:ctx.first,last:ctx.last,imgBefore:ctx.imgBefore,imgAfter:ctx.imgAfter,imgsBefore:ctx.imgsBefore||[],imgsAfter:ctx.imgsAfter||[],autoComment:autoComment||""});
    const blob=new Blob([html],{type:"text/html"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    const fnDate=(ctx.last.date||"")+(ctx.first!==ctx.last?("_"+(ctx.first.date||"")):"");
    a.href=url; a.download="JS_report_"+(ctx.pid||"patient")+"_"+fnDate+".html";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),4000);
  }catch(err){ alert("Export failed: "+err.message); }
  finally{ if(eb){ eb.disabled=false; eb.textContent=old; } }
}
// 차트 입력 모달 제어
function openChartModal(ctx){
  const modal=$("chartModal"); if(!modal){ doExport(ctx,""); return; }
  const ta=$("chartInput"), status=$("chartStatus"), go=$("chartGo"), cancel=$("chartCancel"), close=$("chartClose"), skip=$("chartSkip");
  ta.value=""; status.textContent=""; skip.checked=false; go.disabled=false; go.textContent="✨ 코멘트 생성 후 내보내기";
  // API 키 미설정 시 안내 + 기본을 '코멘트 없이'로
  if(!aiAvailable()){ skip.checked=true; status.textContent="AI 코멘트는 로그인 상태에서 사용할 수 있습니다. 지금은 코멘트 없이 내보냅니다."; }
  modal.classList.add("show"); setTimeout(()=>ta.focus(),50);
  function done(){ modal.classList.remove("show"); }
  cancel.onclick=done; close.onclick=done;
  go.onclick=async()=>{
    if(skip.checked){ done(); doExport(ctx,""); return; }
    if(!aiAvailable()){ status.textContent="AI 코멘트를 사용할 수 없습니다(로그인 필요). '코멘트 없이 바로 내보내기'를 선택하세요."; return; }
    const chartText=ta.value.trim();
    if(!chartText){ status.textContent="차트 내용을 입력하거나, '코멘트 없이 바로 내보내기'를 선택하세요."; return; }
    go.disabled=true; go.textContent="⏳ 코멘트 생성 중…"; status.textContent="AI가 측정 결과와 차트를 분석하고 있습니다…";
    try{
      const comment=await generatePatientComment(chartText, ctx);
      done(); doExport(ctx, comment);
    }catch(e){
      status.textContent="코멘트 생성에 실패했습니다 ("+(e&&e.message||e)+"). 코멘트 없이 내보내려면 위 체크박스를 선택하세요.";
      go.disabled=false; go.textContent="✨ 코멘트 생성 후 내보내기";
    }
  };
}
function buildReportHTML(d){
  const esc=s=>(""+s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
  // 레포트 고유 식별자: 환자ID + 포함된 검사들의 날짜/시각 조합 (다른 레포트끼리 코멘트가 섞이지 않도록)
  const __rsig=((d.pid||"")+"|"+(d.series||[]).map(s=>(s.date||"")+(s.time||"")).join(",")).replace(/[^0-9A-Za-z,|]/g,"");
  const keys=[]; const seen={}; d.series.forEach(s=>Object.keys(s.metrics).forEach(k=>{ if(!seen[k]){seen[k]=1;keys.push(k);} }));
  // 모든 항목은 0에 가까울수록 좋음. 쉬운말(전문용어) 병기 라벨.
  function lab(key){
    // 측면(시상면) 지표: 영문 키 → 쉬운 한글
    const sagMap={
      "Trunk forward (SVA)":"몸이 앞으로 쏠린 정도",
      "Head forward (cSVA)":"목(머리)이 앞으로 나온 정도",
      "Lumbar curve (PI-LL)":"허리가 알맞게 휜 정도",
      "Pelvic compensation (PT)":"골반이 뒤로 젖혀 버티는 정도",
      "Neck curve (T1S-CL)":"목이 알맞게 휜 정도"
    };
    if(sagMap[key]) return sagMap[key];
    let k=key, suf="";
    if(/ L–R diff$/.test(k)){ suf=" 좌우 높이차"; k=k.replace(/ L–R diff$/,""); }
    else if(/ rotation$/.test(k)){ suf=" 돌아간 정도"; k=k.replace(/ rotation$/,""); }
    else if(/ midline dist$/.test(k)){ suf=" 가운데서 벗어난 정도"; k=k.replace(/ midline dist$/,""); }
    const map={
      "Cobb angle":"척추가 휜 각도(Cobb각)","Clavicle":"어깨 높이(쇄골)","Iliac crest":"골반 높이(장골능)",
      "Femoral head":"고관절 높이(대퇴골두)","Sacral base":"엉치뼈 기울기(천골저)","Mandibular angle":"턱 높이(하악각)",
      "Coracoid":"어깨 앞쪽(오훼돌기)","Obturator":"골반 구멍 좌우(폐쇄공)","LT-IR":"골반 아래 좌우(하전장골)","Pelvic ratio":"골반 안정성(경사도)"
    };
    let base=k;
    for(const en in map){ if(k.indexOf(en)===0){ base=map[en]+k.slice(en.length); break; } }
    // 척추 레벨 쉬운말
    base=base.replace(/\bC([1-7])\b/g,"목뼈($1번)").replace(/\bT([0-9]{1,2})\b/g,"등뼈($1번)")
             .replace(/\bL([1-5])\b/g,"허리뼈($1번)").replace(/\bS([12])\b/g,"엉치뼈($1번)").replace(/\bCoccyx\b/g,"꼬리뼈");
    return base+suf;
  }
  function labEn(key){ return key; }
  // 대부분 항목은 0에 가까울수록(낮을수록) 좋음. 단, 골반 경사도(Pelvic ratio)는 높을수록 좋음.
  function higherIsBetter(key){ return /^Pelvic ratio/.test(key); }
  function trendOf(key){
    const vals=d.series.map(s=>(s.metrics[key]&&s.metrics[key].value!=null)?s.metrics[key].value:null);
    const unit=(d.series.map(s=>s.metrics[key]&&s.metrics[key].unit).find(u=>u))||"";
    // absMode: |값|이 0에 가까울수록 좋은 지표(SVA·cSVA·PI−LL 등). 측정값 객체의 absMode 플래그로 판정.
    const absMode=d.series.some(s=>s.metrics[key]&&s.metrics[key].absMode===true);
    const valid=vals.filter(v=>v!=null);
    if(valid.length<2) return {state:"none",unit,first:valid[0]??null,last:valid[valid.length-1]??null,delta:null,prev:null,prevDelta:null,prevState:"none",hib:higherIsBetter(key)};
    const hib=higherIsBetter(key);
    // 개선 방향(좋아짐)을 +로 환산
    function judge(from,to){
      const raw=to-from;                      // 실제 변화량(부호 그대로, 표시용)
      let improve;
      if(absMode){ improve = Math.abs(from) - Math.abs(to); }   // |값|이 줄면 호전(0에 가까워짐)
      else { improve = hib ? raw : -raw; }    // 낮을수록 좋으면 -raw, 높을수록 좋으면 +raw
      // 임계 하한
      const base = absMode ? Math.abs(from) : Math.abs(from);
      const floor = unit ? 0.5 : Math.max(base*0.08, 0.01);
      const thr=Math.max(floor, base*0.05);
      let s="hold"; if(improve>thr) s="good"; else if(improve<-thr) s="watch";
      return {raw, s};
    }
    const fv=valid[0], lv=valid[valid.length-1];
    const o=judge(fv,lv);
    const pv=valid[valid.length-2];
    const p=judge(pv,lv);
    return {state:o.s,unit,first:fv,last:lv,delta:o.raw,prev:pv,prevDelta:p.raw,prevState:p.s,hib,absMode};
  }
  // 정렬 순서(사용자 지정): ①중심선 이탈 ②척추 회전 ③Cobb각 ④턱 ⑤어깨 ⑥골반 ⑦골반 틀어짐
  // 각 그룹 안에서 척추는 위→아래(C→T→L→S→천골저→꼬리뼈), 부위는 지정 순서.
  function orderScore(key){
    // 척추 레벨 → 위에서 아래로 가는 단일 점수(C1..C7 < T1..T12 < L1..L5 < S1..S2 < 천골저 < 꼬리뼈)
    function spineLevel(k){
      const mC=k.match(/\bC([1-7])\b/), mT=k.match(/\bT(1[0-2]|[1-9])\b/), mL=k.match(/\bL([1-5])\b/), mS=k.match(/\bS([12])\b/);
      if(mC) return 0+parseInt(mC[1],10);          // 1..7
      if(mT) return 10+parseInt(mT[1],10);         // 11..22
      if(mL) return 30+parseInt(mL[1],10);         // 31..35
      if(mS) return 40+parseInt(mS[1],10);         // 41..42
      if(/Sacral base/.test(k)) return 50;          // 천골저
      if(/Coccyx/.test(k)) return 60;               // 꼬리뼈
      return 99;
    }
    let group, sub=0;
    if(/ midline dist$/.test(key)){ group=0; sub=spineLevel(key); }          // ① 중심선 이탈
    else if(/ rotation$/.test(key)){ group=1; sub=spineLevel(key); }         // ② 척추 회전
    else if(/^Cobb angle/.test(key)){ group=2; const n=key.match(/#(\d+)/); sub=n?parseInt(n[1],10):0; } // ③ Cobb각
    else if(/Mandibular/.test(key)){ group=3; sub=0; }                       // ④ 턱
    else if(/Coracoid/.test(key)){ group=4; sub=0; }                         // ⑤ 어깨: 오훼돌기
    else if(/Clavicle/.test(key)){ group=4; sub=1; }                         //         → 쇄골
    else if(/Iliac crest/.test(key)){ group=5; sub=0; }                      // ⑥ 골반: 장골능
    else if(/Obturator/.test(key)){ group=5; sub=1; }                        //         → 폐쇄공
    else if(/LT-IR/.test(key)){ group=5; sub=2; }                            //         → 하전장골
    else if(/Femoral head/.test(key)){ group=5; sub=3; }                     //         → 대퇴골두
    else if(/Pelvic ratio/.test(key)){ group=6; sub=0; }                     // ⑦ 골반 틀어짐
    else { group=7; sub=spineLevel(key); }                                   // 기타(좌우 높이차 등 미지정)는 맨 뒤
    return group*1000 + sub;
  }
  keys.sort((a,b)=>{ const d=orderScore(a)-orderScore(b); return d!==0?d:a.localeCompare(b); });
  const trends=keys.map(k=>({key:k,t:trendOf(k)}));

  // 요약 뱃지 텍스트(그룹 뱃지/단일 항목 뱃지에서 사용)
  function badgeText(st){
    if(st==="good") return {en:"Improved",ko:"좋아졌어요"};
    if(st==="watch") return {en:"Needs attention",ko:"조금 더 살펴봐요"};
    return {en:"Well maintained",ko:"잘 유지했어요"};
  }

  // 부위별 변화 — 전체 시점 시계열 차트(SVG, 컨테이너에 꽉 맞아 넘치지 않음)
  function sparkline(key,t,narrow){
    const pts=d.series.map(s=>(s.metrics[key]&&s.metrics[key].value!=null)?s.metrics[key].value:null);
    const idx=[]; pts.forEach((v,i)=>{ if(v!=null) idx.push(i); });
    if(idx.length===0) return "";
    const st=t.state;
    const stroke = st==="good"?"var(--green-bar)":(st==="watch"?"var(--watch)":"var(--neutral)");
    // viewBox: A4는 가로로 넓게, 카톡(narrow)은 폭 대비 세로를 키워 납작해지지 않게.
    const W=narrow?360:600, H=narrow?230:132, padL=narrow?10:8, padR=narrow?52:58, padT=narrow?18:16, padB=narrow?28:26;
    const FS=narrow?15:11, FSv=narrow?16:12, FS0=narrow?13:10, R=narrow?5.5:4.8, LW=narrow?3.2:2.4;
    const n=d.series.length;
    const xs=i=>padL+(n<=1?0:(i*(W-padL-padR)/(n-1)));
    const vmax=Math.max.apply(null, pts.filter(v=>v!=null).map(v=>Math.abs(v)).concat([1]));
    const ys=v=>padT+(1-Math.abs(v)/vmax)*(H-padT-padB); // 0이 아래, 값 클수록 위
    const y0=ys(0);
    // 라인 path(값 있는 점만 연결)
    let dpath=""; idx.forEach((i,k)=>{ dpath+=(k===0?"M":"L")+xs(i).toFixed(1)+" "+ys(pts[i]).toFixed(1)+" "; });
    const lastI=idx[idx.length-1], firstI=idx[0];
    const prevI=(idx.length>=2)?idx[idx.length-2]:null;
    const lastV=pts[lastI], firstV=pts[firstI];
    // 마지막 구간(직전→마지막) 강조선: 직전 변화 상태 색
    let lastSeg="";
    if(prevI!=null){
      const pstroke = t.prevState==="good"?"var(--green-bar)":(t.prevState==="watch"?"var(--watch)":"var(--neutral)");
      lastSeg="<path d='M"+xs(prevI).toFixed(1)+" "+ys(pts[prevI]).toFixed(1)+" L"+xs(lastI).toFixed(1)+" "+ys(lastV).toFixed(1)+"' fill='none' stroke='"+pstroke+"' stroke-width='"+(LW+1.6)+"' stroke-linecap='round'/>";
    }
    // 도트 + 마지막/직전 강조
    let dots=""; idx.forEach((i,k)=>{ const last=(k===idx.length-1), prev=(prevI!=null&&i===prevI);
      dots+="<circle cx='"+xs(i).toFixed(1)+"' cy='"+ys(pts[i]).toFixed(1)+"' r='"+(last?R:(prev?R*0.83:R*0.67))+"' fill='"+(last?stroke:"#fff")+"' stroke='"+stroke+"' stroke-width='2'/>"; });
    // x축 날짜 라벨(첫·끝만, 겹침 방지)
    const xlabels="<text x='"+xs(firstI).toFixed(1)+"' y='"+(H-7)+"' fill='var(--muted)' font-size='"+FS+"' text-anchor='start'>"+esc(d.series[firstI].short||"")+"</text>"+
                  (lastI!==firstI?"<text x='"+xs(lastI).toFixed(1)+"' y='"+(H-7)+"' fill='var(--muted)' font-size='"+FS+"' text-anchor='end'>"+esc(d.series[lastI].short||"")+"</text>":"");
    // 끝값 라벨(오른쪽 여백)
    const endLab="<text x='"+(xs(lastI)+8).toFixed(1)+"' y='"+(ys(lastV)+4).toFixed(1)+"' fill='"+stroke+"' font-size='"+FSv+"' font-weight='600' font-family=\"'IBM Plex Mono',monospace\">"+lastV+t.unit+"</text>";
    // 0 기준선: 낮을수록 좋은 항목에만 표시(0이 목표). 높을수록 좋은 항목(골반 경사도)은 숨김.
    const zeroLine = t.hib ? "" :
      ("<line x1='"+padL+"' y1='"+y0.toFixed(1)+"' x2='"+(W-padR)+"' y2='"+y0.toFixed(1)+"' stroke='var(--axis)' stroke-width='1.5' stroke-dasharray='4 4' opacity='.65'/>"+
       "<text x='"+(W-padR+6)+"' y='"+(y0+4).toFixed(1)+"' fill='var(--axis)' font-size='"+FS0+"' opacity='.8'>0</text>");
    return "<svg class='spark "+(narrow?"sk":"a4")+"' viewBox='0 0 "+W+" "+H+"' xmlns='http://www.w3.org/2000/svg'>"+
      zeroLine+
      "<path d='"+dpath+"' fill='none' stroke='"+stroke+"' stroke-width='"+LW+"' stroke-linejoin='round' stroke-linecap='round'/>"+
      lastSeg+dots+xlabels+endLab+
      "</svg>";
  }
  // 상태별 칩 문구 — 좋아짐만 변화량 표기, 유지/주의는 긍정적 상태 문구
  function chipPhrase(state,unit,delta,hib){
    const a=(delta!=null)?Math.abs(+delta.toFixed(1)):null;
    if(state==="good") return {ko:(a!=null?(a+unit+" 좋아짐"):"좋아짐"), en:(a!=null?(a+unit+" better"):"better")};
    if(state==="watch") return {ko:"조금 더 살펴봐요", en:"keep an eye on it"};
    return {ko:"잘 유지했어요", en:"well maintained"};
  }
  // ── 그룹 멀티라인 차트: 같은 종류 항목들을 한 그래프에 여러 선으로 ──
  const PALETTE=["#1FB07F","#2E73E8","#E07A2E","#9B5DE5","#E0395A","#0FB5C4","#C28A00","#6B7686","#D6457F","#3AA655"];
  function multiChart(items,narrow){
    // items: [{key,t,short(짧은라벨),color}]
    const n=d.series.length;
    const W=narrow?360:600, padL=narrow?10:8, padR=narrow?54:64, padT=narrow?16:14, padB=narrow?26:24;
    // 카톡(narrow)은 세로를 키워 납작해지지 않게
    const H=narrow?240:150;
    const FS=narrow?14:10.5, FSv=narrow?14:10.5, FS0=narrow?13:10, R=narrow?5:4, LW=narrow?3:2.2;
    const xs=i=>padL+(n<=1?0:(i*(W-padL-padR)/(n-1)));
    // 그룹 공통 최대값(같은 단위 가정). 정규화로 한 축에.
    let vmax=1;
    items.forEach(it=>{ d.series.forEach(s=>{ const v=s.metrics[it.key]&&s.metrics[it.key].value; if(v!=null) vmax=Math.max(vmax,Math.abs(v)); }); });
    const anyHib=items.some(it=>it.t.hib);
    const ys=v=>padT+(1-Math.abs(v)/vmax)*(H-padT-padB);
    const y0=ys(0);
    // 0 기준선(높을수록 좋은 그룹은 숨김)
    let svg="<svg class='spark "+(narrow?"sk":"a4")+"' viewBox='0 0 "+W+" "+H+"' xmlns='http://www.w3.org/2000/svg'>";
    if(!anyHib){
      svg+="<line x1='"+padL+"' y1='"+y0.toFixed(1)+"' x2='"+(W-padR)+"' y2='"+y0.toFixed(1)+"' stroke='var(--axis)' stroke-width='1.5' stroke-dasharray='4 4' opacity='.55'/>"+
           "<text x='"+(W-padR+6)+"' y='"+(y0+4).toFixed(1)+"' fill='var(--axis)' font-size='"+FS0+"' opacity='.8'>0</text>";
    }
    // 각 항목 라인
    const endLabels=[];
    items.forEach(it=>{
      const pts=d.series.map(s=>(s.metrics[it.key]&&s.metrics[it.key].value!=null)?s.metrics[it.key].value:null);
      const idx=[]; pts.forEach((v,i)=>{ if(v!=null) idx.push(i); });
      if(!idx.length) return;
      let dpath=""; idx.forEach((i,k)=>{ dpath+=(k===0?"M":"L")+xs(i).toFixed(1)+" "+ys(pts[i]).toFixed(1)+" "; });
      svg+="<path d='"+dpath+"' fill='none' stroke='"+it.color+"' stroke-width='"+LW+"' stroke-linejoin='round' stroke-linecap='round' opacity='.95'/>";
      // 도트
      idx.forEach((i,k)=>{ const last=(k===idx.length-1);
        svg+="<circle cx='"+xs(i).toFixed(1)+"' cy='"+ys(pts[i]).toFixed(1)+"' r='"+(last?R:R*0.65)+"' fill='"+(last?it.color:"#fff")+"' stroke='"+it.color+"' stroke-width='1.8'/>"; });
      const lastI=idx[idx.length-1];
      endLabels.push({y:ys(pts[lastI]), x:xs(lastI), v:pts[lastI], unit:it.t.unit, color:it.color});
    });
    // 끝값 라벨(겹침 방지: y 정렬 후 최소간격 확보)
    endLabels.sort((a,b)=>a.y-b.y);
    const minGap=narrow?16:12; let prevY=-99;
    endLabels.forEach(L=>{ let yy=L.y; if(yy-prevY<minGap) yy=prevY+minGap; prevY=yy;
      svg+="<text x='"+(W-padR+6)+"' y='"+(yy+3).toFixed(1)+"' fill='"+L.color+"' font-size='"+FSv+"' font-weight='600' font-family=\"'IBM Plex Mono',monospace\">"+L.v+L.unit+"</text>"; });
    // x축 날짜(첫·끝)
    const fI=0,lI=n-1;
    svg+="<text x='"+xs(fI).toFixed(1)+"' y='"+(H-6)+"' fill='var(--muted)' font-size='"+FS+"' text-anchor='start'>"+esc(d.series[fI].short||"")+"</text>";
    if(lI!==fI) svg+="<text x='"+xs(lI).toFixed(1)+"' y='"+(H-6)+"' fill='var(--muted)' font-size='"+FS+"' text-anchor='end'>"+esc(d.series[lI].short||"")+"</text>";
    svg+="</svg>";
    return svg;
  }
  // 모든 검사일의 실제 측정값을 작은 표로 (그래프 아래 표기)
  function valuesRow(key,unit){
    let cells="";
    d.series.forEach(s=>{
      const v=(s.metrics[key]&&s.metrics[key].value!=null)?(s.metrics[key].value+unit):"—";
      cells+="<span class='vcell'><span class='vd'>"+esc(s.short||s.label||"")+"</span><span class='vv mono'>"+esc(v)+"</span></span>";
    });
    return "<div class='valrow'>"+cells+"</div>";
  }
  // 항목 1개의 전체/직전 칩 행 생성
  function chipRow(key,t,colorDot){
    const ov=chipPhrase(t.state,t.unit,t.delta,t.hib);
    let html="<div class='itemrow'>"+
      "<span class='ilegend'>"+(colorDot?("<span class='lgdot' style='background:"+colorDot+"'></span>"):"")+
      "<span class='iname'><span data-en=\""+esc(labEn(key))+"\" data-ko=\""+esc(lab(key))+"\">"+esc(lab(key))+"</span></span></span>"+
      "<span class='ichips'>"+
        "<span class='dchip "+t.state+"'><span class='dk' data-en='Overall' data-ko='전체'>전체</span>"+
          "<span class='dv mono'>"+t.first+t.unit+" → "+t.last+t.unit+"</span>"+
          "<span class='dt' data-en='"+ov.en+"' data-ko='"+ov.ko+"'>"+ov.ko+"</span></span>";
    if(t.prev!=null){ const pv=chipPhrase(t.prevState,t.unit,t.prevDelta,t.hib);
      html+="<span class='dchip "+t.prevState+"'><span class='dk' data-en='vs last' data-ko='직전 대비'>직전 대비</span>"+
        "<span class='dv mono'>"+t.prev+t.unit+" → "+t.last+t.unit+"</span>"+
        "<span class='dt' data-en='"+pv.en+"' data-ko='"+pv.ko+"'>"+pv.ko+"</span></span>";
    }
    html+="</span></div>";
    if(d.showValues) html+=valuesRow(key,t.unit);
    return html;
  }
  // 그룹 분류
  function groupOf(key){
    if(/\((SVA|cSVA|PI-LL|PT|T1S-CL)\)$/.test(key)) return "sag";
    if(/ midline dist$/.test(key)) return "midline";
    if(/ rotation$/.test(key)) return "rotation";
    if(/^Cobb angle/.test(key)) return "cobb";
    if(/^Pelvic ratio/.test(key)) return "pelvic";
    if(/ L–R diff$/.test(key)) return "ldiff";
    return "etc";
  }
  const groupTitle={
    midline:{en:"Off-center distance",ko:"중심선 이탈"},
    rotation:{en:"Rotation",ko:"척추 회전"},
    ldiff:{en:"Left–right height difference",ko:"좌우 높이차"},
    cobb:{en:"Spinal curve (Cobb)",ko:"척추 만곡(Cobb각)"},
    pelvic:{en:"Pelvic balance",ko:"골반 안정성(경사도)"},
    sag:{en:"Sagittal alignment (side view)",ko:"옆에서 본 정렬(시상면)"},
    etc:{en:"Other",ko:"기타"}
  };
  // trends를 그룹별로 모으되, 기존 정렬(keys 순서) 유지
  const groupOrder=["midline","rotation","cobb","pelvic","ldiff","sag","etc"];
  const grouped={}; groupOrder.forEach(g=>grouped[g]=[]);
  trends.forEach(({key,t})=>{ if(t.first==null&&t.last==null) return; grouped[groupOf(key)].push({key,t}); });

  // 그룹 요약 상태(전체 항목 중 호전/주의 카운트로 그룹 뱃지)
  function groupBadge(items){
    let g=0,w=0,h=0; items.forEach(({t})=>{ if(t.state==="good")g++; else if(t.state==="watch")w++; else h++; });
    let st,ko,en;
    if(g>0&&w===0){ st="good"; ko="좋아졌어요"; en="Improved"; }
    else if(w>0&&g===0){ st="watch"; ko="조금 더 살펴봐요"; en="Needs attention"; }
    else if(g>0&&w>0){ st="good"; ko=g+"곳 좋아졌어요"; en=g+" improved"; }
    else { st="hold"; ko="잘 유지했어요"; en="Well maintained"; }
    return {st,ko,en,g,w,h};
  }

  // 지정한 그룹들만 골라 지표 행(bars)을 생성
  function renderBars(groupKeys){
    let out="";
    groupKeys.forEach(g=>{
      const items=grouped[g]; if(!items || !items.length) return;
      const multi = (g==="midline"||g==="rotation"||g==="ldiff");
      if(multi && items.length>1){
        const colored=items.map((it,i)=>({...it, color:PALETTE[i%PALETTE.length]}));
        const gb=groupBadge(items);
        const gt=groupTitle[g];
        let chips=""; colored.forEach(it=>{ chips+=chipRow(it.key,it.t,it.color); });
        out+="<div class='lvrow grouped'>"+
          "<div class='lvhead'><span class='lvname'><span data-en=\""+gt.en+"\" data-ko=\""+gt.ko+"\">"+gt.ko+"</span></span>"+
            "<span class='lvbadge "+gb.st+"'><span class='dot'></span><span data-en=\""+gb.en+"\" data-ko=\""+gb.ko+"\">"+gb.ko+"</span></span></div>"+
          "<div class='sparkwrap'>"+multiChart(colored,false)+multiChart(colored,true)+"</div>"+
          "<div class='itemlist'>"+chips+"</div></div>";
      } else {
        items.forEach(({key,t})=>{
          const st=t.state; const bt=badgeText(st);
          const badge="<span class='lvbadge "+st+"'><span class='dot'></span><span data-en='"+bt.en+"' data-ko='"+bt.ko+"'>"+bt.ko+"</span></span>";
          const ov=chipPhrase(t.state,t.unit,t.delta,t.hib);
          const overallChip="<span class='dchip "+t.state+"'><span class='dk' data-en='Overall' data-ko='전체'>전체</span>"+
            "<span class='dv mono'>"+t.first+t.unit+" → "+t.last+t.unit+"</span>"+
            "<span class='dt' data-en='"+ov.en+"' data-ko='"+ov.ko+"'>"+ov.ko+"</span></span>";
          let prevChip="";
          if(t.prev!=null){ const pv=chipPhrase(t.prevState,t.unit,t.prevDelta,t.hib);
            prevChip="<span class='dchip "+t.prevState+"'><span class='dk' data-en='vs last' data-ko='직전 대비'>직전 대비</span>"+
              "<span class='dv mono'>"+t.prev+t.unit+" → "+t.last+t.unit+"</span>"+
              "<span class='dt' data-en='"+pv.en+"' data-ko='"+pv.ko+"'>"+pv.ko+"</span></span>";
          }
          out+="<div class='lvrow'>"+
            "<div class='lvhead'><span class='lvname'><span data-en=\""+esc(labEn(key))+"\" data-ko=\""+esc(lab(key))+"\">"+esc(lab(key))+"</span></span>"+badge+"</div>"+
            "<div class='sparkwrap'>"+sparkline(key,t,false)+sparkline(key,t,true)+"</div>"+
            "<div class='lvchips'>"+overallChip+prevChip+"</div>"+
            (d.showValues?valuesRow(key,t.unit):"")+"</div>";
        });
      }
    });
    return out;
  }
  const AP_GROUPS=["midline","rotation","cobb","pelvic","ldiff","etc"];
  const SAG_GROUPS=["sag"];
  const apBars=renderBars(AP_GROUPS);
  const sagBars=renderBars(SAG_GROUPS);
  const bars=apBars+sagBars;   // graphsOnly 등에서 쓰는 전체 합본
  const hasSag = grouped["sag"] && grouped["sag"].length>0;


  const today=new Date().toISOString().slice(0,10);
  const _imgsBefore=(d.imgsBefore&&d.imgsBefore.length)?d.imgsBefore:(d.imgBefore?[d.imgBefore]:[]);
  const _imgsAfter=(d.imgsAfter&&d.imgsAfter.length)?d.imgsAfter:(d.imgAfter?[d.imgAfter]:[]);
  const viewName=(i)=> (i===0?{ko:"정면",en:"Front (AP)"}:(i===1?{ko:"측면",en:"Side (Lateral)"}:{ko:("뷰 "+(i+1)),en:("View "+(i+1))}));
  const beforeDt=dateTimeDisp(d.first.date,d.first.time), afterDt=dateTimeDisp(d.last.date,d.last.time);
  // 같은 뷰(정면/측면)끼리 이전·이번을 나란히 묶어 비교
  function viewGroup(vi){
    const before=_imgsBefore[vi], after=_imgsAfter[vi];
    if(!before && !after) return "";
    const vn=viewName(vi);
    const head="<div class='cap'><b data-en='"+vn.en+"' data-ko='"+vn.ko+"'>"+vn.ko+"</b></div>";
    const cell=(src,isAfter,dt)=> src ? (
      "<div class='imgview'><div class='vlab "+(isAfter?"vlab-after":"")+"' data-en='"+(isAfter?"After":"Before")+"' data-ko='"+(isAfter?"이번":"이전")+"'>"+(isAfter?"이번":"이전")+"</div><div class='vdt'>"+esc(dt)+"</div><img src='"+src+"'></div>"
    ) : "";
    return "<div class='imgbox'>"+head+"<div class='imgviews'>"+cell(before,false,beforeDt)+cell(after,true,afterDt)+"</div></div>";
  }
  const _maxViews=Math.max(_imgsBefore.length,_imgsAfter.length);
  // 뷰별 이미지 블록(0=정면, 1=측면). 본문에서 사진+해당 지표를 묶어 배치.
  const apImg = viewGroup(0) ? ("<div class='imgs imgs-byview'>"+viewGroup(0)+"</div>") : "";
  const latImg = (_maxViews>1 && viewGroup(1)) ? ("<div class='imgs imgs-byview'>"+viewGroup(1)+"</div>") : "";
  let _vg=""; for(let vi=0; vi<_maxViews; vi++){ _vg+=viewGroup(vi); }
  const imgBlock = _vg ? ("<div class='imgs imgs-byview'>"+_vg+"</div>") : "";

  const hasData=keys.length>0;
  const rangeBlock = "<div class='daterange'>"+
    "<div class='d'><small data-en='PREVIOUS' data-ko='이전 촬영'>이전 촬영</small><b class='mono'>"+esc(dateDisp(d.first.date)||"—")+"</b></div>"+
    "<div class='arrow'>→</div>"+
    "<div class='d'><small data-en='LATEST' data-ko='이번 촬영'>이번 촬영</small><b class='mono'>"+esc(dateDisp(d.last.date)||"—")+"</b></div></div>";

  const STYLE =
    ":root{--paper:#EEF0F4;--card:#FFFFFF;--ink:#161C26;--ink2:#3A4453;--muted:#737E8C;--line:#E6E9EF;--green:#16936A;--green-soft:#E4F3EC;--green-bar:#1FB07F;--axis:#E0395A;--ghost:#A6AEBA;--neutral:#BFC6D1;--neutral-soft:#EFF1F5;--watch:#8A94A3;--watch-soft:#DDE1E8;--shadow:0 1px 2px rgba(20,28,45,.04),0 18px 40px rgba(20,28,45,.07);}"+
    "*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}"+
    "body{margin:0;background:var(--paper);color:var(--ink);font-family:'Pretendard','Pretendard Variable',-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;-webkit-font-smoothing:antialiased;line-height:1.55;letter-spacing:-.005em;}"+
    ".mono{font-family:'IBM Plex Mono','SFMono-Regular',ui-monospace,monospace;font-feature-settings:'tnum' 1;letter-spacing:0;}"+
    ".bar-wrap{display:none}"+
    /* toolbar */
    ".toolbar{position:sticky;top:0;z-index:50;display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:rgba(238,240,244,.86);backdrop-filter:blur(8px);padding:12px 16px;border-bottom:1px solid var(--line);}"+
    ".toolbar .grp{display:flex;gap:5px;background:#fff;border:1px solid var(--line);border-radius:99px;padding:3px;}"+
    ".toolbar button{font:inherit;font-size:13px;font-weight:600;border:0;background:transparent;color:var(--muted);border-radius:99px;padding:7px 15px;cursor:pointer;transition:.15s;}"+
    ".toolbar button.on{background:var(--ink);color:#fff;}"+
    ".toolbar .sp{flex:1}"+
    ".toolbar .act{font:inherit;font-size:13px;font-weight:600;border:1px solid var(--line);background:#fff;color:var(--ink2);border-radius:10px;padding:8px 15px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}"+
    ".toolbar .act.primary{background:var(--green);color:#fff;border-color:var(--green);}"+
    ".toolbar .act:hover{filter:brightness(.97)}"+
    /* page */
    ".stage{padding:26px 18px 60px;display:flex;justify-content:center;}"+
    ".card{width:100%;max-width:860px;background:var(--card);border:1px solid var(--line);border-radius:22px;padding:40px 44px 44px;box-shadow:var(--shadow);}"+
    ".eyebrow{font-size:11.5px;letter-spacing:.2em;font-weight:700;color:var(--axis);text-transform:uppercase;margin:0 0 10px;}"+
    "h1{font-size:30px;font-weight:800;letter-spacing:-.03em;margin:0 0 22px;line-height:1.15;}"+
    ".meta{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;padding-bottom:22px;border-bottom:1px solid var(--line);}"+
    ".meta .who{font-weight:700;font-size:16px;} .meta .who span{color:var(--muted);font-weight:500;margin-left:9px;font-size:14px;}"+
    ".pidtag{display:inline-flex;align-items:center;gap:5px;margin-left:10px;padding:2px 9px;border-radius:99px;background:var(--neutral-soft);font-size:12px;font-weight:600;color:var(--ink2);vertical-align:middle;}"+
    ".pidtag span{margin-left:0;color:var(--muted);font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;}"+
    "body.dark .pidtag{background:#0e1622;}"+
    ".daterange{margin-left:auto;display:flex;align-items:center;gap:14px;}"+
    ".daterange .d{text-align:center;} .daterange .d small{display:block;color:var(--muted);font-size:10.5px;letter-spacing:.1em;font-weight:600;margin-bottom:3px;}"+
    ".daterange .d b{font-weight:600;font-size:15px;} .daterange .arrow{color:var(--axis);font-size:19px;}"+
    "h2{font-size:13px;letter-spacing:.02em;font-weight:700;color:var(--ink2);margin:34px 0 16px;display:flex;align-items:center;gap:9px;}"+
    "h2::before{content:'';width:5px;height:15px;border-radius:3px;background:var(--axis);}"+
    /* summary */
    ".summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}"+
    ".scard{border:1px solid var(--line);border-radius:16px;padding:16px 16px 17px;background:#fff;}"+
    ".scard .tag{font-size:11.5px;font-weight:700;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:99px;margin-bottom:11px;}"+
    ".scard .tag .dot{width:7px;height:7px;border-radius:50%;}"+
    ".scard.good .tag{background:var(--green-soft);color:var(--green);} .scard.good .tag .dot{background:var(--green-bar);}"+
    ".scard.hold .tag{background:var(--neutral-soft);color:var(--muted);} .scard.hold .tag .dot{background:var(--neutral);}"+
    ".scard.watch .tag{background:var(--watch-soft);color:var(--watch);} .scard.watch .tag .dot{background:var(--watch);}"+
    ".scard h3{font-size:15px;margin:0 0 7px;font-weight:700;line-height:1.35;} .scard p{font-size:14px;color:var(--ink2);margin:0;font-weight:600;}"+
    /* images */
    ".imgs{display:grid;grid-template-columns:1fr 1fr;gap:16px;}"+
    ".imgbox{border:1px solid var(--line);border-radius:16px;overflow:hidden;background:#0c0e12;}"+
    ".imgbox .cap{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#fff;border-bottom:1px solid var(--line);}"+
    ".imgbox .cap b{font-size:13px;} .imgbox .cap span{font-size:11.5px;color:var(--muted);} .imgbox img{display:block;width:100%;} .imgbox.after .cap b{color:var(--green);}"+
    ".imgviews{display:flex;gap:0;}.imgview{flex:1 1 0;min-width:0;border-right:1px solid var(--line);position:relative;}.imgview:last-child{border-right:none;}.imgview .vlab{position:absolute;top:6px;left:6px;background:rgba(12,14,18,.78);color:#fff;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:6px;letter-spacing:.3px;}.imgview img{width:100%;}"+
    ".imgview .vlab-after{background:rgba(22,147,106,.92);}"+   // 이번 촬영 라벨은 초록
    ".imgview .vdt{position:absolute;top:6px;right:6px;background:rgba(12,14,18,.7);color:#cfd8e3;font-size:9.5px;font-weight:600;padding:2px 6px;border-radius:6px;}"+
    ".imgs-byview{grid-template-columns:1fr;gap:16px;}"+        // 뷰별 묶음은 1열로 쌓아 좌우=이전/이번 비교
    "@media print{.imgs-byview{grid-template-columns:1fr;}}"+
    ".secthead{margin:26px 0 12px;padding-bottom:7px;border-bottom:2px solid var(--line);font-size:15px;font-weight:800;color:var(--ink);letter-spacing:.3px;}.secthead:first-child{margin-top:6px;}"+
    /* bars — labels OUTSIDE the colored fill, never wrap */
    ".lvrow{padding:15px 0;border-bottom:1px solid var(--line);} .lvrow:last-child{border-bottom:0;}"+
    ".lvhead{display:flex;align-items:center;gap:10px;margin-bottom:11px;flex-wrap:wrap;} .lvname{font-weight:700;font-size:15px;}"+
    ".lvbadge{font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:99px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;} .lvbadge .dot{width:7px;height:7px;border-radius:50%;}"+
    ".lvbadge.good{background:var(--green-soft);color:var(--green);} .lvbadge.good .dot{background:var(--green-bar);}"+
    ".lvbadge.hold{background:var(--neutral-soft);color:var(--muted);} .lvbadge.hold .dot{background:var(--neutral);}"+
    ".lvbadge.watch{background:var(--watch-soft);color:var(--watch);} .lvbadge.watch .dot{background:var(--watch);}"+
    ".sparkwrap{width:100%;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#FbFcFd;padding:6px 10px;}"+
    ".spark{display:block;width:100%;height:auto;}"+
    ".lvchips{display:flex;flex-wrap:wrap;gap:8px;margin-top:11px;justify-content:flex-end;}"+
    ".valrow{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;padding-top:10px;border-top:1px dashed var(--line);}"+
    ".vcell{display:inline-flex;flex-direction:column;align-items:center;gap:2px;min-width:52px;padding:5px 8px;border-radius:8px;background:#F4F6F9;}"+
    ".vcell .vd{font-size:10px;color:var(--muted);}"+
    ".vcell .vv{font-size:12.5px;font-weight:600;color:var(--ink);}"+
    "body.kakao .valrow{gap:5px;} body.kakao .vcell{min-width:44px;padding:4px 6px;}"+
    ".itemlist{margin-top:12px;display:flex;flex-direction:column;gap:8px;}"+
    ".itemrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:7px 10px;border-radius:10px;background:#FaFbFc;border:1px solid var(--line);}"+
    ".ilegend{display:flex;align-items:center;gap:7px;min-width:150px;flex:0 0 auto;}"+
    ".lgdot{width:11px;height:11px;border-radius:3px;flex:none;}"+
    ".iname{font-weight:700;font-size:13.5px;}"+
    ".ichips{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto;}"+
    "body.kakao .ilegend{min-width:0;flex:1 1 100%;} body.kakao .ichips{margin-left:0;flex:1 1 100%;}"+
    ".dchip{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:99px;padding:5px 12px;font-size:12px;background:#fff;}"+
    ".dchip .dk{font-weight:700;font-size:10.5px;letter-spacing:.02em;color:var(--muted);text-transform:uppercase;}"+
    ".dchip .dv{color:var(--ink2);font-size:11.5px;}"+
    ".dchip .dt{font-weight:600;}"+
    ".dchip.good{background:var(--green-soft);border-color:transparent;} .dchip.good .dk{color:var(--green);} .dchip.good .dt{color:var(--green);}"+
    ".dchip.watch{background:var(--watch-soft);border-color:transparent;} .dchip.watch .dk{color:var(--watch);} .dchip.watch .dt{color:var(--watch);}"+
    ".dchip.hold{background:var(--neutral-soft);border-color:transparent;} .dchip.hold .dt{color:var(--muted);}"+
    /* table */
    "table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px;}th,td{border:1px solid var(--line);padding:8px 10px;text-align:center;}"+
    "th{background:#F3F5F8;font-weight:700;color:var(--ink2);}td:first-child,th:first-child{text-align:left;}td.trend{text-align:left;color:var(--muted);white-space:nowrap;}td.trend.tgood{color:var(--green);font-weight:600;}td.trend.twatch{color:var(--muted);font-weight:600;}tr.rgood td:first-child{color:var(--green);font-weight:700;}tr.rwatch td:first-child{color:var(--muted);font-weight:700;}"+
    /* doctor comment */
    ".docwrap{margin-top:18px;}"+
    ".docbtn{font:inherit;font-size:13px;font-weight:600;border:1px dashed var(--neutral);background:#fff;color:var(--muted);border-radius:12px;padding:11px 16px;cursor:pointer;width:100%;text-align:left;display:flex;align-items:center;gap:8px;}"+
    ".docbox{border:1px solid var(--line);border-radius:16px;padding:18px 20px;background:#FbFcFd;}"+
    ".docbox h3{margin:0 0 10px;font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px;}"+
    ".docbox h3 .ic{color:var(--axis)}"+
    ".docbox textarea{width:100%;min-height:90px;border:1px solid var(--line);border-radius:10px;padding:11px 13px;font:inherit;font-size:14px;line-height:1.6;resize:vertical;color:var(--ink);background:#fff;}"+
    ".docbox textarea:focus{outline:2px solid var(--green-soft);border-color:var(--green-bar);}"+
    ".doctext{font-size:14px;line-height:1.7;color:var(--ink);white-space:pre-wrap;}"+
    ".docfoot{margin-top:10px;display:flex;justify-content:flex-end;gap:8px;}"+
    ".docfoot button{font:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:8px 14px;cursor:pointer;border:1px solid var(--line);background:#fff;color:var(--ink2);}"+
    ".docfoot .rm{color:var(--axis);border-color:#f2ccd4;}"+
    /* note */
    ".note{margin-top:28px;background:#FaFbFc;border:1px solid var(--line);border-radius:14px;padding:16px 18px;font-size:13px;color:var(--muted);line-height:1.65;} .note b{color:var(--ink2);}"+
    ".disc{margin-top:13px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.55;}"+
    ".foot{margin-top:18px;font-size:11px;color:var(--ghost);text-align:center;}"+
    /* kakao mode */
    "body.kakao .stage{padding:14px 10px 40px;}"+
    "body.kakao .card{max-width:420px;border-radius:18px;padding:26px 22px 30px;}"+
    "body.kakao h1{font-size:25px;}"+
    "body.kakao .summary{grid-template-columns:1fr;}"+
    "body.kakao .imgs{grid-template-columns:1fr;}"+
    "body.kakao .daterange{margin-left:0;}"+
    "body.kakao .meta{gap:10px 16px;}"+
    "body.kakao table{font-size:12px;}body.kakao th,body.kakao td{padding:6px 6px;}"+
    /* 차트: 기본은 A4용 표시, 카톡 모드에선 세로로 긴 카톡용 차트로 교체 */
    ".spark.sk{display:none;} body.kakao .spark.a4{display:none;} body.kakao .spark.sk{display:block;}"+
    "body.kakao .sparkwrap{padding:10px 8px;}"+
    /* print = A4 */
    "@page{size:A4;margin:14mm;}"+
    "@media print{body{background:#fff;}.toolbar{display:none!important;}.stage{padding:0;}.card{box-shadow:none;border:none;max-width:none;padding:0;}.docbtn{display:none!important;}.docfoot{display:none!important;}.docbox textarea{display:none!important;}.doctext{display:block!important;}}"+
    "@media (max-width:620px){.card{padding:26px 20px 30px;}.summary{grid-template-columns:1fr;}.imgs{grid-template-columns:1fr;}h1{font-size:24px;}.daterange{margin-left:0;}}"+
    /* ── 다크 테마(Analyze, JS PACS 톤) ── */
    "body.dark{--paper:#0a0e15;--card:#0c1119;--ink:#e8eef6;--ink2:#cfe0f2;--muted:#7e94ad;--line:#1f2a3c;--neutral:#3a4860;--neutral-soft:#141c28;--watch:#9fb0c4;--watch-soft:#1a2433;--green:#46e08a;--green-soft:#10261c;--green-bar:#46e08a;--axis:#ff6b86;--ghost:#5f7188;}"+
    "body.dark{background:var(--paper);}"+
    "body.dark .toolbar{background:rgba(10,14,21,.9);border-bottom:1px solid var(--line);}"+
    "body.dark .toolbar .grp{background:#0e1622;border:1px solid var(--line);}"+
    "body.dark .toolbar button{color:var(--muted);}"+
    "body.dark .toolbar button.on{background:var(--accent,#3b82f6);color:#fff;}"+
    "body.dark .card{background:var(--card);border:1px solid var(--line);box-shadow:none;}"+
    "body.dark .sparkwrap{background:#0a0e15;border-color:var(--line);}"+
    "body.dark .itemrow{background:#0e1622;border-color:var(--line);}"+
    "body.dark .vcell{background:#0e1622;}"+
    "body.dark .dchip{background:#0e1622;border-color:var(--line);}"+
    "body.dark .dchip.good{background:var(--green-soft);} body.dark .dchip.watch{background:var(--watch-soft);} body.dark .dchip.hold{background:#141c28;}"+
    "body.dark .lvbadge.good{background:var(--green-soft);} body.dark .lvbadge.watch{background:var(--watch-soft);} body.dark .lvbadge.hold{background:#141c28;}"+
    "body.dark .note{background:#0e1622;border-color:var(--line);}"+
    "body.dark .eyebrow{color:#ff8aa0;}";

  const SCRIPT =
    "function setLang(l){document.documentElement.lang=l;document.querySelectorAll('[data-en]').forEach(function(e){var v=e.getAttribute('data-'+l);if(v!=null)e.textContent=v;});q('#bKo').classList.toggle('on',l==='ko');q('#bEn').classList.toggle('on',l==='en');}"+
    "function q(s){return document.querySelector(s);}"+
    "function setMode(m){var b=document.body;b.classList.toggle('kakao',m==='kakao');b.classList.toggle('a4',m!=='kakao');q('#bA4').classList.toggle('on',m!=='kakao');q('#bKk').classList.toggle('on',m==='kakao');}"+
    "function toggleDoc(){var w=q('#docwrap');var open=w.getAttribute('data-open')==='1';w.setAttribute('data-open',open?'0':'1');q('#docbtn').style.display=open?'flex':'none';q('#docbox').style.display=open?'none':'block';var ta=q('#docArea');if(!open){if(ta){ta.value=(window.__docVal!=null?window.__docVal:(ta.value||''));ta.focus();}}else{var t=ta?ta.value:'';window.__docVal=t;if(q('#docText'))q('#docText').textContent=t;}}"+
    "function saveDoc(){var t=q('#docArea').value;q('#docText').textContent=t;window.__docVal=t;}"+
    "function clearDoc(){q('#docArea').value='';q('#docText').textContent='';window.__docVal='';q('#docArea').setAttribute('data-saved','');__AUTOCOMMENT='';q('#docbox').style.display='none';q('#docbtn').style.display='flex';q('#docwrap').setAttribute('data-open','0');}"+
    "function download(){"+
      "var t=q('#docArea')?q('#docArea').value:'';"+
      "var doc=document.documentElement.cloneNode(true);"+
      "var ta=doc.querySelector('#docArea'); if(ta){ta.textContent=t;ta.setAttribute('data-saved',t);}"+
      "var dt=doc.querySelector('#docText'); if(dt){dt.textContent=t;}"+
      "var dw=doc.querySelector('#docwrap'); if(dw){ if(t&&t.trim()){dw.setAttribute('data-open','1');} else {dw.setAttribute('data-open','0');} }"+
      "var html='<!doctype html>\\n'+doc.outerHTML;"+
      "var blob=new Blob([html],{type:'text/html'});var url=URL.createObjectURL(blob);"+
      "var a=document.createElement('a');a.href=url;a.download='"+esc("JS_report_"+(d.pid||"patient")+"_"+today)+".html';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url);},3000);"+
    "}"+
    "function initDoc(){"+
      "var w=q('#docwrap'); if(!w) return;"+ // graphsOnly 등 코멘트 영역이 없으면 건너뜀
      "var ta=q('#docArea');"+
      // 코멘트 출처 우선순위: ① 파일에 이미 박힌 코멘트(data-saved: 저장본 다시 열기/수정본) ② 이번에 생성한 AI 코멘트 초안. localStorage는 쓰지 않음
      "var saved='';"+
      "var ds=ta?ta.getAttribute('data-saved'):''; if(ds&&ds.trim()) saved=ds;"+
      "if((!saved||!saved.trim()) && __AUTOCOMMENT && __AUTOCOMMENT.trim()){ saved=__AUTOCOMMENT; }"+
      "if(ta){ta.value=saved;} if(q('#docText'))q('#docText').textContent=saved; window.__docVal=saved; if(ta)ta.setAttribute('data-saved',saved);"+
      // 입력 시 화면·data-saved만 갱신(브라우저 저장 안 함). 코멘트는 파일에 담겨 이동됨
      "if(ta&&!ta.__bound){ ta.__bound=true; ta.addEventListener('input',function(){ var v=ta.value; window.__docVal=v; ta.setAttribute('data-saved',v); if(q('#docText'))q('#docText').textContent=v; }); }"+
      "var openAttr=w?w.getAttribute('data-open'):'0';"+
      "if(saved&&saved.trim()){ if(w)w.setAttribute('data-open','1'); q('#docbtn').style.display='none'; q('#docbox').style.display='block'; }"+
      "else if(openAttr==='1'){ q('#docbtn').style.display='none'; q('#docbox').style.display='block'; }"+
      "else { q('#docbtn').style.display='flex'; q('#docbox').style.display='none'; }"+
    "}"+
    // ===== 수정 완료(Finalize): 코멘트 잠금 + 생년월일/비밀번호 암호화 파일 생성 =====
    "var __BIRTH8='"+esc(d.birth||"")+"';"+ // 환자 생년월일 YYYYMMDD (있으면)
    "var __RPID='"+esc((d.pid||"").replace(/'/g,""))+"';"+ // 환자 ID
    "var __RSIG='"+esc(__rsig)+"';"+ // 레포트 고유 식별자(환자ID+검사일시 조합)
    "var __AUTOCOMMENT="+JSON.stringify(d.autoComment||"")+";"+ // AI가 생성한 코멘트 초안(있으면)
    "var __PNAME="+JSON.stringify(d.pname||"")+";"+ // 환자명(케이스 파일에서 코멘트 익명화에 사용)
    "function __docKey(){ return 'jsha_report_comment:'+(__RSIG||__RPID||'_'); }"+
    "var __CLINICPW='"+esc((d.clinicPw||"qksemtgks").replace(/'/g,""))+"';"+ // 리포트 의원 비밀번호
    "function birthKey(){ if(__BIRTH8&&__BIRTH8.length>=8){ return __BIRTH8.slice(2,8); } return ''; }"+ // YYMMDD
    "function buf2b64(b){ var u=new Uint8Array(b),s=''; for(var i=0;i<u.length;i++) s+=String.fromCharCode(u[i]); return btoa(s); }"+
    "function b642buf(s){ var bin=atob(s),u=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u.buffer; }"+
    "async function deriveKey(pass,salt){ var enc=new TextEncoder(); var km=await crypto.subtle.importKey('raw',enc.encode(pass),'PBKDF2',false,['deriveKey']); return await crypto.subtle.deriveKey({name:'PBKDF2',salt:salt,iterations:120000,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['encrypt','decrypt']); }"+
    "async function encryptFor(plain,pass){ var enc=new TextEncoder(); var salt=crypto.getRandomValues(new Uint8Array(16)); var iv=crypto.getRandomValues(new Uint8Array(12)); var key=await deriveKey(pass,salt); var ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},key,enc.encode(plain)); return {salt:buf2b64(salt),iv:buf2b64(iv),ct:buf2b64(ct)}; }"+
    "async function finalizeReport(){"+
      "try{"+
        "var bk=birthKey();"+
        "if(!bk){"+
          "var inp=prompt('이 환자는 생년월일 정보가 없습니다.\\n잠금 해제에 사용할 생년월일 6자리(YYMMDD)를 입력하세요.\\n예: 1991년 1월 31일 → 910131');"+
          "if(inp==null){ return; }"+ // 취소
          "inp=(''+inp).replace(/[^0-9]/g,'');"+
          "if(inp.length===8){ inp=inp.slice(2,8); }"+ // YYYYMMDD로 넣으면 뒤 6자리
          "if(inp.length!==6){ alert('생년월일은 숫자 6자리(YYMMDD)로 입력해 주세요.'); return; }"+
          "bk=inp;"+
        "}"+
        // 코멘트 확정
        "var t=q('#docArea')?q('#docArea').value:''; window.__docVal=t;"+
        // 콘텐츠 클론 후 잠금용으로 정리(툴바 제거, 코멘트 읽기전용)
        "var doc=document.documentElement.cloneNode(true);"+
        "var tb=doc.querySelector('.toolbar'); if(tb) tb.remove();"+ // 모드/언어/수정완료 버튼 제거
        // 코멘트: 입력/버튼은 제거하되, 값 보존용 숨김 textarea로 남겨 잠금 해제 후에도 코멘트 유지
        "var ta=doc.querySelector('#docArea'); if(ta){ ta.setAttribute('data-saved', t); ta.value=t; ta.textContent=t; ta.style.display='none'; ta.setAttribute('readonly','readonly'); }"+
        "var df=doc.querySelector('.docfoot'); if(df) df.remove();"+
        "var db=doc.querySelector('#docbtn'); if(db) db.remove();"+
        "var dt=doc.querySelector('#docText'); if(dt){ dt.textContent=t; }"+
        "var dbox=doc.querySelector('#docbox'); if(dbox){ dbox.style.display = (t&&t.trim())?'block':'none'; }"+
        "var dw=doc.querySelector('#docwrap'); if(dw){ dw.setAttribute('data-open',(t&&t.trim())?'1':'0'); dw.setAttribute('data-locked','1'); }"+
        // 잠금 표시(뱃지 없음 — 텍스트 미표시)
        // 본문 SCRIPT는 그대로 유지(언어/모드 토글은 콘텐츠에 없지만 setLang/setMode 호출은 무해하게 가드)
        "var contentHTML='<!doctype html>\\n'+doc.outerHTML;"+
        // 암호화: 생년월일(YYMMDD) 키로 1회. (의원 비밀번호는 같은 평문을 별도 키로 한 번 더)
        "var encA=await encryptFor(contentHTML, bk);"+
        "var encB=await encryptFor(contentHTML, __CLINICPW);"+
        "var locked=buildLockedHTML(encA, encB);"+
        "var blob=new Blob([locked],{type:'text/html'});var url=URL.createObjectURL(blob);"+
        "var a=document.createElement('a');a.href=url;a.download='"+esc("JS_report_"+(d.pid||"patient")+"_"+today)+"_locked.html';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url);},3000);"+
        "alert('수정 완료되었습니다.\\n암호화된 잠금 파일이 저장되었습니다.\\n환자 생년월일(YYMMDD) 또는 의원 비밀번호로 열 수 있습니다.');"+
      "}catch(e){ alert('수정 완료 처리 중 오류: '+(e&&e.message||e)); }"+
    "}"+
    // ===== 케이스 파일: 개인정보(이름·병록번호) 삭제 + 암호화 없는 평문 HTML =====
    "function makeCaseFile(){"+
      "try{"+
        // 코멘트 현재값 확정
        "var t=q('#docArea')?q('#docArea').value:''; window.__docVal=t;"+
        // 코멘트 본문에서 환자명 가리기(케이스=익명). 이름 전체 + '성+님/씨/환자분' 호칭까지 치환.
        "var tCase=t;"+
        "if(__PNAME && __PNAME.trim()){"+
          "var nm=__PNAME.trim();"+
          "function esc4re(s){ return s.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&'); }"+
          // 1) 전체 이름(예: 손형준) → ○○○ (글자 수 맞춰 동그라미)
          "var circ=new Array(nm.length+1).join('○');"+
          "tCase=tCase.split(nm).join(circ);"+
          // 2) 성씨 + 호칭(예: 손 님, 손님, 손씨, 손 환자분) → ○ 님 등
          "if(nm.length>=2){ var sur=nm.charAt(0);"+
            "tCase=tCase.replace(new RegExp(esc4re(sur)+'\\\\s*(님|씨|환자분)','g'),'○ $1'); }"+
        "}"+
        "var doc=document.documentElement.cloneNode(true);"+
        // 툴바·코멘트 편집 UI 제거(케이스 파일은 보기 전용)
        "var tb=doc.querySelector('.toolbar'); if(tb) tb.remove();"+
        "var ta=doc.querySelector('#docArea'); if(ta){ ta.setAttribute('data-saved', tCase); ta.value=tCase; ta.textContent=tCase; ta.style.display='none'; ta.setAttribute('readonly','readonly'); }"+
        "var df=doc.querySelector('.docfoot'); if(df) df.remove();"+
        "var db=doc.querySelector('#docbtn'); if(db) db.remove();"+
        "var dt=doc.querySelector('#docText'); if(dt){ dt.textContent=tCase; }"+
        "var dbox=doc.querySelector('#docbox'); if(dbox){ dbox.style.display = (tCase&&tCase.trim())?'block':'none'; }"+
        "var dw=doc.querySelector('#docwrap'); if(dw){ dw.setAttribute('data-open',(tCase&&tCase.trim())?'1':'0'); }"+
        // --- 개인정보 익명화 ---
        // 1) 환자 이름: .who 의 텍스트 노드(이름)만 비우고 성별·나이 span은 유지
        "var who=doc.querySelector('.meta .who'); if(who){ for(var i=0;i<who.childNodes.length;i++){ var n=who.childNodes[i]; if(n.nodeType===3){ n.textContent=''; } } }"+
        // 2) 병록번호(ID) 태그 제거
        "var pidtag=doc.querySelector('.meta .pidtag'); if(pidtag) pidtag.remove();"+
        // 3) 혹시 본문 다른 곳에 들어간 ID/이름 data 속성 정리
        "var ids=doc.querySelectorAll('[data-pid]'); for(var k=0;k<ids.length;k++){ ids[k].removeAttribute('data-pid'); }"+
        // 평문 파일 그대로 저장(암호화 없음)
        "var contentHTML='<!doctype html>\\n'+doc.outerHTML;"+
        "var blob=new Blob([contentHTML],{type:'text/html'});var url=URL.createObjectURL(blob);"+
        "var a=document.createElement('a');a.href=url;a.download='"+esc("JS_case_"+today)+"_'+Date.now()+'.html';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(url);},3000);"+
        "alert('케이스 파일이 저장되었습니다.\\n환자 이름과 병록번호가 삭제된 버전입니다.\\n(암호화되지 않은 일반 파일입니다)');"+
      "}catch(e){ alert('케이스 파일 생성 중 오류: '+(e&&e.message||e)); }"+
    "}"+
    // 잠금 파일 HTML(생년월일 입력 화면 + 복호화 스크립트) 생성
    "function buildLockedHTML(encA, encB){"+
      "var payload=JSON.stringify({a:encA,b:encB});"+
      "var css='body{margin:0;font-family:Pretendard,-apple-system,system-ui,sans-serif;background:#0a0e15;color:#e8eef6;display:flex;align-items:center;justify-content:center;min-height:100vh;}'+"+
        "'.lockbox{background:#0c1119;border:1px solid #1f2a3c;border-radius:16px;padding:36px 32px;width:min(380px,92vw);box-shadow:0 20px 60px rgba(0,0,0,.5);text-align:center;}'+"+
        "'.lockbox h1{font-size:18px;margin:0 0 6px;}'+'.lockbox p{font-size:13px;color:#7e94ad;margin:0 0 22px;line-height:1.6;}'+"+
        "'.lockbox input{width:100%;box-sizing:border-box;background:#0a0e15;border:1px solid #25324a;border-radius:9px;padding:12px 14px;color:#e8eef6;font-size:15px;text-align:center;letter-spacing:2px;margin-bottom:12px;}'+"+
        "'.lockbox button{width:100%;background:#3b82f6;color:#fff;border:none;border-radius:9px;padding:12px;font-size:14px;font-weight:700;cursor:pointer;}'+'.lockbox button:hover{filter:brightness(1.08);}'+"+
        "'.lockerr{color:#ff7a7a;font-size:12px;margin-top:10px;min-height:16px;}'+'.lockico{font-size:34px;margin-bottom:10px;}';"+
      "var js=\"var P=\"+payload+\";\"+"+
        "\"function b642buf(s){var bin=atob(s),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u.buffer;}\"+"+
        "\"async function deriveKey(pass,salt){var enc=new TextEncoder();var km=await crypto.subtle.importKey('raw',enc.encode(pass),'PBKDF2',false,['deriveKey']);return await crypto.subtle.deriveKey({name:'PBKDF2',salt:salt,iterations:120000,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['decrypt']);}\"+"+
        "\"async function tryDec(enc,pass){try{var key=await deriveKey(pass,new Uint8Array(b642buf(enc.salt)));var pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(b642buf(enc.iv))},key,b642buf(enc.ct));return new TextDecoder().decode(pt);}catch(e){return null;}}\"+"+
        "\"async function unlock(){var v=document.getElementById('pw').value.trim();var er=document.getElementById('er');er.textContent='';if(!v){er.textContent='생년월일 또는 비밀번호를 입력하세요.';return;}var out=await tryDec(P.a,v);if(out==null)out=await tryDec(P.b,v);if(out==null){er.textContent='생년월일(YYMMDD) 또는 비밀번호가 올바르지 않습니다.';return;}document.open();document.write(out);document.close();}\"+"+
        "\"document.getElementById('go').onclick=unlock;document.getElementById('pw').addEventListener('keydown',function(e){if(e.key==='Enter')unlock();});document.getElementById('pw').focus();\";"+
      "return '<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>JS 리포트 (잠금)</title>'+"+
        "'<link rel=\"stylesheet\" as=\"style\" crossorigin href=\"https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css\"/>'+"+
        "'<style>'+css+'</style></head><body><div class=\"lockbox\">'+"+
        "'<div class=\"lockico\">🔒</div><h1>보호된 리포트</h1>'+"+
        "'<p>환자 생년월일 6자리(YYMMDD)를 입력하면<br>리포트를 보실 수 있습니다.</p>'+"+
        "'<input id=\"pw\" type=\"password\" inputmode=\"numeric\" placeholder=\"예: 900131\" autocomplete=\"off\">'+"+
        "'<button id=\"go\">열기</button><div id=\"er\" class=\"lockerr\"></div></div>'+"+
        "'<script>'+js+'<\\/script></body></html>';"+
    "}"+
    "setLang('"+(d.graphsOnly?"en":"ko")+"');setMode('a4');initDoc();";

  return "<!doctype html><html lang='ko'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"+
    "<title>자세 변화 리포트</title>"+
    "<link rel='preconnect' href='https://fonts.googleapis.com'><link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>"+
    "<link href='https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap' rel='stylesheet'>"+
    "<link rel='stylesheet' as='style' crossorigin href='https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css'/>"+
    "<style>"+STYLE+"</style></head><body class='"+(d.graphsOnly?"a4 dark":"a4")+"'>"+
    (d.graphsOnly?(
      "<div class='toolbar'>"+
        "<div class='grp'><button id='bA4' class='on' onclick=\"setMode('a4')\" data-en='Wide' data-ko='넓게'>Wide</button><button id='bKk' onclick=\"setMode('kakao')\" data-en='Narrow' data-ko='좁게'>Narrow</button></div>"+
        "<div class='grp'><button id='bKo' onclick=\"setLang('ko')\">KOR</button><button id='bEn' class='on' onclick=\"setLang('en')\">ENG</button></div>"+
      "</div>"+
      "<div class='stage'><div class='card'>"+
      "<p class='eyebrow' data-en='MEASUREMENT TRENDS' data-ko='측정값 추이'>측정값 추이</p>"+
      "<h1 data-en='Analysis' data-ko='측정 분석'>측정 분석</h1>"+
      "<div class='meta'><div class='who'>"+esc(d.pname||"—")+" <span>"+esc((d.sex||"")+(d.age?(" · "+d.age):""))+"</span>"+(d.pid?("<span class='pidtag'><span data-en='ID' data-ko='ID'>ID</span> "+esc(d.pid)+"</span>"):"")+"</div>"+rangeBlock+"</div>"+
      (bars?bars:"<p style='color:var(--muted)' data-en='No saved measurements found.' data-ko='저장된 측정값이 없습니다.'>저장된 측정값이 없습니다.</p>")+
      "<div class='note'><b data-en='How to read this' data-ko='읽는 법'>읽는 법</b><br>"+
      "<span data-en='For most items, a line closer to the red 0 line means better balance. Pelvic tilt is the exception — a higher value is better. Each chart shows actual values at every visit.' "+
      "data-ko='대부분 항목은 선이 빨간 0선에 가까울수록 균형이 좋아요. 단, 골반 안정성(경사도)은 수치가 높을수록 좋아요. 각 그래프 아래에 모든 검사일의 실제 측정값이 함께 표시됩니다.'>대부분 항목은 선이 빨간 0선에 가까울수록 균형이 좋아요. 단, 골반 안정성(경사도)은 수치가 높을수록 좋아요. 각 그래프 아래에 모든 검사일의 실제 측정값이 함께 표시됩니다.</span></div>"+
      "</div></div>"+
      "<script>"+SCRIPT+"<\/script>"+
      "</body></html>"
    ):(
    "<div class='toolbar'>"+
      "<div class='grp'><button id='bA4' class='on' onclick=\"setMode('a4')\" data-en='A4 print' data-ko='A4 인쇄용'>A4 인쇄용</button><button id='bKk' onclick=\"setMode('kakao')\" data-en='KakaoTalk' data-ko='카카오톡용'>카카오톡용</button></div>"+
      "<div class='grp'><button id='bKo' class='on' onclick=\"setLang('ko')\">한</button><button id='bEn' onclick=\"setLang('en')\">영</button></div>"+
      "<div class='sp'></div>"+
      "<button class='act' id='caseBtn' onclick='makeCaseFile()' data-en='📋 Case' data-ko='📋 케이스'>📋 케이스</button>"+
      "<button class='act primary' id='finalizeBtn' onclick='finalizeReport()' data-en='🔒 Finalize' data-ko='🔒 수정 완료'>🔒 수정 완료</button>"+
    "</div>"+
    "<div class='stage'><div class='card'>"+
    "<p class='eyebrow' data-en='POSTURE TRACKING' data-ko='자세 경과 추적'>자세 경과 추적</p>"+
    "<h1 data-en='Posture Progress Report' data-ko='자세 변화 리포트'>자세 변화 리포트</h1>"+
    "<div class='meta'><div class='who'>"+esc(d.pname||"—")+" <span>"+esc((d.sex||"")+(d.age?(" · "+d.age):""))+"</span>"+(d.pid?("<span class='pidtag'><span data-en='ID' data-ko='ID'>ID</span> "+esc(d.pid)+"</span>"):"")+"</div>"+rangeBlock+"</div>"+
    // 코멘트 (맨 위 배치)
    "<div class='docwrap' id='docwrap' data-open='0'>"+
      "<button class='docbtn' id='docbtn' onclick='toggleDoc()'><span>＋</span> <span data-en='Add comment' data-ko='코멘트 추가하기'>코멘트 추가하기</span></button>"+
      "<div class='docbox' id='docbox' style='display:none'>"+
        "<h3><span class='ic'>✎</span> <span data-en='Comment' data-ko='코멘트'>코멘트</span></h3>"+
        "<textarea id='docArea' data-saved='' placeholder='환자에게 전달할 코멘트를 입력하세요.'></textarea>"+
        "<div class='doctext' id='docText'></div>"+
        "<div class='docfoot'>"+
          "<button class='rm' onclick='clearDoc()' data-en='Remove' data-ko='삭제'>삭제</button>"+
          "<button onclick='toggleDoc()' data-en='Close' data-ko='접기'>접기</button>"+
        "</div>"+
      "</div>"+
    "</div>"+
    // 정면(AP): 사진 → 관련 지표
    ((apImg||apBars)?(
      "<h2><span data-en='Front view (AP)' data-ko='앞에서 본 정렬 (정면)'>앞에서 본 정렬 (정면)</span></h2>"+
      apImg+
      (apBars||"")
    ):"")+
    // 측면(Lateral): 사진 → 관련 지표
    ((latImg||sagBars)?(
      "<h2><span data-en='Side view (Lateral)' data-ko='옆에서 본 정렬 (측면)'>옆에서 본 정렬 (측면)</span></h2>"+
      latImg+
      (sagBars||"")
    ):"")+
    "<div class='note'><b data-en='How to read this' data-ko='읽는 법'>읽는 법</b><br>"+
    "<span data-en='For most items, a line closer to the red 0 line means better balance. Pelvic tilt is the exception — for it, a higher value is better. Items that got better are shown in green.' "+
    "data-ko='대부분 항목은 선이 빨간 0선에 가까울수록 균형이 좋다는 뜻이에요. 단, 골반 안정성(경사도)은 반대로 수치가 높을수록 좋아요. 좋아진 부위는 초록색으로 보여드려요.'>대부분 항목은 선이 빨간 0선에 가까울수록 균형이 좋다는 뜻이에요. 단, 골반 안정성(경사도)은 반대로 수치가 높을수록 좋아요. 좋아진 부위는 초록색으로 보여드려요.</span></div>"+
    "<p class='disc' data-en='This document is for posture-tracking reference and does not replace a medical diagnosis. Please consult during your visit.' "+
    "data-ko='본 자료는 자세 경과 참고용이며 의학적 진단을 대신하지 않습니다. 자세한 사항은 진료 시 상담해 주세요.'>본 자료는 자세 경과 참고용이며 의학적 진단을 대신하지 않습니다. 자세한 사항은 진료 시 상담해 주세요.</p>"+
    "</div></div>"+
    "<script>"+SCRIPT+"<\/script>"+
    "</body></html>"));
}
/* 미리보기 전용 주석 렌더러 (뷰어 drawScene과 동일 좌표/반전 규칙, 글씨는 항상 정방향) */
function drawPreviewAnno(c, meta, nW, sc, flip){
  if(!meta) return;
  const CC={ref:"#ffe600",pt:"#00eaff",ptl:"#8af3ff",line:"#5dff00",lev:"#1f9dff",levl:"#8cc6ff",rot:"#00ffcc",pel:"#ff9500",obt:"#c77dff",ltr:"#ffbf00",cobb:"#ff5da2"};
  const W=nW*sc, H=meta.height*sc;
  const lineW=Math.max(1.5,W/420), fp=Math.max(15,W/40), R=Math.max(4,W/150);
  const pm=(meta.px_per_mm>0)?meta.px_per_mm:0;
  const refX=(meta.pubic_symphysis_x!=null)?meta.pubic_symphysis_x:(meta.centerline_x!=null?meta.centerline_x:null);
  const fx=x=>(flip?(nW-x):x)*sc;
  const labels=[];
  function otext(t,x,y,col,align,baseline){ c.save(); c.font="bold "+fp+"px sans-serif"; c.textAlign=align||"left"; c.textBaseline=baseline||"alphabetic";
    c.lineWidth=Math.max(2,fp/6); c.strokeStyle="rgba(0,0,0,.92)"; c.strokeText(t,x,y); c.fillStyle=col; c.fillText(t,x,y); c.restore(); }
  const dot=(X,Y,col)=>{ c.fillStyle=col; c.beginPath(); c.arc(X,Y,R,0,7); c.fill(); c.strokeStyle="#fff"; c.lineWidth=Math.max(1,lineW*0.8); c.stroke(); };
  const screenSide=(a,b)=>{ const d=a-b; if(d===0) return ""; return (flip?(d>0):(d<0))?"L":"R"; };
  // 중심선
  if(refX!=null){ const RX=fx(refX); c.strokeStyle=CC.ref; c.lineWidth=lineW*1.3; c.setLineDash([]); c.beginPath(); c.moveTo(RX,0); c.lineTo(RX,H); c.stroke();
    labels.push({x:RX+4,y:3,text:"Midline",color:"#fff07a",align:"left",baseline:"top"}); }
  // 점
  (meta.points||[]).forEach(p=>{ const X=fx(p.x),Y=p.y*sc; let txt=p.label;
    if(refX!=null){ const RX=fx(refX); c.strokeStyle=CC.line; c.lineWidth=lineW; c.setLineDash([6,4]); c.beginPath(); c.moveTo(RX,Y); c.lineTo(X,Y); c.stroke(); c.setLineDash([]);
      const opx=p.x-refX, side=opx<0?"L":(opx>0?"R":""); const dist=(pm>0)?(Math.abs(opx/pm).toFixed(1)+"mm"):(Math.abs(opx)+"px"); txt=p.label+" ("+dist+(side?(" "+side):"")+")"; }
    dot(X,Y,CC.pt); const ll=(refX!=null)?(X<fx(refX)):false;
    labels.push({x:ll?X-R-4:X+R+4,y:Y+fp*0.34,text:txt,color:CC.ptl,align:ll?"right":"left"}); });
  // 레벨(좌우 높이차)
  (meta.level_pairs||[]).forEach(g=>{ const L=g.L,Rp=g.R; let low=null,distStr="";
    if(L&&Rp){ const dpx=Math.abs(L.y-Rp.y); distStr=(pm>0)?(Math.abs(dpx/pm).toFixed(1)+"mm"):(dpx+"px"); low=(L.y>Rp.y)?"L":"R"; }
    [["L",L],["R",Rp]].forEach(([s,pt])=>{ if(pt){ const X=fx(pt.x),Y=pt.y*sc; c.fillStyle=CC.lev; c.fillRect(X-R,Y-R,2*R,2*R); c.strokeStyle="#fff"; c.lineWidth=Math.max(1,lineW*0.8); c.strokeRect(X-R,Y-R,2*R,2*R);
      if(s===low&&distStr) labels.push({x:X,y:Y-R-3,text:distStr,color:CC.levl,align:"center",baseline:"bottom"}); }});
    if(L&&Rp){ const hiY=Math.min(L.y,Rp.y)*sc, lo=(L.y<=Rp.y)?Rp:L; const X1=Math.min(fx(L.x),fx(Rp.x)),X2=Math.max(fx(L.x),fx(Rp.x)),pad=(X2-X1)*0.12+R*2;
      c.strokeStyle=CC.lev; c.lineWidth=lineW*1.2; c.setLineDash([]); c.beginPath(); c.moveTo(X1-pad,hiY); c.lineTo(X2+pad,hiY); c.stroke();
      c.setLineDash([6,4]); c.beginPath(); c.moveTo(fx(lo.x),lo.y*sc); c.lineTo(fx(lo.x),hiY); c.stroke(); c.setLineDash([]); } });
  // 회전
  (meta.rotation||[]).forEach(g=>{ const sr=Math.max(1.5,R*0.45), dd=Math.max(1.8,R*0.5), lw=Math.max(0.6,lineW*0.4);
    if(g.SP){ const X=fx(g.SP.x),Y=g.SP.y*sc; c.fillStyle=CC.pt; c.beginPath(); c.arc(X,Y,sr,0,7); c.fill(); c.strokeStyle="#fff"; c.lineWidth=Math.max(0.5,lw*0.8); c.stroke(); }
    ["LB","RB"].forEach(rl=>{ if(g[rl]){ const X=fx(g[rl].x),Y=g[rl].y*sc; c.fillStyle=CC.rot; c.beginPath(); c.moveTo(X,Y-dd); c.lineTo(X+dd,Y); c.lineTo(X,Y+dd); c.lineTo(X-dd,Y); c.closePath(); c.fill(); c.strokeStyle="#fff"; c.lineWidth=Math.max(0.5,lw*0.8); c.stroke(); }});
    let rotTok="",distTok="",rightEdge=-1e9,anchorY=0;
    if(g.LB&&g.RB){ const cxv=(g.LB.x+g.RB.x)/2, cyv=(g.LB.y+g.RB.y)/2, halfW=Math.abs(g.RB.x-g.LB.x)/2; const CXD=fx(cxv),CYD=cyv*sc; anchorY=g.SP?(g.SP.y*sc):CYD;
      rightEdge=Math.max(fx(g.LB.x)+dd,fx(g.RB.x)+dd); if(g.SP) rightEdge=Math.max(rightEdge,fx(g.SP.x)+sr);
      c.strokeStyle=CC.rot; c.lineWidth=lw; c.setLineDash([]); c.beginPath(); c.moveTo(fx(g.LB.x),g.LB.y*sc); c.lineTo(fx(g.RB.x),g.RB.y*sc); c.stroke();
      if(refX!=null){ const RX=fx(refX); c.strokeStyle=CC.line; c.lineWidth=lw; c.setLineDash([5,3]); c.beginPath(); c.moveTo(RX,CYD); c.lineTo(CXD,CYD); c.stroke(); c.setLineDash([]);
        const opx=cxv-refX; const dist=(pm>0)?(Math.abs(opx/pm).toFixed(1)+"mm"):(Math.abs(opx)+"px"); distTok=dist+screenSide(cxv,refX); }
      if(g.SP){ const PXD=fx(g.SP.x),th=Math.max(3,R*0.85); c.strokeStyle="#fff"; c.lineWidth=lw; c.beginPath(); c.moveTo(CXD,CYD-th); c.lineTo(CXD,CYD+th); c.stroke();
        c.strokeStyle=CC.rot; c.lineWidth=Math.max(0.8,lw*1.5); c.beginPath(); c.moveTo(PXD,CYD-th); c.lineTo(PXD,CYD+th); c.stroke();
        const pct=halfW>0?(Math.abs(g.SP.x-cxv)/halfW*100):0; rotTok=pct.toFixed(0)+"%"+screenSide(g.SP.x,cxv); }
      const txt=[g.label,rotTok,distTok].filter(Boolean).join(" "); labels.push({x:rightEdge+16,y:anchorY+fp*0.34,text:txt,color:CC.ptl,align:"left"}); }
    else if(g.SP){ const PXD=fx(g.SP.x),PYD=g.SP.y*sc; let dtok=""; if(refX!=null){ const RX=fx(refX); c.strokeStyle=CC.line; c.lineWidth=lw; c.setLineDash([5,3]); c.beginPath(); c.moveTo(RX,PYD); c.lineTo(PXD,PYD); c.stroke(); c.setLineDash([]);
        const opx=g.SP.x-refX; const dd2=(pm>0)?(Math.abs(opx/pm).toFixed(1)+"mm"):(Math.abs(opx)+"px"); dtok=dd2+screenSide(g.SP.x,refX); }
      labels.push({x:PXD+sr+12,y:PYD+fp*0.34,text:[g.label,dtok].filter(Boolean).join(" "),color:CC.ptl,align:"left"}); } });
  // 골반강
  const pv=meta.pelvis; if(pv){ const A=pv.A,B=pv.B,Cc=pv.C; [A,B,Cc].forEach(p=>{ if(p) dot(fx(p.x),p.y*sc,CC.pel); });
    if(A&&B){ c.strokeStyle=CC.pel; c.lineWidth=lineW; c.setLineDash([]); c.beginPath(); c.moveTo(fx(A.x),A.y*sc); c.lineTo(fx(B.x),B.y*sc); c.stroke(); }
    if(A&&B&&Cc){ const abx=B.x-A.x,aby=B.y-A.y,ab2=abx*abx+aby*aby; const t=ab2>0?(((Cc.x-A.x)*abx+(Cc.y-A.y)*aby)/ab2):0; const Fx2=A.x+t*abx,Fy2=A.y+t*aby;
      c.setLineDash([6,4]); c.strokeStyle=CC.pel; c.lineWidth=lineW; c.beginPath(); c.moveTo(fx(Cc.x),Cc.y*sc); c.lineTo(fx(Fx2),Fy2*sc); c.stroke(); c.setLineDash([]);
      const ablen=Math.sqrt(ab2); const perp=ablen>0?(Math.abs(abx*(Cc.y-A.y)-aby*(Cc.x-A.x))/ablen):0; const val=ablen>0?(perp/ablen):0;
      labels.push({x:fx((A.x+B.x+Cc.x)/3),y:(A.y+B.y+Cc.y)/3*sc,text:val.toFixed(2),color:CC.pel,align:"center"}); } }
  // 폐쇄공/LT-IR
  const SH={obt:{short:"Obturator",color:CC.obt},ltr:{short:"LT-IR",color:CC.ltr}};
  ["obt","ltr"].forEach(kind=>{ const arr=(meta.spans&&meta.spans[kind])||[]; const col=SH[kind].color;
    ["L","R"].forEach(side=>{ const a=arr.find(p=>p.side===side&&p.role==="a"), b=arr.find(p=>p.side===side&&p.role==="b");
      if(a) dot(fx(a.x),a.y*sc,col); if(b) dot(fx(b.x),b.y*sc,col);
      if(a&&b){ c.strokeStyle=col; c.lineWidth=lineW*1.2; c.setLineDash([]); c.beginPath(); c.moveTo(fx(a.x),a.y*sc); c.lineTo(fx(b.x),b.y*sc); c.stroke();
        const dpx=Math.hypot(a.x-b.x,a.y-b.y); const ds=(pm>0)?(dpx/pm).toFixed(1)+"mm":Math.round(dpx)+"px"; labels.push({x:fx((a.x+b.x)/2),y:(a.y+b.y)/2*sc-R-3,text:ds,color:col,align:"center",baseline:"bottom"}); } }); });
  // Cobb
  (meta.cobbs||[]).forEach(cb=>{ const drawLine=(ln,col)=>{ if(ln&&ln.a&&ln.b){ const X1=fx(ln.a.x),Y1=ln.a.y*sc,X2=fx(ln.b.x),Y2=ln.b.y*sc; let dx=X2-X1,dy=Y2-Y1; const L=Math.hypot(dx,dy)||1; dx/=L;dy/=L; const ext=Math.max(W,H);
      c.strokeStyle=col; c.lineWidth=lineW*1.2; c.setLineDash([]); c.beginPath(); c.moveTo(X1-dx*ext,Y1-dy*ext); c.lineTo(X2+dx*ext,Y2+dy*ext); c.stroke(); dot(X1,Y1,col); dot(X2,Y2,col); } };
    drawLine(cb.l0,CC.cobb); drawLine(cb.l1,CC.cobb);
    if(cb.angle!=null && cb.l0&&cb.l0.a&&cb.l0.b&&cb.l1&&cb.l1.a&&cb.l1.b){ const m0x=(cb.l0.a.x+cb.l0.b.x)/2,m0y=(cb.l0.a.y+cb.l0.b.y)/2,m1x=(cb.l1.a.x+cb.l1.b.x)/2,m1y=(cb.l1.a.y+cb.l1.b.y)/2;
      labels.push({x:fx((m0x+m1x)/2),y:((m0y+m1y)/2)*sc,text:"Cobb "+(+cb.angle).toFixed(1)+"°",color:CC.cobb,align:"center"}); } });
  // 측면(시상면) 정렬 작도
  if(meta.sagittal && meta.sagittal.pts){
    const sp=meta.sagittal.pts; const C_SAG="#7CFF6B", C_SAGV="#ffe600";
    const _mid=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
    const _li=(p1,p2,p3,p4)=>{ const dd=(p1.x-p2.x)*(p3.y-p4.y)-(p1.y-p2.y)*(p3.x-p4.x); if(Math.abs(dd)<1e-9) return null;
      const aa=p1.x*p2.y-p1.y*p2.x, bb=p3.x*p4.y-p3.y*p4.x; return {x:(aa*(p3.x-p4.x)-(p1.x-p2.x)*bb)/dd, y:(aa*(p3.y-p4.y)-(p1.y-p2.y)*bb)/dd}; };
    let C7=null;
    if(sp.C7_ua&&sp.C7_up&&sp.C7_la&&sp.C7_lp) C7=_li(sp.C7_ua,sp.C7_lp,sp.C7_up,sp.C7_la);
    else if(sp.C7_ua&&sp.C7_lp) C7=_mid(sp.C7_ua,sp.C7_lp);
    let FH=null; if(sp.AC_a&&sp.AC_p) FH=_mid(sp.AC_a,sp.AC_p); else if(sp.FH) FH=sp.FH;
    const sm=(meta.sagittal.metrics)||{};
    const drawV=(X,col)=>{ const sx0=fx(X); c.strokeStyle=col; c.lineWidth=lineW*1.2; c.setLineDash([7,5]); c.beginPath(); c.moveTo(sx0,0); c.lineTo(sx0,H); c.stroke(); c.setLineDash([]); };
    const drawSeg=(a,b,col)=>{ c.strokeStyle=col; c.lineWidth=lineW; c.setLineDash([]); c.beginPath(); c.moveTo(fx(a.x),a.y*sc); c.lineTo(fx(b.x),b.y*sc); c.stroke(); };
    const drawH=(fromX,fromY,toX,col)=>{ c.strokeStyle=col; c.lineWidth=lineW; c.setLineDash([4,3]); c.beginPath(); c.moveTo(fx(fromX),fromY*sc); c.lineTo(fx(toX),fromY*sc); c.stroke(); c.setLineDash([]); };
    // 종판선들
    if(sp.C7_ua&&sp.C7_up) drawSeg(sp.C7_ua,sp.C7_up,"#3fd0ff");
    if(sp.C7_la&&sp.C7_lp) drawSeg(sp.C7_la,sp.C7_lp,"#3fd0ff");
    if(sp.C2_la&&sp.C2_lp) drawSeg(sp.C2_la,sp.C2_lp,"#9d7cff");
    if(sp.T1_a&&sp.T1_p) drawSeg(sp.T1_a,sp.T1_p,"#ffd166");
    if(sp.L1_a&&sp.L1_p) drawSeg(sp.L1_a,sp.L1_p,"#ff9d3c");
    if(sp.S1_a&&sp.S1_p) drawSeg(sp.S1_a,sp.S1_p,"#ff5da2");
    // cSVA (C2 수직선 → C7 중심)
    if(sp.C2){ drawV(sp.C2.x,C_SAGV);
      if(C7){ drawH(sp.C2.x, C7.y, C7.x, C_SAGV);
        if(sm.csva_mm!=null) labels.push({x:fx((sp.C2.x+C7.x)/2),y:C7.y*sc-6,text:"cSVA "+(+sm.csva_mm).toFixed(1)+"mm",color:C_SAGV,align:"center",baseline:"bottom"}); } }
    // SVA (C7 중심 수직선 → S1 후상연)
    if(C7){ drawV(C7.x,C_SAG); dot(fx(C7.x),C7.y*sc,C_SAG);
      if(sp.S1_p){ drawH(C7.x, sp.S1_p.y, sp.S1_p.x, C_SAG);
        if(sm.sva_mm!=null) labels.push({x:fx((C7.x+sp.S1_p.x)/2),y:sp.S1_p.y*sc+6,text:"SVA "+(+sm.sva_mm).toFixed(1)+"mm",color:C_SAG,align:"center",baseline:"top"}); } }
    // 대퇴골두 중심 - 종판중점 (PT) + 비구 전후연
    if(FH&&sp.S1_a&&sp.S1_p){ const mid=_mid(sp.S1_a,sp.S1_p); drawSeg(FH,mid,"#62d0c0"); }
    if(sp.AC_a&&sp.AC_p){ drawSeg(sp.AC_a,sp.AC_p,"#62d0c0"); if(FH) dot(fx(FH.x),FH.y*sc,"#9be7da"); }
    // 모든 찍은 점 표시
    Object.keys(sp).forEach(k=>{ const q=sp[k]; if(q&&typeof q.x==="number") dot(fx(q.x),q.y*sc,C_SAG); });
  }
  // 라벨(글씨는 항상 정방향)
  labels.forEach(l=>{ otext(l.text,l.x,l.y,l.color,l.align,l.baseline); });
  // 환자 메모(좌상단)
  const pinfo=(meta.patient_info||"").trim(); if(pinfo){ const m=Math.max(8,W/90); otext(pinfo,m,m,"#ffffff","left","top"); }
}
async function readSavedMeta(e){
  try{ if(e.jsonHandle){ const jf=await e.jsonHandle.getFile(); return JSON.parse(await jf.text()); } }catch(_){ }
  return null;
}
async function loadPreview(st, idx){
  const e=st.files[idx]; selEntry=e; curIdx=idx;
  const my=++previewSeq;
  // 프리뷰 OFF(기본): 무거운 DICOM 디코딩을 건너뛰고 안내만 표시
  if(!window.__previewOn){
    $("prevWrap").style.display="none";
    var pe=$("prevEmpty"); if(pe){ pe.style.display="flex";
      pe.innerHTML=(window.getUiLang&&window.getUiLang()==="ko")
        ? "미리보기가 꺼져 있습니다.<br><span style='color:#7e94ad;font-size:12px'>상단 <b>👁 미리보기 켜기</b>로 볼 수 있어요. 켜면 로딩이 느려질 수 있습니다.</span>"
        : "Preview is off.<br><span style='color:#7e94ad;font-size:12px'>Turn it on with <b>👁 Preview on</b> at the top. It may slow down loading.</span>";
    }
    return;
  }
  $("prevEmpty").style.display="none"; $("prevWrap").style.display="block";
  const seriesLbl = st.count>1 ? (" · "+(idx+1)+"/"+st.count) : "";
  $("prevMeta").textContent=(st.pid||"—")+" "+(st.name_||"")+" "+(st.sex||"")+(st.age!=null?(" "+st.age+"y"):"")+" · "+dateTimeDisp(st.date,st.time)+seriesLbl;
  $("prevImg").style.display="none"; applyPrevFlip(false); setPrevNote("Loading…");
  $("prevCap").textContent=""; $("prevCap").className="";
  $("prevImg").ondblclick=()=>{ if(selStudy) openStudy(selStudy, curIdx); };
  updPrevNav();
  setPrevData(e);
  // 저장된 주석 meta(좌표·반전 포함) 읽기
  const meta = await readSavedMeta(e); if(my!==previewSeq) return;
  const savedFlip = !!(meta && meta.flip);
  try{
    const f=await e.getFile(); const ab=await f.arrayBuffer();
    if(my!==previewSeq) return;
    let parsed; try{ parsed=JSHADICOM.parse(ab); }catch(err){ setPrevNote("DICOM parse failed: "+err.message); return; }
    if(!JSHADICOM.isSupported(parsed.info.transferSyntax)){ setPrevNote("Unsupported transfer syntax: "+parsed.info.transferSyntax); $("prevCap").textContent="Original (cannot decode)"; $("prevCap").className="orig"; return; }
    setPrevNote("Decoding…");
    await new Promise(r=>setTimeout(r,10)); if(my!==previewSeq) return;
    const base=document.createElement("canvas");
    try{ JSHADICOM.renderToCanvas(parsed, base); }catch(err){ setPrevNote("Render failed: "+err.message); return; }
    if(my!==previewSeq) return;
    const nW=base.width, nH=base.height;
    // 합성 캔버스: ① 사진(픽셀)만 반전 후 ② 주석을 뷰어 좌표 규칙으로 위에 그림(글씨는 정방향)
    const out=document.createElement("canvas"); out.width=nW; out.height=nH; const oc=out.getContext("2d");
    if(savedFlip){ oc.save(); oc.translate(nW,0); oc.scale(-1,1); oc.drawImage(base,0,0); oc.restore(); }
    else oc.drawImage(base,0,0);
    if(meta){ try{ drawPreviewAnno(oc, meta, nW, 1, savedFlip); }catch(_){ } }
    const hasAnno = !!(meta && (meta.points&&meta.points.length || meta.rotation&&meta.rotation.length || meta.level_pairs&&meta.level_pairs.length || (meta.centerline_x!=null||meta.pubic_symphysis_x!=null) || (meta.cobbs&&meta.cobbs.length) || meta.pelvis || (meta.spans&&(meta.spans.obt.length||meta.spans.ltr.length))));
    $("prevCap").textContent = (hasAnno?"✓ Annotated":"Original")+(savedFlip?" · flipped":"")+(hasAnno?"":" (no annotation)");
    $("prevCap").className = hasAnno?"anno":"orig";
    if(lastPrevUrl){ URL.revokeObjectURL(lastPrevUrl); lastPrevUrl=null; }
    out.toBlob(blob=>{ if(my!==previewSeq||!blob) return; const url=URL.createObjectURL(blob); lastPrevUrl=url;
      const img=$("prevImg"); img.onload=()=>{ if(my===previewSeq){ img.style.display="block"; applyPrevFlip(false); setPrevNote(""); } };
      img.src=url; },"image/png");
  }catch(err){ if(my===previewSeq) setPrevNote("Preview failed: "+err.message); }
}

/* ---------- 주석 툴로 열기 (항상 비교 창) ---------- */
async function openStudy(st, idx){
  if(!st||!st.files.length) return;
  window.__LAST_STUDY__=st;
  // 네이티브 모드: 파일명→전체경로(id) 매핑 + 주석 저장을 네이티브 saveSidecar 로 라우팅
  if(window.__NATIVE_HOST__ && window.NativeBridge){
    window.__NATIVE_ID_BY_NAME__={};
    st.files.forEach(function(f){ if(f && f.name) window.__NATIVE_ID_BY_NAME__[f.name]=f.id; });
    window.JSHA_BRIDGE.saveAnno=function(name, meta){
      var id=(window.__NATIVE_ID_BY_NAME__ && window.__NATIVE_ID_BY_NAME__[name]) || name;
      return window.NativeBridge.call("saveSidecar",{ id:id, json:JSON.stringify(meta) });
    };
  }
  // 네이티브 호스트(WPF)에서는 비교 창(postMessage) 대신 인페이지 뷰어 사용 → 파일 바이트를 네이티브에서 직접 로드
  // 더블클릭 → 항상 비교 창(새 창)으로 전송, 빈 패널부터 채움
  if(!window.__NATIVE_HOST__ && window.JSHA_CMP && window.JSHA_CMP.openStudyInComparison){
    await window.JSHA_CMP.openStudyInComparison(st);
    return;
  }
  // 폴백: 인페이지 오버레이 (JSHA_CMP 미가용 시)
  idx=idx||0;
  const series=st.files.map(f=>({
    name:f.name,
    getBuffer: async()=>{ const file=await f.getFile(); return await file.arrayBuffer(); },
    getAnno: async()=>{ if(!f.jsonHandle) return null; try{ const jf=await f.jsonHandle.getFile(); return JSON.parse(await jf.text()); }catch(_){ return null; } }
  }));
  try{ await window.JSHA_BRIDGE.openAnnotatorSeries(series, idx, {pid:st.pid, name:st.name_, sex:st.sex, age:st.age, date:st.date}); }
  catch(err){ alert("Failed to open annotation tool: "+err.message); }
}
/* 단일 파일 열기(하위 호환) */
async function openEntry(e){
  const st=studies.find(s=>s.files.includes(e)); if(st){ const i=st.files.indexOf(e); return openStudy(st,i); }
}

/* ---------- 이벤트 ---------- */
/* ===== UI 다국어(한/영) ===== */
var UI_LANG="en";
var UI_I18N={
  "ui.noFolder":{en:"No folder selected.",ko:"선택된 폴더가 없습니다."},
  "ui.setting":{en:"⚙ Setting",ko:"⚙ 설정"},
  "ui.viewer":{en:"⊟ JS VIEWER",ko:"⊟ JS VIEWER"},
  "ui.idName":{en:"Patient ID · Name",ko:"환자번호 · 이름"},
  "ui.idNamePh":{en:"Patient ID or name",ko:"환자번호 또는 이름"},
  "ui.studyDate":{en:"Study date",ko:"검사일"},
  "ui.today":{en:"Today",ko:"오늘"},
  "ui.allDates":{en:"All dates",ko:"전체 기간"},
  "ui.groupSame":{en:"Group same study",ko:"같은 검사 묶기"},
  "ui.search":{en:"🔍 Search",ko:"🔍 검색"},
  "ui.reopenAsk":{en:"Reopen previous folder",ko:"이전 폴더 다시 열기"},
  "ui.reopen":{en:"📂 Reopen",ko:"📂 다시 열기"},
  "ui.thPid":{en:"Patient ID",ko:"환자번호"},
  "ui.thName":{en:"Name",ko:"이름"},
  "ui.thSex":{en:"Sex",ko:"성별"},
  "ui.thAge":{en:"Age",ko:"나이"},
  "ui.thStudy":{en:"Study",ko:"검사"},
  "ui.thDate":{en:"Date/Time",ko:"검사일시"},
  "ui.thDoc":{en:"Physician",ko:"판독의"},
  "ui.thSize":{en:"Size",ko:"크기"},
  "ui.emptyHint":{en:"Open <b>⚙ Setting</b> to choose a folder containing DICOM files.<br><b>Single-click</b> a study to see its history and preview; <b>double-click</b> to open it in JS VIEWER.",ko:"<b>⚙ 설정</b>에서 DICOM 파일이 들어있는 폴더를 선택하세요.<br><b>한 번 클릭</b>하면 검사 이력과 미리보기가, <b>두 번 클릭</b>하면 JS VIEWER가 열립니다."},
  "ui.analyze":{en:"📈 Analyze",ko:"📈 분석"},
  "ui.export":{en:"📄 Export",ko:"📄 내보내기"},
  "ui.studyHistory":{en:"Study history",ko:"검사 이력"},
  "set.title":{en:"Settings",ko:"설정"},
  "set.lang":{en:"Language",ko:"언어"},
  "set.langHint":{en:"Switch the whole interface language.",ko:"전체 사용 환경의 언어를 변경합니다."},
  "set.folder":{en:"DICOM folder",ko:"DICOM 폴더"},
  "set.folderHint":{en:"Choose a folder that contains DICOM files (subfolders included).",ko:"DICOM 파일이 들어있는 폴더를 선택하세요 (하위 폴더 포함)."},
  "set.pick":{en:"Select folder",ko:"폴더 선택"},
  "set.clinicPw":{en:"Report clinic password",ko:"레포트 의원 비밀번호"},
  "set.toolbarPos":{en:"JS VIEWER toolbar",ko:"JS VIEWER 툴바 위치"},
  "set.toolbarPosHint":{en:"Choose where the JS VIEWER toolbar appears.",ko:"JS VIEWER 툴바가 표시될 위치를 선택합니다."},
  "set.posLeft":{en:"Left",ko:"좌측"},
  "set.posTop":{en:"Top",ko:"상단"},
  "set.clinicPwHint":{en:"A master password to open locked reports (besides the patient's birth date).",ko:"잠긴 레포트를 여는 공용 비밀번호입니다 (환자 생년월일 외에 사용)."},
  "set.clinicPwNote":{en:"Saved on this device. Used when finalizing reports.",ko:"이 기기에 저장됩니다. 수정 완료 시 사용됩니다."},
  "set.apiKey":{en:"AI comment — Anthropic API key",ko:"AI 코멘트 — Anthropic API 키"},
  "set.apiKeyHint":{en:"On export, drafts a patient comment from the chart and measurements. The key is stored only on this device and never included in files.",ko:"내보내기 시 차트와 측정 결과로 환자용 코멘트 초안을 자동 작성합니다. 키는 이 기기에만 저장되며 파일에는 포함되지 않습니다."},
  "set.apiKeyNote":{en:"Enter a key issued at console.anthropic.com (paid API — usage is billed per request, typically a fraction of a cent per comment). Anthropic does not train on API inputs. Leave blank to export without AI comments.",ko:"console.anthropic.com 에서 발급한 키를 입력하세요. 유료 API이며 코멘트 1건당 보통 1원 미만이 과금됩니다. Anthropic은 API로 보낸 내용을 모델 학습에 사용하지 않습니다. 비워두면 AI 코멘트 없이 내보냅니다."},
  "set.guide":{en:"AI comment style guide",ko:"AI 코멘트 지침 (말투·형식)"},
  "set.guideHint":{en:"Tell the AI how you want comments written. Adding a sample comment improves accuracy. Leave blank for the default style.",ko:"코멘트를 원하는 스타일로 쓰도록 지침을 입력하세요. 예시 코멘트를 함께 적으면 더 정확합니다. 비워두면 기본 스타일로 작성됩니다."},
  "set.guideNote":{en:"Saved on this device. Edit freely until you're happy with the results.",ko:"이 기기에 저장됩니다. 마음에 들 때까지 자유롭게 수정하세요."},
  "set.backup":{en:"Export / import settings",ko:"설정 내보내기 / 가져오기"},
  "set.backupHint":{en:"Save settings (API key, comment guide, clinic password, etc.) to a file and load them on another PC.",ko:"API 키·코멘트 지침·의원 비밀번호 등 설정을 파일로 저장해 다른 PC에서 불러올 수 있습니다."},
  "set.backupExport":{en:"⬇ Save settings to file",ko:"⬇ 설정 파일로 저장"},
  "set.backupImport":{en:"⬆ Load settings from file",ko:"⬆ 설정 파일 불러오기"},
  "set.backupNote":{en:"The settings file contains your API key. Keep it secure.",ko:"설정 파일에는 API 키가 포함됩니다. 안전하게 보관하세요."},
  "ui.histEmpty":{en:"Click a study once to see the full history for that patient.",ko:"검사를 한 번 클릭하면 해당 환자의 전체 이력이 표시됩니다."},
  "ui.preview":{en:"Preview",ko:"미리보기"},
  "ui.prevEmpty":{en:"Click a study once to preview the image.",ko:"검사를 한 번 클릭하면 이미지가 미리보기로 표시됩니다."},
  "ui.prevHint":{en:"For multi-image studies use <b>← →</b> keys, drag, or wheel to flip. Double-click to open in JS VIEWER.",ko:"여러 장인 검사는 <b>← →</b> 키, 드래그, 휠로 넘기세요. 두 번 클릭하면 JS VIEWER가 열립니다."},
  "ui.foot":{en:"Single-click = patient history &amp; preview · Double-click = open in JS VIEWER · Annotations saved as <b>original.dcm.jsha.json</b> (original DICOM unchanged) · Folder write recommended on Chrome/Edge",ko:"한 번 클릭 = 환자 이력·미리보기 · 두 번 클릭 = JS VIEWER 열기 · 주석은 <b>original.dcm.jsha.json</b>으로 저장(원본 DICOM 불변) · Chrome/Edge에서 폴더 쓰기 권장"},
  "cmp.title":{en:"JS VIEWER",ko:"JS VIEWER"},
  "cmp.clickActivate":{en:"Click an image to activate.",ko:"이미지를 클릭하면 활성화됩니다."},
  "cmp.save":{en:"💾 Save",ko:"💾 저장"},
  "cmp.analyze":{en:"📈 Analyze",ko:"📈 분석"},
  "cmp.notePh":{en:"Patient note (shown on active image)",ko:"환자 메모 (활성 이미지에 표시)"},
  "cmp.midline":{en:"Midline",ko:"정중선"},
  "cmp.pelvis":{en:"Pelvic cavity",ko:"골반강"},
  "cmp.obt":{en:"Obturator",ko:"폐쇄공"},
  "cmp.vertRot":{en:"Vertebra rotation…",ko:"척추 회전…"},
  "cmp.levelH":{en:"Level height…",ko:"좌우 높이…"},
  "cmp.undo":{en:"↶ Undo",ko:"↶ 실행취소"},
  "cmp.redo":{en:"↷ Redo",ko:"↷ 다시실행"},
  "cmp.clear":{en:"Clear",ko:"지우기"},
  "cmp.zoomIn":{en:"＋ Zoom in",ko:"＋ 확대"},
  "cmp.zoomOut":{en:"－ Zoom out",ko:"－ 축소"},
  "cmp.fit":{en:"Fit",ko:"맞춤"},
  "cmp.flip":{en:"⇄ Flip",ko:"⇄ 좌우반전"},
  "cmp.manual":{en:"📖 Manual",ko:"📖 매뉴얼"},
  "cmp.autohide":{en:"⇤ Hide toolbar",ko:"⇤ 툴바 숨기기"},
  "cmp.posToggle":{en:"⇄ Toolbar position",ko:"⇄ 툴바 위치"},
  "cmp.showToolbar":{en:"▾ Show toolbar (₩)",ko:"▾ 툴바 표시 (₩)"},
  "cmp.leftBefore":{en:"Left",ko:"왼쪽"},
  "cmp.rightAfter":{en:"Right",ko:"오른쪽"},
  "cmp.leftEmpty":{en:"Left — double-click a study in the worklist",ko:"왼쪽 — 목록에서 검사를 두 번 클릭하세요"},
  "cmp.rightEmpty":{en:"Right — double-click a study in the worklist",ko:"오른쪽 — 목록에서 검사를 두 번 클릭하세요"},
  "cmp.manualBody":{en:"<p><b>Basic flow</b><br>Double-click a study in the worklist to fill the empty panels. Click an image to activate it (blue border); the left toolbar and shortcuts then apply only to that image.</p><p><b>Measurement tools</b><br>· <b>Midline (cc)</b>: vertical reference through pubic symphysis<br>· <b>Pelvic cavity (p)</b> / <b>Obturator (o)</b> / <b>LT-IR (le)</b>: left–right symmetry<br>· <b>Cobb 1 (cb)</b>: 4-point endplate measurement<br>· <b>Cobb 2 (xb)</b>: click two measured vertebrae<br>· <b>Vertebra rotation</b>: pick a level from the dropdown, then click LB·RB·SP<br>· <b>Level height</b>: clavicle / iliac crest / femoral head left–right heights</p><p><b>View / shortcuts</b><br>Zoom in <b>=</b> · Zoom out <b>-</b> · Fit <b>0</b> · Flip <b>r</b> · Undo <b>⌘Z</b> · Hide/Show toolbar <b>₩</b></p><p><b>Save / close</b><br>Save (⌘S) writes the annotation as a sidecar next to the original DICOM. Press <b>ESC twice</b> inside a panel to close just that image.</p><p><b>Analyze</b><br>Click <b>📈 Analyze</b> to see all of this patient's studies over time as trend charts. Improved values are highlighted in green.</p>",ko:"<p><b>기본 흐름</b><br>목록에서 검사를 두 번 클릭하면 빈 패널이 채워집니다. 이미지를 클릭하면 활성화되며(파란 테두리), 왼쪽 도구와 단축키는 그 이미지에만 적용됩니다.</p><p><b>계측 도구</b><br>· <b>정중선 (cc)</b>: 치골결합을 지나는 수직 기준선<br>· <b>골반강 (p)</b> / <b>폐쇄공 (o)</b> / <b>LT-IR (le)</b>: 좌우 대칭<br>· <b>Cobb 1 (cb)</b>: 4점 종판 계측<br>· <b>Cobb 2 (xb)</b>: 계측된 두 척추를 클릭<br>· <b>척추 회전</b>: 드롭다운에서 레벨 선택 후 LB·RB·SP 클릭<br>· <b>좌우 높이</b>: 쇄골 / 장골능 / 대퇴골두 좌우 높이</p><p><b>보기 / 단축키</b><br>확대 <b>=</b> · 축소 <b>-</b> · 맞춤 <b>0</b> · 좌우반전 <b>r</b> · 실행취소 <b>⌘Z</b> · 툴바 숨기기/표시 <b>₩</b></p><p><b>저장 / 닫기</b><br>저장(⌘S)은 원본 DICOM 옆에 사이드카로 주석을 기록합니다. 패널 안에서 <b>ESC를 두 번</b> 누르면 해당 이미지만 닫힙니다.</p><p><b>분석</b><br><b>📈 분석</b>을 누르면 이 환자의 모든 검사 추이를 그래프로 볼 수 있습니다. 호전된 값은 초록색으로 표시됩니다.</p>"}
};
function applyUiLang(){
  document.querySelectorAll("[data-i18n]").forEach(function(el){
    var k=el.getAttribute("data-i18n"); var t=UI_I18N[k]; if(!t) return;
    el.innerHTML = t[UI_LANG]!=null?t[UI_LANG]:t.en;
  });
  document.querySelectorAll("[data-i18n-ph]").forEach(function(el){
    var k=el.getAttribute("data-i18n-ph"); var t=UI_I18N[k]; if(!t) return;
    el.setAttribute("placeholder", t[UI_LANG]!=null?t[UI_LANG]:t.en);
  });
}
function setUiLang(l){ UI_LANG=(l==="ko")?"ko":"en"; try{ localStorage.setItem("jsha_ui_lang",UI_LANG); }catch(e){} applyUiLang(); try{ if(window.__syncPrevToggle) window.__syncPrevToggle(); }catch(_){ } }
(function initUiLang(){ var s="en"; try{ s=localStorage.getItem("jsha_ui_lang")||"en"; }catch(e){} UI_LANG=(s==="ko")?"ko":"en"; })();
try{ window.UI_I18N=UI_I18N; window.getUiLang=function(){ return UI_LANG; }; }catch(_){ }

$("refreshBtn").onclick=refresh;
if($("compareBtn")) $("compareBtn").onclick=()=>{ if(window.JSHA_CMP) window.JSHA_CMP.openComparison(); };

/* ========== 이미지 → DICOM 변환 도구 ========== */
(function(){
  const modal=$("img2dcmModal"); if(!modal) return;
  let picked=[];   // {file, name}

  function openModal(){
    // 검사일시 기본값 = 현재
    const now=new Date(); const pad=n=>("0"+n).slice(-2);
    $("i2dDate").value=now.getFullYear()+"-"+pad(now.getMonth()+1)+"-"+pad(now.getDate())+"T"+pad(now.getHours())+":"+pad(now.getMinutes());
    $("i2dStatus").textContent=""; modal.classList.add("show");
  }
  function closeModal(){ modal.classList.remove("show"); }
  if($("img2dcmBtn")) $("img2dcmBtn").onclick=()=>{
    if(!dirHandle){ alert("먼저 DICOM 폴더를 선택하세요. (⚙ 설정 → 폴더 선택)"); return; }
    openModal();
  };
  if($("img2dcmClose")) $("img2dcmClose").onclick=closeModal;
  modal.addEventListener("click",e=>{ if(e.target===modal) closeModal(); });

  // 이미지 선택(숨은 input)
  const fileInput=document.createElement("input");
  fileInput.type="file"; fileInput.accept="image/*"; fileInput.multiple=true; fileInput.style.display="none";
  document.body.appendChild(fileInput);
  $("i2dPick").onclick=()=>fileInput.click();
  fileInput.onchange=()=>{ picked=Array.from(fileInput.files||[]).map(f=>({file:f,name:f.name}));
    $("i2dFiles").textContent = picked.length? (picked.length+"개: "+picked.map(p=>p.name).join(", ")) : "선택된 파일 없음"; };

  // 이미지 파일 → grayscale 픽셀(Uint8) + 크기
  function imageToGray(file){ return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file); const im=new Image();
    im.onload=()=>{ try{
      let W=im.naturalWidth, H=im.naturalHeight;
      // 너무 크면 적당히 축소(메모리·속도). 긴 변 2400px 상한.
      const MAX=2400; const scale=Math.min(1, MAX/Math.max(W,H)); W=Math.round(W*scale); H=Math.round(H*scale);
      const cv=document.createElement("canvas"); cv.width=W; cv.height=H;
      const cx=cv.getContext("2d"); cx.drawImage(im,0,0,W,H);
      const rgba=cx.getImageData(0,0,W,H).data;
      const gray=new Uint8Array(W*H);
      for(let i=0,j=0;i<rgba.length;i+=4,j++){ // 휘도 변환(BT.601)
        gray[j]=(rgba[i]*0.299 + rgba[i+1]*0.587 + rgba[i+2]*0.114)|0; }
      URL.revokeObjectURL(url); resolve({gray,W,H});
    }catch(err){ reject(err); } };
    im.onerror=()=>{ URL.revokeObjectURL(url); reject(new Error("이미지를 읽을 수 없습니다: "+file.name)); };
    im.src=url;
  }); }

  // ── 최소 DICOM(Explicit VR Little Endian, 8bit MONOCHROME2) 인코더 ──
  function buildDicom(gray,W,H,meta){
    const parts=[]; // Uint8Array 조각들
    const enc=new TextEncoder();
    function pad2(s){ s=String(s||""); return s.length%2? s+" ": s; }     // 짝수 길이(공백 패딩)
    function padNull(s){ s=String(s||""); return s.length%2? s+"\\0": s; } // UI 등 짝수(널 패딩)
    // VR별 element 직렬화 (Explicit VR LE)
    function elem(group,element,vr,valueBytes){
      const head=new Uint8Array( (vr==="OB"||vr==="OW"||vr==="OF"||vr==="SQ"||vr==="UT"||vr==="UN")?12:8 );
      const dv=new DataView(head.buffer);
      dv.setUint16(0,group,true); dv.setUint16(2,element,true);
      head[4]=vr.charCodeAt(0); head[5]=vr.charCodeAt(1);
      if(head.length===12){ dv.setUint16(6,0,true); dv.setUint32(8,valueBytes.length,true); }
      else { dv.setUint16(6,valueBytes.length,true); }
      parts.push(head); parts.push(valueBytes);
    }
    function str(group,element,vr,s){ elem(group,element,vr,enc.encode(pad2(s))); }
    function us(group,element,v){ const b=new Uint8Array(2); new DataView(b.buffer).setUint16(0,v,true); elem(group,element,"US",b); }
    function uid(){ return "1.2.826.0.1.3680043.2.1143."+Date.now()+"."+Math.floor(Math.random()*1e6); }

    const sopUID=uid(), studyUID=meta.studyUID||uid(), seriesUID=meta.seriesUID||uid();

    // ----- File Meta (group 0002) : Explicit VR LE 고정 -----
    const metaParts=[];
    (function(){
      const save=parts.length;
      // 임시로 parts에 쌓되, 길이 계산을 위해 별도 처리
    })();
    // group 0002 요소들을 따로 만들어 길이 계산
    function metaElem(group,element,vr,valueBytes){
      const head=new Uint8Array( (vr==="OB")?12:8 ); const dv=new DataView(head.buffer);
      dv.setUint16(0,group,true); dv.setUint16(2,element,true);
      head[4]=vr.charCodeAt(0); head[5]=vr.charCodeAt(1);
      if(head.length===12){ dv.setUint16(6,0,true); dv.setUint32(8,valueBytes.length,true); }
      else dv.setUint16(6,valueBytes.length,true);
      metaParts.push(head); metaParts.push(valueBytes);
    }
    function mstr(g,e,vr,s){ metaElem(g,e,vr,enc.encode(pad2(s))); }
    const TS="1.2.840.10008.1.2.1"; // Explicit VR Little Endian
    const SOPCLASS="1.2.840.10008.5.1.4.1.1.7"; // Secondary Capture Image Storage
    // (0002,0001) FileMetaInfoVersion
    metaElem(0x0002,0x0001,"OB",new Uint8Array([0,1]));
    mstr(0x0002,0x0002,"UI",SOPCLASS);
    mstr(0x0002,0x0003,"UI",sopUID);
    mstr(0x0002,0x0010,"UI",TS);
    mstr(0x0002,0x0012,"UI","1.2.826.0.1.3680043.2.1143.1"); // ImplementationClassUID
    mstr(0x0002,0x0013,"SH","JSHA_PACS");
    // group length 계산
    let metaLen=0; metaParts.forEach(p=>metaLen+=p.length);
    const glen=new Uint8Array(12); const gdv=new DataView(glen.buffer);
    gdv.setUint16(0,0x0002,true); gdv.setUint16(2,0x0000,true); glen[4]=85;glen[5]=76; /*UL*/ gdv.setUint16(6,4,true); gdv.setUint32(8,metaLen,true);

    // ----- Dataset (Explicit VR LE) -----
    str(0x0008,0x0005,"CS","ISO_IR 192");
    str(0x0008,0x0016,"UI",SOPCLASS);
    str(0x0008,0x0018,"UI",sopUID);
    str(0x0008,0x0020,"DA",meta.date||"");      // StudyDate YYYYMMDD
    str(0x0008,0x0030,"TM",meta.time||"");      // StudyTime HHMMSS
    str(0x0008,0x0060,"CS","OT");               // Modality = Other
    str(0x0008,0x0090,"PN",meta.doc||"");       // ReferringPhysicianName
    str(0x0008,0x103E,"LO",meta.exam||"");      // SeriesDescription
    str(0x0008,0x1030,"LO",meta.exam||"");      // StudyDescription
    str(0x0010,0x0010,"PN",meta.name||"");      // PatientName
    str(0x0010,0x0020,"LO",meta.pid||"");       // PatientID
    str(0x0010,0x0030,"DA",meta.birth||"");     // PatientBirthDate
    str(0x0010,0x0040,"CS",meta.sex||"");       // PatientSex
    str(0x0020,0x000D,"UI",studyUID);
    str(0x0020,0x000E,"UI",seriesUID);
    str(0x0020,0x0010,"SH","1");                // StudyID
    str(0x0020,0x0011,"IS",String(meta.seriesNum||"1"));
    str(0x0020,0x0013,"IS",String(meta.instNum||"1"));
    // 이미지 픽셀 모듈
    us(0x0028,0x0002,1);                         // SamplesPerPixel
    str(0x0028,0x0004,"CS","MONOCHROME2");       // PhotometricInterpretation
    us(0x0028,0x0010,H);                          // Rows
    us(0x0028,0x0011,W);                          // Columns
    us(0x0028,0x0100,8);                          // BitsAllocated
    us(0x0028,0x0101,8);                          // BitsStored
    us(0x0028,0x0102,7);                          // HighBit
    us(0x0028,0x0103,0);                          // PixelRepresentation
    // PixelData (8bit, 짝수 길이 보장)
    let px=gray; if(px.length%2!==0){ const p2=new Uint8Array(px.length+1); p2.set(px); px=p2; }
    elem(0x7FE0,0x0010,"OB",px);

    // ----- 조립: preamble(128) + 'DICM' + meta(grouplen+meta) + dataset -----
    const preamble=new Uint8Array(128);
    const dicm=enc.encode("DICM");
    let total=preamble.length+dicm.length+glen.length+metaLen;
    metaParts.forEach(()=>{}); parts.forEach(p=>total+=p.length);
    const out=new Uint8Array(total); let o=0;
    out.set(preamble,o); o+=preamble.length;
    out.set(dicm,o); o+=dicm.length;
    out.set(glen,o); o+=glen.length;
    metaParts.forEach(p=>{ out.set(p,o); o+=p.length; });
    parts.forEach(p=>{ out.set(p,o); o+=p.length; });
    return out;
  }

  async function convert(){
    if(!dirHandle){ alert("DICOM 폴더가 없습니다."); return; }
    if(!picked.length){ $("i2dStatus").textContent="이미지를 먼저 선택하세요."; return; }
    const pid=$("i2dPid").value.trim(), name=$("i2dName").value.trim();
    if(!pid && !name){ $("i2dStatus").textContent="환자번호 또는 이름을 입력하세요."; return; }
    const dtv=$("i2dDate").value; // YYYY-MM-DDTHH:MM
    let date="",time="";
    if(dtv){ const m=dtv.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); if(m){ date=m[1]+m[2]+m[3]; time=m[4]+m[5]+"00"; } }
    const meta={ pid, name, sex:$("i2dSex").value, birth:$("i2dBirth").value.trim(),
      exam:$("i2dExam").value.trim()||"IMG", date, time, doc:$("i2dDoc").value.trim(),
      studyUID:null, seriesUID:null };
    // 같은 변환 묶음은 같은 study/series UID 공유
    const baseUID="1.2.826.0.1.3680043.2.1143."+Date.now();
    meta.studyUID=baseUID+".1"; meta.seriesUID=baseUID+".2";

    try{
      if(!(await ensureRW(dirHandle))){ $("i2dStatus").textContent="폴더 쓰기 권한이 없습니다."; return; }
      let ok=0;
      for(let i=0;i<picked.length;i++){
        $("i2dStatus").textContent="변환 중… ("+(i+1)+"/"+picked.length+")";
        const {gray,W,H}=await imageToGray(picked[i].file);
        meta.instNum=i+1; meta.seriesNum=1;
        const bytes=buildDicom(gray,W,H,meta);
        // 파일명: 환자번호_검사일_순번_타임스탬프.dcm — 매 변환마다 고유(덮어쓰기 방지)
        const safe=(s)=>String(s||"").replace(/[^0-9A-Za-z가-힣_-]/g,"");
        const stamp=baseUID.slice(-8);
        let fname=safe(pid||name)+"_"+(date||"img")+"_"+(i+1)+"_"+stamp+".dcm";
        const fh=await dirHandle.getFileHandle(fname,{create:true});
        const w=await fh.createWritable(); await w.write(new Blob([bytes],{type:"application/dicom"})); await w.close();
        ok++;
      }
      $("i2dStatus").textContent=ok+"개 DICOM 저장 완료. 목록을 새로고침했습니다. 이어서 더 변환할 수 있어요.";
      picked=[]; $("i2dFiles").textContent="선택된 파일 없음"; fileInput.value="";
      try{ await refresh(); }catch(_){ }
    }catch(err){ $("i2dStatus").textContent="오류: "+(err&&err.message||err); }
    finally{ converting=false; $("i2dConvert").disabled=false; $("i2dConvert").textContent="DICOM으로 변환·저장"; }
  }
  let converting=false;
  $("i2dConvert").onclick=()=>{ if(converting) return; converting=true; $("i2dConvert").disabled=true; $("i2dConvert").textContent="변환 중…"; convert(); };
})();

/* ===== 설정(Setting) 모달: 언어 전환 + 폴더 선택 ===== */
(function initSetting(){
  const modal=$("settingModal"); if(!modal) return;
  // 의원 비밀번호: 저장된 값 불러오기(기본 qksemtgks)
  function getClinicPw(){ try{ var v=localStorage.getItem("jsha_clinic_pw"); return (v&&v.trim())?v:"qksemtgks"; }catch(e){ return "qksemtgks"; } }
  try{ window.getClinicPw=getClinicPw; }catch(_){ }
  const pwInput=$("setClinicPw");
  if(pwInput){ pwInput.value=getClinicPw(); pwInput.addEventListener("input",()=>{ try{ var v=pwInput.value.trim(); if(v) localStorage.setItem("jsha_clinic_pw",v); else localStorage.removeItem("jsha_clinic_pw"); }catch(e){} }); }
  // Anthropic API 키
  const keyInput=$("setApiKey");
  function getKey(){ try{ var v=localStorage.getItem("jsha_anthropic_key"); return (v&&v.trim())?v.trim():""; }catch(e){ return ""; } }
  if(keyInput){ keyInput.value=getKey(); keyInput.addEventListener("input",()=>{ try{ var v=keyInput.value.trim(); if(v) localStorage.setItem("jsha_anthropic_key",v); else localStorage.removeItem("jsha_anthropic_key"); }catch(e){} }); }
  // AI 코멘트 지침
  const guideInput=$("setGuide");
  function getGuide(){ try{ var v=localStorage.getItem("jsha_comment_guide"); return v||""; }catch(e){ return ""; } }
  if(guideInput){ guideInput.value=getGuide(); guideInput.addEventListener("input",()=>{ try{ var v=guideInput.value; if(v&&v.trim()) localStorage.setItem("jsha_comment_guide",v); else localStorage.removeItem("jsha_comment_guide"); }catch(e){} }); }
  // analyze 전문가 지침
  const proInput=$("setProGuide");
  function getPro(){ try{ var v=localStorage.getItem("jsha_pro_guide"); return v||""; }catch(e){ return ""; } }
  if(proInput){ proInput.value=getPro(); proInput.addEventListener("input",()=>{ try{ var v=proInput.value; if(v&&v.trim()) localStorage.setItem("jsha_pro_guide",v); else localStorage.removeItem("jsha_pro_guide"); }catch(e){} }); }
  // 기능 on/off 토글
  function bindFeatSeg(segId, lsKey, label){ const seg=$(segId); if(!seg) return;
    function sync(){ const on=(localStorage.getItem(lsKey)!=="off"); seg.querySelectorAll("button").forEach(b=>b.classList.toggle("on",(b.getAttribute("data-feat")==="on")===on)); }
    seg.querySelectorAll("button").forEach(b=>{ b.onclick=()=>{ const on=(b.getAttribute("data-feat")==="on");
      const cur=(localStorage.getItem(lsKey)!=="off"); if(on===cur) return;
      if(!requireFeaturePerm()){ sync(); return; }
      try{ if(on) localStorage.removeItem(lsKey); else localStorage.setItem(lsKey,"off"); }catch(e){}
      try{ if(window.JS_LOG) window.JS_LOG('setting',{key:lsKey,label:label,value:on?'사용':'차단'}); }catch(_){ }
      sync(); try{ applyFeatureFlags(); }catch(_){ } }; });
    sync();
  }
  bindFeatSeg("featReportSeg","jsha_feat_report","레포트");
  bindFeatSeg("featAnalyzeAISeg","jsha_feat_analyzeai","분석 AI 코멘트");
  // AI 환자정보 전송 토글(전송=기본 / 전송 안 함). block일 때만 localStorage에 'on' 저장.
  function bindPhiSeg(){ const seg=$("featAiPhiSeg"); if(!seg) return;
    function sync(){ const block=isAiNoPHI(); seg.querySelectorAll("button").forEach(b=>b.classList.toggle("on",(b.getAttribute("data-phi")==="block")===block)); }
    seg.querySelectorAll("button").forEach(b=>{ b.onclick=()=>{ const block=(b.getAttribute("data-phi")==="block"); const cur=isAiNoPHI(); if(block===cur) return;
      if(!requireFeaturePerm()){ sync(); return; }
      try{ if(block) localStorage.setItem("jsha_ai_no_phi","on"); else localStorage.removeItem("jsha_ai_no_phi"); }catch(e){}
      try{ if(window.JS_LOG) window.JS_LOG('setting',{key:'jsha_ai_no_phi',label:'AI 환자정보 전송',value:block?'전송 안 함':'전송(이름 가림)'}); }catch(_){ }
      sync(); }; });
    sync();
  }
  bindPhiSeg();
  // ===== 권한(동선 관리자 역할)에 따른 UI 표시 + 로그 조회 =====
  function fmtLogTime(ts){ try{ var d=new Date(ts); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }catch(e){ return ''; } }
  function escLog(s){ return (s==null?'':String(s)).replace(/[&<>"]/g,function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
  function renderLogs(docs){
    var list=$("logList"); if(!list) return;
    if(!docs.length){ list.style.display="block"; list.innerHTML="<div style='padding:14px;color:#7e94ad;font-size:12px'>기록이 없습니다.</div>"; return; }
    var rows=docs.map(function(d){
      var t=d.type==='login'?'🔑 로그인':(d.type==='setting'?'⚙️ 설정변경':escLog(d.type));
      var extra='';
      if(d.type==='setting'&&d.detail){ extra=' — '+escLog(d.detail.label||d.detail.key||'')+' → <b>'+escLog(d.detail.value||'')+'</b>'; }
      else if(d.type==='login'&&d.detail&&(d.detail.admin||d.detail.super)){ extra=" <span style='color:#7e94ad'>("+(d.detail.super?'최고관리자':'관리자')+")</span>"; }
      return "<div style='display:flex;gap:10px;padding:8px 11px;border-bottom:1px solid #18202e;font-size:12px;line-height:1.5'>"+
        "<span style='color:#7e94ad;white-space:nowrap'>"+fmtLogTime(d.ts)+"</span>"+
        "<span style='flex:1'><b>"+escLog(d.name||'?')+"</b> · "+t+extra+"</span></div>";
    }).join('');
    list.style.display="block"; list.innerHTML=rows;
  }
  function loadLogs(){
    var st=$("logStatus");
    if(!window.JS_LOGS){ if(st) st.textContent="로그인 후 사용할 수 있습니다."; return; }
    if(st) st.textContent="불러오는 중…";
    window.JS_LOGS(150).then(function(snap){
      var docs=snap.docs.map(function(x){ return x.data(); });
      renderLogs(docs); if(st) st.textContent="최근 "+docs.length+"건";
    }).catch(function(e){
      if(st) st.textContent="기록을 불러올 수 없습니다(관리자 계정·클라우드 규칙 확인).";
    });
  }
  var logBtn=$("logRefreshBtn"); if(logBtn) logBtn.onclick=loadLogs;

  // ===== 기능 설정 변경 권한(아이디별) 편집기 — 관리자 전용 =====
  var _featAllow=[];   // 관리자 외 추가 허용 이메일 목록
  function renderFeatPerm(){
    var list=$("featPermList"); if(!list) return;
    var members=(window.JS_MEMBERS||[]).slice();
    if(!members.length){ list.innerHTML="<div style='padding:14px;color:#7e94ad;font-size:12px'>직원 명단을 불러오지 못했습니다. 새로고침해 주세요.</div>"; return; }
    list.innerHTML=members.map(function(m){
      var isAdm=m.super||m.role==='admin';
      var checked=isAdm||_featAllow.indexOf(m.email)>=0;
      var tag=isAdm?" <span style='color:#7ee0a6;font-size:11px'>("+(m.super?'최고관리자':'관리자')+" · 항상 가능)</span>":"";
      return "<label style='display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid #18202e;font-size:13px;cursor:"+(isAdm?'default':'pointer')+"'>"+
        "<input type='checkbox' class='fpchk' data-email='"+escLog(m.email)+"'"+(checked?" checked":"")+(isAdm?" disabled":"")+">"+
        "<span><b>"+escLog(m.name||m.email)+"</b>"+tag+"</span></label>";
    }).join('');
    list.querySelectorAll('.fpchk').forEach(function(cb){
      if(cb.disabled) return;
      cb.onchange=function(){
        var em=cb.getAttribute('data-email'), idx=_featAllow.indexOf(em);
        if(cb.checked){ if(idx<0) _featAllow.push(em); } else if(idx>=0){ _featAllow.splice(idx,1); }
        var st=$("featPermStatus"); if(st) st.textContent="저장 중…";
        window.JS_FEATPERMS_SET(_featAllow).then(function(){
          if(st) st.textContent="저장됨 ("+_featAllow.length+"명 추가 허용)";
          try{ if(window.JS_LOG) window.JS_LOG('featperm',{email:em, allow:cb.checked}); }catch(_){ }
        }).catch(function(){
          // 롤백
          cb.checked=!cb.checked; var i2=_featAllow.indexOf(em);
          if(cb.checked){ if(i2<0)_featAllow.push(em); } else if(i2>=0){ _featAllow.splice(i2,1); }
          if(st) st.textContent="저장 실패(관리자 권한·규칙 확인)";
        });
      };
    });
  }
  function loadFeatPerm(){
    var st=$("featPermStatus");
    if(!window.JS_FEATPERMS_GET){ if(st) st.textContent="로그인 후 사용할 수 있습니다."; return; }
    if(st) st.textContent="불러오는 중…";
    window.JS_FEATPERMS_GET().then(function(arr){ _featAllow=arr||[]; renderFeatPerm(); if(st) st.textContent="현재 "+_featAllow.length+"명 추가 허용"; })
      .catch(function(){ renderFeatPerm(); if(st) st.textContent="명단을 불러올 수 없습니다(관리자·규칙 확인)."; });
  }
  var fpBtn=$("featPermRefreshBtn"); if(fpBtn) fpBtn.onclick=loadFeatPerm;

  function applyAuthUI(){
    var a=window.JS_AUTH, note=$("featAdminNote");
    var canChange=!!(a&&(a.isAdmin||a.featAllowed));
    if(note){
      if(a){ var roleTxt=a.isAdmin?(a.isSuper?'최고관리자':'관리자'):'일반 직원';
        note.innerHTML="현재 로그인: <b>"+escLog(a.user)+"</b> · "+roleTxt+" · "+(canChange?"<span style='color:#7ee0a6'>기능 설정 변경 가능</span>":"<span style='color:#ffb454'>변경 불가(관리자 허용 필요)</span>"); }
      else note.textContent="";
    }
    var fg=$("featPermGroup"); if(fg) fg.style.display=(a&&a.isAdmin)?"":"none";
    var lg=$("logGroup"); if(lg) lg.style.display=(a&&a.isAdmin)?"":"none";
    if(a&&a.isAdmin){ try{ loadFeatPerm(); }catch(_){ } }
  }
  window.__onJsAuth=applyAuthUI;
  applyAuthUI();
  const open=()=>{ syncLangSeg(); const fi=$("setFolderInfo"); if(fi) fi.textContent=$("folderInfo")?$("folderInfo").textContent:""; if(pwInput) pwInput.value=getClinicPw(); if(keyInput) keyInput.value=getKey(); if(guideInput) guideInput.value=getGuide(); if(proInput) proInput.value=getPro(); bindFeatSeg("featReportSeg","jsha_feat_report","레포트"); bindFeatSeg("featAnalyzeAISeg","jsha_feat_analyzeai","분석 AI 코멘트"); bindPhiSeg(); applyAuthUI(); modal.classList.add("show"); };
  // ===== 설정 내보내기 / 가져오기 =====
  var BACKUP_KEYS=["jsha_comment_guide","jsha_pro_guide","jsha_feat_report","jsha_feat_analyzeai","jsha_ai_no_phi","jsha_clinic_pw","jsha_ui_lang","jsha_cmp_toolbarpos"];
  var exportBtnEl=$("setExportBtn"), importBtnEl=$("setImportBtn"), importFile=$("setImportFile"), backupInfo=$("setBackupInfo");
  if(exportBtnEl){ exportBtnEl.onclick=function(){
    try{
      var data={ _type:"jsha_settings", _version:1, _exportedAt:new Date().toISOString(), settings:{} };
      BACKUP_KEYS.forEach(function(k){ try{ var v=localStorage.getItem(k); if(v!=null) data.settings[k]=v; }catch(e){} });
      var blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
      var url=URL.createObjectURL(blob);
      var a=document.createElement("a"); a.href=url; a.download="jsha_settings.json"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); },3000);
      if(backupInfo) backupInfo.textContent="설정을 jsha_settings.json 으로 저장했습니다. 다른 PC에서 '불러오기'로 적용하세요.";
    }catch(e){ if(backupInfo) backupInfo.textContent="내보내기 실패: "+(e&&e.message||e); }
  }; }
  if(importBtnEl && importFile){
    importBtnEl.onclick=function(){ importFile.value=""; importFile.click(); };
    importFile.onchange=function(){
      var f=importFile.files&&importFile.files[0]; if(!f) return;
      var reader=new FileReader();
      reader.onload=function(){
        try{
          var data=JSON.parse(reader.result);
          var s=(data&&data.settings)?data.settings:(data&&data._type?{}:data); // 관대하게 파싱
          if(!s||typeof s!=="object") throw new Error("형식이 올바르지 않습니다.");
          var n=0;
          BACKUP_KEYS.forEach(function(k){ if(s[k]!=null){ try{ localStorage.setItem(k, s[k]); n++; }catch(e){} } });
          // 입력란 즉시 갱신
          if(keyInput) keyInput.value=getKey();
          if(guideInput) guideInput.value=getGuide();
          if(pwInput) pwInput.value=getClinicPw();
          if(typeof applyUiLang==="function") applyUiLang();
          if(typeof syncLangSeg==="function") syncLangSeg();
          if(backupInfo) backupInfo.textContent=n+"개 설정을 불러왔습니다.";
        }catch(e){ if(backupInfo) backupInfo.textContent="가져오기 실패: 올바른 설정 파일이 아닙니다 ("+(e&&e.message||e)+")."; }
      };
      reader.onerror=function(){ if(backupInfo) backupInfo.textContent="파일을 읽지 못했습니다."; };
      reader.readAsText(f);
    };
  }
  const close=()=>modal.classList.remove("show");
  if($("settingBtn")) $("settingBtn").onclick=open;
  if($("settingClose")) $("settingClose").onclick=close;
  modal.addEventListener("click",e=>{ if(e.target===modal) close(); });
  document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&modal.classList.contains("show")) close(); });
  // 폴더 선택(설정 안에서)
  if($("setFolderBtn")) $("setFolderBtn").onclick=async()=>{ try{ await pickFolder(); const fi=$("setFolderInfo"); if(fi) fi.textContent=$("folderInfo").textContent; }catch(_){ } };
  // 언어 세그먼트
  const seg=$("langSeg");
  if(seg) seg.querySelectorAll("button").forEach(b=>{ b.onclick=()=>{ setUiLang(b.getAttribute("data-lang")); syncLangSeg(); }; });
  function syncLangSeg(){ if(!seg) return; seg.querySelectorAll("button").forEach(b=>b.classList.toggle("on", b.getAttribute("data-lang")===UI_LANG)); }
  // JS VIEWER 툴바 위치(기본 left) — 전환은 VIEWER 툴바의 버튼에서 함
  function getToolbarPos(){ try{ var v=localStorage.getItem("jsha_cmp_toolbarpos"); return (v==="top")?"top":"left"; }catch(e){ return "left"; } }
  try{ window.getToolbarPos=getToolbarPos; }catch(_){ }
  // 주석 잠금 토글
  const lockSeg=$("annLockSeg");
  function syncLockSeg(){ if(!lockSeg) return; lockSeg.querySelectorAll("button").forEach(b=>b.classList.toggle("on", (b.getAttribute("data-annlock")==="on")===annLocked)); }
  if(lockSeg){ lockSeg.querySelectorAll("button").forEach(b=>{ b.onclick=()=>{
    const want=(b.getAttribute("data-annlock")==="on");
    if(want===annLocked) return;   // 변화 없으면 무시
    if(!requireAdmin(want?"주석을 잠그":"주석 잠금을 해제")){ syncLockSeg(); return; }
    annLocked=want; syncLockSeg();
    try{ idbSet("annLocked", annLocked); }catch(_){ }
    try{ if(typeof updStatus==="function" && imgEl) updStatus(); }catch(_){ }
  }; }); }
  // 저장된 잠금 상태 복원
  (async()=>{ try{ const v=await idbGet("annLocked"); annLocked=!!v; syncLockSeg(); }catch(_){ } })();
})();
applyUiLang(); // 초기 UI 언어 적용
try{ applyFeatureFlags(); }catch(_){ }
// 차트 입력 모달: 배경 클릭 / Escape 로 닫기
(function initChartModal(){
  var m=$("chartModal"); if(!m) return;
  m.addEventListener("click",e=>{ if(e.target===m) m.classList.remove("show"); });
  document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&m.classList.contains("show")) m.classList.remove("show"); });
})();
$("searchBtn").onclick=render;

/* ===== 네이티브 호스트(WPF) 브리지: 환자번호 타겟 조회 =====
   웹의 폴더 전체 스캔 대신 C#(PacsFileService)이 \\서버\sts\YYYYMM\DD\{환자번호} 를
   타겟 조회한다. 각 파일의 getFile 은 네이티브 getDicom(fo-dicom 비압축 변환)을 호출. */
if(window.__NATIVE_HOST__ && window.NativeBridge){
  // 네이티브 스터디 목록(JSON) → 워크리스트 entries(파일 단위) 로 변환.
  // 각 파일의 getFile 은 네이티브 getDicom(fo-dicom 비압축 변환), jsonHandle 은 getSidecar.
  function nativeToEntries(sts){
    var list=[];
    (sts||[]).forEach(function(s){
      (s.files||[]).forEach(function(f){
        list.push({
          name:f.name, path:f.id, dir:"", size:f.size||0, id:f.id,
          pid:s.pid, name_:s.name_, exam:s.exam, date:s.date, time:s.time,
          doc:s.doc, dateInt:s.dateInt, sex:s.sex, age:s.age, birth:s.birth,
          instNum:f.instNum||"", view:f.view||"", modality:f.modality||"", supported:true, hasAnno:!!f.hasAnno,
          jsonHandle: f.hasAnno ? { getFile:function(){
            return window.NativeBridge.call("getSidecar",{id:f.id}).then(function(t){
              return { text:function(){ return Promise.resolve(t||""); } };
            });
          } } : null,
          getFile: function(){
            return window.NativeBridge.call("getDicom",{id:f.id}).then(function(b64){
              return new Blob([window.b64ToBytes(b64)],{type:"application/dicom"});
            });
          }
        });
      });
    });
    return list;
  }

  async function nativeSearch(){
    var q=($("search").value||"").trim();
    if(!q){ setFolderInfo("환자번호를 입력하세요."); return; }
    window.__TODAY_MODE__=false;  // 수동 검색 모드(감지 시 자동 새로고침 안 함)
    setFolderInfo("환자 "+q+" 조회 중… (공유폴더 타겟 조회)");
    try{
      var res=await window.NativeBridge.call("searchPatient",{patientId:q});
      entries=nativeToEntries((res&&res.studies)||[]); dirSidecars={};
      // 날짜필터가 결과를 가리지 않도록 전체 기간으로
      try{ $("startDate").value=""; $("endDate").value=""; }catch(_){}
      buildStudies(entries);
      folderName="공유폴더 · 환자 "+q;
      clearSelection(); render();
      setFolderInfo(studies.length? (folderName+" · "+studies.length+"건") : ("환자 "+q+" 의 촬영 기록이 없습니다."));
    }catch(e){
      var msg=(e&&e.message)||e;
      setFolderInfo("조회 실패: "+msg); alert("조회 실패: "+msg);
    }
  }

  // ===== 오늘 촬영 실시간 워크리스트 (검색 없이 자동) =====
  var _todayLoading=false;
  async function nativeListToday(){
    if(_todayLoading) return; _todayLoading=true;
    window.__TODAY_MODE__=true;
    try{
      var res=await window.NativeBridge.call("listToday",{});
      entries=nativeToEntries((res&&res.studies)||[]); dirSidecars={};
      try{ $("search").value=""; $("startDate").value=""; $("endDate").value=""; }catch(_){}
      buildStudies(entries);
      folderName="오늘 촬영 (실시간)";
      try{ sortKey="date"; sortDir=-1; }catch(_){}  // 최근 촬영이 맨 위로
      var prev=selStudy; render();
      setFolderInfo(studies.length? ("🟢 오늘 촬영 (실시간) · "+studies.length+"건 — 새로 찍으면 자동으로 올라옵니다") : "오늘 촬영된 검사가 아직 없습니다. (촬영하면 자동으로 표시)");
    }catch(e){ setFolderInfo("오늘 촬영 조회 실패: "+((e&&e.message)||e)); }
    finally{ _todayLoading=false; }
  }
  window.__NATIVE_LISTTODAY__=nativeListToday;

  $("searchBtn").onclick=nativeSearch;
  // 캡처 단계에서 Enter 를 가로채 기존 render() 대신 네이티브 조회 실행
  $("search").addEventListener("keydown",function(ev){
    if(ev.key==="Enter"){ ev.preventDefault(); ev.stopPropagation(); nativeSearch(); }
  }, true);
  window.__NATIVE_SEARCH__=nativeSearch;
  // 네이티브 모드: "JS VIEWER" 버튼 → 비교 팝업(window.open, 파일 접근 불가) 대신
  // 현재 선택된 스터디를 인페이지 뷰어로 연다. (비교 팝업 연동은 추후)
  if($("compareBtn")){
    $("compareBtn").onclick=function(){
      if(selStudy) openStudy(selStudy, curIdx||0);
      else setFolderInfo("먼저 목록에서 검사를 선택하세요.");
    };
  }

  // ── Claude 판독: JS study → 네이티브 파라미터 ──
  function studyToNative(st){
    if(!st) return null;
    return {
      patientId: st.pid||"", pid: st.pid||"", name: st.name_||"", sex: st.sex||"",
      age: (st.age!=null? st.age : null), birth: st.birth||"", exam: st.exam||"",
      date: st.date||"", modality: (st.files&&st.files[0]&&st.files[0].modality)||"",
      files: (st.files||[]).map(function(f){ return { id:f.id||f.path, view:f.view||"", inst:f.instNum||"" }; })
    };
  }
  // ── Claude 판독 버튼(검사 이력 헤더에 추가) ──
  (function addReadButtons(){
    var head=$("histHead"); if(!head) return;
    function mk(label){ var b=document.createElement("button"); b.textContent=label; b.style.cssText="margin-right:6px"; return b; }
    var single=mk("🩺 단일 판독"), compare=mk("🩺 전/후 비교 판독");
    head.insertBefore(compare, head.firstChild);
    head.insertBefore(single, head.firstChild);
    async function run(btn, method, params){
      var old=btn.textContent; btn.disabled=true; btn.textContent="판독 생성 중…";
      try{ await window.NativeBridge.call(method, params); }
      catch(e){ alert("판독 실패: "+((e&&e.message)||e)); }
      finally{ btn.disabled=false; btn.textContent=old; }
    }
    single.onclick=function(){
      if(!selStudy){ alert("먼저 목록에서 검사를 선택하세요."); return; }
      run(single, "generateReading", studyToNative(selStudy));
    };
    compare.onclick=function(){
      var checked=[].slice.call(document.querySelectorAll("#histRows .histChk:checked"))
        .map(function(c){ return c.__study; }).filter(Boolean);
      if(checked.length!==2){ alert("전/후 비교는 아래 '검사 이력'에서 검사 2개를 체크한 뒤 눌러주세요."); return; }
      checked.sort(function(a,b){ return (a.dateInt||0)-(b.dateInt||0); }); // 이른 것=전, 늦은 것=후
      run(compare, "generateCompare", { before: studyToNative(checked[0]), after: studyToNative(checked[1]) });
    };
  })();
}

/* ===== 미리보기 표시/숨김 토글 (기본: 숨김 — 로딩 속도) ===== */
window.__previewOn=false;
(function initPrevToggle(){
  var btn=$("prevToggleBtn"); if(!btn) return;
  function syncLabel(){
    var ko=(window.getUiLang&&window.getUiLang()==="ko");
    if(window.__previewOn){ btn.textContent=ko?"👁 미리보기 끄기":"👁 Preview off"; btn.classList.add("on"); }
    else { btn.textContent=ko?"👁 미리보기 켜기":"👁 Preview on"; btn.classList.remove("on"); }
  }
  btn.onclick=function(){
    if(!window.__previewOn){
      var ko=(window.getUiLang&&window.getUiLang()==="ko");
      var ok=confirm(ko?"미리보기를 켜면 검사를 선택할 때마다 이미지를 불러오므로 로딩이 느려질 수 있습니다.\n계속할까요?":"Turning on preview loads the image each time you select a study, which may slow things down.\nContinue?");
      if(!ok) return;
    }
    window.__previewOn=!window.__previewOn; syncLabel();
    // 켜면 현재 선택 항목 즉시 로드, 끄면 안내로
    if(typeof selStudy!=="undefined" && selStudy){ loadPreview(selStudy, curIdx||0); }
  };
  window.__syncPrevToggle=syncLabel;
  syncLabel();
})();
$("todayBtn").onclick=setToday;
$("allBtn").onclick=setAll;
if($("groupChk")){
  $("groupChk").checked=groupMode;
  $("groupChk").addEventListener("change",()=>{
    groupMode=$("groupChk").checked;
    try{ localStorage.setItem("jsha_group", groupMode?"1":"0"); }catch(e){}
    buildStudies(entries);
    clearSelection(); render();
  });
}
$("startDate").addEventListener("change",render);
$("endDate").addEventListener("change",render);
$("search").addEventListener("keydown",ev=>{ if(ev.key==="Enter") render(); });
document.addEventListener("keydown",ev=>{
  if(ev.key==="Escape"){ if(selStudy) clearSelection(); return; }
  const t=ev.target; if(t===$("search")||(t.classList&&t.classList.contains("dt"))) return;
  // 오버레이(주석툴)가 떠 있으면 PACS 단축키 무시
  if(document.getElementById('annotatorOverlay').classList.contains('show')) return;
  if(ev.key==="ArrowLeft"){ if(selStudy&&selStudy.count>1){ prevImage(); ev.preventDefault(); } return; }
  if(ev.key==="ArrowRight"){ if(selStudy&&selStudy.count>1){ nextImage(); ev.preventDefault(); } return; }
  // 위/아래 화살표: 워크리스트에서 선택 행을 한 칸씩 이동
  if(ev.key==="ArrowDown"||ev.key==="ArrowUp"){
    const list=shownStudies||[]; if(!list.length) return;
    ev.preventDefault();
    let i=selStudy?list.indexOf(selStudy):-1;
    if(i<0){ i=(ev.key==="ArrowDown")?0:list.length-1; }   // 미선택이면 끝에서 시작
    else { i += (ev.key==="ArrowDown")?1:-1; if(i<0)i=0; if(i>=list.length)i=list.length-1; }
    const st=list[i]; if(st){ selectStudy(st);
      // 선택 행이 화면에 보이도록 스크롤
      try{ const rows=$("rows").children; if(rows[i]) rows[i].scrollIntoView({block:"nearest"}); }catch(_){ }
    }
    return;
  }
});

/* 미리보기 좌우 버튼 + 드래그(스와이프) */
(function(){
  const pn=$("prevNav"); if(pn){ $("prevPrevBtn").onclick=prevImage; $("prevNextBtn").onclick=nextImage; }
  const img=$("prevImg"); let dragX=null, moved=false;
  function down(x){ dragX=x; moved=false; }
  function move(x){ if(dragX==null) return; if(Math.abs(x-dragX)>8) moved=true; }
  function up(x){ if(dragX==null) return; const dx=x-dragX; dragX=null; if(selStudy&&selStudy.count>1&&Math.abs(dx)>40){ if(dx<0) nextImage(); else prevImage(); } }
  if(img){
    img.addEventListener("mousedown",e=>{ down(e.clientX); });
    window.addEventListener("mousemove",e=>{ if(dragX!=null) move(e.clientX); });
    window.addEventListener("mouseup",e=>{ if(dragX!=null) up(e.clientX); });
    img.addEventListener("touchstart",e=>{ if(e.touches[0]) down(e.touches[0].clientX); },{passive:true});
    img.addEventListener("touchmove",e=>{ if(e.touches[0]) move(e.touches[0].clientX); },{passive:true});
    img.addEventListener("touchend",e=>{ if(e.changedTouches[0]) up(e.changedTouches[0].clientX); });
    // 미리보기 휠로도 넘김
    $("prevWrap").addEventListener("wheel",e=>{ if(selStudy&&selStudy.count>1){ if(e.deltaY>0||e.deltaX>0) nextImage(); else prevImage(); e.preventDefault(); } },{passive:false});
  }
})();

/* ---------- 주석 툴 저장 요청 → 사이드카 파일 저장(원본 DICOM 불변) ---------- */
async function ensureRW(h){ try{ const o={mode:"readwrite"}; if((await h.queryPermission(o))==="granted") return true; return (await h.requestPermission(o))==="granted"; }catch(_){ return false; } }
async function writeFileInDir(fname, blob, dir){
  if(!dirHandle) throw new Error("No folder handle (browser does not support folder write)");
  if(!(await ensureRW(dirHandle))) throw new Error("Folder write permission denied");
  // dir(상대 폴더 경로)가 있으면 그 하위 폴더 핸들에 저장(원본 DICOM과 같은 위치)
  let target = (dir && dirHandleByPath[dir]) ? dirHandleByPath[dir] : dirHandle;
  if(dir && !dirHandleByPath[dir]){
    // 핸들 캐시에 없으면 경로를 따라 내려가며 폴더 핸들 확보
    try{ let cur=dirHandle; for(const seg of dir.split("/").filter(Boolean)){ cur=await cur.getDirectoryHandle(seg,{create:true}); } target=cur; dirHandleByPath[dir]=cur; }catch(_){ target=dirHandle; }
  }
  const fh=await target.getFileHandle(fname,{create:true});
  const w=await fh.createWritable(); await w.write(blob); await w.close();
  return fh;
}
window.JSHA_BRIDGE.saveAnno = async function(name, anno, pngBuffer){
  const e=entries.find(x=>x.name===name);
  if(!e){ return {ok:false, reason:"no-entry"}; }
  if(!dirHandle){ return {ok:false, reason:"no-folder-handle"}; }
  try{
    const dir=e.dir||"";
    const jsonName=sidecarJson(e.name);
    const jfh=await writeFileInDir(jsonName, new Blob([JSON.stringify(anno||{},null,2)],{type:"application/json"}), dir);
    e.hasAnno=true; e.jsonHandle=jfh;
    dirSidecars[dir+jsonName]=jfh;
    if(typeof studies!=="undefined"){ const sst=studies.find(s=>s.files.includes(e)); if(sst) sst.hasAnno=true; }
    render(); if(selStudy && selStudy.files.includes(e)){ const ix=selStudy.files.indexOf(e); if(ix===curIdx) loadPreview(selStudy, curIdx); }
    return {ok:true};
  }catch(err){ return {ok:false, reason:(err&&err.message)||"error"}; }
};

/* ---------- 하단 패널 크기 드래그 조절 ---------- */
(function(){
  const split=$("hsplit"), hist=$("history"), left=$("leftcol");
  function clamp(h){ const rect=left.getBoundingClientRect(); const min=110, max=Math.max(min, rect.height-150); return Math.min(max, Math.max(min, h)); }
  function applyH(h){ hist.style.flex="0 0 "+clamp(h)+"px"; }
  let drag=false;
  function start(){ drag=true; document.body.classList.add("rowdrag"); }
  function move(y){ if(!drag) return; const rect=left.getBoundingClientRect(); applyH(rect.bottom-y); }
  function end(){ if(!drag) return; drag=false; document.body.classList.remove("rowdrag"); try{ localStorage.setItem("jsha_pacs_histH", Math.round(hist.getBoundingClientRect().height)); }catch(e){} }
  split.addEventListener("mousedown",ev=>{ ev.preventDefault(); start(); });
  window.addEventListener("mousemove",ev=>move(ev.clientY));
  window.addEventListener("mouseup",end);
  split.addEventListener("touchstart",ev=>{ ev.preventDefault(); start(); },{passive:false});
  window.addEventListener("touchmove",ev=>{ if(drag){ ev.preventDefault(); move(ev.touches[0].clientY); } },{passive:false});
  window.addEventListener("touchend",end);
  try{ const hh=parseInt(localStorage.getItem("jsha_pacs_histH")); if(hh>=110) applyH(hh); }catch(e){}
})();

/* ---------- 초기화 ---------- */
if(window.JSHA_MODE!=="annot"){
  setToday();          /* 시작/종료일 기본값 = 오늘 */
  tryRestore();        /* 이전 폴더 복원 시도 */
}

window.__PACS__={openEntry:openEntry};
})();