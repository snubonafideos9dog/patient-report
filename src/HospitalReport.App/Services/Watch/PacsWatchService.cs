using System.IO;
using HospitalReport.App.Configuration;

namespace HospitalReport.App.Services.Watch;

// 감지된 새 촬영 1건.
public sealed record DetectedStudy(
    string PatientId,
    string PatientName,
    string StudyDesc,
    string Modality,
    int FileCount,
    string FolderPath,
    DateTime DetectedAt);

/// <summary>
/// PACS 공유폴더(오늘 날짜)를 주기적으로 폴링해 '새로 들어온 촬영'을 감지한다.
/// 네트워크 공유에서 FileSystemWatcher 는 불안정하므로 폴링 방식을 쓴다.
/// 시작 시점의 기존 스터디는 baseline 처리(알림 안 함), 이후 생성분만 감지.
/// 파일 쓰기가 멈춰 파일 수가 debounce 시간 동안 안정되면 '완료'로 1회 발화.
/// </summary>
public sealed class PacsWatchService : IDisposable
{
    private readonly AppSettings _settings;
    private readonly System.Threading.Timer _timer;
    private readonly object _lock = new();
    private readonly Dictionary<string, FolderState> _seen = new(StringComparer.OrdinalIgnoreCase);
    private bool _baselined;
    private volatile bool _running;

    public event Action<DetectedStudy>? NewStudyDetected;

    private sealed class FolderState
    {
        public int Count;
        public DateTime LastChange;
        public bool Reported;
    }

    public PacsWatchService(AppSettings settings)
    {
        _settings = settings;
        _timer = new System.Threading.Timer(_ => Tick(), null, Timeout.Infinite, Timeout.Infinite);
    }

    public void Start()
    {
        if (_running) return;
        _running = true;
        var interval = Math.Max(1, _settings.Pacs.WatchIntervalSeconds) * 1000;
        _timer.Change(0, interval);
    }

    public void Stop()
    {
        _running = false;
        _timer.Change(Timeout.Infinite, Timeout.Infinite);
    }

    private string WatchRoot =>
        string.IsNullOrWhiteSpace(_settings.Pacs.WatchRootPath)
            ? _settings.Pacs.RootPath
            : _settings.Pacs.WatchRootPath;

    private void Tick()
    {
        if (!_running) return;

        List<DetectedStudy> detected;
        try
        {
            var root = WatchRoot;
            if (string.IsNullOrWhiteSpace(root)) return;

            var now = DateTime.Now;
            var dayDir = Path.Combine(root, now.ToString("yyyyMM"), now.ToString("dd"));

            var debounce = TimeSpan.FromSeconds(Math.Max(1, _settings.Pacs.WatchDebounceSeconds));
            detected = new List<DetectedStudy>();

            lock (_lock)
            {
                // today 폴더가 아직 없어도 첫 tick 에서 baseline 은 확정한다(아래 _baselined=true).
                // 그래야 이후 폴더가 생겼을 때 '새 촬영'으로 감지된다.
                var patientDirs = Directory.Exists(dayDir) ? EnumerateSafe(dayDir) : Enumerable.Empty<string>();
                foreach (var patientDir in patientDirs)
                {
                    int count;
                    try
                    {
                        count = Directory.EnumerateFiles(patientDir, "*.dcm", SearchOption.AllDirectories).Count();
                    }
                    catch { continue; }
                    if (count == 0) continue;

                    if (!_seen.TryGetValue(patientDir, out var st))
                    {
                        // 시작 시점 이전의 폴더는 Reported=true 로 baseline(알림 안 함).
                        st = new FolderState { Count = count, LastChange = now, Reported = !_baselined };
                        _seen[patientDir] = st;
                    }
                    else if (count != st.Count)
                    {
                        st.Count = count;
                        st.LastChange = now;
                        st.Reported = false; // 파일이 늘어나는 중 → 다시 대기
                    }

                    if (!st.Reported && (now - st.LastChange) >= debounce)
                    {
                        st.Reported = true;
                        detected.Add(BuildDetected(patientDir, count));
                    }
                }
                _baselined = true;
            }
        }
        catch
        {
            return; // 일시적 네트워크 오류 등은 다음 주기에 재시도
        }

        foreach (var d in detected)
        {
            try { NewStudyDetected?.Invoke(d); } catch { }
        }
    }

    private static IEnumerable<string> EnumerateSafe(string dir)
    {
        try { return Directory.EnumerateDirectories(dir); }
        catch { return Enumerable.Empty<string>(); }
    }

    // 폴더명 = 환자번호. 모달리티는 하위 폴더명(CR/RF/US/CT...)에서 추출한다.
    // (DICOM 을 열지 않아 빠르고, 한글 인코딩 문제도 없음. 환자명·검사명은 자동조회된 목록에 표시됨)
    private static DetectedStudy BuildDetected(string patientDir, int count)
    {
        var patientId = new DirectoryInfo(patientDir).Name;
        string modality = "";
        try
        {
            modality = string.Join(", ", Directory.EnumerateDirectories(patientDir)
                .Select(d => new DirectoryInfo(d).Name)
                .Where(n => !string.IsNullOrWhiteSpace(n) && n.Length <= 5)  // 모달리티 폴더는 짧음(CR/RF/US/CT/DX/XA...)
                .Distinct());
        }
        catch { }

        return new DetectedStudy(patientId, "", "", modality, count, patientDir, DateTime.Now);
    }

    public void Dispose()
    {
        Stop();
        _timer.Dispose();
    }
}
