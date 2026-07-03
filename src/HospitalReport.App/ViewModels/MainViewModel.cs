using System.Windows.Input;
using HospitalReport.App.Helpers;
using HospitalReport.App.Models;
using HospitalReport.App.Services.Interfaces;
using HospitalReport.App.Services.Pacs;

namespace HospitalReport.App.ViewModels;

public class MainViewModel : ObservableObject
{
    private readonly IEmrRepository _emrRepository;
    private readonly IPacsService _pacsService;
    private readonly IClaudeReportService _claudeReportService;
    private readonly PacsDiagnosticService _pacsDiagnosticService;

    private string _patientIdInput = "";
    private string _patientNameInput = "";
    private string _statusMessage = "대기 중";
    private string? _previewImagePath;
    private PatientInfo? _patient;
    private ChartNote? _latestChart;
    private XrayStudy? _latestXray;
    private GeneratedReport? _report;
    private string _diagnosticText = "";
    private bool _isBusy;

    public MainViewModel(
        IEmrRepository emrRepository,
        IPacsService pacsService,
        IClaudeReportService claudeReportService,
        PacsDiagnosticService pacsDiagnosticService)
    {
        _emrRepository = emrRepository;
        _pacsService = pacsService;
        _claudeReportService = claudeReportService;
        _pacsDiagnosticService = pacsDiagnosticService;

        SearchCommand = new AsyncRelayCommand(SearchAsync, () => !IsBusy && !string.IsNullOrWhiteSpace(PatientIdInput));
        GenerateReportCommand = new AsyncRelayCommand(GenerateReportAsync, () => !IsBusy && Patient != null && LatestChart != null && LatestXray != null);
        RunPacsDiagnosticCommand = new AsyncRelayCommand(RunPacsDiagnosticAsync, () => !IsBusy);
    }

    public string PatientIdInput
    {
        get => _patientIdInput;
        set
        {
            if (SetProperty(ref _patientIdInput, value))
                RaiseCommandState();
        }
    }

    public string PatientNameInput
    {
        get => _patientNameInput;
        set => SetProperty(ref _patientNameInput, value);
    }

    public string StatusMessage
    {
        get => _statusMessage;
        set => SetProperty(ref _statusMessage, value);
    }

    public string? PreviewImagePath
    {
        get => _previewImagePath;
        set => SetProperty(ref _previewImagePath, value);
    }

    public PatientInfo? Patient
    {
        get => _patient;
        set
        {
            if (SetProperty(ref _patient, value))
                RaiseCommandState();
        }
    }

    public ChartNote? LatestChart
    {
        get => _latestChart;
        set
        {
            if (SetProperty(ref _latestChart, value))
                RaiseCommandState();
        }
    }

    public XrayStudy? LatestXray
    {
        get => _latestXray;
        set
        {
            if (SetProperty(ref _latestXray, value))
                RaiseCommandState();
        }
    }

    public GeneratedReport? Report
    {
        get => _report;
        set => SetProperty(ref _report, value);
    }

    public string DiagnosticText
    {
        get => _diagnosticText;
        set => SetProperty(ref _diagnosticText, value);
    }

    public bool IsBusy
    {
        get => _isBusy;
        set
        {
            if (SetProperty(ref _isBusy, value))
                RaiseCommandState();
        }
    }

    public ICommand SearchCommand { get; }
    public ICommand GenerateReportCommand { get; }
    public ICommand RunPacsDiagnosticCommand { get; }

    private async Task SearchAsync()
    {
        try
        {
            IsBusy = true;
            StatusMessage = "환자/차트/X-ray 조회 중...";
            Report = null;
            PreviewImagePath = null;

            Patient = await _emrRepository.GetPatientAsync(PatientIdInput)
                      ?? new PatientInfo
                      {
                          PatientId = PatientIdInput,
                          PatientName = PatientNameInput
                      };

            LatestChart = await _emrRepository.GetLatestChartAsync(PatientIdInput);

            LatestXray = await _pacsService.GetLatestStudyAsync(PatientIdInput, PatientNameInput);
            if (LatestXray != null)
            {
                PreviewImagePath = await _pacsService.RenderPreviewAsync(LatestXray);
            }

            StatusMessage = $"조회 완료 | 환자: {(Patient?.PatientName ?? "없음")} | 차트: {(LatestChart != null ? "있음" : "없음")} | X-ray: {(LatestXray != null ? "있음" : "없음")}";
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

    private async Task GenerateReportAsync()
    {
        if (Patient == null || LatestChart == null || LatestXray == null)
        {
            StatusMessage = "먼저 환자, 차트, X-ray를 조회해 주세요.";
            return;
        }

        try
        {
            IsBusy = true;
            StatusMessage = "Claude로 경과 레포트 초안 생성 중...";

            Report = await _claudeReportService.GenerateReportAsync(
                Patient,
                LatestChart,
                LatestXray,
                PreviewImagePath);

            StatusMessage = "레포트 초안 생성 완료";
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

    private void RaiseCommandState()
    {
        if (SearchCommand is AsyncRelayCommand sc) sc.RaiseCanExecuteChanged();
        if (GenerateReportCommand is AsyncRelayCommand gc) gc.RaiseCanExecuteChanged();
        if (RunPacsDiagnosticCommand is AsyncRelayCommand dc) dc.RaiseCanExecuteChanged();
    }
}
