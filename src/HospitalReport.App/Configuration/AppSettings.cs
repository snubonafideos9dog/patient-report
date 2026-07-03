namespace HospitalReport.App.Configuration;

public class AppSettings
{
    public PacsSettings Pacs { get; set; } = new();
    public EmrDbSettings EmrDb { get; set; } = new();
    public ClaudeSettings Claude { get; set; } = new();
}

public class PacsSettings
{
    public string RootPath { get; set; } = string.Empty;
    public string SearchPattern { get; set; } = "*.dcm";
    public int MaxFilesToScan { get; set; } = 5000;
    public string PreviewOutputPath { get; set; } = string.Empty;
    public List<string> PreferredSeriesKeywords { get; set; } = new();
}

public class EmrDbSettings
{
    public string ConnectionString { get; set; } = string.Empty;
    public string PatientQuery { get; set; } = string.Empty;
    public string LatestChartQuery { get; set; } = string.Empty;
}

public class ClaudeSettings
{
    public string ApiKey { get; set; } = string.Empty;
    public string ApiUrl { get; set; } = "https://api.anthropic.com/v1/messages";
    public string ApiVersion { get; set; } = "2023-06-01";
    public string Model { get; set; } = "claude-sonnet-4-5";
    public int MaxTokens { get; set; } = 1400;
}
