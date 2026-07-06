(function(){
  var overlay=document.getElementById('annotatorOverlay');
  var backBar=document.getElementById('annBackBar');
  var backName=document.getElementById('annBackName');
  function showAnnotator(name){ overlay.classList.add('show'); backBar.style.display='flex'; backName.textContent=name||''; overlay.scrollTop=0; }
  function hideAnnotator(){ overlay.classList.remove('show'); backBar.style.display='none'; }
  document.getElementById('annBackBtn').onclick=function(){
    if(window.__ANN_DIRTY__ && !confirm('There are unsaved changes. Return to the worklist?')) return;
    hideAnnotator();
  };
  window.JSHA_BRIDGE=window.JSHA_BRIDGE||{};
  window.JSHA_BRIDGE.openAnnotator=function(name, buffer, anno){
    showAnnotator(name);
    setTimeout(function(){ try{ window.__ANN__.loadDicomBuffer(buffer, name, anno||null); }catch(e){ alert('DICOM load failed: '+e.message); } }, 40);
  };
  window.JSHA_BRIDGE.openAnnotatorSeries=function(series, idx, patient){
    showAnnotator((series&&series[idx]&&series[idx].name)||'');
    setTimeout(function(){ try{ window.__ANN__.loadSeries(series, idx||0, patient||null); }catch(e){ alert('DICOM load failed: '+e.message); } }, 40);
  };
  window.JSHA_BRIDGE.setBackName=function(t){ backName.textContent=t||''; };
  window.JSHA_BRIDGE.closeAnnotator=hideAnnotator;
  // saveAnno 는 PACS 로직이 등록함
})();