using Dapper;
using HospitalReport.App.Configuration;
using HospitalReport.App.Models;
using HospitalReport.App.Services.Interfaces;
using Microsoft.Data.SqlClient;

namespace HospitalReport.App.Services.Emr;

public class SqlEmrRepository : IEmrRepository
{
    private readonly AppSettings _settings;

    public SqlEmrRepository(AppSettings settings)
    {
        _settings = settings;
    }

    public async Task<PatientInfo?> GetPatientAsync(string patientId, CancellationToken cancellationToken = default)
    {
        await using var conn = new SqlConnection(_settings.EmrDb.ConnectionString);
        await conn.OpenAsync(cancellationToken);

        return await conn.QueryFirstOrDefaultAsync<PatientInfo>(
            new CommandDefinition(
                _settings.EmrDb.PatientQuery,
                new { PatientId = patientId },
                cancellationToken: cancellationToken));
    }

    public async Task<ChartNote?> GetLatestChartAsync(string patientId, CancellationToken cancellationToken = default)
    {
        await using var conn = new SqlConnection(_settings.EmrDb.ConnectionString);
        await conn.OpenAsync(cancellationToken);

        return await conn.QueryFirstOrDefaultAsync<ChartNote>(
            new CommandDefinition(
                _settings.EmrDb.LatestChartQuery,
                new { PatientId = patientId },
                cancellationToken: cancellationToken));
    }
}
