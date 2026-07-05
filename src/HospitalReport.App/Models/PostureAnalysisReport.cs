namespace HospitalReport.App.Models;

// Claude가 생성하는 치료 전/후 영상 비교 판독 결과 (참고용 초안).
public class PostureAnalysisReport
{
    public string Title { get; set; } = string.Empty;          // 예: "X-ray 치료 후 개선 분석"
    public string Subtitle { get; set; } = string.Empty;       // 예: 비교 기간/개요 한 줄
    public string OverallSummary { get; set; } = string.Empty; // 전체 요약 한 단락
    public List<RegionFinding> Findings { get; set; } = new();
    public List<string> OverallAssessment { get; set; } = new(); // 종합평가 체크 항목
}

public class RegionFinding
{
    public string Region { get; set; } = string.Empty;   // 예: "경추 전만", "골반 비대칭"
    public string Change { get; set; } = string.Empty;   // 개선 / 유지 / 관찰필요 / 악화
    public string View { get; set; } = string.Empty;     // 전면 / 측면 / 전면·측면 (해당 소견이 보이는 뷰)
    public List<string> Details { get; set; } = new();   // 부위별 상세 소견(불릿)
}

// 치료 전/후 × 전면(AP)/측면(Lateral) 렌더 이미지 경로 세트.
public record ComparisonImageSet(
    string? BeforeFrontal,
    string? BeforeLateral,
    string? AfterFrontal,
    string? AfterLateral);
