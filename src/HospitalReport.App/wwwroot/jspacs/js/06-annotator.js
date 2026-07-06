(function(){

let imgBytes=null, imgName="image.png", imgEl=null, natW=0, natH=0;
let points=[], levelPts=[], rotPts=[], pelvisPts=[], spans={obt:[],ltr:[]}, cobbs=[];
/* 측면(시상면) 정렬: mode = null | "simple" | "complex"; pts = {key:{x,y}} */
let sag={mode:null, pts:{}};
let refX=null, zoom=1, tool="point", calPts=[], sel=null, history=[], redoStack=[], zipHandle=null;
let flip=false, curVertebra="L5", curLevel="Clavicle", fitMode=false, pmLocked=false, magOn=false;
let dirty=false, fromPacs=false, sourceName="";
let annLocked=false;   // 주석 잠금: true면 작성·삭제 불가(읽기 전용)
let curSeries=null, curSeriesIdx=0, curPatient=null;
let curPixelSpacing=null, curDicomPat="", cobb2Pick=null;
function showImageArea(on){ const a=$("imgArea"), d=$("drop"); if(a) a.style.display=on?"block":"none"; if(d) d.style.display=on?"none":"block"; }
function seriesHasUnsaved(){
  if(window.__ANN_DIRTY__) return true;
  if(curSeries){ for(const it of curSeries){ if(it&&it.__memDirty) return true; } }
  return false;
}
// 한 장(주석 스냅샷+파일명+이미지메타)을 현재 저장 경로로 저장.
async function saveOneSnapshot(it){
  if(!it||!it.__memAnno||!it.name) return;
  const _bk=snapshot(), _src=sourceName, _in=imgName, _w=natW, _h=natH, _fl=flip;  // 백업
  try{
    restore(it.__memAnno); sourceName=it.name;
    if(it.__memImg){ imgName=it.__memImg.imgName; natW=it.__memImg.natW; natH=it.__memImg.natH; flip=it.__memImg.flip; }
    const {meta}=buildMeta();
    const _host=(window.JSHA_MODE==="annot"&&window.__CMP_HOST__)?window.__CMP_HOST__():null;
    if(_host){ _host.postMessage({type:"cmp-save", paneId:window.__CMP_PANE__, name:it.name, anno:meta}, "*"); }
    else if(fromPacs && window.JSHA_BRIDGE && window.JSHA_BRIDGE.saveAnno){ await window.JSHA_BRIDGE.saveAnno(it.name, meta, null); }
  }catch(_){ }
  finally{ restore(_bk); sourceName=_src; imgName=_in; natW=_w; natH=_h; flip=_fl; }  // 원복
}
async function closeImage(){
  // 창/사진을 닫을 때 미저장 주석(좌우반전 상태 포함)을 확인 없이 자동 저장
  if(imgEl && seriesHasUnsaved()){
    try{
      // 현재 화면 사진의 최신 상태(주석 + 이미지 메타 flip 등)를 메모리에 반영
      if(curSeries && curSeries[curSeriesIdx]){ const c=curSeries[curSeriesIdx];
        c.__memAnno=snapshot(); c.__memDirty=(window.__ANN_DIRTY__||dirty);
        c.__memImg={imgName:imgName, natW:natW, natH:natH, flip:flip}; }
      if(curSeries && curSeries.length){
        for(let k=0;k<curSeries.length;k++){ const it=curSeries[k];
          if(it && it.__memDirty && it.__memAnno){ await saveOneSnapshot(it); it.__memDirty=false; } }
      } else {
        await doSave();
      }
      window.__ANN_DIRTY__=false; dirty=false;
    }catch(_){ }
  }
  if(curSeries){ curSeries.forEach(it=>{ if(it){ it.__memAnno=null; it.__memDirty=false; it.__memImg=null; } }); }
  resetAll(); if(window.__CMP_NOTIFY_CLOSE__) window.__CMP_NOTIFY_CLOSE__();
}
const SINGLE_SP=new Set(["S2","Coccyx"]);
let drawW=0, drawH=0, scale=1, labelHits=[];
const $=id=>document.getElementById(id);
const cv=$("cv"), ctx=cv.getContext("2d");
const mag=$("mag"), mctx=mag.getContext("2d");

const C_REF="#ffe600", C_PT="#00eaff", C_PTL="#8af3ff", C_LINE="#5dff00",
      C_LEV="#1f9dff", C_LEVL="#8cc6ff", C_ROT="#00ffcc", C_CAL="#46ff46",
      C_PEL="#ff9500", C_OBT="#c77dff", C_LTR="#ffbf00", C_COBB="#ff5da2";
const SPAN={obt:{a:"medial",b:"lateral",short:"Obturator",color:C_OBT},
            ltr:{a:"Lesser trochanter",b:"Inferior ramus",short:"LT-IR",color:C_LTR}};
const PELNAME={A:"left SI joint inferior",B:"right SI joint inferior",C:"pubic symphysis top"};

function snapshot(){ return JSON.stringify({points,levelPts,rotPts,pelvisPts,spans,refX,cobbs,sag}); }
function pushHist(){ history.push(snapshot()); if(history.length>300) history.shift(); redoStack=[]; dirty=true; window.__ANN_DIRTY__=true; }
function restore(s){ const o=JSON.parse(s);
  points=o.points||[]; levelPts=o.levelPts||[]; rotPts=o.rotPts||[]; pelvisPts=o.pelvisPts||[];
  spans=o.spans||{obt:[],ltr:[]}; if(!spans.obt)spans.obt=[]; if(!spans.ltr)spans.ltr=[];
  cobbs=o.cobbs||[];
  sag=(o.sag&&typeof o.sag==="object")?{mode:o.sag.mode||null, pts:o.sag.pts||{}}:{mode:null,pts:{}};
  refX=(o.refX!=null?o.refX:null); }
function clearAnno(){ points=[];levelPts=[];rotPts=[];pelvisPts=[];spans={obt:[],ltr:[]};cobbs=[];refX=null;calPts=[];sel=null; sag={mode:null,pts:{}}; }
function cobbComplete(cb){ return !!(cb&&cb.l0&&cb.l0.a&&cb.l0.b&&cb.l1&&cb.l1.a&&cb.l1.b); }
function cobbAngle(cb){ if(!cobbComplete(cb)) return null;
  const a0=Math.atan2(cb.l0.b.y-cb.l0.a.y, cb.l0.b.x-cb.l0.a.x);
  const a1=Math.atan2(cb.l1.b.y-cb.l1.a.y, cb.l1.b.x-cb.l1.a.x);
  let ang=Math.abs(a0-a1)*180/Math.PI; ang=ang%180; if(ang>90) ang=180-ang; return ang; }

/* ===================== 측면(시상면) 정렬 ===================== */
/* 좌표는 natural 이미지 좌표(flip 무관). 화면 좌측 = 환자 앞(anterior) = x 작은 쪽. */
/* 클릭 시퀀스 정의: key=내부키, hint=상태표시줄 안내 */
const SAG_SEQ={
  simple:[
    {key:"C2",        hint:"C2 치돌기(dens) 끝점"},
    {key:"C7_ua",     hint:"C7 상종판 앞쪽(anterior) 모서리 — 대각선 1"},
    {key:"C7_lp",     hint:"C7 하종판 뒤쪽(posterior) 모서리 — 대각선 2 (두 점의 중점 = C7 중심)"},
    {key:"S1_p",      hint:"S1 천골종판 뒤끝(posterior, 후상연)"}
  ],
  complex:[
    {key:"C2",        hint:"C2 치돌기(dens) 끝점 — cSVA 기준"},
    {key:"C2_la",     hint:"C2 하종판 앞끝(anterior) — CL 기준"},
    {key:"C2_lp",     hint:"C2 하종판 뒤끝(posterior) — CL 기준"},
    {key:"C7_ua",     hint:"C7 상종판 앞쪽(anterior) 모서리"},
    {key:"C7_up",     hint:"C7 상종판 뒤쪽(posterior) 모서리"},
    {key:"C7_la",     hint:"C7 하종판 앞쪽(anterior) 모서리"},
    {key:"C7_lp",     hint:"C7 하종판 뒤쪽(posterior) 모서리"},
    {key:"T1_a",      hint:"T1 상종판 앞끝(anterior)"},
    {key:"T1_p",      hint:"T1 상종판 뒤끝(posterior)"},
    {key:"L1_a",      hint:"L1 상종판 앞끝(anterior)"},
    {key:"L1_p",      hint:"L1 상종판 뒤끝(posterior)"},
    {key:"S1_a",      hint:"S1 천골종판 앞끝(anterior)"},
    {key:"S1_p",      hint:"S1 천골종판 뒤끝(posterior, 후상연)"},
    {key:"AC_a",      hint:"비구(acetabulum) 전연(anterior) — 대퇴골두 중심 1"},
    {key:"AC_p",      hint:"비구(acetabulum) 후연(posterior) — 대퇴골두 중심 2 (두 점의 중점 사용)"}
  ]
};
const SAG_LABELS={C2:"C2",C2_la:"C2",C2_lp:"C2",C7_ua:"C7",C7_up:"C7",C7_la:"C7",C7_lp:"C7",
  T1_a:"T1",T1_p:"T1",L1_a:"L1",L1_p:"L1",S1_a:"S1",S1_p:"S1",AC_a:"FH",AC_p:"FH",FH:"FH"};
const C_SAG="#7CFF6B", C_SAGV="#ffe600", C_SAGH="#ff9d3c";
/* 진행 상태: 다음에 찍을 시퀀스 인덱스(없으면 -1=완료/비활성) */
function sagNextIdx(){ if(!sag.mode) return -1; const seq=SAG_SEQ[sag.mode];
  for(let i=0;i<seq.length;i++){ if(!sag.pts[seq[i].key]) return i; } return -1; }
function sagActive(){ return sag.mode!=null && tool==="sag"; }
/* C7 추체 중심 = 네 모서리 대각선(상앞-하뒤, 상뒤-하앞) 교차점 */
function lineIntersect(p1,p2,p3,p4){
  const d=(p1.x-p2.x)*(p3.y-p4.y)-(p1.y-p2.y)*(p3.x-p4.x); if(Math.abs(d)<1e-9) return null;
  const a=p1.x*p2.y-p1.y*p2.x, b=p3.x*p4.y-p3.y*p4.x;
  return { x:(a*(p3.x-p4.x)-(p1.x-p2.x)*b)/d, y:(a*(p3.y-p4.y)-(p1.y-p2.y)*b)/d }; }
/* C7 추체 중심: 네 모서리가 있으면 대각선 교차(정확), 대각 2점(상앞·하뒤)만 있으면 그 중점 */
function sagC7center(){ const p=sag.pts;
  if(p.C7_ua&&p.C7_up&&p.C7_la&&p.C7_lp) return lineIntersect(p.C7_ua,p.C7_lp,p.C7_up,p.C7_la);
  if(p.C7_ua&&p.C7_lp) return midpt(p.C7_ua,p.C7_lp);
  return null; }
function midpt(a,b){ return {x:(a.x+b.x)/2, y:(a.y+b.y)/2}; }
/* 대퇴골두 중심: 비구 전연·후연(AC_a/AC_p)이 있으면 그 중점, 없으면 단일 FH(구버전 호환) */
function sagFH(){ const p=sag.pts;
  if(p.AC_a&&p.AC_p) return midpt(p.AC_a,p.AC_p);
  if(p.FH) return p.FH;
  return null; }
/* 두 점 선분이 수평과 이루는 각(0~90, 절대값) */
function slopeDeg(a,b){ let d=Math.abs(Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI); if(d>90)d=180-d; return d; }
/* 두 종판선이 이루는 각(Cobb 방식, 0~90) */
function endplateAngle(a0,b0,a1,b1){ const t0=Math.atan2(b0.y-a0.y,b0.x-a0.x), t1=Math.atan2(b1.y-a1.y,b1.x-a1.x);
  let d=Math.abs(t0-t1)*180/Math.PI; d=d%180; if(d>90)d=180-d; return d; }
/* 측면 지표 산출. 반환 {svaMm, csvaMm, ll, ss, pt, pi, piLl, t1s, cl, t1sCl} (가능한 것만) */
function sagMetrics(){
  const p=sag.pts, pm=parseFloat($("pxmm").value); const out={};
  const C7=sagC7center();
  const toMm=px=>(pm>0?px/pm:null);
  // 부호 규약: 화면 좌측 = 환자 앞(anterior). 점은 natural 좌표로 저장되므로,
  // flip 미적용 시 앞=x작음(ant=+1), flip 적용 시 화면상 앞이 natural x큰쪽이 되어 부호 반전(ant=-1).
  const ant = flip ? -1 : 1;
  // SVA(+) = C7 수직선이 S1 후상연보다 앞(anterior)
  if(C7 && p.S1_p){ const off=ant*(p.S1_p.x - C7.x); out.svaPx=off; out.svaMm=toMm(off); }
  // cSVA(+) = C2 수직선이 C7 중심보다 앞(anterior). 도착점은 C7 중심으로 통일.
  if(p.C2 && C7){ const off=ant*(C7.x - p.C2.x); out.csvaPx=off; out.csvaMm=toMm(off); }
  if(p.S1_a && p.S1_p){
    // 종판 벡터 (앞S1_a → 뒤S1_p). 화면 앞=왼쪽(x작음)
    let ex=p.S1_p.x-p.S1_a.x, ey=p.S1_p.y-p.S1_a.y;
    let ss=Math.abs(Math.atan2(ey,ex)*180/Math.PI); if(ss>90)ss=180-ss; out.ss=ss;
    const FH=sagFH();
    if(FH){ const mid=midpt(p.S1_a,p.S1_p);
      // 종판 법선(위쪽 향함)
      let nx=-ey, ny=ex; const nl=Math.hypot(nx,ny)||1; nx/=nl; ny/=nl; if(ny>0){nx=-nx;ny=-ny;}
      // FH→종판중점 단위벡터
      let fx=mid.x-FH.x, fy=mid.y-FH.y; const fl=Math.hypot(fx,fy)||1; fx/=fl; fy/=fl;
      // PI = 법선과 (FH→중점) 사이각
      out.pi=Math.acos(Math.max(-1,Math.min(1, nx*fx+ny*fy)))*180/Math.PI;
      // PT = 수직(위 (0,-1))과 (FH→중점) 사이각
      out.pt=Math.acos(Math.max(-1,Math.min(1, fy*(-1))))*180/Math.PI;
    }
    if(p.L1_a && p.L1_p){ out.ll=endplateAngle(p.L1_a,p.L1_p,p.S1_a,p.S1_p);
      if(out.pi!=null) out.piLl=out.pi-out.ll; } }
  if(p.T1_a && p.T1_p){ out.t1s=slopeDeg(p.T1_a,p.T1_p);
    // CL(경추 전만) = C2 하종판선과 C7 하종판선이 이루는 각 (C2–C7 Cobb)
    if(p.C2_la && p.C2_lp && p.C7_la && p.C7_lp){
      out.cl=endplateAngle(p.C2_la,p.C2_lp,p.C7_la,p.C7_lp);
      out.t1sCl=out.t1s-out.cl; } }
  return out;
}
function sagStartMode(m){
  if(!imgEl){ alert("먼저 이미지를 여세요."); return; }
  pushHist();
  if(sag.mode!==m){ sag={mode:m, pts:{}}; }   // 모드 전환 시 초기화
  setTool("sag"); redraw(); updStatus();
}
function sagClear(){ if(sag.mode||Object.keys(sag.pts).length){ pushHist(); } sag={mode:null,pts:{}}; if(tool==="sag")setTool("point"); redraw(); updStatus(); }

function loadFile(f){
  if(!f) return;
  imgName=f.name||"image.png"; zipHandle=null; clearAnno(); history=[]; redoStack=[]; $("patientInfo").value="";
  const rb=new FileReader(); rb.onload=()=>{imgBytes=new Uint8Array(rb.result);}; rb.readAsArrayBuffer(f);
  const url=URL.createObjectURL(f); imgEl=new Image();
  var _ie=imgEl; imgEl.onload=()=>{ if(_ie!==imgEl||!imgEl) return; natW=imgEl.naturalWidth; natH=imgEl.naturalHeight;
    $("imginfo").textContent=imgName+" ("+natW+"\u00d7"+natH+")";
    showImageArea(true); setTool("point"); layout(); };
  imgEl.src=url;
}
/* 파일 로딩은 PACS(postMessage)로만 수행 — 드래그앤드롭·로딩 버튼 제거됨 */

/* ---------- DICOM 로딩 (PACS에서 전송된 ArrayBuffer) ---------- */
function restoreAnnoMeta(meta){
  // PACS 사이드카 JSON → 작업 상태 복원 (ZIP annotation.json과 동일 스키마)
  refX=(meta.pubic_symphysis_x!=null)?meta.pubic_symphysis_x:(meta.centerline_x!=null?meta.centerline_x:null);
  if(!pmLocked) $("pxmm").value=(meta.px_per_mm!=null)?meta.px_per_mm:"";
  $("patientInfo").value=meta.patient_info||"";
  points=(meta.points||[]).map(p=>({label:p.label,x:p.x,y:p.y}));
  (meta.level_pairs||[]).forEach(pr=>{ if(pr.L) levelPts.push({label:pr.label,side:"L",x:pr.L.x,y:pr.L.y}); if(pr.R) levelPts.push({label:pr.label,side:"R",x:pr.R.x,y:pr.R.y}); });
  (meta.rotation||[]).forEach(r=>{ ["LB","RB","SP"].forEach(role=>{ if(r[role]) rotPts.push({label:r.label,role:role,x:r[role].x,y:r[role].y}); }); });
  if(meta.pelvis){ ["A","B","C"].forEach(rr=>{ if(meta.pelvis[rr]) pelvisPts.push({role:rr,x:meta.pelvis[rr].x,y:meta.pelvis[rr].y}); }); }
  if(meta.spans){ ["obt","ltr"].forEach(k=>{ (meta.spans[k]||[]).forEach(p=>spans[k].push({side:p.side,role:p.role,x:p.x,y:p.y})); }); }
  if(meta.cobbs){ (meta.cobbs||[]).forEach(cb=>{ if(cb&&cb.l0&&cb.l1) cobbs.push({l0:cb.l0,l1:cb.l1}); }); }
  if(meta.sagittal&&meta.sagittal.mode){ sag={mode:meta.sagittal.mode, pts:meta.sagittal.pts||{}}; }
  if(typeof meta.flip==="boolean") flip=meta.flip;
}
/* 디코딩 결과 캐시: 무거운 parse+renderToCanvas+encode를 1회만 수행하고 재사용 */
function decodeDicomToImage(buffer){
  // 반환: Promise<{img, info, natW, natH, pngBytes}>
  return new Promise((resolve,reject)=>{
    let parsed;
    try{ parsed=JSHADICOM.parse(buffer); }catch(err){ reject(err); return; }
    if(!JSHADICOM.isSupported(parsed.info.transferSyntax)){ reject(new Error("Unsupported transfer syntax: "+parsed.info.transferSyntax)); return; }
    setTimeout(()=>{
      let cnv;
      try{ cnv=document.createElement("canvas"); JSHADICOM.renderToCanvas(parsed, cnv); }
      catch(err){ reject(err); return; }
      const url=cnv.toDataURL("image/png");
      const img=new Image();
      img.onload=()=>{ resolve({img, info:parsed.info, natW:img.naturalWidth, natH:img.naturalHeight, dataURL:url}); };
      img.onerror=()=>reject(new Error("image decode failed"));
      img.src=url;
    }, 0);
  });
}
function applyDecoded(dec, name, annoMeta){
  // 캐시된(또는 새로 디코딩된) 이미지를 화면에 반영 — 무거운 작업 없음
  const I=dec.info;
  clearAnno(); history=[]; redoStack=[]; flip=false;
  curPixelSpacing=(I.pixelSpacing>0)?I.pixelSpacing:null;
  $("pxmm").value = curPixelSpacing? (1/curPixelSpacing).toFixed(4) : "";
  $("patientInfo").value="";
  imgName=(name||"image.dcm").replace(/\.dcm$/i,"")+".dcm";
  sourceName=name||""; fromPacs=true; zipHandle=null;
  const pn=JSHADICOM.formatName(I.patientNameRaw);
  const agev=JSHADICOM.ageFrom(I.patientAge, I.birthDate, I.studyDate);
  const sx=JSHADICOM.formatSex(I.sex);
  curDicomPat=[I.patientID, sx, (agev!=null?agev+"y":""), pn].filter(Boolean).join("  ·  ");
  imgBytes=null;
  natW=dec.natW; natH=dec.natH;
  imgEl=dec.img;
  tool="point";
  $("imginfo").textContent=imgName+" ("+natW+"\u00d7"+natH+")  [DICOM]";
  showImageArea(true);
  if(annoMeta){ restoreAnnoMeta(annoMeta); }
  setTool(tool);
  if(document.documentElement.classList.contains("panemode")){ fitMode=true; const fb=$("fitBtn"); if(fb) fb.classList.add("active"); }
  layout(); updPatientHeader(); layout(); updStatus(); renderReport();
  if(typeof reportMetrics==="function") reportMetrics();
  dirty=false; window.__ANN_DIRTY__=false;
  setStatus("DICOM loaded","#46ff46");
}
function loadDicomBuffer(buffer, name, annoMeta){
  setStatus("Decoding DICOM…","#ffd166");
  decodeDicomToImage(buffer).then(dec=>{ applyDecoded(dec, name, annoMeta); })
    .catch(err=>{ setStatus("DICOM decode failed: "+err.message,"#ff6b6b"); });
}
function updPatientHeader(){
  const pd=$("patDicom"), pm=$("patManual"); if(!pd) return;
  pd.textContent=curDicomPat||"";
  const t=($("patientInfo").value||"").trim();
  pm.textContent=t; pm.style.display=t?"block":"none";
}
function setPatNote(t){ const el=$("patNoteOverlay"); if(!el) return; t=(t||"").trim(); el.textContent=t; el.style.display=t?"block":"none"; }

/* ---------- 시리즈(여러 장) 로딩 + 좌우 넘김 ---------- */
async function loadSeries(series, idx, patient){
  curSeries=series||null; curSeriesIdx=idx||0; curPatient=patient||null;
  updSeriesNav();
  await loadSeriesIndex(curSeriesIdx);
  // item6: 나머지 장들을 백그라운드로 미리 디코딩 캐시(빠른 넘김)
  preloadSeries();
}
function preloadSeries(){
  if(!curSeries||curSeries.length<2) return;
  let k=0;
  (function step(){
    if(k>=curSeries.length){ return; }
    const it=curSeries[k++];
    const next=()=>setTimeout(step,0);
    if(!it){ next(); return; }
    if(it.__dec || it.__decoding){ next(); return; }   // 이미 디코딩됨/진행중
    it.__decoding=true;
    // 버퍼 확보 → 디코딩 캐시 (무거운 작업을 미리 수행)
    Promise.resolve(it.__buf || (it.getBuffer?it.getBuffer():null)).then(buf=>{
      if(!buf){ it.__decoding=false; next(); return; }
      it.__buf=buf;
      decodeDicomToImage(buf).then(dec=>{ it.__dec=dec; it.__decoding=false; next(); }).catch(()=>{ it.__decoding=false; next(); });
    }).catch(()=>{ it.__decoding=false; next(); });
  })();
}
function reportSeries(){ const h=(window.JSHA_MODE==="annot"&&window.__CMP_HOST__)?window.__CMP_HOST__():null;
  if(h){ try{ h.postMessage({type:"cmp-series", paneId:window.__CMP_PANE__, idx:curSeriesIdx, total:(curSeries?curSeries.length:0)},"*"); }catch(_){ } } }
async function loadSeriesIndex(i){
  if(!curSeries||!curSeries.length) return;
  // 이동 전: 현재 사진의 주석을 메모리에 보관(저장 여부는 묻지 않음 — 종료 시에만 확인)
  if(imgEl && curSeries[curSeriesIdx]){ try{ const c=curSeries[curSeriesIdx];
    c.__memAnno=snapshot(); c.__memDirty=window.__ANN_DIRTY__||false;
    c.__memImg={imgName:imgName, natW:natW, natH:natH, flip:flip}; }catch(_){ } }
  curSeriesIdx=(i+curSeries.length)%curSeries.length;
  const it=curSeries[curSeriesIdx];
  try{
    // 같은 세션에서 이미 작업하던 주석이 메모리에 있으면 그걸 우선 사용(파일 주석보다 우선)
    const anno=it.getAnno?await it.getAnno():null;
    if(it.__dec){
      applyDecoded(it.__dec, it.name, anno);
    } else {
      setStatus("Decoding DICOM…","#ffd166");
      const buffer=it.__buf || await it.getBuffer();
      if(!it.__buf) it.__buf=buffer;
      it.__decoding=true;
      const dec=await decodeDicomToImage(buffer);
      it.__dec=dec; it.__decoding=false;
      applyDecoded(dec, it.name, anno);
    }
    // 메모리에 보관해둔 주석이 있으면 파일 주석 위에 복원하고 dirty 상태도 되살림
    if(it.__memAnno){ try{ restore(it.__memAnno); window.__ANN_DIRTY__=it.__memDirty||false; dirty=it.__memDirty||false; redraw(); renderReport(); reportMetrics(); updStatus(); }catch(_){ } }
    try{ if(window.JSHA_BRIDGE&&window.JSHA_BRIDGE.setBackName) window.JSHA_BRIDGE.setBackName(it.name+(curSeries.length>1?("  ("+(curSeriesIdx+1)+"/"+curSeries.length+")"):"")); }catch(_){}
    updSeriesNav();
    if(typeof reportSeries==="function") reportSeries();
    setTimeout(preloadSeries,0);
  }catch(e){ setStatus("Image load failed: "+e.message,"#ff6b6b"); }
}
function seriesPrev(){ if(curSeries&&curSeries.length>1) loadSeriesIndex(curSeriesIdx-1); }
function seriesNext(){ if(curSeries&&curSeries.length>1) loadSeriesIndex(curSeriesIdx+1); }
function updSeriesNav(){
  const nav=$("annSeriesNav"); if(!nav) return;
  if(curSeries&&curSeries.length>1){ nav.style.display="flex"; $("annSeriesLabel").textContent=(curSeriesIdx+1)+" / "+curSeries.length; }
  else nav.style.display="none";
}
async function openZipPicker(){
  if(window.showOpenFilePicker){
    try{ const [h]=await window.showOpenFilePicker({types:[{description:"ZIP",accept:{"application/zip":[".zip"],"application/x-zip-compressed":[".zip"]}}]});
      const file=await h.getFile(); zipHandle=h; loadZipFromFile(file);
    }catch(err){ if(err&&err.name==="AbortError")return; $("zipfile").click(); }
  } else { $("zipfile").click(); }
}
function mimeOf(name){ const n=(name||"").toLowerCase();
  if(n.endsWith(".png"))return "image/png"; if(n.endsWith(".jpg")||n.endsWith(".jpeg"))return "image/jpeg";
  if(n.endsWith(".webp"))return "image/webp"; if(n.endsWith(".gif"))return "image/gif"; if(n.endsWith(".bmp"))return "image/bmp"; return "image/png"; }
function readZip(bytes){
  const dv=new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const files={}; let off=0;
  while(off+4<=bytes.length){
    if(dv.getUint32(off,true)!==0x04034b50) break;
    const method=dv.getUint16(off+8,true), compSize=dv.getUint32(off+18,true);
    const nameLen=dv.getUint16(off+26,true), extraLen=dv.getUint16(off+28,true);
    const name=new TextDecoder().decode(bytes.subarray(off+30,off+30+nameLen));
    const dataStart=off+30+nameLen+extraLen;
    files[name]={method, data:bytes.subarray(dataStart, dataStart+compSize)};
    off=dataStart+compSize;
  }
  return files;
}
function loadZipBytes(bytes){
  try{
    const files=readZip(bytes);
    if(!files["annotation.json"]){
      // 메타데이터 없는 ZIP(예: 병원 원본): 이미지만 찾아 새 작업으로 로딩
      let key=null;
      for(const k in files){ if(/\.(png|jpe?g|webp|gif|bmp)$/i.test(k) && k!=="annotated.png"){ key=k; break; } }
      if(!key && files["annotated.png"]) key="annotated.png";
      if(!key){ alert("No image found inside the ZIP."); return; }
      const imgF=files[key];
      if(imgF.method!==0){ alert("Unsupported compression (only stored ZIP is supported)."); return; }
      clearAnno(); history=[]; redoStack=[]; if(!pmLocked) $("pxmm").value=""; $("patientInfo").value="";
      imgName=key; imgBytes=imgF.data.slice();
      const blob=new Blob([imgF.data],{type:mimeOf(imgName)}); const url=URL.createObjectURL(blob); imgEl=new Image();
      var _ie=imgEl; imgEl.onload=()=>{ if(_ie!==imgEl||!imgEl) return; natW=imgEl.naturalWidth; natH=imgEl.naturalHeight;
        $("imginfo").textContent=imgName+" ("+natW+"\u00d7"+natH+")"; showImageArea(true); setTool("point"); layout(); updStatus(); };
      imgEl.src=url; dirty=false; window.__ANN_DIRTY__=false; return;
    }
    const meta=JSON.parse(new TextDecoder().decode(files["annotation.json"].data));
    const imgF=files[meta.image];
    if(!imgF){ alert("Original image ("+meta.image+") not found inside the ZIP."); return; }
    if(imgF.method!==0){ alert("Unsupported compression (only stored ZIP is supported)."); return; }
    clearAnno(); history=[]; redoStack=[];
    imgName=meta.image||"image.png"; imgBytes=imgF.data.slice();
    refX=(meta.pubic_symphysis_x!=null)?meta.pubic_symphysis_x:(meta.centerline_x!=null?meta.centerline_x:null);
    $("pxmm").value=(meta.px_per_mm!=null)?meta.px_per_mm:"";
    $("patientInfo").value=meta.patient_info||"";
    points=(meta.points||[]).map(p=>({label:p.label,x:p.x,y:p.y}));
    (meta.level_pairs||[]).forEach(pr=>{ if(pr.L) levelPts.push({label:pr.label,side:"L",x:pr.L.x,y:pr.L.y}); if(pr.R) levelPts.push({label:pr.label,side:"R",x:pr.R.x,y:pr.R.y}); });
    (meta.rotation||[]).forEach(r=>{ ["LB","RB","SP"].forEach(role=>{ if(r[role]) rotPts.push({label:r.label,role:role,x:r[role].x,y:r[role].y}); }); });
    if(meta.pelvis){ ["A","B","C"].forEach(rr=>{ if(meta.pelvis[rr]) pelvisPts.push({role:rr,x:meta.pelvis[rr].x,y:meta.pelvis[rr].y}); }); }
    if(meta.spans){ ["obt","ltr"].forEach(k=>{ (meta.spans[k]||[]).forEach(p=>spans[k].push({side:p.side,role:p.role,x:p.x,y:p.y})); }); }
    if(meta.sagittal&&meta.sagittal.mode){ sag={mode:meta.sagittal.mode, pts:meta.sagittal.pts||{}}; }
    const blob=new Blob([imgF.data],{type:mimeOf(imgName)}); const url=URL.createObjectURL(blob); imgEl=new Image();
    var _ie=imgEl; imgEl.onload=()=>{ if(_ie!==imgEl||!imgEl) return; natW=imgEl.naturalWidth; natH=imgEl.naturalHeight;
      $("imginfo").textContent=imgName+" ("+natW+"\u00d7"+natH+")  [ZIP]";
      showImageArea(true); setTool("point"); layout(); updStatus(); };
    imgEl.src=url; dirty=false; window.__ANN_DIRTY__=false;
  }catch(err){ alert("ZIP read failed: "+err.message); }
}
function loadZipFromFile(f){ if(!f) return; const rd=new FileReader(); rd.onload=()=>loadZipBytes(new Uint8Array(rd.result)); rd.readAsArrayBuffer(f); }

function setStatus(t,c){ const el=$("status"); el.textContent=t; el.style.color=c||"#9aa";
  // compare(iframe) 모드: 작도 진행 중(도구 활성)일 때만 안내를 부모 상태창으로 전달
  if(window.JSHA_MODE==="annot" && window.__CMP_HOST__){ const h=window.__CMP_HOST__();
    const active=(typeof tool!=="undefined" && tool && tool!=="point");
    if(h){ try{ h.postMessage({type:"cmp-status", paneId:window.__CMP_PANE__, text:(active?t:""), color:(c||"")}, "*"); }catch(_){ } } } }
function updStatus(){
  if(!imgEl){ setStatus("Load an image first.","#9aa"); return; }
  if(tool==="sag"){ const i=sagNextIdx(); const seq=SAG_SEQ[sag.mode];
    if(i<0){ setStatus("측면 정렬 입력 완료 — 결과는 오른쪽 표/리포트에 표시됩니다.",C_SAG); }
    else { setStatus("측면("+(sag.mode==="simple"?"Simple":"Complex")+") ▶ ["+(i+1)+"/"+seq.length+"] "+seq[i].hint,C_SAG); }
    return; }
  if(tool==="ref"){ setStatus("Click the midline (vertical reference)",C_REF); return; }
  if(tool==="cobb2"){ setStatus("Cobb's angle 2 ▶ click two measured vertebrae in order",C_COBB); return; }
  if(tool.indexOf("rot")===0){ const nm={SP:"spinous process (SP)",LB:"left vertebral border",RB:"right vertebral border"};
    setStatus("Vertebra "+curVertebra+" ▶ click "+nm[tool.slice(3)],C_ROT); return; }
  if(tool==="levL"||tool==="levR"){ setStatus("Level height ▶ click "+curLevel+(tool==="levL"?" (left)":" (right)"),C_LEV); return; }
  if(tool.indexOf("pel")===0){ setStatus("Pelvic cavity ▶ "+tool.slice(3)+": click "+PELNAME[tool.slice(3)],C_PEL); return; }
  if(tool.indexOf("cobb:")===0){ const code=tool.split(":")[1]; const li=+code[0], pt=code[1];
    const lineNm=li===0?"upper endplate (upper vertebra)":"lower endplate (lower vertebra)"; const ptNm=pt==="a"?"1st point":"2nd point";
    setStatus("Cobb's angle ▶ click "+lineNm+" "+ptNm+" ("+(li*2+(pt==="a"?1:2))+"/4)",C_COBB); return; }
  if(tool.indexOf(":")>0){ const k=tool.split(":")[0], code=tool.split(":")[1]; const side=code[0]==="L"?"left":"right";
    const nm=code[1]==="a"?SPAN[k].a:SPAN[k].b; setStatus(SPAN[k].short+" ▶ click "+side+" "+nm,SPAN[k].color); return; }
  setStatus("Select a tool · click label=select, Delete=remove, ESC=deselect",C_PTL);
}

function otext(c,t,x,y,fill,fp){ c.lineJoin="round"; c.strokeStyle="rgba(0,0,0,0.95)"; c.lineWidth=Math.max(3,fp*0.32);
  c.strokeText(t,x,y); c.fillStyle=fill; c.fillText(t,x,y); }
function roundRect(c,x,y,w,h,r){ c.beginPath(); c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r);
  c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }
function refEq(a,b){ if(!a||!b||a.type!==b.type) return false;
  if(a.type==="pt") return a.i===b.i;
  if(a.type==="lev"||a.type==="rot") return a.label===b.label;
  if(a.type==="span") return a.kind===b.kind && a.side===b.side;
  return true; }
function drawLabelsNoOverlap(c, labels, fp, interactive){
  c.font="bold "+fp+"px sans-serif";
  const h=fp*1.02, placed=[], cands=[0];
  for(let s=1;s<=90;s++){ cands.push(s*2); cands.push(-s*2); }
  labels.forEach(L=>{
    c.textAlign=L.align||"left"; c.textBaseline=L.baseline||"alphabetic";
    const w=c.measureText(L.text).width; let x1,x2;
    if(L.align==="center"){ x1=L.x-w/2; x2=L.x+w/2; }
    else if(L.align==="right"){ x1=L.x-w; x2=L.x; } else { x1=L.x; x2=L.x+w; }
    const bl=L.baseline||"alphabetic"; let t0,b0;
    if(bl==="top"){ t0=L.y; b0=L.y+h; } else if(bl==="bottom"){ t0=L.y-h; b0=L.y; } else { t0=L.y-h*0.78; b0=L.y+h*0.24; }
    const hit=(t,b)=>placed.some(P=> !(x2<P.x1-1 || x1>P.x2+1 || b<P.t-1 || t>P.b+1));
    let dy=0; for(const d of cands){ if(!hit(t0+d,b0+d)){ dy=d; break; } }
    const box={x1:x1-3,t:t0+dy-3,x2:x2+3,b:b0+dy+3};
    if(interactive && L.ref && sel && refEq(L.ref,sel)){
      c.save(); c.fillStyle="rgba(255,255,255,0.22)"; c.strokeStyle="#fff"; c.lineWidth=1.5;
      roundRect(c,box.x1,box.t,box.x2-box.x1,box.b-box.t,4); c.fill(); c.stroke(); c.restore();
    }
    otext(c, L.text, L.x, L.y+dy, L.color, fp);
    placed.push({x1:x1,x2:x2,t:t0+dy,b:b0+dy});
    if(interactive && L.ref) labelHits.push({x1:box.x1,y1:box.t,x2:box.x2,y2:box.b,ref:L.ref});
  });
  c.textAlign="left"; c.textBaseline="alphabetic";
}
function screenSide(a,b){ const d=a-b; if(d===0) return ""; return (flip?(d>0):(d<0))?"L":"R"; }
function drawScene(c,sc,interactive){
  if(interactive) labelHits=[];
  const W=natW*sc, H=natH*sc; c.clearRect(0,0,W,H);
  if(imgEl){ if(flip){ c.save(); c.translate(W,0); c.scale(-1,1); c.drawImage(imgEl,0,0,W,H); c.restore(); } else c.drawImage(imgEl,0,0,W,H); }
  const lineW=Math.max(1.5,W/420), fp=Math.max(15,W/40), R=Math.max(4,W/150);
  const pm=parseFloat($("pxmm").value); const labels=[];
  const fx=x=>(flip?(natW-x):x)*sc;
  const dot=(X,Y,col)=>{ c.fillStyle=col; c.beginPath(); c.arc(X,Y,R,0,7); c.fill(); c.strokeStyle="#fff"; c.lineWidth=Math.max(1,lineW*0.8); c.stroke(); };
  if(refX!=null){ const RX=fx(refX); c.strokeStyle=C_REF; c.lineWidth=lineW*1.3; c.setLineDash([]);
    c.beginPath(); c.moveTo(RX,0); c.lineTo(RX,H); c.stroke();
    labels.push({x:RX+4,y:3,text:"Midline",color:"#fff07a",align:"left",baseline:"top",ref:{type:"ref"}}); }
  points.forEach((p,i)=>{ const X=fx(p.x), Y=p.y*sc; let txt=p.label;
    if(refX!=null){ const RX=fx(refX); c.strokeStyle=C_LINE; c.lineWidth=lineW; c.setLineDash([6,4]);
      c.beginPath(); c.moveTo(RX,Y); c.lineTo(X,Y); c.stroke(); c.setLineDash([]);
      const opx=p.x-refX, side=opx<0?"L":(opx>0?"R":""); const dist=(pm>0)?(Math.abs(opx/pm).toFixed(1)+"mm"):(Math.abs(opx)+"px");
      txt=p.label+" ("+dist+(side?(" "+side):"")+")"; }
    dot(X,Y,C_PT); const ll=(refX!=null)?(X<fx(refX)):false;
    labels.push({x:ll?X-R-4:X+R+4,y:Y+fp*0.34,text:txt,color:C_PTL,align:ll?"right":"left",ref:{type:"pt",i:i}}); });
  const lg={}; levelPts.forEach(p=>{(lg[p.label]=lg[p.label]||{})[p.side]=p;});
  for(const lab in lg){ const g=lg[lab]; let lowerSide=null, distStr="";
    if(g.L&&g.R){ const dpx=Math.abs(g.L.y-g.R.y); distStr=(pm>0)?(Math.abs(dpx/pm).toFixed(1)+"mm"):(dpx+"px"); lowerSide=(g.L.y>g.R.y)?"L":"R"; }
    ["L","R"].forEach(s=>{ if(g[s]){ const X=fx(g[s].x),Y=g[s].y*sc;
      c.fillStyle=C_LEV; c.fillRect(X-R,Y-R,2*R,2*R); c.strokeStyle="#fff"; c.lineWidth=Math.max(1,lineW*0.8); c.strokeRect(X-R,Y-R,2*R,2*R);
      if(s===lowerSide && distStr) labels.push({x:X,y:Y-R-3,text:distStr,color:C_LEVL,align:"center",baseline:"bottom",ref:{type:"lev",label:lab}}); }});
    if(g.L&&g.R){ const hi=(g.L.y<=g.R.y)?g.L:g.R, lo=(g.L.y<=g.R.y)?g.R:g.L, hiY=hi.y*sc;
      const X1=Math.min(fx(g.L.x),fx(g.R.x)), X2=Math.max(fx(g.L.x),fx(g.R.x)), pad=(X2-X1)*0.12+R*2;
      c.strokeStyle=C_LEV; c.lineWidth=lineW*1.2; c.setLineDash([]); c.beginPath(); c.moveTo(X1-pad,hiY); c.lineTo(X2+pad,hiY); c.stroke();
      c.setLineDash([6,4]); c.beginPath(); c.moveTo(fx(lo.x),lo.y*sc); c.lineTo(fx(lo.x),hiY); c.stroke(); c.setLineDash([]); } }
  const rg={}; rotPts.forEach(p=>{(rg[p.label]=rg[p.label]||{})[p.role]=p;});
  for(const lab in rg){ const g=rg[lab];
    const inProg=(tool.indexOf("rot")===0 && lab===curVertebra);
    const sr=Math.max(1.5,R*0.45), dd=Math.max(1.8,R*0.5), lw=Math.max(0.6,lineW*0.4);
    if(g.SP){ const X=fx(g.SP.x), Y=g.SP.y*sc; c.fillStyle=C_PT; c.beginPath(); c.arc(X,Y,sr,0,7); c.fill(); c.strokeStyle="#fff"; c.lineWidth=Math.max(0.5,lw*0.8); c.stroke(); }
    ["LB","RB"].forEach(rl=>{ if(g[rl]){ const X=fx(g[rl].x),Y=g[rl].y*sc;
      c.fillStyle=C_ROT; c.beginPath(); c.moveTo(X,Y-dd); c.lineTo(X+dd,Y); c.lineTo(X,Y+dd); c.lineTo(X-dd,Y); c.closePath(); c.fill();
      c.strokeStyle="#fff"; c.lineWidth=Math.max(0.5,lw*0.8); c.stroke(); }});
    let rotTok="", distTok="", rightEdge=-1e9, anchorY=0;
    if(g.LB&&g.RB){ const cxv=(g.LB.x+g.RB.x)/2, cyv=(g.LB.y+g.RB.y)/2, halfW=Math.abs(g.RB.x-g.LB.x)/2;
      const CXD=fx(cxv), CYD=cyv*sc; anchorY=g.SP?(g.SP.y*sc):CYD;
      rightEdge=Math.max(fx(g.LB.x)+dd, fx(g.RB.x)+dd); if(g.SP) rightEdge=Math.max(rightEdge, fx(g.SP.x)+sr);
      if(!inProg){
        c.strokeStyle=C_ROT; c.lineWidth=lw; c.setLineDash([]); c.beginPath(); c.moveTo(fx(g.LB.x),g.LB.y*sc); c.lineTo(fx(g.RB.x),g.RB.y*sc); c.stroke();
        if(refX!=null){ const RX=fx(refX); c.strokeStyle=C_LINE; c.lineWidth=lw; c.setLineDash([5,3]); c.beginPath(); c.moveTo(RX,CYD); c.lineTo(CXD,CYD); c.stroke(); c.setLineDash([]);
          const opx=cxv-refX; const dist=(pm>0)?(Math.abs(opx/pm).toFixed(1)+"mm"):(Math.abs(opx)+"px"); distTok=dist+screenSide(cxv,refX); }
        if(g.SP){ const PXD=fx(g.SP.x), th=Math.max(3,R*0.85);
          c.strokeStyle="#fff"; c.lineWidth=lw; c.beginPath(); c.moveTo(CXD,CYD-th); c.lineTo(CXD,CYD+th); c.stroke();
          c.strokeStyle=C_ROT; c.lineWidth=Math.max(0.8,lw*1.5); c.beginPath(); c.moveTo(PXD,CYD-th); c.lineTo(PXD,CYD+th); c.stroke();
          const pct=halfW>0?(Math.abs(g.SP.x-cxv)/halfW*100):0; rotTok=pct.toFixed(0)+"%"+screenSide(g.SP.x,cxv); }
      }
    }
    if(!inProg && g.LB&&g.RB){ const txt=[lab,rotTok,distTok].filter(Boolean).join(" ");
      labels.push({x:rightEdge+16,y:anchorY+fp*0.34,text:txt,color:C_PTL,align:"left",ref:{type:"rot",label:lab}}); }
    else if(!inProg && g.SP && !g.LB && !g.RB){ const PXD=fx(g.SP.x), PYD=g.SP.y*sc; let dtok="";
      if(refX!=null){ const RX=fx(refX); c.strokeStyle=C_LINE; c.lineWidth=lw; c.setLineDash([5,3]); c.beginPath(); c.moveTo(RX,PYD); c.lineTo(PXD,PYD); c.stroke(); c.setLineDash([]);
        const opx=g.SP.x-refX; const dd2=(pm>0)?(Math.abs(opx/pm).toFixed(1)+"mm"):(Math.abs(opx)+"px"); dtok=dd2+screenSide(g.SP.x,refX); }
      labels.push({x:PXD+sr+12,y:PYD+fp*0.34,text:[lab,dtok].filter(Boolean).join(" "),color:C_PTL,align:"left",ref:{type:"rot",label:lab}}); }
  }
  if(pelvisPts.length){ const br={}; pelvisPts.forEach(p=>br[p.role]=p); const A=br.A,B=br.B,Cc=br.C;
    ["A","B","C"].forEach(rr=>{ const p=br[rr]; if(p){ dot(fx(p.x),p.y*sc,C_PEL); }});
    if(A&&B){ c.strokeStyle=C_PEL; c.lineWidth=lineW; c.setLineDash([]); c.beginPath(); c.moveTo(fx(A.x),A.y*sc); c.lineTo(fx(B.x),B.y*sc); c.stroke(); }
    if(A&&B&&Cc){ const abx=B.x-A.x, aby=B.y-A.y, ab2=abx*abx+aby*aby, ablen=Math.sqrt(ab2);
      const t=ab2>0?(((Cc.x-A.x)*abx+(Cc.y-A.y)*aby)/ab2):0; const Fx2=A.x+t*abx, Fy2=A.y+t*aby;
      c.setLineDash([6,4]); c.strokeStyle=C_PEL; c.lineWidth=lineW; c.beginPath(); c.moveTo(fx(Cc.x),Cc.y*sc); c.lineTo(fx(Fx2),Fy2*sc); c.stroke(); c.setLineDash([]);
      const perp=ablen>0?(Math.abs(abx*(Cc.y-A.y)-aby*(Cc.x-A.x))/ablen):0; const val=ablen>0?(perp/ablen):0;
      const mx=fx((A.x+B.x+Cc.x)/3), my=(A.y+B.y+Cc.y)/3*sc;
      labels.push({x:mx,y:my,text:val.toFixed(2),color:C_PEL,align:"center",ref:{type:"pelvis"}}); } }
  function drawSpan(kind){ const col=SPAN[kind].color, arr=spans[kind]; if(!arr.length) return;
    ["L","R"].forEach(side=>{ const a=arr.find(p=>p.side===side&&p.role==="a"), b=arr.find(p=>p.side===side&&p.role==="b");
      if(a) dot(fx(a.x),a.y*sc,col); if(b) dot(fx(b.x),b.y*sc,col);
      if(a&&!b){ c.strokeStyle=col; c.lineWidth=lineW; c.setLineDash([10,6]); c.beginPath(); c.moveTo(0,a.y*sc); c.lineTo(W,a.y*sc); c.stroke(); c.setLineDash([]); }
      if(a&&b){ c.strokeStyle=col; c.lineWidth=lineW*1.2; c.setLineDash([]); c.beginPath(); c.moveTo(fx(a.x),a.y*sc); c.lineTo(fx(b.x),b.y*sc); c.stroke();
        const dpx=Math.hypot(a.x-b.x,a.y-b.y); const ds=(pm>0)?(dpx/pm).toFixed(1)+"mm":Math.round(dpx)+"px";
        const mx=fx((a.x+b.x)/2), my=(a.y+b.y)/2*sc;
        labels.push({x:mx,y:my-R-3,text:ds,color:col,align:"center",baseline:"bottom",ref:{type:"span",kind:kind,side:side}}); } }); }
  drawSpan("obt"); drawSpan("ltr");
  // ---- Cobb's angle ----
  cobbs.forEach((cb,ci)=>{
    const drawLine=(ln,col)=>{ if(ln&&ln.a&&ln.b){ const X1=fx(ln.a.x),Y1=ln.a.y*sc,X2=fx(ln.b.x),Y2=ln.b.y*sc;
      // 종판 선을 양옆으로 연장
      let dx=X2-X1, dy=Y2-Y1; const L=Math.hypot(dx,dy)||1; dx/=L; dy/=L; const ext=Math.max(W,H);
      c.strokeStyle=col; c.lineWidth=lineW*1.2; c.setLineDash([]);
      c.beginPath(); c.moveTo(X1-dx*ext,Y1-dy*ext); c.lineTo(X2+dx*ext,Y2+dy*ext); c.stroke();
      dot(X1,Y1,col); dot(X2,Y2,col); }
      else if(ln&&ln.a){ dot(fx(ln.a.x),ln.a.y*sc,col); } };
    drawLine(cb.l0,C_COBB); drawLine(cb.l1,C_COBB);
    if(cb.l0&&cb.l0.a&&cb.l0.b&&cb.l1&&cb.l1.a&&cb.l1.b){
      // 원본좌표 기준 각도 (flip 무관: 두 선 사이 사잇각)
      const a0=Math.atan2(cb.l0.b.y-cb.l0.a.y, cb.l0.b.x-cb.l0.a.x);
      const a1=Math.atan2(cb.l1.b.y-cb.l1.a.y, cb.l1.b.x-cb.l1.a.x);
      let ang=Math.abs(a0-a1)*180/Math.PI; ang=ang%180; if(ang>90) ang=180-ang;
      // 두 선의 교점(연장선)에서 수선/라벨 표시
      const m0x=(cb.l0.a.x+cb.l0.b.x)/2, m0y=(cb.l0.a.y+cb.l0.b.y)/2;
      const m1x=(cb.l1.a.x+cb.l1.b.x)/2, m1y=(cb.l1.a.y+cb.l1.b.y)/2;
      // 두 종판 중점에 수선(perpendicular) 짧게 표시
      const perp=(mx,my,ax,ay,bx,by,col)=>{ let dx=bx-ax,dy=by-ay; const l=Math.hypot(dx,dy)||1; dx/=l;dy/=l;
        const px=-dy,py=dx; const len=Math.max(W,H)*0.10;
        c.strokeStyle=col; c.lineWidth=lineW*0.9; c.setLineDash([5,4]);
        c.beginPath(); c.moveTo(fx(mx),my*sc); c.lineTo(fx(mx)+ (flip?-px:px)*len, my*sc+py*len); c.stroke(); c.setLineDash([]); };
      perp(m0x,m0y,cb.l0.a.x,cb.l0.a.y,cb.l0.b.x,cb.l0.b.y,C_COBB);
      perp(m1x,m1y,cb.l1.a.x,cb.l1.a.y,cb.l1.b.x,cb.l1.b.y,C_COBB);
      const lx=fx((m0x+m1x)/2), ly=((m0y+m1y)/2)*sc;
      labels.push({x:lx,y:ly,text:"Cobb "+ang.toFixed(1)+"°",color:C_COBB,align:"center",ref:{type:"cobb",i:ci}});
    }
  });
  /* ---------- 측면(시상면) 정렬 작도 ---------- */
  if(sag.mode){
    const p=sag.pts; const C7=sagC7center();
    const drawV=(X,col)=>{ const sx0=fx(X); c.strokeStyle=col; c.lineWidth=lineW*1.2; c.setLineDash([7,5]);
      c.beginPath(); c.moveTo(sx0,0); c.lineTo(sx0,H); c.stroke(); c.setLineDash([]); };
    const drawSeg=(a,b,col)=>{ c.strokeStyle=col; c.lineWidth=lineW; c.setLineDash([]);
      c.beginPath(); c.moveTo(fx(a.x),a.y*sc); c.lineTo(fx(b.x),b.y*sc); c.stroke(); };
    const drawHoriz=(fromX,fromY,toX,col)=>{ c.strokeStyle=col; c.lineWidth=lineW; c.setLineDash([4,3]);
      c.beginPath(); c.moveTo(fx(fromX),fromY*sc); c.lineTo(fx(toX),fromY*sc); c.stroke(); c.setLineDash([]); };
    const M=sagMetrics();
    // C7 종판선
    if(p.C7_ua&&p.C7_up) drawSeg(p.C7_ua,p.C7_up,"#3fd0ff");
    if(p.C7_la&&p.C7_lp) drawSeg(p.C7_la,p.C7_lp,"#3fd0ff");
    // C2 하종판선 (complex)
    if(p.C2_la&&p.C2_lp) drawSeg(p.C2_la,p.C2_lp,"#9d7cff");
    // T1·L1·S1 종판선
    if(p.T1_a&&p.T1_p) drawSeg(p.T1_a,p.T1_p,"#ffd166");
    if(p.L1_a&&p.L1_p) drawSeg(p.L1_a,p.L1_p,"#ff9d3c");
    if(p.S1_a&&p.S1_p) drawSeg(p.S1_a,p.S1_p,"#ff5da2");
    // cSVA 수직선 (C2 기준) + 수평 편위 (도착점 = C7 중심)
    if(p.C2){ drawV(p.C2.x,C_SAGV);
      if(C7) drawHoriz(p.C2.x, C7.y, C7.x, C_SAGV);
      if(C7){ const lx=fx((p.C2.x+C7.x)/2), ly=C7.y*sc; if(M.csvaMm!=null) labels.push({x:lx,y:ly-6,text:"cSVA "+M.csvaMm.toFixed(1)+"mm",color:C_SAGV,align:"center",baseline:"bottom",ref:{type:"sag"}}); } }
    // SVA 수직선 (C7 중심 기준) + 수평 편위
    if(C7){ drawV(C7.x,C_SAG); dot(fx(C7.x),C7.y*sc,C_SAG);
      if(p.S1_p){ drawHoriz(C7.x, p.S1_p.y, p.S1_p.x, C_SAG);
        const lx=fx((C7.x+p.S1_p.x)/2), ly=p.S1_p.y*sc; if(M.svaMm!=null) labels.push({x:lx,y:ly+6,text:"SVA "+M.svaMm.toFixed(1)+"mm",color:C_SAG,align:"center",baseline:"top",ref:{type:"sag"}}); } }
    // 대퇴골두 중심 - 종판중점 선 (PT)
    const FHc=sagFH();
    if(FHc&&p.S1_a&&p.S1_p){ const mid=midpt(p.S1_a,p.S1_p); drawSeg(FHc,mid,"#62d0c0");
      drawV(mid.x,"#62d0c055"); }
    // 비구 전·후연을 잇는 짧은 선 + 중심점(대퇴골두 중심)
    if(p.AC_a&&p.AC_p){ drawSeg(p.AC_a,p.AC_p,"#62d0c0");
      if(FHc) dot(fx(FHc.x),FHc.y*sc,"#9be7da"); }
    // 각도 지표 라벨 (Complex) — 각 요소 근처에 배치
    if(M.pt!=null && FHc){ labels.push({x:fx(FHc.x),y:FHc.y*sc-6,text:"PT "+M.pt.toFixed(1)+"°",color:"#62d0c0",align:"center",baseline:"bottom",ref:{type:"sag"}}); }
    if(M.t1sCl!=null && p.T1_a && p.T1_p){ const mx=(p.T1_a.x+p.T1_p.x)/2, my=(p.T1_a.y+p.T1_p.y)/2; labels.push({x:fx(mx),y:my*sc-6,text:"T1S−CL "+M.t1sCl.toFixed(1)+"°",color:"#ffd166",align:"center",baseline:"bottom",ref:{type:"sag"}}); }
    if(M.piLl!=null && p.L1_a && p.L1_p){ const mx=(p.L1_a.x+p.L1_p.x)/2, my=(p.L1_a.y+p.L1_p.y)/2; labels.push({x:fx(mx),y:my*sc-6,text:"PI−LL "+M.piLl.toFixed(1)+"°",color:"#ff9d3c",align:"center",baseline:"bottom",ref:{type:"sag"}}); }
    if(M.ll!=null && p.S1_a && p.S1_p){ const mx=(p.S1_a.x+p.S1_p.x)/2; labels.push({x:fx(mx),y:p.S1_p.y*sc-18,text:"LL "+M.ll.toFixed(1)+"°",color:"#ff5da2",align:"center",baseline:"bottom",ref:{type:"sag"}}); }
    // 점 찍기 + 라벨
    const seq=sag.mode?SAG_SEQ[sag.mode]:[];
    seq.forEach((s)=>{ const q=p[s.key]; if(!q) return; dot(fx(q.x),q.y*sc,C_SAG); });
    // 진행 중인 다음 점 안내 라벨은 상태표시줄에서 처리
  }
  calPts.forEach(p=>{ dot(fx(p[0]),p[1]*sc,C_CAL); });
  drawLabelsNoOverlap(c, labels, fp, interactive);
  const pinfo=($("patientInfo")&&$("patientInfo").value||"").trim();
  if(pinfo){ const pf=Math.max(14,W/44); c.font="bold "+pf+"px sans-serif";
    const m=Math.max(8,W/90);
    c.textAlign="left"; c.textBaseline="top"; otext(c,pinfo,m,m,"#ffffff",pf);
    c.textAlign="left"; c.textBaseline="alphabetic"; }
}
function layout(){ if(!imgEl) return;
  const pane=document.documentElement.classList.contains("panemode");
  let baseW;
  if(fitMode){
    const main=$("main");
    if(pane && main){
      // 패널모드: #main의 실제 가용 영역에 꽉 맞춤(스크롤 없음)
      const availW=Math.max(80, main.clientWidth - 12);
      const availH=Math.max(80, main.clientHeight - 12);
      const s=Math.max(0.05, Math.min(availW/natW, availH/natH)); baseW=natW*s;
    } else {
      const availW=Math.max(120,(main?main.clientWidth:window.innerWidth*0.55)-24);
      const sh=$("status").offsetHeight||0; const topChrome=sh+18;
      const availH=Math.max(120, window.innerHeight - topChrome - 8);
      const s=Math.max(0.05, Math.min(availW/natW, availH/natH)); baseW=natW*s;
    }
  } else {
    if(pane){ const main=$("main"); const w=(main?main.clientWidth:window.innerWidth)-12; baseW=Math.max(80,w)*zoom; }
    else baseW=Math.min(window.innerWidth*0.55,900)*zoom;
  }
  drawW=baseW; scale=drawW/natW; drawH=natH*scale; cv.width=drawW; cv.height=drawH; redraw(); updStatus(); }
function redraw(){ if(!imgEl) return; drawScene(ctx,scale,true); renderTable(); renderLevels(); renderRot(); renderMeasures(); renderReport(); if(typeof reportMetrics==="function") reportMetrics(); }

function renderTable(){ const pm=parseFloat($("pxmm").value), tb=document.querySelector("#tbl tbody"); tb.innerHTML="";
  const rows=[]; points.forEach(p=>rows.push({label:p.label,x:p.x,y:p.y}));
  const rg={}; rotPts.forEach(p=>{(rg[p.label]=rg[p.label]||{})[p.role]=p;});
  Object.keys(rg).forEach(lab=>{ const g=rg[lab]; if(g.LB&&g.RB) rows.push({label:lab+" 중앙",x:Math.round((g.LB.x+g.RB.x)/2),y:Math.round((g.LB.y+g.RB.y)/2)}); });
  rows.forEach((p,i)=>{ const op=(refX!=null)?(p.x-refX):null; const om=(op!=null&&pm>0)?(op/pm).toFixed(1):"";
    const tr=document.createElement("tr");
    tr.innerHTML="<td>"+(i+1)+"</td><td class=l>"+p.label+"</td><td>"+p.x+"</td><td>"+p.y+"</td><td>"+(op!=null?op:"")+"</td><td>"+om+"</td>";
    tb.appendChild(tr); }); }
function renderLevels(){ const pm=parseFloat($("pxmm").value), lg={}; levelPts.forEach(p=>{(lg[p.label]=lg[p.label]||{})[p.side]=p;});
  const tb=document.querySelector("#levtbl tbody"); tb.innerHTML="";
  Object.keys(lg).forEach(lab=>{ const g=lg[lab], L=g.L, Rp=g.R; let dpx="",dmm="",low="";
    if(L&&Rp){ const d=Math.abs(L.y-Rp.y); dpx=d; dmm=(pm>0)?(d/pm).toFixed(1):""; low=(L.y>Rp.y)?"L":"R"; }
    const tr=document.createElement("tr");
    tr.innerHTML="<td class=l>"+lab+"</td><td>"+(L?L.x+","+L.y:"-")+"</td><td>"+(Rp?Rp.x+","+Rp.y:"-")+"</td><td>"+dpx+"</td><td>"+dmm+"</td><td>"+low+"</td>";
    tb.appendChild(tr); }); }
function renderRot(){ const rg={}; rotPts.forEach(p=>{(rg[p.label]=rg[p.label]||{})[p.role]=p;});
  const tb=document.querySelector("#rottbl tbody"); tb.innerHTML="";
  Object.keys(rg).forEach(lab=>{ const g=rg[lab]; let w="",pc="",dir="";
    if(g.LB&&g.RB&&g.SP){ const cx=(g.LB.x+g.RB.x)/2, halfW=Math.abs(g.RB.x-g.LB.x)/2;
      w=Math.round(Math.abs(g.RB.x-g.LB.x)); const pct=halfW>0?(Math.abs(g.SP.x-cx)/halfW*100):0; pc=pct.toFixed(0)+"%"; dir=screenSide(g.SP.x,cx)||"중립"; }
    else { const n=["LB","RB","SP"].filter(r=>g[r]).length; dir=n+"/3 점"; }
    const tr=document.createElement("tr"); tr.innerHTML="<td class=l>"+lab+"</td><td>"+w+"</td><td>"+pc+"</td><td>"+dir+"</td>"; tb.appendChild(tr); }); }
function spanDist(kind,side){ const pm=parseFloat($("pxmm").value); const arr=spans[kind];
  const a=arr.find(p=>p.side===side&&p.role==="a"), b=arr.find(p=>p.side===side&&p.role==="b");
  if(a&&b){ const d=Math.hypot(a.x-b.x,a.y-b.y); return (pm>0)?(d/pm).toFixed(1)+"mm":Math.round(d)+"px"; } return ""; }
function renderMeasures(){ const tb=document.querySelector("#mtbl tbody"); tb.innerHTML="";
  let pv=""; const br={}; pelvisPts.forEach(p=>br[p.role]=p);
  if(br.A&&br.B&&br.C){ const A=br.A,B=br.B,Cc=br.C; const abx=B.x-A.x,aby=B.y-A.y,ablen=Math.hypot(abx,aby);
    const perp=ablen>0?Math.abs(abx*(Cc.y-A.y)-aby*(Cc.x-A.x))/ablen:0; pv=ablen>0?(perp/ablen).toFixed(2):""; }
  const rows=[["골반강 비율","","",pv],["폐쇄공",spanDist("obt","L"),spanDist("obt","R"),""],["LT-IR",spanDist("ltr","L"),spanDist("ltr","R"),""]];
  rows.forEach(r=>{ const tr=document.createElement("tr"); tr.innerHTML="<td class=l>"+r[0]+"</td><td>"+r[1]+"</td><td>"+r[2]+"</td><td>"+r[3]+"</td>"; tb.appendChild(tr); });
  cobbs.forEach((cb,i)=>{ const a=cobbAngle(cb); if(a!=null){ const tr=document.createElement("tr"); tr.innerHTML="<td class=l>Cobb's angle"+(cobbs.length>1?(" #"+(i+1)):"")+"</td><td></td><td></td><td>"+a.toFixed(1)+"°</td>"; tb.appendChild(tr); } }); }

const VORDER=["C2","C3","C4","C5","C6","C7","T1","T2","T3","T4","T5","T6","T7","T8","T9","T10","T11","T12","L1","L2","L3","L4","L5","S1","S2","Coccyx"];
const LEVEN={"하악각":"Mandibular angle","쇄골":"Clavicle","오훼돌기":"Coracoid","장골능":"Iliac crest","천골기저부":"Sacral base","대퇴골두":"Femoral head"};
/* ===== 시상면(sagittal) 지표 정상범위 + 해석 (report·analyze 공유) =====
   normLo/normHi: 정상범위(절대값 기준 또는 부호 포함). absMode면 |값| 비교.
   pro: 전문가용 한 줄 해석. kid: 초등학생도 이해할 쉬운 설명. */
const SAG_REF={
  "SVA":   {unit:"mm", normHi:50,  absMode:true,  pro:"전신 시상면 균형. C7 수직선과 S1 후상연의 수평거리. +50mm 초과 시 양성 불균형(전방 쏠림), 통증·기능장애와 상관.", kid:"몸 전체가 옆에서 봤을 때 앞으로 얼마나 쏠렸는지예요. 숫자가 작을수록 똑바로 서 있는 거예요."},
  "cSVA":  {unit:"mm", normHi:40,  absMode:true,  pro:"경추 균형(C2–C7). 두부 전방 편위 정도. +40mm 초과 시 거북목 정렬, 목 신전근 부하 증가.", kid:"머리가 어깨보다 얼마나 앞으로 나왔는지예요. 작을수록 거북목이 아니에요."},
  "PI\u2212LL":{unit:"\u00b0", normLo:-9, normHi:9, absMode:true, pro:"골반이 요구하는 전만 대비 실제 요추전만의 부족분. |9°| 초과 시 요추 전만 소실, 보상기전 가동·인접분절 부담.", kid:"허리가 살짝 휘어 있어야 하는 만큼 잘 휘었는지예요. 0에 가까울수록 좋아요."},
  "PT":    {unit:"\u00b0", normHi:20,  absMode:true,  pro:"골반 후방경사(보상). 20° 초과 시 요추전만 소실을 골반으로 보상 중, 보상여력 감소 신호.", kid:"골반을 뒤로 젖혀서 버티고 있는 정도예요. 작을수록 편하게 서 있는 거예요."},
  "T1S\u2212CL":{unit:"\u00b0", normHi:20, absMode:true, pro:"T1 기울기 대비 경추전만 부족분. 20° 초과 시 경추 보상 부족, 두부 전방 편위 유발.", kid:"목이 받쳐주는 만큼 잘 휘었는지예요. 작을수록 목이 편한 상태예요."},
  "LL":    {unit:"\u00b0", normLo:40, normHi:60, absMode:false, pro:"요추 전만각(L1–S1). 정상 약 40–60°. 개인 PI에 따라 적정값이 달라짐.", kid:"허리가 안쪽으로 휜 정도예요. 너무 펴지거나 너무 휘지 않은 게 좋아요."},
  "SS":    {unit:"\u00b0", pro:"천골 경사. PI=PT+SS 관계의 구성요소.", kid:"엉치뼈가 기울어진 정도예요."},
  "PI":    {unit:"\u00b0", pro:"골반 형태 상수(불변). 개인의 요추전만 요구량을 결정.", kid:"타고난 골반 모양이에요. 사람마다 달라요."},
  "T1 slope":{unit:"\u00b0", pro:"T1 상종판 기울기. 경추가 메워야 할 보상 요구량.", kid:"목을 받치는 받침대가 기운 정도예요."},
  "CL":    {unit:"\u00b0", pro:"경추 전만각(C2–C7). 측정법(Cobb/Harrison)에 따라 값 차이.", kid:"목이 안쪽으로 휜 정도예요."}
};
// 정상 여부 판정: true=정상, false=벗어남, null=기준 없음
function sagInRange(label, value){ const r=SAG_REF[label]; if(!r||value==null) return null;
  if(r.absMode){ const a=Math.abs(value);
    if(r.normHi!=null && a>r.normHi) return false;
    if(r.normLo!=null && r.normHi!=null && (value<r.normLo||value>r.normHi)) return (value>=r.normLo&&value<=r.normHi);
    return true; }
  if(r.normLo!=null && value<r.normLo) return false;
  if(r.normHi!=null && value>r.normHi) return false;
  if(r.normLo==null && r.normHi==null) return null;
  return true; }
// 정상범위 텍스트
function sagRangeText(label){ const r=SAG_REF[label]; if(!r) return ""; const u=r.unit||"";
  if(r.absMode && r.normHi!=null && r.normLo==null) return "정상 |값| < "+r.normHi+u;
  if(r.normLo!=null && r.normHi!=null) return "정상 "+r.normLo+"~"+r.normHi+u;
  if(r.normHi!=null) return "정상 < "+r.normHi+u;
  return ""; }

/* 비교 그래프용 측정값 추출 (label → {value,unit,goodLow}) */
function getMetrics(){
  const pm=parseFloat($("pxmm").value); const out={};
  const lg={}; levelPts.forEach(p=>{(lg[p.label]=lg[p.label]||{})[p.side]=p;});
  const rg={}; rotPts.forEach(p=>{(rg[p.label]=rg[p.label]||{})[p.role]=p;});
  // 1) 중심선(치골결합 수직선) 거리 — 라벨 포인트 + 회전 SP의 좌우 편위 (0에 가까울수록 정상)
  if(refX!=null){
    points.forEach(p=>{ const off=Math.abs(p.x-refX); const mm=(pm>0)?(off/pm):off; out[(p.label||"점")+" 중심선거리"]={value:+mm.toFixed(1),unit:(pm>0?"mm":"px"),goodLow:true}; });
    Object.keys(rg).forEach(lab=>{ const g=rg[lab]; const cxv=(g.LB&&g.RB)?((g.LB.x+g.RB.x)/2):(g.SP?g.SP.x:null); if(cxv!=null){ const off=Math.abs(cxv-refX); const mm=(pm>0)?(off/pm):off; out[lab+" 중심선거리"]={value:+mm.toFixed(1),unit:(pm>0?"mm":"px"),goodLow:true}; } });
  }
  // 2) 척추 회전 편위 % (낮을수록 좋음)
  Object.keys(rg).forEach(lab=>{ const g=rg[lab]; if(g.LB&&g.RB&&g.SP){ const cx=(g.LB.x+g.RB.x)/2, halfW=Math.abs(g.RB.x-g.LB.x)/2; if(halfW>0){ const pct=Math.abs(g.SP.x-cx)/halfW*100; out[lab+" 회전"]={value:+pct.toFixed(0),unit:"%",goodLow:true}; } } });
  // 3) 높이비교 좌우차 (낮을수록 좋음)
  Object.keys(lg).forEach(lab=>{ const g=lg[lab]; if(g.L&&g.R){ const d=Math.abs(g.L.y-g.R.y); const mm=(pm>0)?(d/pm):d; out[(LEVEN[lab]||lab)+" 좌우차"]={value:+mm.toFixed(1),unit:(pm>0?"mm":"px"),goodLow:true}; } });
  // 4) 골반강 비율
  const br={}; pelvisPts.forEach(p=>br[p.role]=p);
  if(br.A&&br.B&&br.C){ const A=br.A,B=br.B,Cc=br.C; const ax=B.x-A.x,ay=B.y-A.y,al=Math.hypot(ax,ay); const pp=al>0?Math.abs(ax*(Cc.y-A.y)-ay*(Cc.x-A.x))/al:0; if(al>0) out["골반강 비율"]={value:+(pp/al).toFixed(2),unit:"",goodLow:false}; }
  // 5) 폐쇄공/LT-IR 좌우차 (낮을수록 좋음)
  [["obt","폐쇄공"],["ltr","LT-IR"]].forEach(kn=>{ const dl=spanRaw(kn[0],"L"), dr=spanRaw(kn[0],"R"); if(dl!=null&&dr!=null){ const d=Math.abs(dl-dr); const mm=(pm>0)?(d/pm):d; out[kn[1]+" 좌우차"]={value:+mm.toFixed(1),unit:(pm>0?"mm":"px"),goodLow:true}; } });
  // 6) Cobb angle (낮을수록 좋음, 0=정상)
  cobbs.forEach((cb,i)=>{ const a=cobbAngle(cb); if(a!=null){ out["Cobb"+(cobbs.length>1?(" #"+(i+1)):"")]={value:+a.toFixed(1),unit:"°",goodLow:true}; } });
  // 측면(시상면) 정렬 지표 (정상범위 normHi/normLo/absMode 동반)
  if(sag.mode){ const M=sagMetrics();
    const add=(lab,val,unit)=>{ if(val==null) return; const r=SAG_REF[lab]||{};
      out[lab]={value:+val.toFixed(1),unit:unit,goodLow:true,normHi:(r.normHi!=null?r.normHi:null),normLo:(r.normLo!=null?r.normLo:null),absMode:!!r.absMode}; };
    add("SVA",M.svaMm,"mm"); add("cSVA",M.csvaMm,"mm");
    add("PI\u2212LL",M.piLl,"\u00b0"); add("PT",M.pt,"\u00b0"); add("T1S\u2212CL",M.t1sCl,"\u00b0");
    if(M.ll!=null) out["LL"]={value:+M.ll.toFixed(1),unit:"\u00b0",goodLow:false,normLo:40,normHi:60,absMode:false};
  }
  return out;
}
function reportMetrics(){ const h=(window.JSHA_MODE==="annot"&&window.__CMP_HOST__)?window.__CMP_HOST__():null;
  if(h){ try{ h.postMessage({type:"cmp-metrics", paneId:window.__CMP_PANE__, name:sourceName, patient:curDicomPat, manual:($("patientInfo").value||""), metrics:getMetrics()},"*"); }catch(_){ } } }
function vsort(a,b){ const ia=VORDER.indexOf(a),ib=VORDER.indexOf(b); return (ia<0?999:ia)-(ib<0?999:ib); }
function rFmt(px){ const pm=parseFloat($("pxmm").value); return (pm>0)?((px/pm).toFixed(1)+"mm"):(Math.round(px)+"px"); }
function spanRaw(kind,side){ const arr=spans[kind]; const a=arr.find(p=>p.side===side&&p.role==="a"), b=arr.find(p=>p.side===side&&p.role==="b"); if(a&&b) return Math.hypot(a.x-b.x,a.y-b.y); return null; }
function buildReportText(){
  const o=[];
  const rg={}; rotPts.forEach(p=>{(rg[p.label]=rg[p.label]||{})[p.role]=p;});
  o.push("Coronal (body-center vs midline):");
  const bcL=Object.keys(rg).filter(k=>rg[k].LB&&rg[k].RB).sort(vsort);
  if(refX==null) o.push("  midline not set");
  else if(!bcL.length) o.push("  none");
  else { let mx=null;
    bcL.forEach(l=>{ const g=rg[l]; const cx=(g.LB.x+g.RB.x)/2, op=cx-refX, s=screenSide(cx,refX);
      o.push("  "+l+":  "+(op===0?"on midline":(rFmt(Math.abs(op))+" "+s))); if(mx==null||Math.abs(op)>Math.abs(mx.o)) mx={l:l,o:op,cx:cx}; });
    if(mx&&mx.o!==0) o.push("  Max: "+mx.l+" "+rFmt(Math.abs(mx.o))+" "+screenSide(mx.cx,refX)); }
  const rotL=Object.keys(rg).filter(k=>rg[k].LB&&rg[k].RB&&rg[k].SP).sort(vsort);
  if(rotL.length){ o.push("Rotation (SP method, qualitative):");
    rotL.forEach(l=>{ const g=rg[l]; const cx=(g.LB.x+g.RB.x)/2, hw=Math.abs(g.RB.x-g.LB.x)/2; const pc=hw>0?(Math.abs(g.SP.x-cx)/hw*100):0; const s=screenSide(g.SP.x,cx);
      o.push("  "+l+":  "+(s===""?"neutral":(pc.toFixed(0)+"% "+s))); }); }
  const lg={}; levelPts.forEach(p=>{(lg[p.label]=lg[p.label]||{})[p.side]=p;});
  const levL=Object.keys(lg).filter(k=>lg[k].L&&lg[k].R);
  if(levL.length){ o.push("Height (L/R):");
    levL.forEach(l=>{ const g=lg[l]; const d=Math.abs(g.L.y-g.R.y); const hi=(g.L.y<g.R.y)?"L":(g.L.y>g.R.y)?"R":"=";
      o.push("  "+(LEVEN[l]||l)+":  "+(d===0?"equal":(rFmt(d)+" "+hi+" higher"))); }); }
  const br={}; pelvisPts.forEach(p=>br[p.role]=p);
  if(br.A&&br.B&&br.C){ const A=br.A,B=br.B,C=br.C; const ax=B.x-A.x,ay=B.y-A.y,al=Math.hypot(ax,ay); const pp=al>0?Math.abs(ax*(C.y-A.y)-ay*(C.x-A.x))/al:0; const r=al>0?(pp/al):0;
    o.push("Pelvic ratio: "+r.toFixed(2)); }
  [["obt","Obturator"],["ltr","LT-IR"]].forEach(kn=>{ const dl=spanRaw(kn[0],"L"), dr=spanRaw(kn[0],"R");
    if(dl==null&&dr==null) return;
    let s=kn[1]+": L "+(dl!=null?rFmt(dl):"—")+" / R "+(dr!=null?rFmt(dr):"—");
    if(dl!=null&&dr!=null){ const df=Math.abs(dl-dr); s+=(df===0?" (equal)":" (\u0394"+rFmt(df)+" "+(dl>dr?"L":"R")+")"); }
    o.push(s); });
  const cbDone=cobbs.filter(cobbComplete);
  if(cbDone.length){ o.push("Cobb's angle:");
    cbDone.forEach((cb,i)=>{ o.push("  "+(cbDone.length>1?("#"+(i+1)+": "):"")+cobbAngle(cb).toFixed(1)+"\u00b0"); }); }
  if(sag.mode){
    const M=sagMetrics(); const pm=parseFloat($("pxmm").value);
    o.push(""); o.push("【옆에서 본 척추·자세 검사】");
    // 쉬운 한 줄: 이름 / 값 / 상태(텍스트) / 정상범위 / 설명
    const mark=(ok)=> ok===true?"— 정상 범위예요":(ok===false?"— 조금 살펴봐요":"");
    const line=(easyName, val, unit, ok, rangeTxt, kid)=>{
      if(val==null) return;
      o.push("• "+easyName+": "+(val>0?"+":"")+(+val).toFixed(0)+unit+"  "+mark(ok));
      o.push("   ("+kid+(rangeTxt?(" / "+rangeTxt):"")+")");
    };
    const absOK=(v,hi)=> v==null?null:(Math.abs(v)<=hi);
    if(M.svaMm!=null) line("몸이 앞으로 쏠린 정도", M.svaMm, "mm", absOK(M.svaMm,50), "정상 50mm 이내",
      "옆에서 봤을 때 몸 전체가 앞으로 얼마나 기울었는지예요. 작을수록 똑바로 서 있어요");
    if(M.csvaMm!=null) line("목(머리)이 앞으로 나온 정도", M.csvaMm, "mm", absOK(M.csvaMm,40), "정상 40mm 이내",
      "머리가 어깨보다 얼마나 앞으로 나왔는지예요. 작을수록 거북목이 아니에요");
    if(M.piLl!=null) line("허리가 알맞게 휜 정도", M.piLl, "°", absOK(M.piLl,9), "정상 9° 이내",
      "허리가 휘어야 하는 만큼 잘 휘었는지예요. 0에 가까울수록 좋아요");
    if(M.pt!=null) line("골반이 뒤로 젖혀 버티는 정도", M.pt, "°", absOK(M.pt,20), "정상 20° 이내",
      "골반을 뒤로 젖혀 억지로 버티고 있는 정도예요. 작을수록 편하게 서 있어요");
    if(M.t1sCl!=null) line("목이 알맞게 휜 정도", M.t1sCl, "°", absOK(M.t1sCl,20), "정상 20° 이내",
      "목이 받쳐주는 만큼 잘 휘었는지예요. 작을수록 목이 편해요");
    // 종합 한마디(쉬운말)
    const warn=[];
    if(M.svaMm!=null&&Math.abs(M.svaMm)>50) warn.push("몸이 앞으로 쏠림");
    if(M.csvaMm!=null&&Math.abs(M.csvaMm)>40) warn.push("거북목");
    if(M.piLl!=null&&Math.abs(M.piLl)>9) warn.push("허리 휨이 부족");
    if(M.pt!=null&&M.pt>20) warn.push("골반이 버티는 중");
    if(M.t1sCl!=null&&Math.abs(M.t1sCl)>20) warn.push("목 휨이 부족");
    o.push("");
    o.push("👉 "+(warn.length? ("조금 살펴볼 점: "+warn.join(", ")+". 바른 자세 운동과 치료로 좋아질 수 있어요."):"전체적으로 자세가 좋은 편이에요. 지금처럼 유지해요!"));
    if(pm<=0||isNaN(pm)) o.push("(※ mm 숫자는 사진 보정(px/mm)이 되어야 정확히 나와요)");
  }
  return o.join("\n");
}
function renderReport(){ const el=$("report"); if(el) el.textContent = imgEl ? buildReportText() : "Load an image and mark points — the report appears here."; }

function hitTestLabel(px,py){ for(let i=labelHits.length-1;i>=0;i--){ const b=labelHits[i]; if(px>=b.x1&&px<=b.x2&&py>=b.y1&&py<=b.y2) return b; } return null; }
cv.addEventListener("click",e=>{
  if(!imgEl) return;
  // 주석 잠금: 그리기 도구 동작 차단. 단 'point'(라벨 선택/이동 보기)는 통과시켜 기존 작도 확인 가능.
  if(annLocked && tool && tool!=="point"){ setStatus("🔒 주석이 잠겨 있습니다.","#ffb454"); return; }
  const r=cv.getBoundingClientRect(); const sx=cv.width/r.width, sy=cv.height/r.height;
  const rawX=(e.clientX-r.left)*sx, rawY=(e.clientY-r.top)*sy;
  let x=Math.round(rawX/scale), y=Math.round(rawY/scale); if(flip) x=natW-x;
  if(tool==="ref"){ pushHist(); refX=x; setTool("point"); redraw(); return; }
  if(tool==="cobb2"){
    // 이미 LB·RB가 찍힌 척추 중 클릭 위치에서 가장 가까운 것을 선택
    const rg={}; rotPts.forEach(p=>{(rg[p.label]=rg[p.label]||{})[p.role]=p;});
    const cands=Object.keys(rg).filter(k=>rg[k].LB&&rg[k].RB);
    if(!cands.length){ setStatus("Measure the left/right vertebral borders (LB·RB) first via [Vertebra rotation].","#ff6b6b"); return; }
    let best=null,bd=1e9;
    cands.forEach(k=>{ const g=rg[k]; const cx=(g.LB.x+g.RB.x)/2, cy=(g.LB.y+g.RB.y)/2; const d=Math.hypot(cx-x,cy-y); if(d<bd){bd=d;best=k;} });
    if(!cobb2Pick) cobb2Pick=[];
    if(cobb2Pick.indexOf(best)<0) cobb2Pick.push(best);
    if(cobb2Pick.length>=2){
      const A=cobb2Pick[0], B=cobb2Pick[1];
      const ga=rg[A], gb=rg[B];
      pushHist();
      cobbs.push({ l0:{a:{x:ga.LB.x,y:ga.LB.y}, b:{x:ga.RB.x,y:ga.RB.y}},
                   l1:{a:{x:gb.LB.x,y:gb.LB.y}, b:{x:gb.RB.x,y:gb.RB.y}},
                   from:"vertebra", v0:A, v1:B });
      cobb2Pick=null; setTool("point");
    }
    redraw(); updStatus(); return; }
  if(tool.indexOf("rot")===0){ const role=tool.slice(3); pushHist(); rotPts.push({label:curVertebra,role:role,x:x,y:y});
    if(SINGLE_SP.has(curVertebra)){ setTool("point"); redraw(); updStatus(); return; }
    const ord=["LB","SP","RB"], i=ord.indexOf(role); setTool(i<2?"rot"+ord[i+1]:"point"); redraw(); updStatus(); return; }
  if(tool==="levL"||tool==="levR"){ const side=tool==="levL"?"L":"R"; const lab=curLevel; pushHist(); levelPts.push({label:lab,side:side,x:x,y:y});
    setTool(side==="L"?"levR":"point"); redraw(); updStatus(); return; }
  if(tool.indexOf("pel")===0){ const role=tool.slice(3); pushHist(); pelvisPts.push({role:role,x:x,y:y});
    setTool({A:"pelB",B:"pelC",C:"point"}[role]); redraw(); updStatus(); return; }
  if(tool.indexOf("cobb:")===0){ const code=tool.split(":")[1]; const li=+code[0], pt=code[1];
    pushHist();
    if(li===0&&pt==="a"){ cobbs.push({l0:{a:{x,y}},l1:{}}); }
    else { let cb=cobbs[cobbs.length-1]; if(!cb){ cb={l0:{},l1:{}}; cobbs.push(cb); }
      if(li===0&&pt==="b") cb.l0.b={x,y};
      else if(li===1&&pt==="a") cb.l1.a={x,y};
      else if(li===1&&pt==="b") cb.l1.b={x,y}; }
    const nx={ "0a":"cobb:0b","0b":"cobb:1a","1a":"cobb:1b","1b":"point" }[code];
    setTool(nx); redraw(); updStatus(); return; }
  if(tool.indexOf(":")>0){ const k=tool.split(":")[0], code=tool.split(":")[1]; let py=y;
    if(code[1]==="b"){ const a=spans[k].find(p=>p.side===code[0]&&p.role==="a"); if(a) py=a.y; }
    pushHist(); spans[k].push({side:code[0],role:code[1],x:x,y:py});
    let nx; if(code==="La")nx=k+":Lb"; else if(code==="Lb")nx=k+":Ra"; else if(code==="Ra")nx=k+":Rb"; else nx="point";
    setTool(nx); redraw(); updStatus(); return; }
  if(tool==="sag"){ const i=sagNextIdx(); if(i<0){ setTool("point"); updStatus(); return; }
    const seq=SAG_SEQ[sag.mode]; pushHist(); sag.pts[seq[i].key]={x:x,y:y};
    if(sagNextIdx()<0){ setTool("point"); } redraw(); updStatus(); return; }
  const hit=hitTestLabel(rawX, rawY);
  if(hit){ sel=hit.ref; redraw(); return; }
  if(sel){ sel=null; redraw(); return; }
});
cv.addEventListener("mousemove",e=>{
  if(!imgEl) return;
  const r=cv.getBoundingClientRect(); const sx=cv.width/r.width, sy=cv.height/r.height;
  let ox=Math.round((e.clientX-r.left)*sx/scale), oy=Math.round((e.clientY-r.top)*sy/scale); if(flip) ox=natW-ox;
  if(tool==="obt:Lb"||tool==="obt:Rb"||tool==="ltr:Lb"||tool==="ltr:Rb"){ const k=tool.split(":")[0], code=tool.split(":")[1]; const a=spans[k].find(p=>p.side===code[0]&&p.role==="a"); if(a) oy=a.y; }
  $("readout").textContent="cursor: x="+ox+", y="+oy+(refX!=null?(" | off "+(ox-refX)+"px"):"");
  // item7: 좌표를 찍는 도구가 활성일 때만 돋보기 표시 (idle 'point'에서는 끔)
  const placing = (tool && tool!=="point" && tool!=="cobb2");
  if(!placing){ mag.style.display="none"; return; }
  const Z=6, half=mag.width/(2*Z);
  mag.style.display="block"; mctx.clearRect(0,0,mag.width,mag.height); mctx.imageSmoothingEnabled=false;
  if(flip){ mctx.save(); mctx.translate(mag.width,0); mctx.scale(-1,1); mctx.drawImage(imgEl, ox-half, oy-half, half*2, half*2, 0,0,mag.width,mag.height); mctx.restore(); }
  else mctx.drawImage(imgEl, ox-half, oy-half, half*2, half*2, 0,0,mag.width,mag.height);
  mctx.strokeStyle="#0a84ff"; mctx.lineWidth=1; mctx.beginPath();
  mctx.moveTo(mag.width/2,0);mctx.lineTo(mag.width/2,mag.height); mctx.moveTo(0,mag.height/2);mctx.lineTo(mag.width,mag.height/2);mctx.stroke();
});
cv.addEventListener("mouseleave",()=>mag.style.display="none");

function setTool(t){
  // 주석 잠금: 그리기 도구 선택 차단(보기/이동 'point'는 허용)
  if(annLocked && t && t!=="point"){ setStatus("🔒 주석이 잠겨 있습니다. 설정에서 잠금을 해제하세요.","#ffb454"); return; }
  tool=t; sel=null;
  $("refBtn").classList.toggle("active", t==="ref");
  $("vtrigger").classList.toggle("active", t.indexOf("rot")===0);
  $("ltrigger").classList.toggle("active", t==="levL"||t==="levR");
  $("pelvisBtn").classList.toggle("active", t.indexOf("pel")===0);
  $("obtBtn").classList.toggle("active", t.indexOf("obt:")===0);
  $("ltrBtn").classList.toggle("active", t.indexOf("ltr:")===0);
  $("cobbBtn").classList.toggle("active", t.indexOf("cobb:")===0);
  $("cobb2Btn").classList.toggle("active", t.indexOf("cobb2")===0);
  const sb=$("sagSimpleBtn"), xb=$("sagComplexBtn");
  if(sb) sb.classList.toggle("active", t==="sag"&&sag.mode==="simple");
  if(xb) xb.classList.toggle("active", t==="sag"&&sag.mode==="complex");
}
$("refBtn").onclick=()=>{ setTool(tool==="ref"?"point":"ref"); updStatus(); };
$("pelvisBtn").onclick=()=>{ if(tool.indexOf("pel")===0){ setTool("point"); } else { if(pelvisPts.length) pushHist(); pelvisPts=[]; setTool("pelA"); redraw(); } updStatus(); };
$("obtBtn").onclick=()=>{ if(tool.indexOf("obt:")===0){ setTool("point"); } else { if(spans.obt.length) pushHist(); spans.obt=[]; setTool("obt:La"); redraw(); } updStatus(); };
$("ltrBtn").onclick=()=>{ if(tool.indexOf("ltr:")===0){ setTool("point"); } else { if(spans.ltr.length) pushHist(); spans.ltr=[]; setTool("ltr:La"); redraw(); } updStatus(); };
$("cobbBtn").onclick=()=>{ if(tool.indexOf("cobb:")===0){ setTool("point"); } else { setTool("cobb:0a"); } updStatus(); };
$("cobb2Btn").onclick=()=>{ if(tool==="cobb2"){ setTool("point"); cobb2Pick=null; } else { cobb2Pick=[]; setTool("cobb2"); } updStatus(); };
$("sagSimpleBtn").onclick=()=>{ if(tool==="sag"&&sag.mode==="simple"){ setTool("point"); updStatus(); } else sagStartMode("simple"); };
$("sagComplexBtn").onclick=()=>{ if(tool==="sag"&&sag.mode==="complex"){ setTool("point"); updStatus(); } else sagStartMode("complex"); };

// 척추 계층 드롭다운
const vmenu=$("vmenu"), vtrigger=$("vtrigger"), vwrap=$("vwrap");
vtrigger.onclick=(e)=>{ e.stopPropagation(); vmenu.classList.toggle("open"); $("lmenu").classList.remove("open"); };
document.addEventListener("click",(e)=>{ if(vwrap && !vwrap.contains(e.target)) vmenu.classList.remove("open"); });
function startVertebra(v){ curVertebra=v; vtrigger.textContent="Vertebra: "+v+" ▾"; vmenu.classList.remove("open");
  if(rotPts.some(p=>p.label===v)) pushHist();
  rotPts=rotPts.filter(p=>p.label!==v); setTool(SINGLE_SP.has(v)?"rotSP":"rotLB"); redraw(); updStatus(); }
document.querySelectorAll("#vmenu .vsub button").forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); startVertebra(b.getAttribute("data-v")); }; });

