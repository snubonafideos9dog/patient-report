using System;
using System.Windows;
using HospitalReport.App.ViewModels;
using Microsoft.Win32;

namespace HospitalReport.App;

public partial class MainWindow : Window
{
    private readonly MainViewModel _viewModel;

    public MainWindow(MainViewModel viewModel)
    {
        InitializeComponent();
        _viewModel = viewModel;
        DataContext = viewModel;

        viewModel.ReportHtmlReady += OnReportHtmlReady;
        viewModel.OpenViewerRequested += OnOpenViewer;
        Loaded += (_, _) =>
        {
            // ReportView(레포트용 WebView2) 초기화는 비차단으로 진행 (JS PACS 오픈을 막지 않도록 분리).
            _ = InitReportViewAsync();
            // 시작하자마자 JS PACS 를 전면(최대화)으로 연다. 창이 자리잡은 뒤 열도록 Background 우선순위로 예약.
            Dispatcher.BeginInvoke(
                new Action(() => OpenJsPacs(_viewModel.PatientIdInput, maximized: true)),
                System.Windows.Threading.DispatcherPriority.Background);
        };
    }

    private async System.Threading.Tasks.Task InitReportViewAsync()
    {
        try { await ReportView.EnsureCoreWebView2Async(); } catch { /* 런타임 미설치 등 */ }
    }

    private void OnOpenViewer(ViewerRequest req)
    {
        var win = new ImageViewerWindow(req.Files, req.StartIndex, req.Render, req.Title) { Owner = this };
        win.Show();
    }

    private JsPacsWindow? _jsPacs;

    private void OpenJsPacs(string? patientId, bool maximized)
    {
        // 이미 열려 있으면 앞으로 가져오기만 한다(중복 생성 방지).
        if (_jsPacs is { IsLoaded: true })
        {
            if (_jsPacs.WindowState == WindowState.Minimized) _jsPacs.WindowState = WindowState.Normal;
            _jsPacs.Activate();
            return;
        }

        _jsPacs = new JsPacsWindow(patientId) { Owner = this };
        if (maximized) _jsPacs.WindowState = WindowState.Maximized;
        _jsPacs.Closed += (_, _) => _jsPacs = null;
        _jsPacs.Show();
    }

    private void OpenJsPacsButton_Click(object sender, RoutedEventArgs e)
    {
        // 메인 창에 입력된 환자번호가 있으면 JS PACS 를 해당 환자 조회 상태로 연다.
        OpenJsPacs(_viewModel.PatientIdInput, maximized: true);
    }

    private async void OnReportHtmlReady(string htmlPath)
    {
        try
        {
            await ReportView.EnsureCoreWebView2Async();
            // 파일 URI로 로드 (대용량 이미지 임베드 대응)
            ReportView.CoreWebView2.Navigate(new Uri(htmlPath).AbsoluteUri);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"레포트 표시 실패: {ex.Message}");
        }
    }

    private async void SavePdfButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            await ReportView.EnsureCoreWebView2Async();

            var dlg = new SaveFileDialog
            {
                Filter = "PDF 파일 (*.pdf)|*.pdf",
                FileName = $"판독레포트_{DateTime.Now:yyyyMMdd_HHmmss}.pdf"
            };
            if (dlg.ShowDialog() != true)
                return;

            var ok = await ReportView.CoreWebView2.PrintToPdfAsync(dlg.FileName, null);
            _viewModel.StatusMessage = ok ? $"PDF 저장 완료: {dlg.FileName}" : "PDF 저장 실패";
        }
        catch (Exception ex)
        {
            MessageBox.Show($"PDF 저장 실패: {ex.Message}");
        }
    }
}
