using System.Windows;
using HospitalReport.App.Configuration;
using HospitalReport.App.Services.Ai;
using HospitalReport.App.Services.Emr;
using HospitalReport.App.Services.Interfaces;
using HospitalReport.App.Services.Pacs;
using HospitalReport.App.ViewModels;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace HospitalReport.App;

public partial class App : Application
{
    public static IHost AppHost { get; private set; } = default!;

    protected override async void OnStartup(StartupEventArgs e)
    {
        AppHost = Host.CreateDefaultBuilder()
            .ConfigureAppConfiguration((context, config) =>
            {
                config.SetBasePath(AppContext.BaseDirectory);
                config.AddJsonFile("appsettings.json", optional: false, reloadOnChange: true);
            })
            .ConfigureServices((context, services) =>
            {
                services.Configure<AppSettings>(context.Configuration);
                services.AddSingleton(sp => sp.GetRequiredService<IOptions<AppSettings>>().Value);

                services.AddHttpClient<IClaudeReportService, ClaudeReportService>();

                services.AddSingleton<IEmrRepository, SqlEmrRepository>();
                services.AddSingleton<IPacsService, PacsFileService>();
                services.AddSingleton<PacsDiagnosticService>();

                services.AddSingleton<MainViewModel>();
                services.AddSingleton<MainWindow>();
            })
            .Build();

        await AppHost.StartAsync();

        var window = AppHost.Services.GetRequiredService<MainWindow>();
        window.Show();

        base.OnStartup(e);
    }

    protected override async void OnExit(ExitEventArgs e)
    {
        if (AppHost != null)
        {
            await AppHost.StopAsync();
            AppHost.Dispose();
        }

        base.OnExit(e);
    }
}
