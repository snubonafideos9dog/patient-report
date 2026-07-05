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
        Loaded += async (_, _) =>
        {
            try { await ReportView.EnsureCoreWebView2Async(); } catch { /* 런타임 미설치 등 */ }
        };
    }

    private void OnOpenViewer(ViewerRequest req)
    {
        var win = new ImageViewerWindow(req.Files, req.StartIndex, req.Render, req.Title) { Owner = this };
        win.Show();
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
