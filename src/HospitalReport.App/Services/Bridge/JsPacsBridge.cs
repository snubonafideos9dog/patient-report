using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using FellowOakDicom;
using FellowOakDicom.Imaging;
using FellowOakDicom.Imaging.Codec;
using FellowOakDicom.IO.Buffer;
using HospitalReport.App.Configuration;
using HospitalReport.App.Models;
using HospitalReport.App.Services.Interfaces;
using HospitalReport.App.Services.Report;

namespace HospitalReport.App.Services.Bridge;

/// <summary>
/// 임베드된 JS PACS(웹 도구)와 네이티브(C#) 사이의 RPC 브리지.
/// 웹의 "환자번호 검색"이 웹 자체 폴더 전체 스캔 대신 네이티브 타겟 조회
/// (PacsFileService, \\서버\sts\YYYYMM\DD\{환자번호})를 쓰도록 하고,
/// DICOM 바이트는 fo-dicom 으로 (압축 포맷 포함) 비압축 변환해 전달한다.
/// 파일 ID = 절대경로.
/// </summary>
public sealed class JsPacsBridge
{
    private readonly IPacsService _pacs;
    private readonly IClaudeReportService _claude;
    private readonly AppSettings _settings;

    // 판독 레포트(HTML 파일)가 생성되면 (htmlPath, 창제목) 을 전달 → JsPacsWindow 가 ReportWindow 를 연다.
    public event Action<string, string>? ReportReady;

    public JsPacsBridge(IPacsService pacs, IClaudeReportService claude, AppSettings settings)
    {
        _pacs = pacs;
        _claude = claude;
        _settings = settings;
    }

    /// <summary>method + JSON params → 결과 객체(직렬화되어 웹으로 반환).</summary>
    public async Task<object?> HandleAsync(string method, JsonElement p, CancellationToken ct = default)
    {
        return method switch
        {
            "searchPatient"    => await SearchPatientAsync(GetStr(p, "patientId"), ct),
            "listToday"        => await ListTodayAsync(ct),
            "getDicom"         => await GetDicomBase64Async(GetStr(p, "id"), ct),
            "getSidecar"       => GetSidecar(GetStr(p, "id")),
            "saveSidecar"      => SaveSidecar(GetStr(p, "id"), GetStr(p, "json")),
            "generateReading"  => await GenerateReadingAsync(p, ct),
            "generateCompare"  => await GenerateCompareAsync(p, ct),
            _ => throw new InvalidOperationException($"알 수 없는 브리지 메서드: {method}")
        };
    }

    private static string GetStr(JsonElement p, string name)
        => p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() ?? ""
            : "";

    // ── 환자번호로 스터디 목록(파일 포함) 반환 ──
    private async Task<object> SearchPatientAsync(string patientId, CancellationToken ct)
    {
        patientId = (patientId ?? "").Trim();
        if (string.IsNullOrEmpty(patientId))
            return new { studies = Array.Empty<object>() };

        var studies = await _pacs.GetStudiesForPatientAsync(patientId, ct);
        UnifyPatientNames(studies);
        return new { studies = studies.Select(MapStudy).ToArray() };
    }

    // ── 오늘 촬영된 모든 스터디(실시간 워크리스트) ──
    private async Task<object> ListTodayAsync(CancellationToken ct)
    {
        var studies = await _pacs.GetStudiesForDayAsync(DateTime.Now, ct);
        UnifyPatientNames(studies);
        return new { studies = studies.Select(MapStudy).ToArray() };
    }

    // 같은 환자의 여러 검사 중 한글 이름이 있으면 그 환자 전체를 한글로 통일.
    // (초음파 등 일부 장비가 이름을 로마자로만 저장 → 같은 환자가 한글/영문 섞여 보이는 문제 완화)
    private static void UnifyPatientNames(IReadOnlyList<StudyItem> studies)
    {
        var best = studies
            .GroupBy(s => s.PatientId ?? "")
            .ToDictionary(g => g.Key, g =>
                g.Select(s => s.PatientName).FirstOrDefault(HasHangul)
                ?? g.Select(s => s.PatientName).FirstOrDefault(n => !string.IsNullOrWhiteSpace(n))
                ?? "");

        foreach (var s in studies)
            if (best.TryGetValue(s.PatientId ?? "", out var bn) && !string.IsNullOrWhiteSpace(bn))
                s.PatientName = bn;
    }

    private static bool HasHangul(string? s)
        => !string.IsNullOrEmpty(s) && s.Any(c => c >= 0xAC00 && c <= 0xD7A3);

