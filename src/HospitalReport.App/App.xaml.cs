using System.Text;
using System.Windows;
using FellowOakDicom;
using FellowOakDicom.Imaging;
using FellowOakDicom.Imaging.NativeCodec;
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

    private static readonly string DiagLog =
        System.IO.Path.Combine(System.IO.Path.GetTempPath(), "hospitalreport_diag.log");
    private static void Diag(string msg)
    {
        try { System.IO.File.AppendAllText(DiagLog, $"{DateTime.Now:HH:mm:ss.fff} {msg}\n"); } catch { }
    }

    protected override async void OnStartup(StartupEventArgs e)
    {
        try { System.IO.File.WriteAllText(DiagLog, $"--- start {DateTime.Now:HH:mm:ss} ---\n"); } catch { }
        DispatcherUnhandledException += (_, ev) => { Diag("DispatcherUnhandledException: " + ev.Exception); ev.Handled = true; };
        AppDomain.CurrentDomain.UnhandledException += (_, ev) => Diag("AppDomain.UnhandledException: " + ev.ExceptionObject);
        System.Threading.Tasks.TaskScheduler.UnobservedTaskException += (_, ev) => { Diag("UnobservedTaskException: " + ev.Exception); ev.SetObserved(); };
        Exit += (_, ev) => Diag($"Application.Exit code={ev.ApplicationExitCode}\nstack:\n{Environment.StackTrace}");

        // 한글 DICOM 문자셋(ISO 2022 IR 149 / EUC-KR, CP949) 디코딩용 코드페이지 등록
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        // fo-dicom: 영상 렌더러(WinForms Bitmap) + JPEG 등 압축 해제용 네이티브 코덱 등록
        new DicomSetupBuilder()
            .RegisterServices(s => s
                .AddImageManager<WinFormsImageManager>()
                .AddTranscoderManager<NativeTranscoderManager>())
            .Build();

        AppHost = Host.CreateDefaultBuilder()
            .ConfigureAppConfiguration((context, config) =>
            {
                config.SetBasePath(AppContext.BaseDirectory);
                config.AddJsonFile("appsettings.json", optional: false, reloadOnChange: true);
                // 실제 접속 정보/키는 여기(git 제외)에서 덮어쓴다. 없으면 무시.
                config.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);
                config.AddEnvironmentVariables("HOSPITALREPORT_");
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

        // JS PACS 를 앱의 메인 창으로 사용(올인원 허브). 판독 레포트도 JS PACS 안에서 생성된다.
        var window = new JsPacsWindow();
        MainWindow = window;
        ShutdownMode = ShutdownMode.OnMainWindowClose;
        window.WindowState = WindowState.Maximized;
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
