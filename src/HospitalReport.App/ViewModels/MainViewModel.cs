using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Threading;
using System.Windows.Input;
using System.Windows.Media;
using HospitalReport.App.Configuration;
using HospitalReport.App.Helpers;
using HospitalReport.App.Models;
using HospitalReport.App.Services.Interfaces;
using HospitalReport.App.Services.Pacs;
using HospitalReport.App.Services.Report;

namespace HospitalReport.App.ViewModels;

// 확대 뷰어 열기 요청 payload
public record ViewerRequest(
    IReadOnlyList<string> Files,
    int StartIndex,
    string Title,
    Func<string, CancellationToken, Task<string?>> Render);

public class MainViewModel : ObservableObject
{
    private readonly IPacsService _pacsService;
    private readonly IClaudeReportService _claudeReportService;
    private readonly PacsDiagnosticService _pacsDiagnosticService;
    private readonly AppSettings _settings;

    private string _patientIdInput = "";
    private string _statusMessage = "환자번호를 입력하고 [조회]를 누르세요.";
    private ImageSource? _previewImage;
    private int _currentImageIndex;
    private PatientInfo? _patient;
    private StudyItem? _selectedStudy;
    private StudyItem? _beforeStudy;
    private StudyItem? _afterStudy;
    private bool _hasReport;
    private string _diagnosticText = "";
    private bool _isBusy;
    private bool _suppressAccordion;

    public event Action<string>? ReportHtmlReady;
    public event Action<ViewerRequest>? OpenViewerRequested;

    public MainViewModel(
        IPacsService pacsService,
        IClaudeReportService claudeReportService,
        PacsDiagnosticService pacsDiagnosticService,
        AppSettings settings)
    {
        _pacsService = pacsService;
        _claudeReportService = claudeReportService;
        _pacsDiagnosticService = pacsDiagnosticService;
        _settings = settings;

        SearchCommand = new AsyncRelayCommand(SearchAsync, () => !IsBusy && !string.IsNullOrWhiteSpace(PatientIdInput));
        ClearCommand = new RelayCommand(_ => Clear(), _ => !IsBusy);
        SelectItemCommand = new RelayCommand(p => { if (p is StudyItem s) SelectedStudy = s; });
        PrevImageCommand = new AsyncRelayCommand(() => ShowImageAsync(_currentImageIndex - 1), () => CanPrev);
        NextImageCommand = new AsyncRelayCommand(() => ShowImageAsync(_currentImageIndex + 1), () => CanNext);
        OpenViewerCommand = new RelayCommand(_ => OpenViewer(), _ => SelectedStudy is { ImageFiles.Count: > 0 });
        SetBeforeCommand = new AsyncRelayCommand(SetBeforeAsync, () => !IsBusy && SelectedStudy != null);
        SetAfterCommand = new AsyncRelayCommand(SetAfterAsync, () => !IsBusy && SelectedStudy != null);
        GenerateComparisonCommand = new AsyncRelayCommand(GenerateComparisonAsync, () => !IsBusy && BeforeStudy != null && AfterStudy != null);
        RunPacsDiagnosticCommand = new AsyncRelayCommand(RunPacsDiagnosticAsync, () => !IsBusy);
    }

    public ObservableCollection<StudyGroup> Groups { get; } = new();

    public string PatientIdInput
    {
        get => _patientIdInput;
        set { if (SetProperty(ref _patientIdInput, value)) RaiseCommandState(); }
    }

    public string StatusMessage { get => _statusMessage; set => SetProperty(ref _statusMessage, value); }
    public ImageSource? PreviewImage { get => _previewImage; set => SetProperty(ref _previewImage, value); }
    public PatientInfo? Patient { get => _patient; set => SetProperty(ref _patient, value); }
    public string DiagnosticText { get => _diagnosticText; set => SetProperty(ref _diagnosticText, value); }

    public StudyItem? SelectedStudy
    {
        get => _selectedStudy;
        set
        {
            var old = _selectedStudy;
            if (SetProperty(ref _selectedStudy, value))
            {
                if (old != null) old.IsSelected = false;
                if (value != null) value.IsSelected = true;
                RaiseCommandState();
                OnPropertyChanged(nameof(PreviewIndexText));
                _ = OnStudySelectedAsync(value);
            }
        }
    }

    public int CurrentImageIndex
    {
        get => _currentImageIndex;
        private set { if (SetProperty(ref _currentImageIndex, value)) OnPropertyChanged(nameof(PreviewIndexText)); }
    }

    public string PreviewIndexText
    {
        get
        {
            var count = _selectedStudy?.ImageFiles.Count ?? 0;
            return count == 0 ? "-" : $"{_currentImageIndex + 1} / {count}";
        }
    }

