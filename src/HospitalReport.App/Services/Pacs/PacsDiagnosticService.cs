using System.IO;
using FellowOakDicom;
using HospitalReport.App.Configuration;

namespace HospitalReport.App.Services.Pacs;

public class PacsDiagnosticService
{
    private readonly AppSettings _settings;

    public PacsDiagnosticService(AppSettings settings)
    {
        _settings = settings;
    }

    public async Task<string> RunAsync(int take = 20, CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(_settings.Pacs.RootPath))
            return $"PACS 경로를 찾을 수 없습니다: {_settings.Pacs.RootPath}";

        var files = Directory.EnumerateFiles(
                _settings.Pacs.RootPath,
                _settings.Pacs.SearchPattern,
                SearchOption.AllDirectories)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .Take(take)
            .ToList();

        var lines = new List<string>
        {
            $"PACS ROOT: {_settings.Pacs.RootPath}",
            $"검사 파일 수: {files.Count}",
            ""
        };

        foreach (var file in files)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                var dicom = await DicomFile.OpenAsync(file);
                var ds = dicom.Dataset;

                lines.Add("========================================");
                lines.Add($"파일: {file}");
                lines.Add($"PatientName       : {Get(ds, DicomTag.PatientName)}");
                lines.Add($"PatientID         : {Get(ds, DicomTag.PatientID)}");
                lines.Add($"StudyDate         : {Get(ds, DicomTag.StudyDate)}");
                lines.Add($"Modality          : {Get(ds, DicomTag.Modality)}");
                lines.Add($"StudyDescription  : {Get(ds, DicomTag.StudyDescription)}");
                lines.Add($"SeriesDescription : {Get(ds, DicomTag.SeriesDescription)}");
            }
            catch (Exception ex)
            {
                lines.Add("========================================");
                lines.Add($"파일: {file}");
                lines.Add($"읽기 실패: {ex.Message}");
            }
        }

        return string.Join(Environment.NewLine, lines);
    }

    private static string Get(DicomDataset ds, DicomTag tag)
    {
        try { return ds.GetSingleValueOrDefault(tag, ""); }
        catch { return ""; }
    }
}
