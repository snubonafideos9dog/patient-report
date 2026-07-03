using HospitalReport.App.Models;

namespace HospitalReport.App.Services.Interfaces;

public interface IEmrRepository
{
    Task<PatientInfo?> GetPatientAsync(string patientId, CancellationToken cancellationToken = default);
    Task<ChartNote?> GetLatestChartAsync(string patientId, CancellationToken cancellationToken = default);
}
