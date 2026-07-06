using System;
using System.IO;
using System.Text.Json;
using System.Windows;
using HospitalReport.App.Configuration;
using HospitalReport.App.Services.Bridge;
using HospitalReport.App.Services.Interfaces;
using HospitalReport.App.Services.Watch;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Web.WebView2.Core;

namespace HospitalReport.App;

/// <summary>
/// 웹 도구(JS PACS + Full-Spine Annotation)를 WebView2에 임베드하는 창.
/// 로컬 wwwroot 를 가상 https 호스트로 매핑해 File System Access API·WebCrypto 등
/// 보안 컨텍스트 기능이 동작하도록 한다. 환자번호 검색·DICOM 디코딩(압축 지원)·
/// 주석 저장은 RPC(WebMessage)로 네이티브 <see cref="JsPacsBridge"/> 에 브리지한다.
/// </summary>
public partial class JsPacsWindow : Window
{
    private const string VirtualHost = "appassets.local";
    private const string StartUrl = "https://appassets.local/jspacs/index.html";

    private readonly JsPacsBridge _bridge;
    private readonly PacsWatchService _watch;
    private readonly string? _initialPatientId;

    // 페이지 스크립트보다 먼저 주입되는 RPC 클라이언트.
    // 웹은 window.NativeBridge.call(method, params) 로 네이티브를 호출한다.
    private const string RpcClientJs = @"
(function(){
  window.__NATIVE_HOST__ = true;
  var seq = 0, pending = {};
  try{
    window.chrome.webview.addEventListener('message', function(ev){
      var m = ev.data; if(!m) return;
      if(m.__notify === 'newStudy'){ onNewStudy(m); return; }   // 실시간 감지 알림
      if(m.__rpc == null) return;
      var p = pending[m.__rpc]; if(!p) return; delete pending[m.__rpc];
      if(m.error) p.rej(new Error(m.error)); else p.res(m.result);
    });
  }catch(e){}
  window.NativeBridge = {
    call: function(method, params){
      return new Promise(function(res, rej){
        var id = ++seq; pending[id] = { res:res, rej:rej };
        try{ window.chrome.webview.postMessage({ __rpc:id, method:method, params:params||{} }); }
        catch(e){ delete pending[id]; rej(e); }
      });
    }
  };
  window.b64ToBytes = function(b64){
    var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for(var i=0;i<n;i++) u[i] = bin.charCodeAt(i);
    return u;
  };

  // ===== 실시간 감지: 알림 배너 + 자동 조회 =====
  var _bannerTimer = null;
  function banner(){
    var b = document.getElementById('__nativeNotify');
    if(!b){
      b = document.createElement('div'); b.id = '__nativeNotify';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;'+
        'background:linear-gradient(90deg,#0ea5e9,#2563eb);color:#fff;'+
        'font:600 14px/1.4 -apple-system,system-ui,sans-serif;padding:11px 16px;'+
        'text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.35);cursor:pointer;'+
        'transition:transform .18s ease;transform:translateY(-100%)';
      b.onclick = function(){ hideBanner(); };
      (document.body||document.documentElement).appendChild(b);
    }
    return b;
  }
  function showBanner(text){
    var b = banner(); b.textContent = text;
    requestAnimationFrame(function(){ b.style.transform='translateY(0)'; });
    if(_bannerTimer) clearTimeout(_bannerTimer);
    _bannerTimer = setTimeout(hideBanner, 9000);
  }
  function hideBanner(){ var b=document.getElementById('__nativeNotify'); if(b) b.style.transform='translateY(-100%)'; }
  function onNewStudy(m){
    var parts = ['🔔 새 촬영 감지 · 환자 ' + (m.patientId||'')];
    if(m.name) parts.push('(' + m.name + ')');
    var d = m.desc || m.modality || ''; if(d) parts.push('· ' + d);
    if(m.count) parts.push('· ' + m.count + '매');
    showBanner(parts.join(' '));
    // '오늘 촬영' 실시간 목록이면 자동 새로고침 → 방금 찍은 게 맨 위로 올라옴.
    // (환자 검색 중이면 목록을 건드리지 않고 배너만 표시)
    try{
      if(window.__TODAY_MODE__ && window.__NATIVE_LISTTODAY__){ window.__NATIVE_LISTTODAY__(); }
    }catch(e){}
  }
})();
";

    public JsPacsWindow(string? initialPatientId = null)
    {
        InitializeComponent();
        _initialPatientId = string.IsNullOrWhiteSpace(initialPatientId) ? null : initialPatientId.Trim();

        var pacs = App.AppHost.Services.GetRequiredService<IPacsService>();
        var claude = App.AppHost.Services.GetRequiredService<IClaudeReportService>();
        var settings = App.AppHost.Services.GetRequiredService<AppSettings>();
        _bridge = new JsPacsBridge(pacs, claude, settings);
        _bridge.ReportReady += OnReportReady;

        _watch = new PacsWatchService(settings);
        _watch.NewStudyDetected += OnNewStudyDetected;

        Loaded += OnLoaded;
        Closed += (_, _) => _watch.Dispose();
    }

