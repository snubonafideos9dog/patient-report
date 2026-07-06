(function(){
  var h=location.hash||"";
  if(h.indexOf("compare")>=0){ window.JSHA_MODE="compare"; document.documentElement.classList.add("comparemode"); }
  else if(h.indexOf("annot")>=0){ window.JSHA_MODE="annot"; document.documentElement.classList.add("annotmode"); if(h.indexOf("pane")>=0) document.documentElement.classList.add("panemode"); }
  else { window.JSHA_MODE="pacs"; }
})();