    private bool CanPrev => !IsBusy && _selectedStudy is { ImageFiles.Count: > 0 } && _currentImageIndex > 0;
    private bool CanNext => !IsBusy && _selectedStudy is { } s && s.ImageFiles.Count > 0 && _currentImageIndex < s.ImageFiles.Count - 1;

    public StudyItem? BeforeStudy
    {
        get => _beforeStudy;
        set { if (SetProperty(ref _beforeStudy, value)) { OnPropertyChanged(nameof(BeforeLabel)); RaiseCommandState(); } }
    }

    public StudyItem? AfterStudy
    {
        get => _afterStudy;
        set { if (SetProperty(ref _afterStudy, value)) { OnPropertyChanged(nameof(AfterLabel)); RaiseCommandState(); } }
    }

    public string BeforeLabel => _beforeStudy is null ? "(미지정)" : $"{_beforeStudy.DateText}  {_beforeStudy.StudyDescription}";
    public string AfterLabel => _afterStudy is null ? "(미지정)" : $"{_afterStudy.DateText}  {_afterStudy.StudyDescription}";

    public bool HasReport { get => _hasReport; set => SetProperty(ref _hasReport, value); }

    public bool IsBusy
    {
        get => _isBusy;
        set { if (SetProperty(ref _isBusy, value)) RaiseCommandState(); }
    }

    public ICommand SearchCommand { get; }
    public ICommand ClearCommand { get; }
    public ICommand SelectItemCommand { get; }
    public ICommand PrevImageCommand { get; }
    public ICommand NextImageCommand { get; }
    public ICommand OpenViewerCommand { get; }
    public ICommand SetBeforeCommand { get; }
    public ICommand SetAfterCommand { get; }
    public ICommand GenerateComparisonCommand { get; }
    public ICommand RunPacsDiagnosticCommand { get; }