    // 실시간 감지 → JS PACS 로 알림 전송(상단 배너 + 자동 조회). 타이머 스레드에서 호출되므로 UI 스레드로 마샬.
    private void OnNewStudyDetected(DetectedStudy d)
    {
        try
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(Path.GetTempPath(), "hr_watch.log"),
                    $"{DateTime.Now:HH:mm:ss} DETECTED pid={d.PatientId} name={d.PatientName} desc={d.StudyDesc} mod={d.Modality} count={d.FileCount}\n");
            }
            catch { }

            Dispatcher.BeginInvoke(new Action(() =>
            {
                Reply(new
                {
                    __notify = "newStudy",
                    patientId = d.PatientId,
                    name = d.PatientName,
                    desc = d.StudyDesc,
                    modality = d.Modality,
                    count = d.FileCount,
                    time = d.DetectedAt.ToString("HH:mm:ss")
                });
            }));
        }
        catch { }
    }

    // 판독 레포트 생성 완료 → 리포트 창으로 표시 (WebMessage 처리 중 UI 스레드에서 호출됨)
    private void OnReportReady(string htmlPath, string title)
    {
        try { new ReportWindow(htmlPath, title) { Owner = this }.Show(); }
        catch (Exception ex) { MessageBox.Show($"레포트 표시 실패: {ex.Message}"); }
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            ShowStatus("엔진 초기화 중...");

            // 기본 환경 사용(메인 창 WebView2 와 동일 user-data 폴더 공유).
            await Web.EnsureCoreWebView2Async();

            Web.CoreWebView2.ProcessFailed += (_, args) =>
                ShowStatus($"WebView2 프로세스 오류: {args.ProcessFailedKind}");

            // 페이지 로드 전에 RPC 클라이언트 주입 + 메시지 수신 연결
            await Web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(RpcClientJs);
            Web.CoreWebView2.WebMessageReceived += OnWebMessage;

            var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            if (!Directory.Exists(wwwroot))
                throw new DirectoryNotFoundException($"wwwroot 폴더가 없습니다: {wwwroot}");

            Web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                VirtualHost, wwwroot, CoreWebView2HostResourceAccessKind.Allow);

            Web.CoreWebView2.NavigationCompleted += async (_, args) =>
            {
                if (!args.IsSuccess) { ShowStatus($"로드 실패: {args.WebErrorStatus}"); return; }
                HideStatus();

                // 페이지가 준비됐으니 실시간 감지 시작 (오늘 촬영되는 새 스터디 감지 → 배너+자동조회)
                _watch.Start();

                // 초기 환자번호가 있으면 그 환자 조회, 없으면 '오늘 촬영' 실시간 목록 자동 로드.
                string js;
                if (_initialPatientId != null)
                {
                    var pid = JsonSerializer.Serialize(_initialPatientId); // 안전 이스케이프
                    js =
                        $@"(function(){{
                            var pid={pid};
                            function go(tries){{
                              if(window.__NATIVE_SEARCH__){{ var box=document.getElementById('search'); if(box) box.value=pid; window.__NATIVE_SEARCH__(); return; }}
                              if(tries>0) setTimeout(function(){{ go(tries-1); }}, 150);
                            }}
                            go(30);
                          }})();";
                }
                else
                {
                    js =
                        @"(function(){
                            function go(tries){
                              if(window.__NATIVE_LISTTODAY__){ window.__NATIVE_LISTTODAY__(); return; }
                              if(tries>0) setTimeout(function(){ go(tries-1); }, 150);
                            }
                            go(30);
                          })();";
                }
                try { await Web.CoreWebView2.ExecuteScriptAsync(js); } catch { }
            };
            Web.CoreWebView2.Navigate(StartUrl);
        }
        catch (Exception ex)
        {
            ShowStatus($"초기화 실패: {ex.Message}");
            MessageBox.Show(
                $"JS PACS 로드 실패: {ex.Message}\n\n" +
                "WebView2 런타임이 설치되어 있는지 확인하세요.",
                "오류", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    // 웹 → 네이티브 RPC 처리. UI 스레드에서 실행되며, await 후에도 UI 컨텍스트로 복귀한다.
    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        int id = 0;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            if (root.TryGetProperty("__rpc", out var idEl) && idEl.TryGetInt32(out var parsedId))
                id = parsedId;
            var method = root.TryGetProperty("method", out var mEl) ? mEl.GetString() ?? "" : "";
            var prms = root.TryGetProperty("params", out var pEl) ? pEl : default;

            var result = await _bridge.HandleAsync(method, prms);
            Reply(new { __rpc = id, result });
        }
        catch (Exception ex)
        {
            Reply(new { __rpc = id, error = ex.Message });
        }
    }

    private void Reply(object payload)
    {
        try { Web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(payload)); }
        catch { /* 창이 닫혔거나 WebView 파괴됨 */ }
    }

    private void ShowStatus(string msg)
    {
        StatusText.Text = msg;
        StatusOverlay.Visibility = Visibility.Visible;
    }

    private void HideStatus() => StatusOverlay.Visibility = Visibility.Collapsed;
}