// 높이비교 큰버튼 드롭다운
const lmenu=$("lmenu"), ltrigger=$("ltrigger"), lwrap=$("lwrap");
ltrigger.onclick=(e)=>{ e.stopPropagation(); lmenu.classList.toggle("open"); vmenu.classList.remove("open"); };
document.addEventListener("click",(e)=>{ if(lwrap && !lwrap.contains(e.target)) lmenu.classList.remove("open"); });
function startLevel(region){ curLevel=region; ltrigger.textContent="Level: "+region+" ▾"; lmenu.classList.remove("open");
  if(levelPts.some(p=>p.label===region)) pushHist();
  levelPts=levelPts.filter(p=>p.label!==region); setTool("levL"); redraw(); updStatus(); }
document.querySelectorAll("#lmenu .vleaf").forEach(b=>{ b.onclick=(e)=>{ e.stopPropagation(); startLevel(b.getAttribute("data-lev")); }; });

function deleteSelected(){ if(!sel) return;
  if(annLocked){ setStatus("🔒 주석이 잠겨 있어 삭제할 수 없습니다.","#ffb454"); return; }
  pushHist();
  if(sel.type==="pt") points.splice(sel.i,1);
  else if(sel.type==="ref") refX=null;
  else if(sel.type==="lev") levelPts=levelPts.filter(p=>p.label!==sel.label);
  else if(sel.type==="rot") rotPts=rotPts.filter(p=>p.label!==sel.label);
  else if(sel.type==="pelvis") pelvisPts=[];
  else if(sel.type==="span") spans[sel.kind]=spans[sel.kind].filter(p=>p.side!==sel.side);
  else if(sel.type==="cobb") cobbs.splice(sel.i,1);
  else if(sel.type==="sag"){ sag={mode:null,pts:{}}; if(tool==="sag") setTool("point"); }
  sel=null; redraw(); updStatus(); }
