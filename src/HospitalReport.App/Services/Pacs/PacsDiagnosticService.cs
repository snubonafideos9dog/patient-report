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
        var root = _settings.Pacs.RootPath;

        if (string.IsNullOrWhiteSpace(root))
            return "PACS RootPath가 비어 있습니다.";

        if (!Directory.Exists(root))
            return $"PACS 경로를 찾을 수 없습니다: {root}";

        // 폴더 스캔 + DICOM 읽기를 UI 스레드 밖에서 수행 (앱 프리징 방지)
        return await Task.Run(async () =>
        {
            var lines = new List<string> { $"PACS ROOT: {root}" };

            List<string> files;
            try
            {
                files = CollectSampleFiles(root, _settings.Pacs.SearchPattern, take, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return $"PACS ROOT: {root}{Environment.NewLine}(취소됨)";
            }
            catch (Exception ex)
            {
                return $"PACS ROOT: {root}{Environment.NewLine}파일 목록 조회 실패: {ex.Message}";
            }

            lines.Add($"표본 파일 수: {files.Count} (최근 폴더부터 최대 {take}개, 전체 스캔 아님)");
            lines.Add("");

            foreach (var file in files)
            {
                cancellationToken.ThrowIfCancellationRequested();

                lines.Add("========================================");
                lines.Add($"파일: {file}");
                try
                {
                    var dicom = await DicomFile.OpenAsync(file);
                    var ds = dicom.Dataset;

                    lines.Add($"PatientName       : {Get(ds, DicomTag.PatientName)}");
                    lines.Add($"PatientID         : {Get(ds, DicomTag.PatientID)}");
                    lines.Add($"StudyDate         : {Get(ds, DicomTag.StudyDate)}");
                    lines.Add($"Modality          : {Get(ds, DicomTag.Modality)}");
                    lines.Add($"StudyDescription  : {Get(ds, DicomTag.StudyDescription)}");
                    lines.Add($"SeriesDescription : {Get(ds, DicomTag.SeriesDescription)}");
                }
                catch (Exception ex)
                {
                    lines.Add($"읽기 실패: {ex.Message}");
                }
            }

            return string.Join(Environment.NewLine, lines);
        }, cancellationToken);
    }

    // 전체 트리를 정렬/열거하지 않고, 최근(이름 내림차순 = 보통 최신 연월) 폴더부터 표본 파일만 빠르게 수집한다.
    private static List<string> CollectSampleFiles(string root, string pattern, int take, CancellationToken ct)
    {
        var result = new List<string>();

        // 접근 불가 하위폴더는 건너뛰고, 숨김/시스템 파일도 포함
        var recursive = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = 0
        };
        var topOnly = new EnumerationOptions
        {
            RecurseSubdirectories = false,
            IgnoreInaccessible = true,
            AttributesToSkip = 0
        };

        // 스캔 대상: 루트 바로 아래 파일 → 하위폴더(최신 연월 우선)
        var targets = new List<(string dir, EnumerationOptions opts)> { (root, topOnly) };
        try
        {
            foreach (var d in Directory.EnumerateDirectories(root).OrderByDescending(d => d, StringComparer.Ordinal))
                targets.Add((d, recursive));
        }
        catch
        {
            // 하위폴더 열거 실패 시 루트만
        }

        foreach (var (dir, opts) in targets)
        {
            ct.ThrowIfCancellationRequested();
            if (TakeFilesInto(dir, pattern, opts, take, result, ct))
                break; // 목표 개수 채움
        }

        return result;
    }

    // dir에서 파일을 lazy하게 읽어 result에 채운다. take개를 채우면 true.
    private static bool TakeFilesInto(string dir, string pattern, EnumerationOptions opts, int take, List<string> result, CancellationToken ct)
    {
        try
        {
            foreach (var f in Directory.EnumerateFiles(dir, pattern, opts))
            {
                ct.ThrowIfCancellationRequested();
                result.Add(f);
                if (result.Count >= take)
                    return true;
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            // 이 폴더 열거 중 오류는 건너뜀
        }

        return false;
    }

    private static string Get(DicomDataset ds, DicomTag tag) => DicomText.Get(ds, tag);
}
