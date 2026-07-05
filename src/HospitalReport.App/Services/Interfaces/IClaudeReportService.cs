using HospitalReport.App.Models;

namespace HospitalReport.App.Services.Interfaces;

public interface IClaudeReportService
{
    // chart는 EMR 미연동 시 null 가능. study는 선택된 영상 스터디.
    Task<GeneratedReport> GenerateReportAsync(
        PatientInfo patient,
        ChartNote? chart,
        StudyItem study,
        string? previewImagePath,
        CancellationToken cancellationToken = default);

    // 치료 전/후 × 전면/측면 영상을 비교해 부위별 개선 판독(참고용 초안)을 생성.
    Task<PostureAnalysisReport> GenerateComparisonReportAsync(
        PatientInfo patient,
        StudyItem beforeStudy,
        StudyItem afterStudy,
        ComparisonImageSet images,
        CancellationToken cancellationToken = default);
}
