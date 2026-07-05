using System.IO;
using System.Windows.Media.Imaging;

namespace HospitalReport.App.Helpers;

public static class ImageLoader
{
    // 파일을 메모리로 완전히 읽어(BitmapCacheOption.OnLoad) BitmapImage 반환 → 파일 잠금 없음.
    public static BitmapImage? LoadNoLock(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            return null;

        var bmp = new BitmapImage();
        bmp.BeginInit();
        bmp.CacheOption = BitmapCacheOption.OnLoad;
        bmp.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
        bmp.UriSource = new Uri(path);
        bmp.EndInit();
        bmp.Freeze();
        return bmp;
    }
}