function doUndo(){ if(!history.length) return; redoStack.push(snapshot()); restore(history.pop()); sel=null; calPts=[]; redraw(); updStatus(); }
function doRedo(){ if(!redoStack.length) return; history.push(snapshot()); restore(redoStack.pop()); sel=null; calPts=[]; redraw(); updStatus(); }
$("undoBtn").onclick=doUndo;
$("redoBtn").onclick=doRedo;
$("flipBtn").onclick=()=>{ flip=!flip; dirty=true; window.__ANN_DIRTY__=true; redraw(); };
$("clr").onclick=()=>{ if(annLocked){ setStatus("🔒 주석이 잠겨 있어 지울 수 없습니다.","#ffb454"); return; } if(confirm("모든 주석을 지울까요? (사진은 유지)")){ pushHist(); clearAnno(); setTool("point"); redraw(); updStatus(); } };
function resetAll(){
  imgBytes=null; imgEl=null; natW=0; natH=0; imgName="image.png"; zipHandle=null; history=[]; redoStack=[];
  clearAnno(); cobb2Pick=null; zoom=1; flip=false; curVertebra="L5"; curLevel="Clavicle"; fitMode=false;
  curPixelSpacing=null; curDicomPat=""; $("pxmm").value=""; $("patientInfo").value="";
  if($("patDicom")){ $("patDicom").textContent=""; $("patManual").textContent=""; $("patManual").style.display="none"; }
  $("fitBtn").classList.remove("active"); $("vtrigger").textContent="Vertebra ▾"; $("ltrigger").textContent="Level ▾"; $("vmenu").classList.remove("open"); $("lmenu").classList.remove("open"); $("imginfo").textContent="No image";
  $("file").value=""; $("zipfile").value="";
  showImageArea(false); mag.style.display="none";
  ctx.clearRect(0,0,cv.width,cv.height);
  ["#tbl","#levtbl","#rottbl","#mtbl"].forEach(id=>{document.querySelector(id+" tbody").innerHTML="";}); renderReport();
  $("readout").textContent="cursor: -"; setTool("point"); updStatus();
  dirty=false; fromPacs=false; sourceName=""; window.__ANN_DIRTY__=false;
}
$("imgCloseBtn").onclick=()=>{ closeImage(); };
function zlab(t){ /* zoom 버튼 라벨 고정 (별도 표시 없음) */ }
function doFit(){ fitMode=true; $("fitBtn").classList.add("active"); zoom=1; layout(); window.scrollTo(0,0); }
function zoomBy(f){ fitMode=false; $("fitBtn").classList.remove("active"); zoom=Math.max(0.2,Math.min(8,zoom*f)); layout(); }
$("zoomInBtn").onclick=()=>zoomBy(1.25);
$("zoomOutBtn").onclick=()=>zoomBy(1/1.25);
$("fitBtn").onclick=doFit;
(function(){ const isMac=/Mac|iPhone|iPad|iPod/i.test((navigator.platform||"")+" "+(navigator.userAgent||"")); const MM=isMac?"⌘":"Ctrl ";
  [["exp",MM+"S"],["expAs",MM+"⇧S"],["undoBtn",MM+"Z"],["redoBtn",MM+"⇧Z"]].forEach(a=>{ const el=$(a[0]); if(el) el.insertAdjacentHTML("beforeend",' <span class="sc">'+a[1]+'</span>'); }); })();
