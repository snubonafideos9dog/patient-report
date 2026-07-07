
/* JSHA-DICOM-MODULE-INLINE */
/* ============================================================
   JSHA DICOM 모듈 (오프라인·의존성 없음)
   - DICOM 헤더 파싱(EUC-KR 한글 지원)
   - JPEG Lossless(SOF3, Process14 SV1) 디코딩 + uncompressed 폴백
   - window/level → 8bit grayscale canvas 렌더
   window.JSHADICOM = { parse, renderToCanvas, formatName, formatDate, formatTime }
   ============================================================ */
(function(){
"use strict";

/* ---------- JPEG Lossless (SOF3) 디코더 ---------- */
function decodeJPEGLossless(data){
  let p=0; const len=data.length;
  function u16(){ const v=(data[p]<<8)|data[p+1]; p+=2; return v; }
  let frame=null; const huff={};
  function buildHuff(counts,symbols){
    const huffsize=[]; for(let l=1;l<=16;l++){ for(let i=0;i<counts[l];i++) huffsize.push(l); }
    const huffcode=[]; let c=0,sz=huffsize[0]||0,idx=0;
    while(idx<huffsize.length){ while(idx<huffsize.length&&huffsize[idx]===sz){ huffcode[idx]=c;c++;idx++; } c<<=1; sz++; }
    const lookup={}; for(let i=0;i<huffsize.length;i++) lookup[huffsize[i]+":"+huffcode[i]]=symbols[i];
    return {lookup};
  }
  let bitBuf=0,bitCnt=0,eoi=false;
  function resetBits(){ bitBuf=0;bitCnt=0; }
  function nextBit(){
    if(bitCnt===0){
      if(p>=len){ eoi=true; return 0; }
      let b=data[p++];
      if(b===0xFF){ const b2=data[p];
        if(b2===0x00) p++;
        else if(b2>=0xD0&&b2<=0xD7){ p++; b=data[p++]; }
        else { eoi=true; p--; return 0; } }
      bitBuf=b; bitCnt=8;
    }
    bitCnt--; return (bitBuf>>bitCnt)&1;
  }
  function decodeHuff(tbl){ let code=0;
    for(let l=1;l<=16;l++){ code=(code<<1)|nextBit(); const s=tbl.lookup[l+":"+code]; if(s!==undefined) return s; }
    return 0; }
  function recv(s){ if(s===0) return 0; let v=0; for(let i=0;i<s;i++) v=(v<<1)|nextBit();
    if(v<(1<<(s-1))) v+=(-(1<<s))+1; return v; }
  while(p<len){
    if(data[p]!==0xFF){ p++; continue; }
    let m=data[p+1]; p+=2;
    if(m===0xD8) continue; if(m===0xD9) break;
    if(m>=0xD0&&m<=0xD7) continue; if(m===0x01) continue;
    const segLen=u16(), segEnd=p+segLen-2;
    if(m===0xC3){ const precision=data[p], height=(data[p+1]<<8)|data[p+2], width=(data[p+3]<<8)|data[p+4], nc=data[p+5];
      const comps=[]; let q=p+6; for(let i=0;i<nc;i++){ comps.push({id:data[q],tq:data[q+2]}); q+=3; }
      frame={precision,height,width,nc,comps}; p=segEnd;
    } else if(m===0xC4){ let q=p;
      while(q<segEnd){ const tc=data[q]>>4,th=data[q]&0xF; q++; const counts=[0]; let total=0;
        for(let l=1;l<=16;l++){ counts[l]=data[q++]; total+=counts[l]; }
        const syms=[]; for(let i=0;i<total;i++) syms.push(data[q++]); huff[tc*16+th]=buildHuff(counts,syms); }
      p=segEnd;
    } else if(m===0xDA){ const ns=data[p]; let q=p+1; const sc=[];
      for(let i=0;i<ns;i++){ sc.push({td:(data[q+1]>>4)}); q+=2; }
      const Ss=data[q], Al=data[q+2]&0xF; p=q+3;
      const W=frame.width,H=frame.height,P=frame.precision, pred=Ss, pt=Al;
      const tbl=huff[0*16+sc[0].td]; const out=new Int32Array(W*H); resetBits();
      const Px0=1<<(P-1-pt), mask=(1<<P)-1;
      for(let row=0; row<H; row++){ for(let col=0; col<W; col++){
        const s=decodeHuff(tbl); let diff = s===16?32768:recv(s);
        const idx=row*W+col; const a=col>0?out[idx-1]:0, b=row>0?out[idx-W]:0, cc=(row>0&&col>0)?out[idx-W-1]:0;
        let pv;
        if(col===0){ pv=row===0?Px0:b; }
        else if(row===0){ pv=a; }
        else { switch(pred){ case 1:pv=a;break; case 2:pv=b;break; case 3:pv=cc;break;
          case 4:pv=a+b-cc;break; case 5:pv=a+((b-cc)>>1);break; case 6:pv=b+((a-cc)>>1);break;
          case 7:pv=(a+b)>>1;break; default:pv=a; } }
        out[idx]=(pv+diff)&mask;
      } }
      return {width:W,height:H,precision:P,pixels:out};
    } else { p=segEnd; }
  }
  throw new Error("JPEG: SOF3/SOS 미발견");
}

/* ---------- DICOM 헤더 파서 ---------- */
const VR4=new Set(["OB","OW","OF","SQ","UT","UN","UC","UR"]);
const WANT={
  "0008,0005":"charset","0010,0020":"PatientID","0010,0010":"PatientName",
  "0010,0030":"BirthDate","0010,0040":"Sex","0010,1010":"PatientAge","0008,1030":"StudyDescription",
  "0008,103e":"SeriesDescription","0008,0060":"Modality","0018,0015":"BodyPart",
  "0008,0020":"StudyDate","0008,0030":"StudyTime","0008,0022":"AcqDate","0008,0032":"AcqTime",
  "0020,0011":"SeriesNumber","0020,0013":"InstanceNumber","0018,5101":"ViewPosition",
  "0008,0090":"ReferringPhysician","0008,1050":"PerformingPhysician","0008,1070":"Operators",
  "0008,0080":"InstitutionName","0008,0050":"AccessionNumber","0020,0010":"StudyID",
  "0008,0018":"SOPInstanceUID","0020,000d":"StudyUID","0020,000e":"SeriesUID",
  "0028,0010":"Rows","0028,0011":"Columns","0028,0100":"BitsAllocated","0028,0101":"BitsStored",
  "0028,0102":"HighBit","0028,0103":"PixelRepresentation","0028,0002":"SamplesPerPixel",
  "0028,0004":"Photometric","0028,1050":"WindowCenter","0028,1051":"WindowWidth",
  "0028,1052":"RescaleIntercept","0028,1053":"RescaleSlope","0028,0006":"PlanarConfig",
  "0028,0030":"PixelSpacing","0018,1164":"ImagerPixelSpacing",
};
const NUMERIC_US=new Set(["Rows","Columns","BitsAllocated","BitsStored","HighBit","PixelRepresentation","SamplesPerPixel","PlanarConfig"]);
const TS_UNCOMPRESSED={
  "1.2.840.10008.1.2":{implicit:true,big:false},
  "1.2.840.10008.1.2.1":{implicit:false,big:false},
  "1.2.840.10008.1.2.2":{implicit:false,big:true},
};
const TS_JPEGLL=new Set(["1.2.840.10008.1.2.4.70","1.2.840.10008.1.2.4.57"]);

function parse(arrbuf){
  const u8=new Uint8Array(arrbuf); const dv=new DataView(arrbuf);
  if(u8.length<132 || !(u8[128]===0x44&&u8[129]===0x49&&u8[130]===0x43&&u8[131]===0x4D))
    throw new Error("DICOM 형식이 아닙니다 (DICM 매직 없음).");
  let p=132, transferSyntax=null;
  // file meta (explicit LE)
  while(p+8<=dv.byteLength){
    const start=p; const group=dv.getUint16(p,true), elem=dv.getUint16(p+2,true); p+=4;
    if(group!==0x0002){ p=start; break; }
    const vr=String.fromCharCode(u8[p],u8[p+1]); p+=2; let vlen;
    if(VR4.has(vr)){ p+=2; vlen=dv.getUint32(p,true); p+=4; } else { vlen=dv.getUint16(p,true); p+=2; }
    if(group===0x0002&&elem===0x0010) transferSyntax=new TextDecoder('latin1').decode(u8.subarray(p,p+vlen)).replace(/\0+$/,'').trim();
    p+=vlen;
  }
  const tsInfo=TS_UNCOMPRESSED[transferSyntax]||null;
  const implicit=tsInfo?tsInfo.implicit:false, big=tsInfo?tsInfo.big:false;
  const tags={}; let pixelInfo=null;
  function tagStr(g,e){ return ("0000"+g.toString(16)).slice(-4)+","+("0000"+e.toString(16)).slice(-4); }
  while(p+8<=dv.byteLength){
    const group=dv.getUint16(p,big?false:true), elem=dv.getUint16(p+2,big?false:true); p+=4;
    let vr=null,vlen;
    if(implicit){ vlen=dv.getUint32(p,big?false:true); p+=4; }
    else { vr=String.fromCharCode(u8[p],u8[p+1]); p+=2;
      if(VR4.has(vr)){ p+=2; vlen=dv.getUint32(p,big?false:true); p+=4; } else { vlen=dv.getUint16(p,big?false:true); p+=2; } }
    if(group===0x7FE0&&elem===0x0010){
      pixelInfo={offset:p,len:vlen,vr,encapsulated:(vlen===0xFFFFFFFF)}; break;
    }
    if(vlen===0xFFFFFFFF){ // SQ undefined length → 종료 구분자까지 스킵
      while(p+8<=dv.byteLength){ const g2=dv.getUint16(p,true),e2=dv.getUint16(p+2,true); if(g2===0xFFFE&&e2===0xE0DD){ p+=8; break; } p+=2; }
      continue;
    }
    const key=tagStr(group,elem);
    if(WANT[key]) tags[key]={raw:u8.subarray(p,p+vlen),vr,vlen};
    p+=vlen;
  }
  // charset 판정: ISO_IR 192 = UTF-8, 그 외(또는 미선언)는 한국 PACS 관행상 EUC-KR
  let charsetRaw=tags["0008,0005"]?new TextDecoder('latin1').decode(tags["0008,0005"].raw).replace(/\0+$/,'').trim():"";
  const isUtf8=/192/.test(charsetRaw);
  const useEucKr=!isUtf8; // UTF-8 선언이 있으면 EUC-KR 끔

  function str(key){ const t=tags[key]; if(!t) return ""; if(isUtf8){ try{ return new TextDecoder('utf-8').decode(t.raw).replace(/\0+$/,'').trim(); }catch(e){} } return decStr(t.raw,useEucKr); }
  function num(key){ const t=tags[key]; if(!t) return null; const d=new DataView(t.raw.buffer,t.raw.byteOffset,t.raw.byteLength);
    if(t.vr==="US") return d.getUint16(0,big?false:true);
    if(t.vr==="SS") return d.getInt16(0,big?false:true);
    if(t.vr==="UL") return d.getUint32(0,big?false:true);
    const s=decStr(t.raw,false); const v=parseFloat(s.split('\\')[0]); return isNaN(v)?null:v; }

  const info={
    transferSyntax,
    patientID:str("0010,0020"), patientNameRaw:str("0010,0010"),
    birthDate:str("0010,0030"), sex:str("0010,0040"), patientAge:str("0010,1010"),
    studyDescription:str("0008,1030"), seriesDescription:str("0008,103e"),
    modality:str("0008,0060"), bodyPart:str("0018,0015"),
    studyDate:str("0008,0020"), studyTime:str("0008,0030"),
    seriesNumber:str("0020,0011"), instanceNumber:str("0020,0013"), viewPosition:str("0018,5101"),
    referringPhysician:str("0008,0090"), performingPhysician:str("0008,1050"),
    operators:str("0008,1070"), institution:str("0008,0080"),
    accession:str("0008,0050"), studyID:str("0020,0010"), sopUID:str("0008,0018"),
    rows:num("0028,0010"), columns:num("0028,0011"),
    bitsAllocated:num("0028,0100"), bitsStored:num("0028,0101"), highBit:num("0028,0102"),
    pixelRepresentation:num("0028,0103")||0, samplesPerPixel:num("0028,0002")||1,
    planarConfig:num("0028,0006")||0,
    photometric:str("0028,0004")||"MONOCHROME2",
    windowCenter:num("0028,1050"), windowWidth:num("0028,1051"),
    rescaleIntercept:num("0028,1052"), rescaleSlope:num("0028,1053"),
    pixelSpacing:(function(){ const s=str("0028,0030")||str("0018,1164"); if(!s) return null; const v=parseFloat((""+s).split('\\')[0]); return (v>0)?v:null; })(),
  };
  return {info,tags,pixelInfo,u8,implicit,big};
}

function decStr(raw,useEucKr){
  if(useEucKr){ try{ return new TextDecoder('euc-kr').decode(raw).replace(/\0+$/,'').trim(); }catch(e){} }
  return new TextDecoder('latin1').decode(raw).replace(/\0+$/,'').trim();
}

/* PersonName: "성^명^^^" → "성명" / 영문 "Lastname^Firstname" → "Firstname Lastname" */
function formatName(raw){
  if(!raw) return "";
  const comp=raw.split('^');
  const family=(comp[0]||"").trim(), given=(comp[1]||"").trim();
  const hasHangul=/[\uAC00-\uD7A3]/.test(raw);
  if(hasHangul) return (family+given).trim() || raw.replace(/\^+/g,'').trim();
  if(given) return (given+" "+family).trim();
  return family || raw.replace(/\^+$/,'');
}
function formatDate(d){ if(!d||d.length<8) return d||""; return d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6,8); }
function formatTime(t){ if(!t||t.length<4) return t||""; return t.slice(0,2)+":"+t.slice(2,4)+(t.length>=6?(":"+t.slice(4,6)):""); }

/* ---------- 픽셀 디코딩 ---------- */
function getPixels(parsed){
  const {info,pixelInfo,u8,big}=parsed;
  const ts=info.transferSyntax;
  if(TS_JPEGLL.has(ts)){
    // encapsulated: BOT item + frame fragment
    let p=pixelInfo.offset; const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
    function item(){ const g=dv.getUint16(p,true),e=dv.getUint16(p+2,true); if(!(g===0xFFFE&&e===0xE000))return null;
      const ln=dv.getUint32(p+4,true); p+=8; const d=u8.subarray(p,p+ln); p+=ln; return d; }
    item(); // skip BOT
    const frag=item(); if(!frag) throw new Error("JPEG frame not found.");
    const dec=decodeJPEGLossless(frag);
    return {pixels:dec.pixels, width:dec.width, height:dec.height};
  }
  if(TS_UNCOMPRESSED[ts]){
    const W=info.columns, H=info.rows, ba=info.bitsAllocated||16;
    const off=pixelInfo.offset, n=W*H;
    // 컬러(초음파 등): 8bit RGB 3채널. 네이티브(C#)가 YBR/JPEG 를 비압축 RGB 로 변환해 전달한다.
    if((info.samplesPerPixel||1)>=3){
      const rgb=new Uint8Array(n*3);
      if(info.planarConfig===1){ // 평면형 RRR..GGG..BBB
        const pl=n;
        for(let i=0;i<n;i++){ rgb[i*3]=u8[off+i]; rgb[i*3+1]=u8[off+pl+i]; rgb[i*3+2]=u8[off+2*pl+i]; }
      } else {                    // 인터리브드 RGBRGB
        for(let i=0;i<n*3;i++) rgb[i]=u8[off+i];
      }
      return {pixels:rgb, width:W, height:H, color:true};
    }
    const out=new Int32Array(n);
    if(ba===16){ const signed=info.pixelRepresentation===1;
      const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
      for(let i=0;i<n;i++){ out[i]=signed?dv.getInt16(off+i*2,!big):dv.getUint16(off+i*2,!big); } }
    else if(ba===8){ for(let i=0;i<n;i++) out[i]=u8[off+i]; }
    else throw new Error("BitsAllocated "+ba+" 미지원");
    return {pixels:out, width:W, height:H};
  }
  throw new Error("지원하지 않는 압축(Transfer Syntax: "+ts+"). JPEG2000/JPEG-LS 등은 디코딩 불가합니다.");
}

/* window/level 적용 → ImageData(canvas)에 그레이스케일 그리기 */
function renderToCanvas(parsed, canvas){
  const px=getPixels(parsed); const {info}=parsed;
  const W=px.width, H=px.height, data=px.pixels;
  // 컬러(RGB 3채널): window/level 없이 그대로 그린다.
  if(px.color){
    canvas.width=W; canvas.height=H;
    const ctx=canvas.getContext("2d");
    const img=ctx.createImageData(W,H); const o=img.data;
    for(let i=0,n=W*H;i<n;i++){ const j=i*4,k=i*3; o[j]=data[k]; o[j+1]=data[k+1]; o[j+2]=data[k+2]; o[j+3]=255; }
    ctx.putImageData(img,0,0);
    return {width:W,height:H};
  }
  const slope=(info.rescaleSlope!=null?info.rescaleSlope:1), intercept=(info.rescaleIntercept!=null?info.rescaleIntercept:0);
  let wc=info.windowCenter, ww=info.windowWidth;
  const stored=info.bitsStored||14;
  if(wc==null||ww==null||!(ww>0)){ // 기본: 데이터 min/max
    let mn=Infinity,mx=-Infinity; for(let i=0;i<data.length;i++){ const v=data[i]*slope+intercept; if(v<mn)mn=v; if(v>mx)mx=v; }
    wc=(mn+mx)/2; ww=(mx-mn)||1;
  }
  const inv=(info.photometric==="MONOCHROME1");
  const lo=wc-ww/2, hi=wc+ww/2, scale=255/(hi-lo||1);
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext("2d");
  const img=ctx.createImageData(W,H); const o=img.data;
  for(let i=0;i<data.length;i++){
    let v=data[i]*slope+intercept;
    let g=(v-lo)*scale; if(g<0)g=0; else if(g>255)g=255; g=g|0;
    if(inv) g=255-g;
    const j=i*4; o[j]=g; o[j+1]=g; o[j+2]=g; o[j+3]=255;
  }
  ctx.putImageData(img,0,0);
  return {width:W,height:H};
}

function formatSex(s){ if(!s) return ""; const u=(""+s).trim().toUpperCase(); if(u[0]==="M") return "M"; if(u[0]==="F") return "F"; if(u[0]==="O") return "O"; return ""; }
function sexKo(s){ const u=formatSex(s); return u==="M"?"남":u==="F"?"여":u==="O"?"기타":""; }
function ageFrom(patientAge, birthDate, studyDate){
  // PatientAge(예 "042Y") 우선, 없으면 birthDate+studyDate로 계산
  if(patientAge){ const m=(""+patientAge).match(/0*(\d+)\s*([YMWD])?/i); if(m){ const n=parseInt(m[1],10); const u=(m[2]||"Y").toUpperCase(); if(u==="Y") return n; if(u==="M") return Math.floor(n/12); if(u==="W") return Math.floor(n/52); if(u==="D") return Math.floor(n/365); } }
  if(birthDate&&birthDate.length>=8&&studyDate&&studyDate.length>=8){
    const by=+birthDate.slice(0,4),bm=+birthDate.slice(4,6),bd=+birthDate.slice(6,8);
    const sy=+studyDate.slice(0,4),sm=+studyDate.slice(4,6),sd=+studyDate.slice(6,8);
    let a=sy-by; if(sm<bm||(sm===bm&&sd<bd)) a--; if(a>=0&&a<150) return a;
  }
  return null;
}

window.JSHADICOM={ parse, getPixels, renderToCanvas, formatName, formatDate, formatTime, formatSex, sexKo, ageFrom,
  isSupported(ts){ return !!(TS_UNCOMPRESSED[ts]||TS_JPEGLL.has(ts)); } };
})();

