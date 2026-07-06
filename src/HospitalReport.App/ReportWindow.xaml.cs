using System;
using System.Windows;
using Microsoft.Win32;

namespace HospitalReport.App;

/// <summary>
/// Claude 판독 레포트(HTML 파일)를 표시하고 PDF 로 저장하는 창.
/// JS PACS 에서 판독을 생성하면 이 창으로 결과를 띄운다.
/// </summary>
public partial class ReportWindow : Window
{
    private readonly string _htmlPath;

    public ReportWindow(string htmlPath, string? title = null)
    {
        InitializeComponent();
        _htmlPath = htmlPath;
        if (!string.IsNullOrWhiteSpace(title)) Title = title;
        Loaded += OnLoaded;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await ReportView.EnsureCoreWebView2Async();
            ReportView.CoreWebView2.Navigate(new Uri(_htmlPath).AbsoluteUri);
        }
        catch (Exception ex)
        {
            StatusText.Text = $"표시 실패: {ex.Message}";
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
            if (dlg.ShowDialog() != true) return;

            var ok = await ReportView.CoreWebView2.PrintToPdfAsync(dlg.FileName, null);
            StatusText.Text = ok ? $"PDF 저장 완료: {dlg.FileName}" : "PDF 저장 실패";
        }
        catch (Exception ex)
        {
            MessageBox.Show($"PDF 저장 실패: {ex.Message}");
        }
    }
}