function setPanelMode(auto){ document.body.classList.toggle("auto",auto); $("pinBtn").textContent=auto?"👁 Auto-hide":"📌 Pin panel"; try{ localStorage.setItem("jsha_panel",auto?"auto":"pin"); }catch(e){} }
function setMagMode(on){ magOn=false; if(mag) mag.style.display="none"; }
setMagMode(false);
$("pinBtn").onclick=()=>setPanelMode(!document.body.classList.contains("auto"));
try{ setPanelMode(localStorage.getItem("jsha_panel")==="auto"); }catch(e){ setPanelMode(false); }
$("patientInfo").addEventListener("input",()=>{ dirty=true; window.__ANN_DIRTY__=true; updPatientHeader(); if(typeof reportMetrics==="function") reportMetrics(); });
$("patientInfo").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); updPatientHeader(); $("patientInfo").blur(); } });
$("copyReport").onclick=()=>{ const t=($("report").textContent)||""; let ok=false; const ta=document.createElement("textarea"); ta.value=t; ta.style.position="fixed"; ta.style.left="-9999px"; document.body.appendChild(ta); ta.select(); try{ ok=document.execCommand("copy"); }catch(e){} document.body.removeChild(ta); const b=$("copyReport"), old=b.textContent; b.textContent=ok?"복사됨 ✓":"실패"; setTimeout(()=>{b.textContent=old;},1200); };
window.addEventListener("resize",layout);

