using HospitalReport.App.Models;

namespace HospitalReport.App.Services.Interfaces;

public interface IClaudeReportService
{
    Task<GeneratedReport> GenerateReportAsync(
        PatientInfo patient,
        ChartNote chart,
        XrayStudy xrayStudy,
        string? previewImagePath,
        CancellationToken cancellationToken = default);
}