    // 흔한 초음파 검사명 로마자 → 한글 (파일에 로마자로만 저장된 경우 표시 개선). 필요 시 추가.
    private static string LocalizeExam(string exam)
    {
        if (string.IsNullOrEmpty(exam)) return exam;
        return exam
            .Replace("GEUNGOLGYEOKGYECHOEUMPA", "근골격계초음파")
            .Replace("(DAEGWANJEOL)", "(대관절)")
            .Replace("(SOGWANJEOL)", "(소관절)")
            .Replace("(JUNGGWANJEOL)", "(중관절)")
            .Replace("SANGBOKBU", "상복부")
            .Replace("HABOKBU", "하복부")
            .Replace("GAPSANGSEON", "갑상선")
            .Replace("SONO", "초음파");
    }

    // StudyItem → 웹 워크리스트용 JSON 객체
    private object MapStudy(StudyItem s)
    {
        var dateStr = s.StudyDate?.ToString("yyyyMMdd") ?? "";
        var dateInt = int.TryParse(dateStr, out var di) ? di : 0;
        var age = CalcAge(s.PatientBirthDate, s.StudyDate);

        var imgs = s.Images.Count > 0
            ? s.Images.Select(i => (path: i.FilePath, view: i.ViewPosition, inst: i.InstanceNumber))
            : s.ImageFiles.Select(f => (path: f, view: "", inst: 0));

        var files = imgs.Where(i => !string.IsNullOrEmpty(i.path)).Select(i => new
        {
            id = i.path,
            name = Path.GetFileName(i.path),
            size = SafeSize(i.path),
            instNum = i.inst.ToString(),
            view = i.view ?? "",
            modality = s.Modality,
            hasAnno = File.Exists(i.path + ".jsha.json")
        }).ToArray();

        return new
        {
            pid = s.PatientId,
            name_ = s.PatientName,
            sex = NormalizeSex(s.PatientSex),
            age,
            birth = s.PatientBirthDate ?? "",
            exam = LocalizeExam(string.IsNullOrWhiteSpace(s.StudyDescription) ? s.ModalityGroup : s.StudyDescription),
            date = dateStr,
            time = s.StudyTimeText,
            dateInt,
            doc = "",
            files
        };
    }

    // ── DICOM → 웹 파서가 읽을 수 있는 형태로 변환 → base64 ──
    //
    // 웹 내장 파서(JSHADICOM)는 흑백(MONOCHROME) 단일 프레임만 처리한다.
    //  · 흑백: (압축이면) Explicit VR LE 비압축으로 트랜스코드 후 그대로 전달.
    //  · 컬러(초음파 YBR/RGB/팔레트) 또는 멀티프레임: 흑백 파서가 잘못 그려
    //    "겹쳐 보이는" 문제가 생긴다 → fo-dicom(DicomImage)으로 프레임0을 올바르게
    //    렌더한 뒤, 비압축 RGB(Explicit VR LE) DICOM 으로 재포장해 전달한다.
    private async Task<string> GetDicomBase64Async(string path, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(path) || !File.Exists(path))
            throw new FileNotFoundException($"DICOM 파일 없음: {path}");

        var file = await DicomFile.OpenAsync(path);
        var ds = file.Dataset;

        var samples = ds.GetSingleValueOrDefault<ushort>(DicomTag.SamplesPerPixel, 1);
        var photometric = ds.GetSingleValueOrDefault(DicomTag.PhotometricInterpretation, "MONOCHROME2");
        var frames = ds.GetSingleValueOrDefault(DicomTag.NumberOfFrames, 1);
        var isColor = samples > 1 ||
            !(photometric.StartsWith("MONOCHROME", StringComparison.OrdinalIgnoreCase));
        var isMultiFrame = frames > 1;

        byte[] bytes;
        if (isColor || isMultiFrame)
        {
            // 컬러/멀티프레임 → 네이티브 렌더 후 비압축 RGB DICOM 재포장 (무거우므로 백그라운드)
            bytes = await Task.Run(() => BuildRenderedRgbDicom(file), ct);
        }
        else
        {
            try
            {
                if (ds.InternalTransferSyntax.IsEncapsulated)
                {
                    // 압축(JPEG/JPEG2000/RLE/JPEG-LS 등) → Explicit VR LE 비압축으로 변환
                    var transcoder = new DicomTranscoder(
                        ds.InternalTransferSyntax, DicomTransferSyntax.ExplicitVRLittleEndian);
                    var xcoded = transcoder.Transcode(file);
                    using var ms = new MemoryStream();
                    await xcoded.SaveAsync(ms);
                    bytes = ms.ToArray();
                }
                else
                {
                    bytes = await File.ReadAllBytesAsync(path, ct);
                }
            }
            catch
            {
                // 변환 실패 시 원본 그대로 전달(웹 파서가 처리 가능하면 처리)
                bytes = await File.ReadAllBytesAsync(path, ct);
            }
        }

