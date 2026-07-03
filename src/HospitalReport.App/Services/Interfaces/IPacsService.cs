using HospitalReport.App.Models;

namespace HospitalReport.App.Services.Interfaces;

public interface IPacsService
{
    Task<XrayStudy?> GetLatestStudyAsync(string patientId, string? patientName = null, CancellationToken cancellationToken = default);
    Task<string?> RenderPreviewAsync(XrayStudy study, CancellationToken cancellationToken = default);
}
