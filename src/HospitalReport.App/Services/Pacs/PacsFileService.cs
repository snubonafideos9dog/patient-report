using System.Drawing.Imaging;
using System.IO;
using FellowOakDicom;
using FellowOakDicom.Imaging;
using HospitalReport.App.Configuration;
using HospitalReport.App.Models;
using HospitalReport.App.Services.Interfaces;

namespace HospitalReport.App.Services.Pacs;

public class PacsFileService : IPacsService
{
    private readonly AppSettings _settings;

    public PacsFileService(AppSettings settings)
    {
        _settings = settings;
        Directory.CreateDirectory(_settings.Pacs.PreviewOutputPath);
    }

    public async Task<XrayStudy?> GetLatestStudyAsync(string patientId, string? patientName = null, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(_settings.Pacs.RootPath))
            throw new InvalidOperationException("PACS RootPath가 비어 있습니다.");

        if (!Directory.Exists(_settings.Pacs.RootPath))
            throw new DirectoryNotFoundException($"PACS 경로를 찾을 수 없습니다: {_settings.Pacs.RootPath}");

        var files = Directory.EnumerateFiles(
                _settings.Pacs.RootPath,
                _settings.Pacs.SearchPattern,
                SearchOption.AllDirectories)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .Take(_settings.Pacs.MaxFilesToScan);

        var candidates = new List<XrayStudy>();

        foreach (var file in files)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                var dicom = await DicomFile.OpenAsync(file);
                var ds = dicom.Dataset;

                var dicomPatientId = SafeGet(ds, DicomTag.PatientID);
                var dicomPatientName = SafeGet(ds, DicomTag.PatientName);
                var studyDateRaw = SafeGet(ds, DicomTag.StudyDate);
                var modality = SafeGet(ds, DicomTag.Modality);
                var studyDescription = SafeGet(ds, DicomTag.StudyDescription);
                var seriesDescription = SafeGet(ds, DicomTag.SeriesDescription);
                var sopUid = SafeGet(ds, DicomTag.SOPInstanceUID);

                if (!IsPatientMatch(patientId, patientName, dicomPatientId, dicomPatientName))
                    continue;

                var score = CalculateMatchScore(modality, studyDescription, seriesDescription);

                candidates.Add(new XrayStudy
                {
                    FilePath = file,
                    PatientId = dicomPatientId,
                    PatientName = dicomPatientName,
                    StudyDate = ParseDicomDate(studyDateRaw),
                    Modality = modality,
                    StudyDescription = studyDescription,
                    SeriesDescription = seriesDescription,
                    SopInstanceUid = sopUid,
                    MatchScore = score
                });
            }
            catch
            {
                // 읽기 실패 파일은 건너뜀
            }
        }

        return candidates
            .OrderByDescending(x => x.MatchScore)
            .ThenByDescending(x => x.StudyDate ?? DateTime.MinValue)
            .ThenByDescending(x => File.GetLastWriteTimeUtc(x.FilePath))
            .FirstOrDefault();
    }

    public async Task<string?> RenderPreviewAsync(XrayStudy study, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(study.FilePath) || !File.Exists(study.FilePath))
            return null;

        return await Task.Run(() =>
        {
            var safeName = string.IsNullOrWhiteSpace(study.SopInstanceUid)
                ? Guid.NewGuid().ToString("N")
                : SanitizeFileName(study.SopInstanceUid);

            var outputPath = Path.Combine(_settings.Pacs.PreviewOutputPath, $"{safeName}.png");

            var image = new DicomImage(study.FilePath);
            using var bitmap = image.RenderImage().AsClonedBitmap();
            bitmap.Save(outputPath, ImageFormat.Png);

            return outputPath;
        }, cancellationToken);
    }

    private static string SafeGet(DicomDataset ds, DicomTag tag)
    {
        try
        {
            return ds.GetSingleValueOrDefault(tag, "");
        }
        catch
        {
            return "";
        }
    }

    private static bool IsPatientMatch(string patientId, string? patientName, string dicomPatientId, string dicomPatientName)
    {
        if (!string.IsNullOrWhiteSpace(patientId) &&
            !string.IsNullOrWhiteSpace(dicomPatientId) &&
            string.Equals(patientId.Trim(), dicomPatientId.Trim(), StringComparison.OrdinalIgnoreCase))
            return true;

        if (!string.IsNullOrWhiteSpace(patientName) &&
            !string.IsNullOrWhiteSpace(dicomPatientName) &&
            dicomPatientName.Contains(patientName.Trim(), StringComparison.OrdinalIgnoreCase))
            return true;

        return false;
    }

    private int CalculateMatchScore(string? modality, string? studyDescription, string? seriesDescription)
    {
        int score = 0;

        var m = (modality ?? "").Trim().ToUpperInvariant();
        if (m is "CR" or "DX" or "DR" or "XRAY")
            score += 30;

        var combined = $"{studyDescription} {seriesDescription}".ToLowerInvariant();

        foreach (var keyword in _settings.Pacs.PreferredSeriesKeywords)
        {
            if (!string.IsNullOrWhiteSpace(keyword) && combined.Contains(keyword.ToLowerInvariant()))
                score += 20;
        }

        if (combined.Contains("ap")) score += 5;
        if (combined.Contains("lat")) score += 5;

        return score;
    }

    private static DateTime? ParseDicomDate(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || raw.Length < 8)
            return null;

        if (int.TryParse(raw[..4], out var y) &&
            int.TryParse(raw.Substring(4, 2), out var m) &&
            int.TryParse(raw.Substring(6, 2), out var d))
        {
            try
            {
                return new DateTime(y, m, d);
            }
            catch
            {
                return null;
            }
        }

        return null;
    }

    private static string SanitizeFileName(string value)
    {
        foreach (var c in Path.GetInvalidFileNameChars())
            value = value.Replace(c, '_');
        return value;
    }
}
