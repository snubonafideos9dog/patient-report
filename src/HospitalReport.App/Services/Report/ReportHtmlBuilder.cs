using System.IO;
using System.Net;
using System.Text;
using HospitalReport.App.Models;

namespace HospitalReport.App.Services.Report;

// PostureAnalysisReport + 전/후 × 전면/측면 이미지 → 예시 판독지 레이아웃 HTML.
// 메인 사진 옆 위치 라벨 + 부위별 크롭 전/후 비교(변화 한눈에 보기)를 포함.
public static class ReportHtmlBuilder
{
    public static string Build(
        PostureAnalysisReport report,
        PatientInfo patient,
        StudyItem beforeStudy,
        StudyItem afterStudy,
        ComparisonImageSet images)
    {
        var afterFront = ImageUtil.ToDataUri(images.AfterFrontal ?? "", 1100);
        var afterLat = ImageUtil.ToDataUri(images.AfterLateral ?? "", 1100);

        string BeforeSrc(bool lat) => (lat ? images.BeforeLateral : images.BeforeFrontal) ?? "";
        string AfterSrc(bool lat) => (lat ? images.AfterLateral : images.AfterFrontal) ?? "";

        var summary = new StringBuilder();
        var apAnno = new StringBuilder();
        var latAnno = new StringBuilder();
        var band = new StringBuilder();

        int num = 1;
        foreach (var f in report.Findings)
        {
            var cls = ChangeClass(f.Change);
            var isLat = (f.View ?? "").Contains("측면");
            var (top, bottom) = ImageUtil.RegionBand(f.Region);
            var center = ImageUtil.RegionCenterPercent(f.Region);

            // 우측 개선 요약
            var details = new StringBuilder();
            foreach (var d in f.Details) details.Append($"<li>{E(d)}</li>");
            summary.Append($$"""
                <div class="fitem {{cls}}">
                  <div class="fnum">{{num}}</div>
                  <div class="fbody">
                    <div class="ftitle">{{E(f.Region)}} <span class="badge {{cls}}">{{E(f.Change)}}</span></div>
                    <ul>{{details}}</ul>
                  </div>
                </div>
                """);

            // 메인 사진 위 위치 라벨 (전면=왼쪽 / 측면=오른쪽)
            var side = isLat ? "r" : "l";
            var target = isLat ? latAnno : apAnno;
            target.Append($"<div class=\"anno {side} {cls}\" style=\"top:{center:0.#}%\"><span class=\"n\">{num}.</span> {E(f.Region)}</div>");

            // 변화 한눈에 보기: 해당 뷰를 부위 밴드로 크롭한 전/후
            var beforeCrop = ImageUtil.CropDataUri(BeforeSrc(isLat), top, bottom, 320);
            var afterCrop = ImageUtil.CropDataUri(AfterSrc(isLat), top, bottom, 320);
            var cap = f.Details.Count > 0 ? f.Details[0] : f.Change;
            band.Append($$"""
                <div class="tcell {{cls}}">
                  <div class="tnum">{{num}}. {{E(f.Region)}}</div>
                  <div class="tpair">
                    {{CropCell(beforeCrop, "치료 전", "before")}}
                    {{CropCell(afterCrop, "치료 후", "after")}}
                  </div>
                  <div class="tcap">{{E(cap)}}</div>
                </div>
                """);

            num++;
        }

        var apStage = Stage("전면 (AP view)", afterFront, apAnno.ToString());
        var latStage = Stage("측면 (Lateral view)", afterLat, latAnno.ToString());

        var assessment = new StringBuilder();
        foreach (var a in report.OverallAssessment)
            assessment.Append($"<li><span class=\"chk\">✓</span>{E(a)}</li>");

        var patientLine = $"{E(patient.PatientName)} · 번호 {E(patient.PatientId)}"
                          + (string.IsNullOrWhiteSpace(patient.Sex) ? "" : $" · {E(patient.Sex)}")
                          + (patient.Age is null ? "" : $" · {patient.Age}세");

        return $$"""
        <!doctype html>
        <html lang="ko">
        <head>
        <meta charset="utf-8">
        <style>
          @page { size: A4; margin: 8mm; }
          * { box-sizing: border-box; }
          body { font-family:'Malgun Gothic','맑은 고딕',sans-serif; color:#1f2937; margin:0; background:#fff; }
          .page { max-width: 1000px; margin:0 auto; padding:8px 6px 26px; }
          header { text-align:center; border-bottom:3px solid #1b5e20; padding-bottom:10px; margin-bottom:14px; }
          header h1 { font-size:25px; color:#12331a; margin:0 0 6px; }
          .subtitle { color:#455a64; margin:0 0 4px; font-size:13px; }
          .patient { color:#607d8b; margin:0; font-size:12px; }
          h2 { font-size:15px; color:#12331a; margin:18px 0 10px; padding:6px 12px; background:#e8f2ea; border-radius:6px; text-align:center; font-weight:bold; }

          .top { display:flex; gap:10px; align-items:stretch; }
          .imgcol { display:flex; gap:10px; flex:1.55; }
          .imgpanel { flex:1; background:#0e1c2b; border-radius:8px; overflow:hidden; display:flex; flex-direction:column; }
          .imgpanel .cap { color:#fff; font-weight:bold; font-size:12px; text-align:center; padding:6px; }
          .stage { position:relative; flex:1; }
          .stage img.main { width:100%; height:100%; object-fit:contain; background:#0e1c2b; max-height:460px; display:block; }
          .stage .none { color:#8aa; text-align:center; padding:60px 8px; font-size:12px; }

          .anno { position:absolute; transform:translateY(-50%); max-width:47%; font-size:9.5px; line-height:1.25;
                  color:#fff; background:rgba(8,18,28,.58); border-radius:4px; padding:2px 5px; }
          .anno .n { font-weight:bold; }
          .anno.l { left:4px; text-align:left; border-left:3px solid; }
          .anno.r { right:4px; text-align:right; border-right:3px solid; }
          .anno.improve { border-color:#66bb6a; } .anno.hold { border-color:#42a5f5; }
          .anno.watch { border-color:#ffca28; } .anno.worse { border-color:#ef5350; }

          .summarycol { flex:1; background:#f6faf6; border:1px solid #dcedc8; border-radius:8px; padding:8px 10px; }
          .summarycol .sh { text-align:center; font-weight:bold; color:#1b5e20; background:#d7ebd9; border-radius:6px; padding:5px; margin-bottom:8px; font-size:13px; }
          .fitem { display:flex; gap:8px; padding:6px 2px; border-bottom:1px dashed #e0e0e0; }
          .fitem:last-child { border-bottom:none; }
          .fnum { flex:0 0 22px; height:22px; border-radius:50%; background:#9e9e9e; color:#fff; font-weight:bold; font-size:12px; text-align:center; line-height:22px; }
          .fitem.improve .fnum { background:#43a047; } .fitem.hold .fnum { background:#1e88e5; }
          .fitem.watch .fnum { background:#f9a825; } .fitem.worse .fnum { background:#e53935; }
          .fbody { flex:1; }
          .ftitle { font-weight:bold; font-size:13px; }
          .badge { font-size:10px; font-weight:bold; color:#fff; padding:1px 7px; border-radius:9px; background:#9e9e9e; margin-left:2px; }
          .badge.improve { background:#43a047; } .badge.hold { background:#1e88e5; } .badge.watch { background:#f9a825; } .badge.worse { background:#e53935; }
          .fbody ul { margin:3px 0 0; padding-left:16px; }
          .fbody li { font-size:11.5px; line-height:1.5; color:#374151; }

          .band { display:flex; gap:6px; flex-wrap:wrap; }
          .tcell { flex:1 1 0; min-width:112px; border:1px solid #e5e7eb; border-radius:6px; padding:5px; border-top:3px solid #9e9e9e; }
          .tcell.improve { border-top-color:#43a047; } .tcell.hold { border-top-color:#1e88e5; }
          .tcell.watch { border-top-color:#f9a825; } .tcell.worse { border-top-color:#e53935; }
          .tnum { font-size:11px; font-weight:bold; color:#12331a; margin-bottom:4px; }
          .tpair { display:flex; gap:3px; }
          .tc { flex:1; position:relative; }
          .tc img { width:100%; max-height:150px; object-fit:cover; background:#0e1c2b; border-radius:3px; display:block; }
          .tc .tnone { width:100%; height:110px; background:#0e1c2b; border-radius:3px; }
          .tl { position:absolute; bottom:2px; left:2px; font-size:8.5px; color:#fff; padding:0 4px; border-radius:3px; }
          .tl.before { background:#546e7a; } .tl.after { background:#2e7d32; }
          .tcap { font-size:10px; color:#555; margin-top:4px; line-height:1.4; }

          .assessment ul { list-style:none; padding:12px 14px; margin:0; background:#e8f5e9; border-radius:8px; }
          .assessment li { font-size:13px; margin:4px 0; display:flex; gap:8px; }
          .chk { color:#2e7d32; font-weight:bold; }
          .disclaimer { margin-top:20px; padding-top:10px; border-top:1px dashed #cfd8dc; color:#78909c; font-size:11px; line-height:1.5; }
        </style>
        </head>
        <body>
          <div class="page">
            <header>
              <h1>{{E(report.Title)}}</h1>
              <p class="subtitle">{{E(report.Subtitle)}}</p>
              <p class="patient">{{patientLine}}</p>
            </header>

            <div class="top">
              <div class="imgcol">
                {{apStage}}
                {{latStage}}
              </div>
              <div class="summarycol">
                <div class="sh">치료 후 개선 요약</div>
                {{summary}}
              </div>
            </div>

            <h2>치료 전 → 치료 후 변화 한눈에 보기</h2>
            <div class="band">{{band}}</div>

            <h2>종합 평가</h2>
            <section class="assessment">
              <p style="margin:0 0 8px;font-size:13px;line-height:1.6;">{{E(report.OverallSummary)}}</p>
              <ul>{{assessment}}</ul>
            </section>

            <footer class="disclaimer">
              ※ 본 분석은 X-ray 상 정렬 변화에 대한 <b>참고 자료(초안)</b>이며 확정 진단이 아닙니다.
              실제 임상 평가는 담당 의사의 의학적 검사 및 환자 증상과 함께 종합적으로 판단합니다.
            </footer>
          </div>
        </body>
        </html>
        """;
    }

