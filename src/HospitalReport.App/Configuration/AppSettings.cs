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

    // 실시간 감지(PacsWatchService) 옵션.
    // WatchRootPath 가 비면 RootPath 를 감시. (테스트 시 임시 폴더로 대체 가능)
    public string WatchRootPath { get; set; } = string.Empty;
    public int WatchIntervalSeconds { get; set; } = 3;   // 폴링 주기
    public int WatchDebounceSeconds { get; set; } = 4;   // 파일 쓰기가 멈춘 뒤 '완료'로 판단할 대기시간
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