    private async Task SearchAsync()
    {
        try
        {
            IsBusy = true;
            StatusMessage = "촬영 목록 조회 중...";
            ResetState();

            var studies = await _pacsService.GetStudiesForPatientAsync(PatientIdInput.Trim());

            foreach (var g in Groups)
                g.PropertyChanged -= OnGroupPropertyChanged;
            Groups.Clear();

            foreach (var byGroup in studies
                         .GroupBy(s => s.ModalityGroup)
                         .OrderBy(g => StudyItem.GroupOrder(g.Key)))
            {
                var grp = new StudyGroup { GroupName = byGroup.Key, Order = StudyItem.GroupOrder(byGroup.Key) };
                foreach (var s in byGroup)
                    grp.Items.Add(s);
                grp.PropertyChanged += OnGroupPropertyChanged;
                Groups.Add(grp);
            }

            StatusMessage = studies.Count == 0
                ? $"환자번호 '{PatientIdInput}'의 촬영 기록을 찾지 못했습니다."
                : $"촬영 {studies.Count}건 조회 완료 — 종류(아코디언)를 펼쳐 항목을 선택하세요.";
        }
        catch (Exception ex)
        {
            StatusMessage = $"조회 실패: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    // 아코디언: 한 그룹을 펼치면 나머지는 접는다.
    private void OnGroupPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (_suppressAccordion || e.PropertyName != nameof(StudyGroup.IsExpanded)) return;
        if (sender is StudyGroup g && g.IsExpanded)
        {
            _suppressAccordion = true;
            foreach (var other in Groups)
                if (!ReferenceEquals(other, g)) other.IsExpanded = false;
            _suppressAccordion = false;
        }
    }

    private void Clear()
    {
        PatientIdInput = "";
        ResetState();
        StatusMessage = "초기화되었습니다. 환자번호를 입력하고 [조회]를 누르세요.";
    }

    private void ResetState()
    {
        foreach (var g in Groups)
            g.PropertyChanged -= OnGroupPropertyChanged;
        Groups.Clear();
        _selectedStudy = null;
        OnPropertyChanged(nameof(SelectedStudy));
        Patient = null;
        PreviewImage = null;
        CurrentImageIndex = 0;
        BeforeStudy = null; AfterStudy = null;
        HasReport = false;
        OnPropertyChanged(nameof(PreviewIndexText));
        RaiseCommandState();
    }

    private async Task OnStudySelectedAsync(StudyItem? study)
    {
        if (study == null)
        {
            PreviewImage = null;
            return;
        }

        Patient = BuildPatient(study);
        CurrentImageIndex = 0;
        await ShowImageAsync(0);
    }

    private async Task ShowImageAsync(int index)
    {
        var study = _selectedStudy;
        if (study == null || study.ImageFiles.Count == 0)
        {
            PreviewImage = null;
            return;
        }

        try
        {
            IsBusy = true;
            CurrentImageIndex = Math.Clamp(index, 0, study.ImageFiles.Count - 1);
            StatusMessage = $"미리보기 로딩 중... ({PreviewIndexText})";

            var png = await _pacsService.RenderPreviewAsync(study.ImageFiles[CurrentImageIndex]);
            PreviewImage = ImageLoader.LoadNoLock(png);

            StatusMessage = $"{study.DateText} {study.StudyDescription} ({study.ModalityGroup})  {PreviewIndexText}";
        }
        catch (Exception ex)
        {
            StatusMessage = $"미리보기 실패: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private void OpenViewer()
    {
        var study = _selectedStudy;
        if (study == null || study.ImageFiles.Count == 0) return;

        var title = $"{study.DateText} {study.StudyDescription}";
        OpenViewerRequested?.Invoke(new ViewerRequest(
            study.ImageFiles,
            _currentImageIndex,
            title,
            (path, ct) => _pacsService.RenderPreviewAsync(path, ct)));
    }

    private Task SetBeforeAsync()
    {
        var s = SelectedStudy;
        if (s != null)
        {
            BeforeStudy = s;
            StatusMessage = $"치료 전 지정: {s.DateText} {s.StudyDescription}" + (s.HasLateral ? " (전면+측면)" : "");
        }
        return Task.CompletedTask;
    }

    private Task SetAfterAsync()
    {
        var s = SelectedStudy;
        if (s != null)
        {
            AfterStudy = s;
            StatusMessage = $"치료 후 지정: {s.DateText} {s.StudyDescription}" + (s.HasLateral ? " (전면+측면)" : "");
        }
        return Task.CompletedTask;
    }

    private async Task<string?> RenderOrNull(string? dicomPath)
        => string.IsNullOrEmpty(dicomPath) ? null : await _pacsService.RenderPreviewAsync(dicomPath);

    private async Task GenerateComparisonAsync()
    {
        if (BeforeStudy == null || AfterStudy == null)
        {
            StatusMessage = "치료 전/후를 모두 지정하세요.";
            return;
        }

        try
        {
            IsBusy = true;
            HasReport = false;
            StatusMessage = "Claude 비교판독 생성 중... (전면/측면 영상 분석, 수십 초 걸릴 수 있습니다)";

            var patient = BuildPatient(AfterStudy);

            var bf = await RenderOrNull(BeforeStudy.FrontalFile);
            var bl = await RenderOrNull(BeforeStudy.LateralFile);
            var af = await RenderOrNull(AfterStudy.FrontalFile);
            var al = await RenderOrNull(AfterStudy.LateralFile);
            var images = new ComparisonImageSet(bf, bl, af, al);

            var analysis = await _claudeReportService.GenerateComparisonReportAsync(
                patient, BeforeStudy, AfterStudy, images);

            var html = ReportHtmlBuilder.Build(analysis, patient, BeforeStudy, AfterStudy, images);
            var path = ReportHtmlBuilder.WriteToTempFile(html, _settings.Pacs.PreviewOutputPath);

            HasReport = true;
            ReportHtmlReady?.Invoke(path);
            StatusMessage = "비교판독 레포트 생성 완료 — [PDF 저장] 가능";
        }
        catch (Exception ex)
        {
            StatusMessage = $"레포트 생성 실패: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task RunPacsDiagnosticAsync()
    {
        try
        {
            IsBusy = true;
            StatusMessage = "PACS 진단 중...";
            DiagnosticText = await _pacsDiagnosticService.RunAsync();
            StatusMessage = "PACS 진단 완료";
        }
        catch (Exception ex)
        {
            DiagnosticText = ex.ToString();
            StatusMessage = $"PACS 진단 실패: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private PatientInfo BuildPatient(StudyItem study) => new()
    {
        PatientId = study.PatientId,
        PatientName = study.PatientName,
        Sex = NormalizeSex(study.PatientSex),
        BirthDate = study.PatientBirthDate,
        Age = CalcAge(study.PatientBirthDate, study.StudyDate)
    };

    private static string? NormalizeSex(string? s)
        => (s ?? "").Trim().ToUpperInvariant() switch
        {
            "M" => "남",
            "F" => "여",
            "" => null,
            var other => other
        };

    private static int? CalcAge(string? birth, DateTime? refDate)
    {
        if (string.IsNullOrWhiteSpace(birth) || birth.Length < 8)
            return null;
        if (!int.TryParse(birth[..4], out var by) ||
            !int.TryParse(birth.Substring(4, 2), out var bm) ||
            !int.TryParse(birth.Substring(6, 2), out var bd))
            return null;

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

    private void RaiseCommandState()
    {
        (SearchCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        (SetBeforeCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        (SetAfterCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        (GenerateComparisonCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        (RunPacsDiagnosticCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        (PrevImageCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
        (NextImageCommand as AsyncRelayCommand)?.RaiseCanExecuteChanged();
    }
}