$("manualBtn").onclick=()=>{ $("manualOverlay").style.display="block"; };
$("manualClose").onclick=()=>{ $("manualOverlay").style.display="none"; };
$("manualOverlay").addEventListener("click",e=>{ if(e.target===$("manualOverlay")) $("manualOverlay").style.display="none"; });
const VACT={};
["C2","C3","C4","C5","C6","C7","T1","T2","T3","T4","T5","T6","T7","T8","T9","T10","T11","T12","L1","L2","L3","L4","L5","S1","S2"].forEach(t=>{ VACT[t]=()=>startVertebra(t); });
VACT["CO"]=()=>startVertebra("Coccyx");
VACT["CC"]=()=>{ setTool("ref"); updStatus(); };
VACT["P"]=()=>{ if(pelvisPts.length) pushHist(); pelvisPts=[]; setTool("pelA"); redraw(); updStatus(); };
VACT["O"]=()=>{ if(spans.obt.length) pushHist(); spans.obt=[]; setTool("obt:La"); redraw(); updStatus(); };
VACT["LE"]=()=>{ if(spans.ltr.length) pushHist(); spans.ltr=[]; setTool("ltr:La"); redraw(); updStatus(); };
VACT["CB"]=()=>{ setTool("cobb:0a"); updStatus(); };
VACT["XB"]=()=>{ cobb2Pick=[]; setTool("cobb2"); updStatus(); };
VACT["SS"]=()=>{ if(tool==="sag"&&sag.mode==="simple"){ setTool("point"); updStatus(); } else sagStartMode("simple"); };
VACT["SX"]=()=>{ if(tool==="sag"&&sag.mode==="complex"){ setTool("point"); updStatus(); } else sagStartMode("complex"); };
VACT["CL"]=()=>startLevel("Clavicle");
VACT["I"]=()=>startLevel("Iliac crest");
VACT["F"]=()=>startLevel("Femoral head");
VACT["R"]=()=>{ flip=!flip; dirty=true; window.__ANN_DIRTY__=true; redraw(); };
VACT["INFO"]=()=>{ const el=$("patientInfo"); if(el){ el.focus(); el.select(); } };
const VPRE=new Set(); Object.keys(VACT).forEach(t=>{ for(let i=1;i<=t.length;i++) VPRE.add(t.slice(0,i)); });
let vkBuf="", vkTimer=null;
function vkReset(){ vkBuf=""; if(vkTimer){ clearTimeout(vkTimer); vkTimer=null; } }
function vkKey(ch){ ch=ch.toUpperCase(); if(!/[A-Z0-9]/.test(ch)) return;
  if(vkTimer){ clearTimeout(vkTimer); vkTimer=null; }
  let cand=vkBuf+ch; if(!VPRE.has(cand)) cand=VPRE.has(ch)?ch:"";
  vkBuf=cand; if(!vkBuf) return;
  const complete=!!VACT[vkBuf];
  const longer=Object.keys(VACT).some(t=>t.length>vkBuf.length && t.slice(0,vkBuf.length)===vkBuf);
  if(complete && !longer){ const fn=VACT[vkBuf]; vkReset(); fn(); }
  else if(complete && longer){ vkTimer=setTimeout(()=>{ const fn=VACT[vkBuf]; vkReset(); fn(); },450); }
  else { vkTimer=setTimeout(vkReset,900); }
}
function cancelInProgress(){
  if(tool.indexOf("rot")===0){ const h={}; rotPts.forEach(p=>{ if(p.label===curVertebra) h[p.role]=1; });
    const complete = SINGLE_SP.has(curVertebra) ? !!h.SP : !!(h.SP&&h.LB&&h.RB);
    if(!complete && rotPts.some(p=>p.label===curVertebra)){ pushHist(); rotPts=rotPts.filter(p=>p.label!==curVertebra); } return; }
  if(tool==="levL"||tool==="levR"){ const g={}; levelPts.forEach(p=>{ if(p.label===curLevel) g[p.side]=1; });
    if(!(g.L&&g.R) && levelPts.some(p=>p.label===curLevel)){ pushHist(); levelPts=levelPts.filter(p=>p.label!==curLevel); } return; }
  if(tool.indexOf("pel")===0){ const br={}; pelvisPts.forEach(p=>br[p.role]=1);
    if(!(br.A&&br.B&&br.C) && pelvisPts.length){ pushHist(); pelvisPts=[]; } return; }
  if(tool.indexOf("cobb:")===0){ const cb=cobbs[cobbs.length-1];
    if(cb && !(cb.l0&&cb.l0.a&&cb.l0.b&&cb.l1&&cb.l1.a&&cb.l1.b)){ pushHist(); cobbs.pop(); } return; }
  if(tool==="cobb2"){ cobb2Pick=[]; return; }
  if(tool.indexOf(":")>0){ const k=tool.split(":")[0], side=tool.split(":")[1][0];
    const hasA=spans[k].some(p=>p.side===side&&p.role==="a"), hasB=spans[k].some(p=>p.side===side&&p.role==="b");
    if(hasA&&!hasB){ pushHist(); spans[k]=spans[k].filter(p=>!(p.side===side&&p.role==="a")); } return; }
}
let _lastEsc=0;
document.addEventListener("keydown",e=>{
  if(e.key==="Escape"){
    if($("manualOverlay").style.display==="block"){ $("manualOverlay").style.display="none"; return; }
    const now=Date.now();
    if(imgEl && now-_lastEsc<450){ _lastEsc=0; closeImage(); return; }  // ESC 빠르게 두 번 → 사진 닫기
    _lastEsc=now;
    cancelInProgress();
    $("vmenu").classList.remove("open"); $("lmenu").classList.remove("open");
    setTool("point"); sel=null; redraw(); updStatus(); return;
  }
  const mod=e.ctrlKey||e.metaKey;
  const tag=(document.activeElement&&document.activeElement.tagName)||"";
  const inField=(tag==="INPUT"||tag==="SELECT"||tag==="TEXTAREA");
  if(mod && (e.key==="s"||e.key==="S")){ e.preventDefault(); if(imgEl) doSave(); return; }
  if(mod && (e.key==="z"||e.key==="Z")){ if(inField) return; e.preventDefault(); if(e.shiftKey) doRedo(); else doUndo(); return; }
  if(mod && (e.key==="y"||e.key==="Y")){ if(inField) return; e.preventDefault(); doRedo(); return; }
  if(inField) return;
  /* ₩(백틱): 툴바 표시/숨김 → 호스트(JS VIEWER 창)로 전달 */
  if(e.key==="₩"||e.key==="`"||e.code==="Backquote"){
    e.preventDefault();
    try{ var h=(window.__CMP_HOST__&&window.__CMP_HOST__()); if(h){ h.postMessage({type:"cmp-autohide-toggle"},"*"); } else if(window.__cmpToggleAutohide){ window.__cmpToggleAutohide(); } }catch(_){ }
    return;
  }
  if(!mod && e.key==="ArrowLeft" && curSeries && curSeries.length>1){ e.preventDefault(); seriesPrev(); return; }
  if(!mod && e.key==="ArrowRight" && curSeries && curSeries.length>1){ e.preventDefault(); seriesNext(); return; }
  if(!mod && (e.key==="="||e.key==="+")){ e.preventDefault(); if(imgEl) zoomBy(1.25); return; }
  if(!mod && (e.key==="-"||e.key==="_")){ e.preventDefault(); if(imgEl) zoomBy(1/1.25); return; }
  if(!mod && e.key==="0"){
    // T10/T11/T12 등 입력 중이면 '0'을 척추 단축키 버퍼로 보냄 (Fit과 충돌 방지)
    if(imgEl && vkBuf && VPRE.has(vkBuf+"0")){ e.preventDefault(); vkKey("0"); return; }
    e.preventDefault(); if(imgEl) doFit(); return;
  }
  if((e.key==="Delete"||e.key==="Backspace") && sel){ e.preventDefault(); deleteSelected(); return; }
  if(imgEl && !mod){ let ch=null; const cd=e.code||"";
    if(/^Key[A-Z]$/.test(cd)) ch=cd.slice(3);
    else { const m=/^(?:Digit|Numpad)([1-9])$/.exec(cd); if(m) ch=m[1]; }
    if(ch) vkKey(ch); }
});
document.addEventListener("mousedown",e=>{ if(sel && e.target!==cv){ sel=null; redraw(); } });
(function(){ const p=$("annSeriesPrev"),n=$("annSeriesNext"); if(p)p.onclick=seriesPrev; if(n)n.onclick=seriesNext; })();
updStatus();

