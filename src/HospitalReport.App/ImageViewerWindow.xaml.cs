using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using HospitalReport.App.Helpers;

namespace HospitalReport.App;

public partial class ImageViewerWindow : Window
{
    private readonly IReadOnlyList<string> _files;
    private readonly Func<string, CancellationToken, Task<string?>> _render;
    private int _index;
    private double _zoom = 1.0;

    private bool _panning;
    private Point _panStart;
    private Vector _panOrigin;

    public ImageViewerWindow(
        IReadOnlyList<string> dicomFiles,
        int startIndex,
        Func<string, CancellationToken, Task<string?>> render,
        string titlePrefix)
    {
        InitializeComponent();
        _files = dicomFiles;
        _render = render;
        _index = startIndex;
        Title = $"{titlePrefix} — 영상 뷰어";

        Loaded += async (_, _) => await ShowAsync(_index);
    }

    private async Task ShowAsync(int index)
    {
        if (_files.Count == 0) { InfoText.Text = "표시할 영상이 없습니다."; return; }

        _index = Math.Clamp(index, 0, _files.Count - 1);
        IndexText.Text = $"{_index + 1} / {_files.Count}";
        PrevBtn.IsEnabled = _index > 0;
        NextBtn.IsEnabled = _index < _files.Count - 1;
        InfoText.Text = "렌더링 중...";

        try
        {
            var png = await _render(_files[_index], CancellationToken.None);
            Img.Source = ImageLoader.LoadNoLock(png);
            InfoText.Text = Path.GetFileName(_files[_index]);
            SetZoom(1.0);
            Scroll.ScrollToHorizontalOffset(0);
            Scroll.ScrollToVerticalOffset(0);
        }
        catch (Exception ex)
        {
            InfoText.Text = "표시 실패: " + ex.Message;
        }
    }

    private async void Prev_Click(object sender, RoutedEventArgs e) => await ShowAsync(_index - 1);
    private async void Next_Click(object sender, RoutedEventArgs e) => await ShowAsync(_index + 1);

    private void SetZoom(double z)
    {
        _zoom = Math.Clamp(z, 0.1, 8.0); // 10% ~ 800% (100% 미만 축소 허용)
        Scale.ScaleX = Scale.ScaleY = _zoom;
        ZoomText.Text = $"{_zoom * 100:0}%";
    }

    private void ZoomIn_Click(object sender, RoutedEventArgs e) => SetZoom(_zoom * 1.2);
    private void ZoomOut_Click(object sender, RoutedEventArgs e) => SetZoom(_zoom / 1.2);
    private void ZoomReset_Click(object sender, RoutedEventArgs e) => SetZoom(1.0);

    private void Scroll_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
    {
        SetZoom(_zoom * (e.Delta > 0 ? 1.15 : 1 / 1.15));
        e.Handled = true;
    }

    private void Scroll_MouseLeftDown(object sender, MouseButtonEventArgs e)
    {
        _panning = true;
        _panStart = e.GetPosition(Scroll);
        _panOrigin = new Vector(Scroll.HorizontalOffset, Scroll.VerticalOffset);
        Scroll.CaptureMouse();
        Scroll.Cursor = Cursors.ScrollAll;
    }

    private void Scroll_MouseMove(object sender, MouseEventArgs e)
    {
        if (!_panning) return;
        var d = e.GetPosition(Scroll) - _panStart;
        Scroll.ScrollToHorizontalOffset(_panOrigin.X - d.X);
        Scroll.ScrollToVerticalOffset(_panOrigin.Y - d.Y);
    }

    private void Scroll_MouseLeftUp(object sender, MouseButtonEventArgs e)
    {
        _panning = false;
        Scroll.ReleaseMouseCapture();
        Scroll.Cursor = Cursors.Arrow;
    }
}
