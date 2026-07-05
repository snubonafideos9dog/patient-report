using System.Text;
using FellowOakDicom;

namespace HospitalReport.App.Services.Pacs;

// DICOM 텍스트(환자명, 검사설명 등)를 안전하게 읽는다.
//
// 문제: 한국 PACS는 장비마다 문자셋 처리가 제각각이다.
//  - US(초음파) 등은 한글을 올바른 문자셋으로 기록 → fo-dicom이 정상 디코딩
//  - CR(X-ray) 등은 한글을 CP949(EUC-KR)로 저장하면서 SpecificCharacterSet을
//    'ISO 2022 IR 6'(ASCII)로 잘못 기록 → fo-dicom이 '?'로 깨뜨림
//
// 그래서 무조건 CP949로 강제하면 정상(US) 값을 오히려 깨뜨린다. 대신:
//  1) fo-dicom이 선언된 문자셋으로 디코딩한 값을 먼저 취하고,
//  2) 원본 바이트에 0x80 이상(멀티바이트 한글)이 있는데 결과가 순수 ASCII면
//     (= 디코딩 실패) 그때만 CP949로 다시 디코딩한다.
public static class DicomText
{
    private static readonly Encoding Cp949 = ResolveCp949();

    private static Encoding ResolveCp949()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        try { return Encoding.GetEncoding(949); }
        catch { return Encoding.UTF8; }
    }

    public static string Get(DicomDataset ds, DicomTag tag)
    {
        try
        {
            if (!ds.Contains(tag))
                return "";

            var declared = ds.GetSingleValueOrDefault(tag, "");

            if (ds.GetDicomItem<DicomItem>(tag) is DicomElement el && el.Buffer is { } buffer)
            {
                var raw = buffer.Data;
                if (raw is { Length: > 0 } && HasHighByte(raw) && IsPureAscii(declared))
                    return Clean(Cp949.GetString(raw));
            }

            return Clean(declared);
        }
        catch
        {
            try { return Clean(ds.GetSingleValueOrDefault(tag, "")); }
            catch { return ""; }
        }
    }

    private static string Clean(string s) => s.TrimEnd('\0', ' ', '^');

    private static bool HasHighByte(byte[] bytes)
    {
        foreach (var b in bytes)
            if (b > 0x7F) return true;
        return false;
    }

    private static bool IsPureAscii(string s)
    {
        foreach (var c in s)
            if (c > 0x7F) return false;
        return true;
    }
}