const crcTable=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}return t;})();
function crc32(b){let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=crcTable[(c^b[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
const enc=s=>new TextEncoder().encode(s);
function makeZip(files){
  const parts=[],central=[]; let offset=0; const dt=0,dd=0x21;
  for(const f of files){
    const nm=enc(f.name), crc=crc32(f.data), sz=f.data.length;
    const lh=new DataView(new ArrayBuffer(30));
    lh.setUint32(0,0x04034b50,true);lh.setUint16(4,20,true);lh.setUint16(6,0,true);lh.setUint16(8,0,true);
    lh.setUint16(10,dt,true);lh.setUint16(12,dd,true);lh.setUint32(14,crc,true);
    lh.setUint32(18,sz,true);lh.setUint32(22,sz,true);lh.setUint16(26,nm.length,true);lh.setUint16(28,0,true);
    parts.push(new Uint8Array(lh.buffer),nm,f.data);
    const cd=new DataView(new ArrayBuffer(46));
    cd.setUint32(0,0x02014b50,true);cd.setUint16(4,20,true);cd.setUint16(6,20,true);cd.setUint16(8,0,true);
    cd.setUint16(10,0,true);cd.setUint16(12,dt,true);cd.setUint16(14,dd,true);cd.setUint32(16,crc,true);
    cd.setUint32(20,sz,true);cd.setUint32(24,sz,true);cd.setUint16(28,nm.length,true);cd.setUint16(30,0,true);
    cd.setUint16(32,0,true);cd.setUint16(34,0,true);cd.setUint16(36,0,true);cd.setUint32(38,0,true);cd.setUint32(42,offset,true);
    central.push(new Uint8Array(cd.buffer),nm);
    offset+=30+nm.length+sz;
  }
  let cdSize=0; central.forEach(p=>cdSize+=p.length);
  const eo=new DataView(new ArrayBuffer(22));
  eo.setUint32(0,0x06054b50,true);eo.setUint16(4,0,true);eo.setUint16(6,0,true);
  eo.setUint16(8,files.length,true);eo.setUint16(10,files.length,true);
  eo.setUint32(12,cdSize,true);eo.setUint32(16,offset,true);eo.setUint16(20,0,true);
  return new Blob([...parts,...central,new Uint8Array(eo.buffer)],{type:"application/zip"});
}
function canvasBlob(cnv){return new Promise(res=>cnv.toBlob(b=>res(b),"image/png"));}
function renderNative(){ const off=document.createElement("canvas"); off.width=natW; off.height=natH; drawScene(off.getContext("2d"),1,false); return off; }

function buildMeta(){
  const pm=parseFloat($("pxmm").value); const hasRef=refX!=null; const hasScale=hasRef&&pm>0;
  let csv="label,x,y"+(hasRef?",offset_px":"")+(hasScale?",offset_mm":"")+"\n";
  points.forEach(p=>{ let row=p.label+","+p.x+","+p.y; if(hasRef) row+=","+(p.x-refX); if(hasScale) row+=","+((p.x-refX)/pm).toFixed(2); csv+=row+"\n"; });
  const lg={}; levelPts.forEach(p=>{(lg[p.label]=lg[p.label]||{})[p.side]=p;});
  let lcsv="label,Lx,Ly,Rx,Ry,dy_px,dy_mm,lower_side\n"; const pairs=[];
  for(const lab in lg){ const g=lg[lab], L=g.L, Rp=g.R; const dpx=(L&&Rp)?Math.abs(L.y-Rp.y):""; const dmm=(L&&Rp&&pm>0)?(dpx/pm).toFixed(2):""; const low=(L&&Rp)?((L.y>Rp.y)?"L":"R"):"";
    lcsv+=lab+","+(L?L.x:"")+","+(L?L.y:"")+","+(Rp?Rp.x:"")+","+(Rp?Rp.y:"")+","+dpx+","+dmm+","+low+"\n";
    pairs.push({label:lab,L:L?{x:L.x,y:L.y}:null,R:Rp?{x:Rp.x,y:Rp.y}:null,dy_px:dpx,dy_mm:dmm,lower_side:low}); }
  const rgx={}; rotPts.forEach(p=>{(rgx[p.label]=rgx[p.label]||{})[p.role]=p;});
  let rcsv="label,LBx,LBy,RBx,RBy,SPx,SPy,width_px,offset_pct,side\n"; const rots=[];
  for(const lab in rgx){ const g=rgx[lab]; const ok=g.LB&&g.RB&&g.SP; let wpx="",opc="",side="";
    if(ok){ const cx=(g.LB.x+g.RB.x)/2, halfW=Math.abs(g.RB.x-g.LB.x)/2, px=g.SP.x; wpx=Math.abs(g.RB.x-g.LB.x).toFixed(1); const pct=halfW>0?((px-cx)/halfW*100):0; opc=pct.toFixed(1); side=pct>0?"R":(pct<0?"L":""); }
    const vx=r=>g[r]?g[r].x:"", vy=r=>g[r]?g[r].y:"";
    rcsv+=lab+","+vx("LB")+","+vy("LB")+","+vx("RB")+","+vy("RB")+","+vx("SP")+","+vy("SP")+","+wpx+","+opc+","+side+"\n";
    rots.push({label:lab,LB:g.LB?{x:g.LB.x,y:g.LB.y}:null,RB:g.RB?{x:g.RB.x,y:g.RB.y}:null,SP:g.SP?{x:g.SP.x,y:g.SP.y}:null,width_px:wpx,offset_pct:opc,side:side}); }
  let pelObj=null, pelVal=""; const br={}; pelvisPts.forEach(p=>br[p.role]=p);
  if(br.A||br.B||br.C){ pelObj={A:br.A?{x:br.A.x,y:br.A.y}:null,B:br.B?{x:br.B.x,y:br.B.y}:null,C:br.C?{x:br.C.x,y:br.C.y}:null};
    if(br.A&&br.B&&br.C){ const A=br.A,B=br.B,Cc=br.C; const abx=B.x-A.x,aby=B.y-A.y,ablen=Math.hypot(abx,aby); const perp=ablen>0?Math.abs(abx*(Cc.y-A.y)-aby*(Cc.x-A.x))/ablen:0; pelVal=ablen>0?(perp/ablen).toFixed(3):""; pelObj.value=pelVal; } }
  let mcsv="measure,detail,value\n";
  if(pelVal!=="") mcsv+="골반강비율,,"+pelVal+"\n";
  ["obt","ltr"].forEach(k=>{ ["L","R"].forEach(side=>{ const a=spans[k].find(p=>p.side===side&&p.role==="a"), b=spans[k].find(p=>p.side===side&&p.role==="b"); if(a&&b){ const d=Math.hypot(a.x-b.x,a.y-b.y); const mm=(pm>0)?(d/pm).toFixed(2):""; mcsv+=SPAN[k].short+","+(side==="L"?"좌":"우")+","+(mm!==""?mm+"mm":Math.round(d)+"px")+"\n"; } }); });
  const cobbOut=[]; cobbs.forEach((cb,i)=>{ const a=cobbAngle(cb); if(a!=null){ mcsv+="Cobb's angle,#"+(i+1)+","+a.toFixed(1)+"deg\n"; }
    cobbOut.push({l0:cb.l0,l1:cb.l1,angle:(a!=null?+a.toFixed(2):null)}); });
  // 측면(시상면) 정렬: 점 + 산출값 저장
  let sagOut=null;
  if(sag.mode){ const M=sagMetrics();
    sagOut={mode:sag.mode, pts:sag.pts, metrics:{
      sva_mm:(M.svaMm!=null?+M.svaMm.toFixed(1):null), csva_mm:(M.csvaMm!=null?+M.csvaMm.toFixed(1):null),
      ll:(M.ll!=null?+M.ll.toFixed(1):null), ss:(M.ss!=null?+M.ss.toFixed(1):null),
      pt:(M.pt!=null?+M.pt.toFixed(1):null), pi:(M.pi!=null?+M.pi.toFixed(1):null),
      pi_ll:(M.piLl!=null?+M.piLl.toFixed(1):null), t1s:(M.t1s!=null?+M.t1s.toFixed(1):null),
      cl:(M.cl!=null?+M.cl.toFixed(1):null), t1s_cl:(M.t1sCl!=null?+M.t1sCl.toFixed(1):null) }};
    const mm=v=>(v!=null?v:"");
    if(M.svaMm!=null) mcsv+="SVA,,"+M.svaMm.toFixed(1)+"mm\n";
    if(M.csvaMm!=null) mcsv+="cSVA,,"+M.csvaMm.toFixed(1)+"mm\n";
    if(M.piLl!=null) mcsv+="PI-LL,,"+M.piLl.toFixed(1)+"deg\n";
    if(M.pt!=null) mcsv+="PT,,"+M.pt.toFixed(1)+"deg\n";
    if(M.t1sCl!=null) mcsv+="T1S-CL,,"+M.t1sCl.toFixed(1)+"deg\n";
  }
  const meta={image:imgName,width:natW,height:natH,centerline_x:(refX!=null?refX:null),pubic_symphysis_x:(refX!=null?refX:null),
    px_per_mm:(pm>0?pm:null),patient_info:($("patientInfo").value||""),flip:flip,points:points,level_pairs:pairs,rotation:rots,pelvis:pelObj,spans:{obt:spans.obt,ltr:spans.ltr},cobbs:cobbOut,sagittal:sagOut,
    report:buildReportText(),created:new Date().toISOString()};
  return {meta, csv, lcsv, rcsv, mcsv};
}
async function buildAnnoPngBytes(){ return new Uint8Array(await (await canvasBlob(renderNative())).arrayBuffer()); }
async function buildZipBlob(){
  const {meta,csv,lcsv,rcsv,mcsv}=buildMeta();
  const annoBytes=await buildAnnoPngBytes();
  // 원본 이미지 바이트: 보관돼 있지 않으면(디코딩 캐시 경로) imgEl에서 즉석 생성
  let baseBytes=imgBytes;
  if((!baseBytes||!baseBytes.length) && imgEl && natW){
    try{ const oc=document.createElement("canvas"); oc.width=natW; oc.height=natH; oc.getContext("2d").drawImage(imgEl,0,0); baseBytes=new Uint8Array(await (await canvasBlob(oc)).arrayBuffer()); }catch(_){ baseBytes=new Uint8Array(0); }
  }
  const files=[{name:imgName,data:baseBytes||new Uint8Array(0)},{name:"points.csv",data:enc(csv)},{name:"levels.csv",data:enc(lcsv)},
    {name:"rotation.csv",data:enc(rcsv)},{name:"measures.csv",data:enc(mcsv)},{name:"report.txt",data:enc(buildReportText())},{name:"annotation.json",data:enc(JSON.stringify(meta,null,2))},{name:"annotated.png",data:annoBytes}];
  return makeZip(files);
}
async function doSave(){
  if(!imgEl){ alert("No image loaded."); return; }
  // 비교(iframe)/새 창(popup) 모드: 호스트(opener/parent)로 저장 요청 전송
  const _host = (window.JSHA_MODE==="annot" && window.__CMP_HOST__) ? window.__CMP_HOST__() : null;
  if(_host){
    try{
      const {meta}=buildMeta();
      setStatus("Saving\u2026","#ffd60a");
      _host.postMessage({type:"cmp-save", paneId:window.__CMP_PANE__, name:sourceName, anno:meta}, "*");
      return;
    }catch(err){ setStatus("Save error: "+err.message,"#ff6b6b"); return; }
  }
  // PACS 연동(단일 오버레이): 주석 JSON 저장
  if(fromPacs && window.JSHA_BRIDGE && window.JSHA_BRIDGE.saveAnno && sourceName){
    try{
      const {meta}=buildMeta();
      setStatus("Saving\u2026","#ffd60a");
      const res=await window.JSHA_BRIDGE.saveAnno(sourceName, meta, null);
      if(res && res.ok){ dirty=false; window.__ANN_DIRTY__=false; setStatus("Saved \u2713 : "+sourceName,"#46ff46"); return; }
      setStatus("Folder save failed ("+((res&&res.reason)||"")+") \u2014 falling back to download","#ff6b6b");
    }catch(err){ setStatus("Save error \u2014 falling back to download","#ff6b6b"); }
  }
  // 단독 실행 폴백: ZIP 다운로드
  let blob; try{ blob=await buildZipBlob(); }catch(err){ alert("Failed to create save file: "+err.message); return; }
  const dn=((imgName.replace(/\.[^.]+$/,"")||"image")+"_annotated.zip");
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=dn; document.body.appendChild(a); a.click(); a.remove();
  dirty=false; setStatus("Downloaded: "+dn,"#46ff46");
}
$("exp").onclick=doSave;
window.addEventListener("beforeunload",function(e){ if(dirty){ e.preventDefault(); e.returnValue=""; } });

window.__ANN__={loadDicomBuffer:loadDicomBuffer, loadSeries:loadSeries};

/* === 비교(iframe)/새 창(popup) 모드: 호스트와 통신 === */
if(window.JSHA_MODE==="annot"){
  // 새 창(popup)은 window.opener, iframe 패널은 window.parent 가 호스트
  function cmpHost(){ try{ if(window.opener && window.opener!==window) return window.opener; }catch(_){ } if(window.parent && window.parent!==window) return window.parent; return null; }
  window.__CMP_HOST__=cmpHost;
  window.__CMP_PANE__=null;
  window.__CMP_NOTIFY_CLOSE__=function(){ const h=cmpHost(); if(h){ try{ h.postMessage({type:"cmp-closed", paneId:window.__CMP_PANE__},"*"); }catch(_){ } } };
  // 클릭 → 호스트에 활성화 알림
  document.addEventListener("mousedown",()=>{ const h=cmpHost(); if(h){ try{ h.postMessage({type:"cmp-focus", paneId:window.__CMP_PANE__},"*"); }catch(_){ } } }, true);
  // 호스트 → 패널/창 메시지
  window.addEventListener("message",async ev=>{
    const d=ev.data; if(!d) return;
    if(d.type==="cmp-init"){ window.__CMP_PANE__=d.paneId; return; }
    if(d.type==="cmp-load" && d.series){
      window.__CMP_PANE__=d.paneId;
      // 로드 시작 즉시 안내문구 숨김(빈 화면처럼 보이지 않게)
      try{ const dp=$("drop"); if(dp) dp.style.display="none"; }catch(_){ }
      setStatus("Loading…","#ffd166");
      const series=d.series.map(it=>({ name:it.name, getBuffer:async()=>it.buffer, getAnno:async()=>it.anno||null }));
      try{
        if(!series.length || !series[0].name){ throw new Error("empty series"); }
        await loadSeries(series, d.idx||0, d.patient||null);
      }catch(e){ setStatus("Load failed: "+e.message,"#ff6b6b"); try{ const dp=$("drop"); if(dp) dp.style.display="block"; }catch(_){ } }
      if(typeof setPatNote==="function") setPatNote(d.note||"");
      return;
    }
    if(d.type==="cmp-note"){ if(typeof setPatNote==="function") setPatNote(d.text||""); return; }
    if(d.type==="cmp-saved"){ dirty=false; window.__ANN_DIRTY__=false; setStatus("Saved \u2713","#46ff46"); return; }
    if(d.type==="cmp-save-failed"){ setStatus("Save failed ("+(d.reason||"")+")","#ff6b6b"); return; }
    if(d.type==="cmp-clear"){ resetAll(); return; }
    if(d.type==="cmp-req-metrics"){ if(typeof reportMetrics==="function") reportMetrics(); return; }
    if(d.type==="cmp-cmd"){ // 부모 공통 툴바 → 이 패널에서 명령 실행
      const id=d.cmd;
      if(id==="vkey"){ if(typeof vkKey==="function") vkKey(d.key); return; }
      if(id==="seriesPrev"){ if(typeof seriesPrev==="function") seriesPrev(); return; }
      if(id==="seriesNext"){ if(typeof seriesNext==="function") seriesNext(); return; }
      if(id==="closeImage"){ if(typeof closeImage==="function") closeImage(); return; }
      const btn=$(id);
      if(btn){ btn.click(); return; }
      // 버튼이 없는 동작은 직접 매핑
      if(id==="save"){ doSave(); }
      return;
    }
  });
  // 준비 완료 알림 (호스트가 준비될 때까지 몇 번 재시도)
  let _rdy=0; (function ping(){ const h=cmpHost(); if(h){ try{ h.postMessage({type:"cmp-ready"},"*"); }catch(_){ } } if(++_rdy<20) setTimeout(ping,150); })();
}
})();