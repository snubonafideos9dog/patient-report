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
    private const int MaxFilesToOpen = 500; // 한 환자 조회 시 열어볼 최대 DICOM 수(과도한 이력 방어)

    private readonly AppSettings _settings;

    public PacsFileService(AppSettings settings)
    {
        _settings = settings;
        Directory.CreateDirectory(_settings.Pacs.PreviewOutputPath);
    }

    // 폴더구조(\sts\YYYYMM\DD\{환자번호}\{모달리티}\...)를 이용해 파일을 최소한으로 열어
    // 환자의 스터디 목록을 StudyInstanceUID 단위로 묶어 최신순으로 반환한다.
    public async Task<IReadOnlyList<StudyItem>> GetStudiesForPatientAsync(string patientId, CancellationToken cancellationToken = default)
    {
        var root = _settings.Pacs.RootPath;

        if (string.IsNullOrWhiteSpace(patientId))
            return Array.Empty<StudyItem>();
        if (string.IsNullOrWhiteSpace(root))
            throw new InvalidOperationException("PACS RootPath가 비어 있습니다.");
        if (!Directory.Exists(root))
            throw new DirectoryNotFoundException($"PACS 경로를 찾을 수 없습니다: {root}");

        var pattern = string.IsNullOrWhiteSpace(_settings.Pacs.SearchPattern) ? "*.dcm" : _settings.Pacs.SearchPattern;

        return await Task.Run(async () =>
        {
            var byStudy = new Dictionary<string, StudyItem>(StringComparer.Ordinal);
            var studyFiles = new Dictionary<string, List<(int order, string file, string view)>>(StringComparer.Ordinal);
            int filesOpened = 0;

            List<string> months;
            try
            {
                months = Directory.EnumerateDirectories(root)
                    .OrderByDescending(d => d, StringComparer.Ordinal)
                    .ToList();
            }
            catch
            {
                months = new List<string>();
            }

            foreach (var month in months)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (filesOpened >= MaxFilesToOpen) break;

                foreach (var patientDir in FindPatientDirs(month, patientId))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (filesOpened >= MaxFilesToOpen) break;

                    foreach (var file in EnumerateFilesSafe(patientDir, pattern))
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (filesOpened >= MaxFilesToOpen) break;

                        try
                        {
                            var dicom = await DicomFile.OpenAsync(file);
                            filesOpened++;
                            var ds = dicom.Dataset;

                            var dcmPatientId = SafeGet(ds, DicomTag.PatientID);
                            if (!string.IsNullOrWhiteSpace(dcmPatientId) &&
                                !string.Equals(dcmPatientId.Trim(), patientId.Trim(), StringComparison.OrdinalIgnoreCase))
                                continue; // 폴더명은 맞지만 내용이 다른 환자면 방어적으로 스킵

                            var uid = SafeGet(ds, DicomTag.StudyInstanceUID);
                            var key = string.IsNullOrWhiteSpace(uid) ? file : uid;

                            if (!byStudy.TryGetValue(key, out var item))
                            {
                                var modality = SafeGet(ds, DicomTag.Modality);
                                item = new StudyItem
                                {
                                    PatientId = string.IsNullOrWhiteSpace(dcmPatientId) ? patientId : dcmPatientId,
                                    PatientName = SafeGet(ds, DicomTag.PatientName),
                                    PatientSex = SafeGet(ds, DicomTag.PatientSex),
                                    PatientBirthDate = SafeGet(ds, DicomTag.PatientBirthDate),
                                    StudyInstanceUid = uid,
                                    StudyDate = ParseDicomDate(SafeGet(ds, DicomTag.StudyDate)),
                                    Modality = modality,
                                    ModalityGroup = StudyItem.ToModalityGroup(modality),
                                    StudyDescription = SafeGet(ds, DicomTag.StudyDescription),
                                    SeriesDescription = SafeGet(ds, DicomTag.SeriesDescription),
                                    RepresentativeFilePath = file,
                                    ImageCount = 0
                                };
                                byStudy[key] = item;
                            }

                            item.ImageCount++;

                            var instRaw = SafeGet(ds, DicomTag.InstanceNumber);
                            int order = int.TryParse(instRaw, out var n) ? n : int.MaxValue;
                            var view = SafeGet(ds, DicomTag.ViewPosition);
                            if (!studyFiles.TryGetValue(key, out var flist))
                            {
                                flist = new List<(int, string, string)>();
                                studyFiles[key] = flist;
                            }
                            flist.Add((order, file, view));
                        }
                        catch
                        {
                            // 읽기 실패 파일 스킵
                        }
                    }
                }
            }

            // 스터디별 이미지 파일을 instance 번호(시간순)로 정렬해 채운다.
            foreach (var kv in byStudy)
            {
                if (studyFiles.TryGetValue(kv.Key, out var files) && files.Count > 0)
                {
                    var ordered = files
                        .OrderBy(x => x.order)
                        .ThenBy(x => x.file, StringComparer.Ordinal)
                        .ToList();
                    kv.Value.Images = ordered
                        .Select(x => new StudyImage { FilePath = x.file, ViewPosition = x.view, InstanceNumber = x.order })
                        .ToList();
                    kv.Value.ImageFiles = ordered.Select(x => x.file).ToList();
                    kv.Value.ImageCount = ordered.Count;
                    kv.Value.RepresentativeFilePath = ordered[0].file;
                }
            }

            return (IReadOnlyList<StudyItem>)byStudy.Values
                .OrderBy(s => StudyItem.GroupOrder(s.ModalityGroup))
                .ThenByDescending(s => s.StudyDate ?? DateTime.MinValue)
                .ThenBy(s => s.StudyDescription, StringComparer.Ordinal)
                .ToList();
        }, cancellationToken);
    }

    // 파일 경로 → DICOM 메타 캐시 (파일 내용은 불변이므로 한 번만 읽고 재사용 → 새로고침 빠름)
    private sealed record FileMeta(
        string Uid, string Pid, string Name, string Sex, string Birth,
        DateTime? StudyDate, string Modality, string StudyDesc, string SeriesDesc,
        int Order, string View);

    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, FileMeta> _fileMetaCache = new();

    // ── 특정 날짜 폴더의 모든 환자 스터디(실시간 워크리스트용) ─────────────
    public async Task<IReadOnlyList<StudyItem>> GetStudiesForDayAsync(DateTime day, CancellationToken cancellationToken = default)
    {
        var root = _settings.Pacs.RootPath;
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
            return Array.Empty<StudyItem>();

        var dayDir = Path.Combine(root, day.ToString("yyyyMM"), day.ToString("dd"));
        if (!Directory.Exists(dayDir))
            return Array.Empty<StudyItem>();

        var pattern = string.IsNullOrWhiteSpace(_settings.Pacs.SearchPattern) ? "*.dcm" : _settings.Pacs.SearchPattern;
        var cap = Math.Max(2000, _settings.Pacs.MaxFilesToScan);

        return await Task.Run(() =>
        {
            var byStudy = new Dictionary<string, StudyItem>(StringComparer.Ordinal);
            var studyFiles = new Dictionary<string, List<(int order, string file, string view, DateTime wt)>>(StringComparer.Ordinal);
            int filesOpened = 0;

            foreach (var patientDir in EnumerateDirsSafe(dayDir))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (filesOpened >= cap) break;
                var folderPid = new DirectoryInfo(patientDir).Name;

                foreach (var file in EnumerateFilesSafe(patientDir, pattern))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (filesOpened >= cap) break;

                    if (!_fileMetaCache.TryGetValue(file, out var meta))
                    {
                        meta = ReadFileMeta(file);
                        if (meta != null) _fileMetaCache[file] = meta; // 실패(잠김 등)는 캐시 안 함 → 다음 스캔에 재시도
                    }
                    if (meta == null) continue;
                    filesOpened++;

                    var key = string.IsNullOrWhiteSpace(meta.Uid) ? (Path.GetDirectoryName(file) ?? file) : meta.Uid;
                    if (!byStudy.TryGetValue(key, out var item))
                    {
                        item = new StudyItem
                        {
                            PatientId = string.IsNullOrWhiteSpace(meta.Pid) ? folderPid : meta.Pid,
                            PatientName = meta.Name,
                            PatientSex = meta.Sex,
                            PatientBirthDate = meta.Birth,
                            StudyInstanceUid = meta.Uid,
                            StudyDate = meta.StudyDate ?? day,
                            Modality = meta.Modality,
                            ModalityGroup = StudyItem.ToModalityGroup(meta.Modality),
                            StudyDescription = meta.StudyDesc,
                            SeriesDescription = meta.SeriesDesc,
                            RepresentativeFilePath = file
                        };
                        byStudy[key] = item;
                        studyFiles[key] = new List<(int, string, string, DateTime)>();
                    }
                    studyFiles[key].Add((meta.Order, file, meta.View, SafeWriteTime(file)));
                }
            }

            var newestPerStudy = new Dictionary<string, DateTime>(StringComparer.Ordinal);
            foreach (var kv in byStudy)
            {
                var files = studyFiles[kv.Key];
                var ordered = files.OrderBy(x => x.order).ThenBy(x => x.file, StringComparer.Ordinal).ToList();
                kv.Value.Images = ordered.Select(x => new StudyImage { FilePath = x.file, ViewPosition = x.view, InstanceNumber = x.order }).ToList();
                kv.Value.ImageFiles = ordered.Select(x => x.file).ToList();
                kv.Value.ImageCount = ordered.Count;
                kv.Value.RepresentativeFilePath = ordered[0].file;
                var newest = files.Count > 0 ? files.Max(x => x.wt) : DateTime.MinValue;
                newestPerStudy[kv.Key] = newest;
                kv.Value.StudyTimeText = newest.ToString("HHmmss");
            }

            // 가장 최근에 쓰인 파일 기준 내림차순 → 방금 찍은 게 맨 위로.
            return (IReadOnlyList<StudyItem>)byStudy
                .OrderByDescending(kv => newestPerStudy[kv.Key])
                .Select(kv => kv.Value)
                .ToList();
        }, cancellationToken);
    }

    private FileMeta? ReadFileMeta(string file)
    {
        try
        {
            var ds = DicomFile.Open(file).Dataset;
            int order = int.TryParse(SafeGet(ds, DicomTag.InstanceNumber), out var n) ? n : int.MaxValue;
            return new FileMeta(
                SafeGet(ds, DicomTag.StudyInstanceUID),
                SafeGet(ds, DicomTag.PatientID),
                SafeGet(ds, DicomTag.PatientName),
                SafeGet(ds, DicomTag.PatientSex),
                SafeGet(ds, DicomTag.PatientBirthDate),
                ParseDicomDate(SafeGet(ds, DicomTag.StudyDate)),
                SafeGet(ds, DicomTag.Modality),
                SafeGet(ds, DicomTag.StudyDescription),
                SafeGet(ds, DicomTag.SeriesDescription),
                order,
                SafeGet(ds, DicomTag.ViewPosition));
        }
        catch { return null; }
    }

    private static IEnumerable<string> EnumerateDirsSafe(string dir)
    {
        try { return Directory.EnumerateDirectories(dir); }
        catch { return Enumerable.Empty<string>(); }
    }

    private static DateTime SafeWriteTime(string file)
    {
        try { return File.GetLastWriteTime(file); } catch { return DateTime.MinValue; }
    }

    public async Task<string?> RenderPreviewAsync(string dicomFilePath, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(dicomFilePath) || !File.Exists(dicomFilePath))
            return null;

        return await Task.Run<string?>(() =>
        {
            var safeName = SanitizeFileName(Path.GetFileNameWithoutExtension(dicomFilePath));
            if (string.IsNullOrWhiteSpace(safeName))
                safeName = Guid.NewGuid().ToString("N");

            var outputPath = Path.Combine(_settings.Pacs.PreviewOutputPath, $"{safeName}.png");

            var image = new DicomImage(dicomFilePath);
            using var bitmap = image.RenderImage().AsClonedBitmap();
            bitmap.Save(outputPath, ImageFormat.Png);

            return outputPath;
        }, cancellationToken);
    }

    public Task<string?> RenderPreviewAsync(XrayStudy study, CancellationToken cancellationToken = default)
        => RenderPreviewAsync(study.FilePath, cancellationToken);

    // ── 기존 흐름 호환: 환자의 최신 X-ray 1건 자동 선택 ────────────────
    public async Task<XrayStudy?> GetLatestStudyAsync(string patientId, string? patientName = null, CancellationToken cancellationToken = default)
    {
        var studies = await GetStudiesForPatientAsync(patientId, cancellationToken);

        var best = studies
            .Where(s => s.ModalityGroup == "X-ray")
            .OrderByDescending(s => CalculateMatchScore(s.Modality, s.StudyDescription, s.SeriesDescription))
            .ThenByDescending(s => s.StudyDate ?? DateTime.MinValue)
            .FirstOrDefault()
            ?? studies.FirstOrDefault();

        if (best == null)
            return null;

        return new XrayStudy
        {
            FilePath = best.RepresentativeFilePath,
            PatientId = best.PatientId,
            PatientName = best.PatientName,
            StudyDate = best.StudyDate,
            Modality = best.Modality,
            StudyDescription = best.StudyDescription,
            SeriesDescription = best.SeriesDescription,
            SopInstanceUid = Path.GetFileNameWithoutExtension(best.RepresentativeFilePath),
            MatchScore = CalculateMatchScore(best.Modality, best.StudyDescription, best.SeriesDescription)
        };
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────
    private List<string> FindPatientDirs(string monthDir, string patientId)
    {
        var dirs = new List<string>();
        try
        {
            var direct = Path.Combine(monthDir, patientId);
            if (Directory.Exists(direct)) dirs.Add(direct);

            foreach (var sub in Directory.EnumerateDirectories(monthDir))
            {
                var p = Path.Combine(sub, patientId);
                if (Directory.Exists(p)) dirs.Add(p);
            }
        }
        catch
        {
            // 접근 불가 월 폴더 스킵
        }
        return dirs;
    }

    private static IEnumerable<string> EnumerateFilesSafe(string dir, string pattern)
    {
        try
        {
            return Directory.EnumerateFiles(dir, pattern, new EnumerationOptions
            {
                RecurseSubdirectories = true,
                IgnoreInaccessible = true,
                AttributesToSkip = 0
            });
        }
        catch
        {
            return Enumerable.Empty<string>();
        }
    }

    private static string SafeGet(DicomDataset ds, DicomTag tag) => DicomText.Get(ds, tag);

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