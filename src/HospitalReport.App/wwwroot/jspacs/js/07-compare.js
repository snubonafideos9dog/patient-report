/* ================= 비교 뷰 ================= */
(function(){
  if(window.JSHA_MODE==="annot") return;  // 패널 iframe·팝업 내부에선 실행 안 함

  /* ============ PACS(부모) 모드: 비교 창 런처 ============ */
  if(window.JSHA_MODE==="pacs"){
    let cmpWin=null, cmpReady=false, cmpQueue=[];
    function compareURL(){ const base=location.href.split("#")[0]; return base+"#compare"; }
    function ensureWindow(){
      if(cmpWin && !cmpWin.closed) return cmpWin;
      cmpReady=false; cmpQueue=[];
      const w=Math.min(1700,(screen.availWidth||1700)), h=Math.min(1000,(screen.availHeight||1000));
      const left=Math.max(0, Math.round(((screen.availWidth||w)-w)/2));
      const top=Math.max(0, Math.round(((screen.availHeight||h)-h)/2));
      // 팝업 창: 주소창·툴바·메뉴를 최대한 숨김 (file:// 에서는 브라우저 정책상 축약 주소가 남을 수 있음)
      const feat="popup=yes,location=no,toolbar=no,menubar=no,status=no,scrollbars=yes,resizable=yes"
        +",width="+w+",height="+h+",left="+left+",top="+top;
      cmpWin=window.open(compareURL(), "jsha_compare", feat);
      try{ window.__cmpWin=cmpWin; }catch(_){ }
      return cmpWin;
    }
    async function buildSeriesPayload(st){
      const out=[];
      for(const f of st.files){
        const file=await f.getFile(); const buffer=await file.arrayBuffer();
        let anno=null; if(f.jsonHandle){ try{ const jf=await f.jsonHandle.getFile(); anno=JSON.parse(await jf.text()); }catch(_){ } }
        out.push({name:f.name, buffer, anno});
      }
      return out;
    }
    function flushQueue(){ if(!cmpWin) return; const q=cmpQueue; cmpQueue=[]; q.forEach(p=>{ try{ cmpWin.postMessage(p,"*"); }catch(_){ } }); }
    // 비교 창에서 오는 메시지(준비/저장요청) 처리
    window.addEventListener("message",async ev=>{
      const d=ev.data; if(!d||!d.type) return;
      if(d.type==="cmpwin-ready"){ cmpReady=true; flushQueue(); return; }
      if(d.type==="cmpwin-save"){
        try{ const res=await window.JSHA_BRIDGE.saveAnno(d.name, d.anno, null);
          if(cmpWin) cmpWin.postMessage({type:"cmpwin-saved", reqId:d.reqId, ok:!!(res&&res.ok), reason:(res&&res.reason)||""},"*");
        }catch(err){ if(cmpWin) cmpWin.postMessage({type:"cmpwin-saved", reqId:d.reqId, ok:false, reason:err.message},"*"); }
        return;
      }
    });
    async function sendStudy(st){
      const win=ensureWindow();
      if(!win){ alert("Pop-up was blocked. Please allow pop-ups and try again."); return false; }
      const payload={ type:"cmpwin-add", study:{ pid:st.pid, name_:st.name_, sex:st.sex, age:st.age, exam:st.exam, date:st.date, time:st.time, count:st.count,
        files:st.files.map(f=>({name:f.name})) }, series:await buildSeriesPayload(st) };
      try{ win.focus(); }catch(_){ }
      cmpQueue.push(payload);
      if(cmpReady) flushQueue();
      // 안전장치: 준비 신호를 놓쳤을 때를 대비해 잠시 후 한 번 더 시도
      setTimeout(()=>{ if(cmpQueue.length){ try{ win.postMessage({type:"cmpwin-ping"},"*"); }catch(_){ } } }, 400);
      return true;
    }
    window.JSHA_CMP={
      isActive:()=>!!(cmpWin && !cmpWin.closed),
      openComparison:()=>{ ensureWindow(); },
      openStudyInComparison:(st)=>sendStudy(st),
      openInNewWindow:(st)=>sendStudy(st)
    };
    return;
  }

  /* ============ COMPARE(새 창) 모드: 실제 비교 UI ============ */
  const $=id=>document.getElementById(id);
  const view=$("cmpView"), panels=$("cmpPanels");
  const paneEls=[...document.querySelectorAll(".cmpPane")];
  let active=true, activePane=0;
  const panes=[{study:null,name:"",ready:false,frame:null,metrics:null,patient:"",manual:""},{study:null,name:"",ready:false,frame:null,metrics:null,patient:"",manual:""}];
  const saveWaiters={};

  function srcURL(pane){ const base=location.href.split("#")[0]; return base+"#annot"+(pane?"&pane":""); }
  function ensureFrame(i){
    if(panes[i].frame) return panes[i].frame;
    const pane=paneEls[i];
    pane.querySelector(".paneEmpty")&&pane.querySelector(".paneEmpty").remove();
    const f=document.createElement("iframe"); f.src=srcURL(true); panes[i].frame=f; panes[i].ready=false;
    pane.appendChild(f);
    f.addEventListener("load",()=>{ /* ready는 메시지로 확인 */ });
    return f;
  }
  function paneHdrName(i,txt,dts){
    var pn=paneEls[i].querySelector(".paneHdr .pn");
    var main=txt||(i===0?cmpL("left"):cmpL("right"));
    pn.innerHTML="<span class='pnMain'></span>"+(dts?"<span class='pnDate'></span>":"");
    pn.querySelector(".pnMain").textContent=main;
    if(dts) pn.querySelector(".pnDate").textContent=dts;
  }
  // 동적 텍스트용 언어 헬퍼(설정 언어 따름)
  function cmpLang(){ try{ return (window.getUiLang?window.getUiLang():"en"); }catch(_){ return "en"; } }
  function cmpL(key){
    var ko=cmpLang()==="ko";
    var M={
      left: ko?"왼쪽":"Left", right: ko?"오른쪽":"Right",
      activeNoImg: ko?" 패널 활성 (이미지 없음)":" panel active (no image)",
      active: ko?" 활성 · ":" active · ",
      clickActivate: ko?"이미지를 클릭하면 활성화됩니다.":"Click an image to activate.",
      dblclick: ko?" — 목록에서 검사를 두 번 클릭하세요":" — double-click a study in the worklist"
    };
    return M[key]!=null?M[key]:"";
  }
  function setActive(i){ active=true; activePane=i; paneEls.forEach((p,k)=>p.classList.toggle("activePane",k===i));
    const note=document.getElementById("cmpPatNote"); if(note) note.value=panes[i].note||"";
    if(panes[i] && panes[i].study) window.__cmpActivePid=panes[i].study.pid||null;
    const st=document.getElementById("cmpStatus"); if(st){ const p=panes[i]; const side=(i===0?cmpL("left"):cmpL("right")); st.textContent = (p&&p.study)? (side+cmpL("active")+((p.study.pid||"")+" "+(p.study.name_||""))) : (side+cmpL("activeNoImg")); }
  }

  function openComparison(){ active=true; view.classList.add("show"); setActive(activePane); }
  function closeComparison(){ try{ window.close(); }catch(_){ } }
  // compare 창에서는 view를 항상 표시
  view.classList.add("show"); setActive(0);
  // ===== JS VIEWER 툴바 위치(좌측/상단) 적용 =====
  function applyToolbarPos(pos){
    if(pos!=="top" && pos!=="left"){ try{ pos=(localStorage.getItem("jsha_cmp_toolbarpos")==="top")?"top":"left"; }catch(e){ pos="left"; } }
    view.classList.toggle("toolbar-top", pos==="top");
    // 레이아웃 변경 후 양쪽 패널 다시 맞춤
    setTimeout(function(){ for(var k=0;k<2;k++){ try{ if(panes[k]&&panes[k].frame&&panes[k].frame.contentWindow){ panes[k].frame.contentWindow.postMessage({type:"cmp-cmd",cmd:"fitBtn"},"*"); } }catch(_){ } } }, 260);
  }
  window.__applyToolbarPos=applyToolbarPos;
  applyToolbarPos();
  // 툴바 위치 전환 버튼 (좌측 ↔ 상단)
  (function bindPosBtn(){
    var pb=document.getElementById("cmpPosBtn"); if(!pb) return;
    pb.onclick=function(){
      var cur=view.classList.contains("toolbar-top")?"top":"left";
      var next=(cur==="top")?"left":"top";
      try{ localStorage.setItem("jsha_cmp_toolbarpos", next); }catch(e){}
      applyToolbarPos(next);
    };
  })();
  // JS VIEWER의 Analyze: 원래 창(JS PACS)에서 분석 모달을 띄움
  (function bindCmpAnalyze(){
    const ab=$("cmpAnalyzeBtn"); if(!ab) return;
    ab.addEventListener("click",()=>{
      let pid=window.__cmpActivePid||null;
      if(!pid){ const p=panes.find(x=>x&&x.study); pid=p?p.study.pid:null; }
      if(!pid){ alert("먼저 이미지를 불러와 주세요."); return; }
      let host=null; try{ if(window.opener && !window.opener.closed) host=window.opener; }catch(_){ }
      if(host && typeof host.runAnalysis==="function"){
        try{ host.runAnalysis(pid); host.focus(); }
        catch(e){ alert("분석 창을 여는 중 문제가 발생했습니다. JS PACS 창에서 Analyze를 사용해 주세요."); }
      } else {
        alert("분석은 JS PACS(원래 창)에서 표시됩니다. PACS 창에서 환자를 선택해 Analyze를 눌러 주세요.");
      }
    });
  })();
  // ===== 툴바 자동 숨기기 (버튼 + 단축키 tt) =====
  (function bindAutohide(){
    var btn=document.getElementById("cmpAutohideBtn");
    function setAH(on){ view.classList.toggle("autohide", on); if(btn) btn.classList.toggle("on", on); try{ localStorage.setItem("jsha_cmp_autohide", on?"1":"0"); }catch(e){}
      // autohide 켜는 순간: 활성 패널의 마지막 작도 안내를 복귀바에 즉시 반영(추가 클릭 없이 보이도록)
      try{ var tb=document.getElementById("cmpShowTabStatus");
        if(tb){ if(on){ var ap=(typeof activePane!=="undefined"?activePane:0); var p=panes[ap];
            var side=(ap===0?cmpL("left"):cmpL("right")); var st=(p&&p.lastStatus)?p.lastStatus:"";
            tb.textContent = st ? (side+" ▶ "+st) : ""; }
          else { tb.textContent=""; } } }catch(_){ }
      // 툴바 폭 변화(트랜지션) 종료 후 양쪽 패널을 다시 화면에 맞춤 → 좌우 크기 동일하게
      setTimeout(function(){ for(var k=0;k<2;k++){ try{ if(panes[k]&&panes[k].frame&&panes[k].frame.contentWindow){ panes[k].frame.contentWindow.postMessage({type:"cmp-cmd",cmd:"fitBtn"},"*"); } }catch(_){ } } }, 280);
    }
    function toggleAH(){ var nowT=Date.now(); if(window.__ahLast && (nowT-window.__ahLast<250)) return; window.__ahLast=nowT; setAH(!view.classList.contains("autohide")); }
    // 저장된 상태 복원
    var saved="0"; try{ saved=localStorage.getItem("jsha_cmp_autohide")||"0"; }catch(e){}
    setAH(saved==="1");
    if(btn) btn.onclick=toggleAH;
    var showTab=document.getElementById("cmpShowTab");
    if(showTab) showTab.onclick=function(){ setAH(false); };
    // ₩ 단축키: 툴바 표시/숨김 토글 (한글 키보드 ₩, 영문 백틱 ` — Backquote)
    document.addEventListener("keydown",function(e){
      var tag=(e.target&&e.target.tagName)||""; if(tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT") return;
      if(e.key==="₩"||e.key==="`"||e.code==="Backquote"){ e.preventDefault(); toggleAH(); }
    }, true);
    window.__cmpToggleAutohide=toggleAH;
  })();
  // 패널 헤더 우측 컨트롤(페이지 넘김·닫기) 구성
  function buildPaneControls(i){
    const pi=paneEls[i].querySelector(".paneHdr .pi");
    if(!pi || pi.__built) return pi;
    pi.__built=true;
    pi.innerHTML="<button class='pgPrev' title='Previous image (←)'>‹</button><span class='pgLabel'></span><button class='pgNext' title='Next image (→)'>›</button><button class='pgClose' title='Close image'>✕</button>";
    pi.querySelector(".pgPrev").onclick=(e)=>{ e.stopPropagation(); setActive(i); try{ panes[i].frame.contentWindow.postMessage({type:"cmp-cmd",cmd:"seriesPrev"},"*"); }catch(_){ } };
    pi.querySelector(".pgNext").onclick=(e)=>{ e.stopPropagation(); setActive(i); try{ panes[i].frame.contentWindow.postMessage({type:"cmp-cmd",cmd:"seriesNext"},"*"); }catch(_){ } };
    pi.querySelector(".pgClose").onclick=(e)=>{ e.stopPropagation(); try{ panes[i].frame.contentWindow.postMessage({type:"cmp-cmd",cmd:"closeImage"},"*"); }catch(_){ } };
    return pi;
  }
  function setPaneLabel(i, idx, total){
    const pi=buildPaneControls(i); if(!pi) return;
    const lbl=pi.querySelector(".pgLabel"); if(lbl) lbl.textContent=total>1?((idx+1)+"/"+total):"";
    const prev=pi.querySelector(".pgPrev"), next=pi.querySelector(".pgNext");
    if(prev) prev.style.display=total>1?"":"none";
    if(next) next.style.display=total>1?"":"none";
  }
  async function fillPane(i, st){
    const f=ensureFrame(i);
    const payload=st.__series || [];
    panes[i].study=st; panes[i].name=(st.files&&st.files[0]&&st.files[0].name)||"";
    window.__cmpActivePid=st.pid||null; // JS VIEWER Analyze 대상 환자
    // item6: 사진 위 헤더에 병록번호·성별·나이·이름·검사명·촬영일시
    const sxKo=(st.sex==="M"?"M":st.sex==="F"?"F":(st.sex||""));
    const dd=st.date?(st.date.slice(0,4)+"-"+st.date.slice(4,6)+"-"+st.date.slice(6,8)):"";
    const tt=(st.time&&st.time.length>=4)?(st.time.slice(0,2)+":"+st.time.slice(2,4)):"";
    const dts=dd?(dd+(tt?(" "+tt):"")):"";
    const hdrMain=[st.pid, sxKo, (st.age!=null?st.age+"y":""), st.name_, st.exam].filter(Boolean).join(" · ");
    paneHdrName(i, hdrMain, dts);
    buildPaneControls(i); setPaneLabel(i, 0, (payload&&payload.length)||1);
    const send=()=>{ try{ f.contentWindow.postMessage({type:"cmp-load", paneId:i, series:payload, idx:0, patient:{pid:st.pid,name:st.name_,sex:st.sex,age:st.age,exam:st.exam}, note:panes[i].note||""}, "*"); }catch(e){} };
    if(panes[i].ready) send();
    else { panes[i]._pending=send; }
    setActive(i);
  }
  window.JSHA_CMP=window.JSHA_CMP||{};
  window.JSHA_CMP.openStudyInComparison=async function(st){
    let target;
    if(!panes[0].study && !panes[1].study) target=0;
    else if(!panes[0].study) target=0;
    else if(!panes[1].study) target=1;
    else target=activePane;
    await fillPane(target, st);
    return true;
  };

  // 패널 닫기 → 비우기 (iframe 제거 후 통일된 빈 화면 복원)
  function paneEmptyText(i){ return (i===0?cmpL("left"):cmpL("right"))+cmpL("dblclick"); }
  function restorePaneEmpty(i){
    const pane=paneEls[i];
    // iframe 제거
    if(panes[i].frame){ try{ pane.removeChild(panes[i].frame); }catch(_){ } panes[i].frame=null; panes[i].ready=false; panes[i]._pending=null; }
    // 헤더 라벨/컨트롤 초기화
    paneHdrName(i,null);
    const pi=pane.querySelector(".paneHdr .pi"); if(pi){ pi.innerHTML=""; pi.__built=false; }
    // 빈 안내(.paneEmpty) 복원 (없으면 생성)
    if(!pane.querySelector(".paneEmpty")){ const d=document.createElement("div"); d.className="paneEmpty"; pane.appendChild(d); }
    pane.querySelector(".paneEmpty").textContent=paneEmptyText(i);
  }
  function emptyPane(i){
    panes[i].study=null; panes[i].name=""; panes[i].metrics=null; panes[i].liveMetrics=null; panes[i].patient=""; panes[i].manual=""; panes[i].note="";
    restorePaneEmpty(i);
    renderGraph();
  }

  /* ---- 비교 그래프 ---- */
  /* 저장된 주석 meta(jsha.json) → metric 계산 (annotator getMetrics와 동일 규칙) */
  function metricsFromMeta(meta){
    const out={}; if(!meta) return out;
    const pm=(meta.px_per_mm>0)?meta.px_per_mm:0;
    const LEVEN={"하악각":"Mandibular angle","쇄골":"Clavicle","오훼돌기":"Coracoid","장골능":"Iliac crest","천골기저부":"Sacral base","대퇴골두":"Femoral head"};
    function cobbAng(cb){ if(!cb||!cb.l0||!cb.l1||!cb.l0.a||!cb.l0.b||!cb.l1.a||!cb.l1.b) return null;
      const a0=Math.atan2(cb.l0.b.y-cb.l0.a.y,cb.l0.b.x-cb.l0.a.x), a1=Math.atan2(cb.l1.b.y-cb.l1.a.y,cb.l1.b.x-cb.l1.a.x);
      let an=Math.abs(a0-a1)*180/Math.PI; an=an%180; if(an>90) an=180-an; return an; }
    function spanLR(arr,side){ if(!arr) return null; const a=arr.find(p=>p.side===side&&p.role==="a"), b=arr.find(p=>p.side===side&&p.role==="b"); return (a&&b)?Math.hypot(a.x-b.x,a.y-b.y):null; }
    const refX=(meta.pubic_symphysis_x!=null)?meta.pubic_symphysis_x:(meta.centerline_x!=null?meta.centerline_x:null);
    // 1) 중심선거리 (라벨 포인트 + 회전 SP)
    if(refX!=null){
      (meta.points||[]).forEach(p=>{ const off=Math.abs(p.x-refX); const mm=pm>0?off/pm:off; out[(p.label||"점")+" 중심선거리"]={value:+mm.toFixed(1),unit:(pm>0?"mm":"px"),goodLow:true}; });
      (meta.rotation||[]).forEach(r=>{ const cxv=(r.LB&&r.RB)?((r.LB.x+r.RB.x)/2):(r.SP?r.SP.x:null); if(cxv!=null){ const off=Math.abs(cxv-refX); const mm=pm>0?off/pm:off; out[r.label+" 중심선거리"]={value:+mm.toFixed(1),unit:(pm>0?"mm":"px"),goodLow:true}; } });
    }
    // 2) 회전 %
    (meta.rotation||[]).forEach(r=>{ if(r.LB&&r.RB&&r.SP){ const cx=(r.LB.x+r.RB.x)/2, hw=Math.abs(r.RB.x-r.LB.x)/2; if(hw>0){ const pct=Math.abs(r.SP.x-cx)/hw*100; out[r.label+" 회전"]={value:+pct.toFixed(0),unit:"%",goodLow:true}; } } });
    // 3) 높이 좌우차
    (meta.level_pairs||[]).forEach(pr=>{ if(pr.L&&pr.R){ const d=Math.abs(pr.L.y-pr.R.y); const mm=pm>0?d/pm:d; out[(LEVEN[pr.label]||pr.label)+" 좌우차"]={value:+mm.toFixed(1),unit:(pm>0?"mm":"px"),goodLow:true}; } });
    // 4) 골반강 비율
    const br={}; (meta.pelvis?["A","B","C"]:[]).forEach(rr=>{ if(meta.pelvis[rr]) br[rr]=meta.pelvis[rr]; });
    if(br.A&&br.B&&br.C){ const A=br.A,B=br.B,C=br.C; const ax=B.x-A.x,ay=B.y-A.y,al=Math.hypot(ax,ay); if(al>0){ const pp=Math.abs(ax*(C.y-A.y)-ay*(C.x-A.x))/al; out["골반강 비율"]={value:+(pp/al).toFixed(2),unit:"",goodLow:false}; } }
    // 5) 폐쇄공/LT-IR 좌우차
    [["obt","폐쇄공"],["ltr","LT-IR"]].forEach(kn=>{ const sp=meta.spans&&meta.spans[kn[0]]; const dl=spanLR(sp,"L"), dr=spanLR(sp,"R"); if(dl!=null&&dr!=null){ const d=Math.abs(dl-dr); const mm=pm>0?d/pm:d; out[kn[1]+" 좌우차"]={value:+mm.toFixed(1),unit:(pm>0?"mm":"px"),goodLow:true}; } });
    // 6) Cobb angle
    (meta.cobbs||[]).forEach((cb,i)=>{ const a=cobbAng(cb); if(a!=null) out["Cobb"+((meta.cobbs.length>1)?(" #"+(i+1)):"")]={value:+a.toFixed(1),unit:"°",goodLow:true}; });
    // 시상면(sagittal) 지표 — 저장된 sagittal.metrics 사용. 정상범위 동반.
    if(meta.sagittal && meta.sagittal.metrics){ const sm=meta.sagittal.metrics;
      const sadd=(lab,val,unit,normHi,normLo,absMode,goodLow)=>{ if(val==null) return;
        out[lab]={value:+(+val).toFixed(1),unit:unit,goodLow:goodLow!==false,normHi:(normHi!=null?normHi:null),normLo:(normLo!=null?normLo:null),absMode:!!absMode}; };
      sadd("SVA",sm.sva_mm,"mm",50,null,true,true);
      sadd("cSVA",sm.csva_mm,"mm",40,null,true,true);
      sadd("PI−LL",sm.pi_ll,"°",9,-9,true,true);
      sadd("PT",sm.pt,"°",20,null,true,true);
      sadd("T1S−CL",sm.t1s_cl,"°",20,null,true,true);
      if(sm.ll!=null) out["LL"]={value:+(+sm.ll).toFixed(1),unit:"°",goodLow:false,normLo:40,normHi:60,absMode:false};
    }
    return out;
  }
  /* 패널 study의 모든 파일(이미지가 달라도) 저장된 메타를 읽어 metric 병합 (item 3) */
  async function mergeStudyMetrics(pid){
    const st=panes[pid].study; const live=panes[pid].liveMetrics||{};
    let merged=Object.assign({}, live);
    const SAGKEYS=["SVA","cSVA","PI−LL","PT","T1S−CL","LL"];
    const hasSag=(o)=>SAGKEYS.some(k=>k in o);
    // ① 직렬화된 series 안 anno(meta) 병합
    const ser=st && st.__series;
    if(ser){ for(const it of ser){ if(it.anno){ try{ const mm=metricsFromMeta(it.anno); Object.keys(mm).forEach(k=>{ if(!(k in merged)) merged[k]=mm[k]; }); }catch(_){ } } } }
    // ② 측면 지표가 아직 없으면 study의 모든 파일(.jsha.json)을 직접 읽어 보충(측면 사진 포함)
    if(!hasSag(merged) && st && st.files && st.files.length){
      for(const f of st.files){ if(!f.jsonHandle) continue;
        try{ const jf=await f.jsonHandle.getFile(); const meta=JSON.parse(await jf.text());
          const mm=metricsFromMeta(meta); Object.keys(mm).forEach(k=>{ if(!(k in merged)) merged[k]=mm[k]; });
        }catch(_){ } }
    }
    try{ console.log("[JSHA analyze] pane",pid,"metrics keys:",Object.keys(merged).join(", "),"| sag?",hasSag(merged)); }catch(_){ }
    panes[pid].metrics=merged;
  }

  function fmtNum(v){ return (Math.round(v*10)/10).toString(); }
  // 시상면 지표 전문 해석(analyze 전용). 값과 정상범위로 한 줄 코멘트 생성.
  const SAG_PRO={
    "SVA":"전신 시상면 균형(C7 plumb–S1). 양성 클수록 전방 쏠림·기능장애 상관↑.",
    "cSVA":"경추 균형(C2–C7). 증가 시 두부 전방 편위·경부 신전근 부하.",
    "PI−LL":"요추전만 부족분. |9°| 초과 시 전만 소실, 골반·인접분절 보상.",
    "PT":"골반 후방경사(보상). 증가 시 보상여력 감소, 진행 위험.",
    "T1S−CL":"경추 보상 부족분. 증가 시 두부 전방 편위 유발, 흉추 후만 동반 가능.",
    "LL":"요추 전만각(L1–S1). 개인 PI에 맞는 적정 전만 유지 여부."
  };
  function sagJudge(lab, val, m){ // {txt,ok}  ok: true정상/false벗어남/null기준없음
    if(!(lab in SAG_PRO)) return null;
    const hi=m.normHi, lo=m.normLo, abs=m.absMode; let ok=null, range="";
    if(abs && hi!=null && lo==null){ ok=Math.abs(val)<=hi; range="정상 |값|<"+hi+(m.unit||""); }
    else if(lo!=null&&hi!=null){ ok=(val>=lo&&val<=hi); range="정상 "+lo+"~"+hi+(m.unit||""); }
    else if(hi!=null){ ok=val<=hi; range="정상 <"+hi+(m.unit||""); }
    return {ok:ok, range:range, pro:SAG_PRO[lab]};
  }
  function renderGraph(){
    const body=$("cmpGraphBody"), empty=$("cmpGraphEmpty");
    if(!body||!empty) return; // 하단 비교 창은 제거됨 (Analyze 버튼으로 대체)
    const m0=panes[0].metrics, m1=panes[1].metrics;
    if(!m0||!m1){ empty.style.display="block"; body.innerHTML=""; return; }
    // 공통 라벨
    const labels=Object.keys(m0).filter(k=>k in m1);
    if(!labels.length){ empty.style.display="block"; body.innerHTML="<div style='color:#7e8ea3;font-size:12px;text-align:center;padding:8px'>No measurements are shared on both sides. Measure the same item (e.g. same vertebra Cobb, same level L–R difference) on both images.</div>"; return; }
    empty.style.display="none";
    const sagComments=[];
    const rows=labels.map(lab=>{
      const a=m0[lab], b=m1[lab]; const before=a.value, after=b.value; const unit=a.unit||"";
      const goodLow=a.goodLow!==false; // 기본 낮을수록 좋음
      const absMode=(a.absMode===true||b.absMode===true); // 0에 가까울수록 좋음(SVA·cSVA 등)
      const maxv=Math.max(Math.abs(before),Math.abs(after),0.0001);
      const wB=Math.max(4,Math.abs(before)/maxv*100), wA=Math.max(4,Math.abs(after)/maxv*100);
      let cls="gsame", arrow="→", deltaTxt="변화 없음", pct=0, better=false;
      const diff=after-before;
      if(Math.abs(diff)>1e-6){
        better = absMode ? (Math.abs(after)<Math.abs(before)) : (goodLow ? (after<before) : (after>before));
        if(before!==0) pct=Math.abs(diff)/Math.abs(before)*100;
        cls = better ? "gbetter" : "gsame";
        arrow = better ? "▼" : "·";
        deltaTxt=(diff>0?"+":"")+fmtNum(diff)+unit+(pct?(" ("+(better?"-":"+")+Math.round(pct)+"%)"):"");
      }
      const afterColor = better?"linear-gradient(90deg,#1f9d57,#46e08a)":"linear-gradient(90deg,#3a4a60,#5c6f88)";
      // 정상범위 판정 배지(시상면 등 정상범위 보유 지표)
      const jB=sagJudge(lab,before,a), jA=sagJudge(lab,after,b);
      let badge="";
      if(jA){ const norm=(jA.ok===true), warn=(jA.ok===false);
        const col=norm?"#46e08a":"#7e8ea3"; const txt=norm?"정상":(warn?"범위밖":"");
        if(txt) badge=" <span style='font-size:9.5px;font-weight:700;color:"+col+";border:1px solid "+col+"55;border-radius:5px;padding:0 4px;margin-left:5px'>"+txt+"</span>";
        // 전문 코멘트 수집(After 기준)
        const beforeJudge=jB?(jB.ok===true?"정상":(jB.ok===false?"범위밖":"-")):"-";
        sagComments.push({lab:lab, range:jA.range, pro:jA.pro, before:before, after:after, unit:unit, okA:jA.ok, okB:(jB?jB.ok:null), better:better, changed:Math.abs(diff)>1e-6});
      }
      const rangeNote = jA&&jA.range ? "<span class='grange' style='font-size:9.5px;color:#7e8ea3;margin-left:6px'>"+jA.range+"</span>" : "";
      return "<div class='grow'>"+
        "<div class='glabel' title='"+lab+"'>"+lab+badge+"</div>"+
        "<div class='gbars'>"+
          "<div class='gbar before' style='width:"+wB+"%'>"+fmtNum(before)+unit+"</div>"+
          "<div class='gbar after' style='width:"+wA+"%;background:"+afterColor+";color:#e8eef6'>"+fmtNum(after)+unit+"</div>"+
        "</div>"+
        "<div class='gdelta "+cls+"'><span class='arrow'>"+arrow+"</span> "+deltaTxt+rangeNote+"</div>"+
      "</div>";
    }).join("");
    // 시상면 전문 분석 패널 (있을 때만)
    let sagPanel="";
    if(sagComments.length){
      const items=sagComments.map(c=>{
        const arrow = c.changed ? (c.better?"호전 ▼":"악화 ▲") : "변화 없음";
        const acol = c.changed && c.better ? "#46e08a" : "#7e8ea3";
        const statusA = c.okA===true?"<b style='color:#46e08a'>정상범위</b>":(c.okA===false?"정상범위 벗어남":"—");
        return "<div style='padding:7px 0;border-bottom:1px solid #1d2735'>"+
          "<div style='font-weight:700;color:#cfe0f2;font-size:12px'>"+c.lab+" <span style='font-weight:500;color:#7e8ea3;font-size:10.5px'>("+c.range+")</span></div>"+
          "<div style='font-size:11px;color:#9fb0c4;margin:2px 0 3px'>"+c.pro+"</div>"+
          "<div style='font-size:11px;color:#cbd5e1'>이전 "+fmtNum(c.before)+c.unit+" → 이번 "+fmtNum(c.after)+c.unit+" · <span style='color:"+acol+";font-weight:700'>"+arrow+"</span> · 현재 "+statusA+"</div>"+
        "</div>";
      }).join("");
      sagPanel="<div style='margin-top:14px;background:#0c1119;border:1px solid #1d2735;border-radius:8px;padding:10px 13px'>"+
        "<div style='font-weight:700;color:#9ec5fe;font-size:12.5px;margin-bottom:4px'>🩺 Sagittal alignment — 전문 분석</div>"+
        "<div style='font-size:10.5px;color:#7e8ea3;margin-bottom:6px'>결과(SVA·cSVA) ← 원인(PI−LL·T1S−CL) ← 보상(PT) 축으로 해석. 정상범위 대비 현재 상태와 이전 대비 변화 방향.</div>"+
        items+"</div>";
    }
    body.innerHTML="<div class='gtitle'>📈 Progress comparison</div>"+
      "<div class='gsub'>Top bar = Left (Before): "+esc2(panes[0].manual||panes[0].name||"")+" · Bottom bar = Right (After): "+esc2(panes[1].manual||panes[1].name||"")+"</div>"+
      rows+
      "<div class='glegend'>※ L–R difference, angle, deviation and midline distance: closer to 0 is more normal. ▼ = improved (green). Bar length is relative to the larger of the two values.</div>"+
      sagPanel;
  }
  function esc2(s){ return (""+s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
  window.JSHA_CMP=window.JSHA_CMP||{};

  // iframe(패널) 메시지 처리 — 패널 프레임에서 온 것만
  window.addEventListener("message",async ev=>{
    const d=ev.data; if(!d||d.type==null) return;
    // 패널(iframe)에서 tt로 보낸 툴바 자동숨기기 토글 — 출처검증 전에 처리
    if(d.type==="cmp-autohide-toggle"){ if(window.__cmpToggleAutohide) window.__cmpToggleAutohide(); return; }
    // 출처가 패널 프레임인지 확인 (팝업/기타 출처는 무시)
    let pid=null;
    for(let k=0;k<2;k++){ if(panes[k].frame&&ev.source===panes[k].frame.contentWindow){ pid=k; break; } }
    if(pid==null) return;
    if(d.type==="cmp-ready"){ panes[pid].ready=true; try{ panes[pid].frame.contentWindow.postMessage({type:"cmp-init", paneId:pid},"*"); }catch(_){ } if(panes[pid]._pending){ const fn=panes[pid]._pending; panes[pid]._pending=null; fn(); } return; }
    if(d.type==="cmp-focus"){ setActive(pid); return; }
    if(d.type==="cmp-closed"){ emptyPane(pid); return; }
    if(d.type==="cmp-series"){ setPaneLabel(pid, d.idx||0, d.total||1); return; }
    if(d.type==="cmp-status"){ // 활성 패널의 작도 진행 안내를 상태창 + autohide 복귀바에 표시
      const txt0=(d.text||"").trim(); panes[pid].lastStatus=txt0; panes[pid].lastStatusColor=d.color||"";
      if(pid===activePane){ const side=(pid===0?cmpL("left"):cmpL("right")); const txt=txt0;
        const el=$("cmpStatus");
        if(el){ if(txt){ el.textContent=side+" ▶ "+txt; el.style.color=d.color||""; }
          else { const p=panes[pid]; el.style.color=""; el.textContent=(p&&p.study)?(side+cmpL("active")+((p.study.pid||"")+" "+(p.study.name_||""))):(side+cmpL("activeNoImg")); } }
        // 툴바 숨김 상태에서도 보이도록 상단 복귀바에 진행 안내 표시(끝나면 비워서 힌트만 남김)
        const tb=$("cmpShowTabStatus"); if(tb){ tb.textContent = txt ? (side+" ▶ "+txt) : ""; } }
      return; }
    if(d.type==="cmp-metrics"){ panes[pid].liveMetrics=d.metrics||{}; panes[pid].patient=d.patient||""; panes[pid].manual=d.manual||""; await mergeStudyMetrics(pid); renderGraph(); return; }
    if(d.type==="cmp-save"){
      const src=panes[pid].frame.contentWindow;
      // 비교 창에는 폴더 핸들이 없으므로 부모(워크리스트) 창으로 저장 중계
      const opener=window.opener;
      if(opener){
        const reqId="s"+(Date.now())+"_"+pid;
        saveWaiters[reqId]={src,pid};
        try{ opener.postMessage({type:"cmpwin-save", reqId, name:d.name, anno:d.anno},"*"); }catch(e){ try{ src.postMessage({type:"cmp-save-failed",paneId:pid,reason:e.message},"*"); }catch(_){ } }
      } else { try{ src.postMessage({type:"cmp-save-failed",paneId:pid,reason:"no-opener"},"*"); }catch(_){ } }
      return;
    }
  });
  // 부모(워크리스트)로부터: study 추가 / 저장 응답 / ping
  window.addEventListener("message",ev=>{
    const d=ev.data; if(!d||!d.type) return;
    if(d.type==="cmpwin-ping"){ if(window.opener){ try{ window.opener.postMessage({type:"cmpwin-ready"},"*"); }catch(_){ } } return; }
    if(d.type==="cmpwin-add" && d.series){
      const st=d.study||{}; st.__series=d.series.map(it=>({name:it.name, buffer:it.buffer, anno:it.anno||null}));
      st.files=st.files||(d.series.map(it=>({name:it.name})));
      window.JSHA_CMP.openStudyInComparison(st);
      return;
    }
    if(d.type==="cmpwin-saved"){ const w=saveWaiters[d.reqId]; if(w){ delete saveWaiters[d.reqId];
      try{ w.src.postMessage(d.ok?{type:"cmp-saved",paneId:w.pid}:{type:"cmp-save-failed",paneId:w.pid,reason:d.reason||"error"},"*"); }catch(_){ } } return; }
  });
  // 부모에 준비 완료 알림 (여러 번 재시도 — 부모 리스너가 늦게 붙어도 도달)
  (function pingOpener(n){ if(window.opener){ try{ window.opener.postMessage({type:"cmpwin-ready"},"*"); }catch(_){ } } if(n<10) setTimeout(()=>pingOpener(n+1),120); })(0);

  // 패널 클릭(부모 영역에서도) → 활성화
  paneEls.forEach((p,i)=>{ p.addEventListener("mousedown",()=>setActive(i)); });
  if($("cmpBackBtn")) $("cmpBackBtn").onclick=closeComparison;
  // item5: 상태창
  function cmpStatus(msg){ const el=$("cmpStatus"); if(el) el.textContent=msg||""; }
  // item8: 매뉴얼 접기/펴기
  (function(){ const head=$("cmpManualHead"), man=$("cmpManual"); if(head&&man){ man.classList.add("collapsed"); const tg=head.querySelector(".mtog"); head.onclick=()=>{ man.classList.toggle("collapsed"); if(tg) tg.textContent=man.classList.contains("collapsed")?"▾":"▴"; }; } })();
  // item4: 환자 추가정보 입력 → 활성 패널에 전달(좌측 상단 표시)
  (function(){ const note=$("cmpPatNote"); if(note){
    // 입력 중에는 즉시 반영하지 않고, Enter 한 번에 활성 사진에 반영 (item1)
    function applyNote(){ const idx=activeReadyPane(); if(idx<0){ flashBar("Click a panel with an image first."); return; } if(idx!==activePane) setActive(idx);
      try{ panes[idx].note=note.value; panes[idx].frame.contentWindow.postMessage({type:"cmp-note", text:note.value},"*"); flashBar("Note applied."); }catch(_){ } }
    note.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); applyNote(); note.blur(); } });
    note.addEventListener("blur",applyNote);
  } })();

  /* ----- item5: 공통 툴바 → 활성 패널 iframe으로 명령 전달 ----- */
  function activeReadyPane(){
    // 활성 패널이 준비됐으면 그걸, 아니면 사진이 있는 다른 준비된 패널
    if(panes[activePane]&&panes[activePane].frame&&panes[activePane].ready&&panes[activePane].study) return activePane;
    for(let k=0;k<2;k++){ if(panes[k]&&panes[k].frame&&panes[k].ready&&panes[k].study) return k; }
    return -1;
  }
  function flashBar(msg){ const el=document.getElementById("cmpStatus"); if(!el) return; const old=el.textContent; el.textContent=msg; el.style.color="#ff9a9a"; clearTimeout(el._tm); el._tm=setTimeout(()=>{ el.style.color=""; const i=activePane,p=panes[i]; const side=(i===0?cmpL("left"):cmpL("right")); el.textContent=(p&&p.study)?(side+cmpL("active")+((p.study.pid||"")+" "+(p.study.name_||""))):cmpL("clickActivate"); },2200); }
  function sendCmd(msg){
    const idx=activeReadyPane();
    if(idx<0){ flashBar("Click a panel with an image to activate it first."); return; }
    if(idx!==activePane) setActive(idx);
    try{ panes[idx].frame.contentWindow.postMessage(msg,"*"); }catch(e){ flashBar("Command failed: "+e.message); }
  }
  const ctools=document.getElementById("cmpTools");
  if(ctools){
    ctools.querySelectorAll("button[data-cmd]").forEach(b=>{ b.onclick=()=>{ sendCmd({type:"cmp-cmd", cmd:b.getAttribute("data-cmd")}); }; });
    // 척추 회전 드롭다운 → 단축키(vkey) 전달
    const VERT=[["C2","C2"],["C3","C3"],["C4","C4"],["C5","C5"],["C6","C6"],["C7","C7"],["T1","T1"],["T2","T2"],["T3","T3"],["T4","T4"],["T5","T5"],["T6","T6"],["T7","T7"],["T8","T8"],["T9","T9"],["T10","T10"],["T11","T11"],["T12","T12"],["L1","L1"],["L2","L2"],["L3","L3"],["L4","L4"],["L5","L5"],["S1","S1"],["S2","S2"],["Coccyx","CO"]];
    const ctv=document.getElementById("ctVert");
    if(ctv){ VERT.forEach(v=>{ const o=document.createElement("option"); o.value=v[1]; o.textContent=v[0]+" rotation"; ctv.appendChild(o); });
      ctv.onchange=()=>{ const v=ctv.value; if(v){ for(const ch of v.split("")) sendCmd({type:"cmp-cmd",cmd:"vkey",key:ch}); ctv.value=""; } }; }
    // 높이비교 드롭다운 → 단축키 전달 (CL=쇄골, I=장골능, F=대퇴골두)
    const ctl=document.getElementById("ctLevel");
    if(ctl){ [["CL","Clavicle"],["I","Iliac crest"],["F","Femoral head"]].forEach(p=>{ const o=document.createElement("option"); o.value=p[0]; o.textContent=p[1]; ctl.appendChild(o); });
      ctl.onchange=()=>{ const v=ctl.value; if(v){ for(const ch of v.split("")) sendCmd({type:"cmp-cmd",cmd:"vkey",key:ch}); ctl.value=""; } }; }
  }
  // 부모창 키보드 → 활성 패널로 전달 + 더블 Enter로 환자노트 활성화 (item1)
  let _lastEnter=0;
  document.addEventListener("keydown",ev=>{
    if(!active) return;
    const t=ev.target;
    // item1: 입력란이 아닌 곳에서 Enter 두 번 → 환자노트 입력란 포커스
    if(ev.key==="Enter" && !(t&&(t.tagName==="INPUT"||t.tagName==="SELECT"||t.tagName==="TEXTAREA"))){
      const now=Date.now();
      if(now-_lastEnter<450){ _lastEnter=0; const note=document.getElementById("cmpPatNote"); if(note){ note.focus(); note.select(); ev.preventDefault(); } }
      else _lastEnter=now;
      return;
    }
    if(t&&(t.tagName==="INPUT"||t.tagName==="SELECT"||t.tagName==="TEXTAREA")) return;
  });
})();