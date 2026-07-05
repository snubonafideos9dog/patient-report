namespace HospitalReport.App.Models;

// 단일 촬영본에 대한 판독 소견 레포트 (참고용 초안).
// EMR 연동 시 문진/차트를 반영해 ClinicalContext에 요약됨.
public class StudyReadingReport
{
    public string Title { get; set; } = string.Empty;
    public string Subtitle { get; set; } = string.Empty;
    public string ClinicalContext { get; set; } = string.Empty;   // 문진/차트 반영 요약(없으면 빈 값)
    public List<ReadingFinding> Findings { get; set; } = new();
    public string Impression { get; set; } = string.Empty;        // 종합 소견/인상
    public List<string> Recommendations { get; set; } = new();    // 권고사항
}

public class ReadingFinding
{
    public string Region { get; set; } = string.Empty;   // 부위/항목
    public List<string> Details { get; set; } = new();   // 소견 불릿
}
