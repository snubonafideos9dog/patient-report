using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

namespace HospitalReport.App.Services.Report;

// PNG 미리보기를 축소/크롭/JPEG 변환. Claude 이미지 한도(5MB) 및 PDF 용량, 부위별 크롭에 사용.
public static class ImageUtil
{
    public static byte[] ToResizedJpeg(string path, int maxEdge, long quality = 82L)
    {
        using var src = new Bitmap(path);
        return EncodeResizedJpeg(src, maxEdge, quality);
    }

    public static string ToDataUri(string path, int maxEdge)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            return string.Empty;
        return "data:image/jpeg;base64," + Convert.ToBase64String(ToResizedJpeg(path, maxEdge));
    }

    // 세로 밴드(top~bottom 비율)로 크롭 후 data URI 반환. 전척추 영상의 부위별 잘라보기용.
    public static string CropDataUri(string path, double topFrac, double bottomFrac, int maxEdge)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            return string.Empty;

        using var src = new Bitmap(path);
        int y = Math.Clamp((int)Math.Round(src.Height * topFrac), 0, Math.Max(0, src.Height - 1));
        int y2 = Math.Clamp((int)Math.Round(src.Height * bottomFrac), y + 1, src.Height);
        var rect = new Rectangle(0, y, src.Width, y2 - y);

        using var crop = src.Clone(rect, PixelFormat.Format24bppRgb);
        return "data:image/jpeg;base64," + Convert.ToBase64String(EncodeResizedJpeg(crop, maxEdge, 82L));
    }

    private static byte[] EncodeResizedJpeg(Bitmap src, int maxEdge, long quality)
    {
        double scale = Math.Min(1.0, (double)maxEdge / Math.Max(src.Width, src.Height));
        int nw = Math.Max(1, (int)Math.Round(src.Width * scale));
        int nh = Math.Max(1, (int)Math.Round(src.Height * scale));

        using var dst = new Bitmap(nw, nh);
        using (var g = Graphics.FromImage(dst))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImage(src, 0, 0, nw, nh);
        }

        var encoder = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        using var ps = new EncoderParameters(1);
        ps.Param[0] = new EncoderParameter(Encoder.Quality, quality);

        using var ms = new MemoryStream();
        dst.Save(ms, encoder, ps);
        return ms.ToArray();
    }

    // 소견 부위명 → 전척추 영상에서의 세로 밴드(top,bottom) 비율. (0=위/머리, 1=아래/골반)
    public static (double top, double bottom) RegionBand(string? region)
    {
        var r = region ?? "";
        if (r.Contains("머리") || r.Contains("두부") || r.Contains("전방 자세") || r.Contains("전방자세")) return (0.00, 0.22);
        if (r.Contains("경추") || r.Contains("목")) return (0.02, 0.26);
        if (r.Contains("흉추") || r.Contains("등")) return (0.16, 0.52);
        if (r.Contains("요추") || r.Contains("허리")) return (0.44, 0.74);
        if (r.Contains("골반") || r.Contains("천골") || r.Contains("고관절") || r.Contains("전방 이동")) return (0.62, 1.00);
        if (r.Contains("체중") || r.Contains("측만") || r.Contains("scolio") || r.Contains("만곡")) return (0.08, 0.98);
        return (0.00, 1.00);
    }

    // 라벨 세로 위치(밴드 중앙 %).
    public static double RegionCenterPercent(string? region)
    {
        var (t, b) = RegionBand(region);
        return (t + b) / 2 * 100.0;
    }
}