    private static string Stage(string caption, string dataUri, string annos)
    {
        var inner = string.IsNullOrEmpty(dataUri)
            ? "<div class=\"none\">해당 뷰 영상 없음</div>"
            : $"<img class=\"main\" src=\"{dataUri}\" alt=\"{E(caption)}\">";
        return $"<div class=\"imgpanel\"><div class=\"cap\">{E(caption)}</div><div class=\"stage\">{inner}{annos}</div></div>";
    }

    private static string CropCell(string uri, string label, string labelCls)
    {
        var body = string.IsNullOrEmpty(uri) ? "<div class=\"tnone\"></div>" : $"<img src=\"{uri}\">";
        return $"<div class=\"tc\">{body}<span class=\"tl {labelCls}\">{E(label)}</span></div>";
    }

    private static string ChangeClass(string? change) => (change ?? "").Trim() switch
    {
        "개선" => "improve",
        "유지" => "hold",
        "관찰필요" => "watch",
        "악화" => "worse",
        _ => "hold"
    };

    private static string E(string? s) => WebUtility.HtmlEncode(s ?? string.Empty);

    public static string WriteToTempFile(string html, string outputDir)
    {
        Directory.CreateDirectory(outputDir);
        var path = Path.Combine(outputDir, "report_preview.html");
        File.WriteAllText(path, html, new UTF8Encoding(false));
        return path;
    }
}