        return Convert.ToBase64String(bytes);
    }

    // 컬러/멀티프레임 DICOM 을 fo-dicom 으로 프레임0 렌더 → 비압축 RGB(Explicit VR LE) DICOM 바이트로 생성.
    private static byte[] BuildRenderedRgbDicom(DicomFile file)
    {
        var src = file.Dataset;
        var image = new DicomImage(src);
        using var bmp = image.RenderImage(0).AsClonedBitmap();
        var rgb = BitmapToRgb(bmp, out int w, out int h);

        var outDs = new DicomDataset(DicomTransferSyntax.ExplicitVRLittleEndian);
        // 뷰어 표시에 필요한 메타데이터 태그 복사 (환자/검사 정보, 픽셀 간격 등)
        foreach (var tg in RgbCopyTags)
            if (src.Contains(tg)) outDs.AddOrUpdate(src.GetDicomItem<DicomItem>(tg));

        outDs.AddOrUpdate(DicomTag.PhotometricInterpretation, "RGB");
        outDs.AddOrUpdate(DicomTag.SamplesPerPixel, (ushort)3);
        outDs.AddOrUpdate(DicomTag.PlanarConfiguration, (ushort)0);
        outDs.AddOrUpdate(DicomTag.BitsAllocated, (ushort)8);
        outDs.AddOrUpdate(DicomTag.BitsStored, (ushort)8);
        outDs.AddOrUpdate(DicomTag.HighBit, (ushort)7);
        outDs.AddOrUpdate(DicomTag.PixelRepresentation, (ushort)0);
        outDs.AddOrUpdate(DicomTag.Rows, (ushort)h);
        outDs.AddOrUpdate(DicomTag.Columns, (ushort)w);

        var pd = DicomPixelData.Create(outDs, true);
        pd.AddFrame(new MemoryByteBuffer(rgb));

        using var ms = new MemoryStream();
        new DicomFile(outDs).Save(ms);
        return ms.ToArray();
    }

    private static readonly DicomTag[] RgbCopyTags =
    {
        DicomTag.PatientID, DicomTag.PatientName, DicomTag.PatientBirthDate, DicomTag.PatientSex,
        DicomTag.StudyDate, DicomTag.StudyTime, DicomTag.Modality, DicomTag.StudyDescription,
        DicomTag.SeriesDescription, DicomTag.PixelSpacing, DicomTag.ImagerPixelSpacing,
        DicomTag.SOPClassUID, DicomTag.SOPInstanceUID, DicomTag.InstanceNumber, DicomTag.ViewPosition
    };

    // System.Drawing.Bitmap(32bpp) → 인터리브드 RGB 바이트(3채널).
    private static byte[] BitmapToRgb(Bitmap bmp, out int w, out int h)
    {
        w = bmp.Width; h = bmp.Height;
        var rect = new Rectangle(0, 0, w, h);
        var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var stride = data.Stride;
            var buf = new byte[stride * h];
            Marshal.Copy(data.Scan0, buf, 0, buf.Length);
            var outb = new byte[w * h * 3];
            int oi = 0;
            for (int y = 0; y < h; y++)
            {
                int rowOff = y * stride;
                for (int x = 0; x < w; x++)
                {
                    int p = rowOff + x * 4;      // BGRA
                    outb[oi++] = buf[p + 2];     // R
                    outb[oi++] = buf[p + 1];     // G
                    outb[oi++] = buf[p + 0];     // B
                }
            }
            return outb;
        }
        finally { bmp.UnlockBits(data); }
    }

    // ── 주석 사이드카 읽기/쓰기 (원본 옆 {경로}.jsha.json) ──
    private object? GetSidecar(string id)
    {
        var scPath = id + ".jsha.json";
        return File.Exists(scPath) ? File.ReadAllText(scPath) : null;
    }

    private object SaveSidecar(string id, string json)
    {
        var scPath = id + ".jsha.json";
        File.WriteAllText(scPath, json ?? "");
        return new { ok = true, path = scPath };
    }

    // ── 단일 판독 ──
    private async Task<object> GenerateReadingAsync(JsonElement p, CancellationToken ct)
    {
        var (study, patient) = BuildStudyFromJson(p);
        if (study.ImageFiles.Count == 0)
            throw new InvalidOperationException("판독할 영상이 없습니다.");

        var frontal = await RenderOrNull(study.FrontalFile, ct);
        var lateral = await RenderOrNull(study.LateralFile, ct);

        var reading = await _claude.GenerateStudyReadingReportAsync(patient, null, study, frontal, lateral, ct);
        var html = ReportHtmlBuilder.BuildReading(reading, patient, study, frontal, lateral);
        var path = WriteReport(html);

        ReportReady?.Invoke(path, $"단일 판독 · {patient.PatientName} ({study.DateText})");
        return new { ok = true };
    }

    // ── 전/후 비교 판독 ──
    private async Task<object> GenerateCompareAsync(JsonElement p, CancellationToken ct)
    {
        if (!p.TryGetProperty("before", out var bEl) || !p.TryGetProperty("after", out var aEl))
            throw new InvalidOperationException("전/후 두 검사가 필요합니다.");

        var (before, _) = BuildStudyFromJson(bEl);
        var (after, patient) = BuildStudyFromJson(aEl); // 환자 정보는 최신(after) 기준

        var images = new ComparisonImageSet(
            await RenderOrNull(before.FrontalFile, ct),
            await RenderOrNull(before.LateralFile, ct),
            await RenderOrNull(after.FrontalFile, ct),
            await RenderOrNull(after.LateralFile, ct));

        var analysis = await _claude.GenerateComparisonReportAsync(patient, before, after, images, ct);
        var html = ReportHtmlBuilder.Build(analysis, patient, before, after, images);
        var path = WriteReport(html);

        ReportReady?.Invoke(path, $"전/후 비교 판독 · {patient.PatientName}");
        return new { ok = true };
    }

    // JS 가 넘긴 스터디 JSON → StudyItem + PatientInfo 재구성
    private static (StudyItem study, PatientInfo patient) BuildStudyFromJson(JsonElement s)
    {
        string G(string n) => s.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        int? GI(string n) => s.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

        var pid = G("pid");
        if (string.IsNullOrEmpty(pid)) pid = G("patientId");

        var dateStr = G("date");
        DateTime? studyDate = dateStr.Length >= 8 &&
            DateTime.TryParseExact(dateStr[..8], "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var dt)
            ? dt : null;

        var modality = G("modality");
        var images = new List<StudyImage>();
        var files = new List<string>();
        if (s.TryGetProperty("files", out var fArr) && fArr.ValueKind == JsonValueKind.Array)
        {
            int inst = 0;
            foreach (var f in fArr.EnumerateArray())
            {
                var id = f.TryGetProperty("id", out var iv) ? iv.GetString() ?? "" : "";
                var view = f.TryGetProperty("view", out var vv) ? vv.GetString() ?? "" : "";
                if (string.IsNullOrEmpty(id)) continue;
                files.Add(id);
                images.Add(new StudyImage { FilePath = id, ViewPosition = view, InstanceNumber = inst++ });
            }
        }

        var study = new StudyItem
        {
            PatientId = pid,
            PatientName = G("name"),
            PatientSex = G("sex"),
            PatientBirthDate = G("birth"),
            StudyDate = studyDate,
            Modality = modality,
            ModalityGroup = StudyItem.ToModalityGroup(modality),
            StudyDescription = G("exam"),
            ImageFiles = files,
            Images = images,
            ImageCount = files.Count,
            RepresentativeFilePath = files.FirstOrDefault() ?? ""
        };

        var patient = new PatientInfo
        {
            PatientId = pid,
            PatientName = G("name"),
            Sex = NormalizeSexKo(G("sex")),
            BirthDate = G("birth"),
            Age = GI("age")
        };

        return (study, patient);
    }

    private async Task<string?> RenderOrNull(string? dicomPath, CancellationToken ct)
        => string.IsNullOrEmpty(dicomPath) ? null : await _pacs.RenderPreviewAsync(dicomPath, ct);

    private string WriteReport(string html)
    {
        Directory.CreateDirectory(_settings.Pacs.PreviewOutputPath);
        var path = Path.Combine(_settings.Pacs.PreviewOutputPath, $"report_{DateTime.Now:yyyyMMdd_HHmmss_fff}.html");
        File.WriteAllText(path, html, new System.Text.UTF8Encoding(false));
        return path;
    }

    private static string? NormalizeSexKo(string? s)
        => (s ?? "").Trim().ToUpperInvariant() switch { "M" => "남", "F" => "여", "O" => "기타", _ => null };

    private static long SafeSize(string path)
    {
        try { return new FileInfo(path).Length; } catch { return 0; }
    }

    private static string NormalizeSex(string? s)
        => (s ?? "").Trim().ToUpperInvariant() switch { "M" => "M", "F" => "F", "O" => "O", _ => "" };

    private static int? CalcAge(string? birth, DateTime? refDate)
    {
        if (string.IsNullOrWhiteSpace(birth) || birth.Length < 8) return null;
        if (!int.TryParse(birth[..4], out var by) ||
            !int.TryParse(birth.Substring(4, 2), out var bm) ||
            !int.TryParse(birth.Substring(6, 2), out var bd)) return null;
        try
        {
            var b = new DateTime(by, bm, bd);
            var r = refDate ?? DateTime.Today;
            var age = r.Year - b.Year;
            if (r < b.AddYears(age)) age--;
            return age is < 0 or > 150 ? null : age;
        }
        catch { return null; }
    }
}
