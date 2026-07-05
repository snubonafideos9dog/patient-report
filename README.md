# 환자 경과 레포트 생성기 (HospitalReport.App)

병원 내부망에서 **PACS(DICOM 영상)** 와 **EMR(SQL Server) 차트**를 조회하고, 그 내용을 **Claude AI**에 넘겨 환자에게 전달할 **경과 레포트 초안**(요약·X-ray 설명·치료 경과·재진 안내·카카오/문자용 문구)을 자동 생성하는 **Windows 데스크톱(WPF) 애플리케이션**입니다.

> ⚠️ **의료 보조 도구**입니다. 생성 결과는 **의사 최종 검토 전 단계의 초안**이며, 확진·처방 근거로 사용하지 않습니다.

---

## 목차
1. [주요 기능](#주요-기능)
2. [기술 스택](#기술-스택)
3. [프로젝트 구조](#프로젝트-구조)
4. [동작 흐름](#동작-흐름)
5. [사전 준비물](#사전-준비물)
6. [설정 (appsettings.json)](#설정-appsettingsjson)
7. [빌드 방법](#빌드-방법)
8. [실행 방법](#실행-방법)
9. [사용 방법 (UI)](#사용-방법-ui)
10. [EMR DB 요구 스키마](#emr-db-요구-스키마)
11. [트러블슈팅](#트러블슈팅)
12. [보안 / 개인정보 주의](#보안--개인정보-주의)

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| **환자 조회** | 환자번호로 EMR에서 환자 기본정보 + 최신 차트를 조회 |
| **X-ray 자동 선별** | PACS 폴더(UNC 공유)를 스캔해 해당 환자의 DICOM 중 **가장 관련성 높은 영상**을 점수화하여 선택 |
| **미리보기 렌더링** | 선택된 DICOM을 PNG로 변환해 화면에 표시 |
| **AI 레포트 초안 생성** | 환자·차트·X-ray 정보(+영상 이미지)를 Claude에 전달해 환자 친화적 경과 레포트를 JSON으로 생성 |
| **PACS 진단** | PACS 폴더 접근/DICOM 태그를 점검하는 진단 유틸리티 |

---

## 기술 스택

- **런타임/프레임워크**: .NET 8 (`net8.0-windows`), **WPF** (MVVM 패턴)
- **호스팅/DI**: `Microsoft.Extensions.Hosting` + `Microsoft.Extensions.DependencyInjection`
- **설정**: `Microsoft.Extensions.Configuration` (`appsettings.json`)
- **DB 접근**: `Microsoft.Data.SqlClient` + **Dapper** (읽기 전용 쿼리)
- **DICOM 처리**: **fo-dicom** (`fo-dicom`, `fo-dicom.Imaging.Desktop`)
- **AI**: Anthropic **Claude** Messages API (HTTP 직접 호출, `IHttpClientFactory`)

> 전체 패키지 목록은 [HospitalReport.App.csproj](src/HospitalReport.App/HospitalReport.App.csproj) 참고.

---

## 프로젝트 구조

```
patient-report/
├─ CopyHospitalReport.sln            # 솔루션 파일 (※ 파일명 주의: "Copy" 접두어)
├─ README.md
└─ src/
   └─ HospitalReport.App/
      ├─ HospitalReport.App.csproj
      ├─ appsettings.json            # PACS / EMR / Claude 설정 (실행 시 output 폴더로 복사)
      ├─ App.xaml / App.xaml.cs      # 진입점 + DI 컨테이너 구성 (Generic Host)
      ├─ MainWindow.xaml / .cs       # 메인 화면 (UI)
      ├─ Configuration/
      │  └─ AppSettings.cs           # 설정 바인딩용 POCO
      ├─ Helpers/
      │  ├─ ObservableObject.cs      # INotifyPropertyChanged 베이스
      │  └─ AsyncRelayCommand.cs     # 비동기 ICommand 구현
      ├─ Models/
      │  ├─ PatientInfo.cs           # 환자 기본정보
      │  ├─ ChartNote.cs             # 최신 진료 차트
      │  ├─ XrayStudy.cs             # X-ray(DICOM) 메타 + 매칭 점수
      │  └─ GeneratedReport.cs       # AI 생성 레포트(7개 필드)
      ├─ ViewModels/
      │  └─ MainViewModel.cs         # 화면 로직 (조회/생성/진단 커맨드)
      └─ Services/
         ├─ Interfaces/              # IEmrRepository, IPacsService, IClaudeReportService
         ├─ Emr/SqlEmrRepository.cs  # Dapper 기반 EMR 조회
         ├─ Pacs/PacsFileService.cs  # DICOM 스캔·선별·PNG 렌더링
         ├─ Pacs/PacsDiagnosticService.cs # PACS 폴더 진단
         └─ Ai/ClaudeReportService.cs     # Claude API 호출
```

---

## 동작 흐름

```
[환자번호 입력]
      │
      ▼
① SearchCommand ──► IEmrRepository.GetPatientAsync()      → 환자 기본정보
                └─► IEmrRepository.GetLatestChartAsync()  → 최신 차트
                └─► IPacsService.GetLatestStudyAsync()    → 후보 DICOM 스캔·점수화·최적 1건 선택
                └─► IPacsService.RenderPreviewAsync()      → DICOM → PNG 미리보기
      │
      ▼
② GenerateReportCommand ──► IClaudeReportService.GenerateReportAsync()
      │   - 환자/차트/X-ray 텍스트 + (선택)PNG 이미지를 Claude에 전송
      │   - 시스템 프롬프트로 "환자 친화적·과장 금지·JSON만 출력" 강제
      ▼
③ GeneratedReport(JSON) 파싱 → 화면 각 항목에 표시 (편집 가능)
```

**X-ray 선별 점수 규칙** ([PacsFileService.cs](src/HospitalReport.App/Services/Pacs/PacsFileService.cs)):
- 환자 매칭: DICOM `PatientID` 일치 **또는** `PatientName` 부분 일치
- Modality가 `CR/DX/DR/XRAY` → **+30**
- `PreferredSeriesKeywords`(예: whole spine, 척추, c-spine…) 포함 → 키워드당 **+20**
- 설명에 `ap` → +5, `lat` → +5
- 최종: 점수 → 촬영일 → 파일 수정시각 순으로 정렬해 1건 선택

---

## 사전 준비물

| 항목 | 내용 |
|------|------|
| **OS** | Windows 10/11 (WPF는 **Windows 전용** — Linux/WSL/macOS 실행 불가) |
| **.NET SDK** | .NET 8 이상 (현재 개발 PC엔 SDK 10.0.301 + .NET 8 데스크톱 런타임 8.0.28 설치됨) |
| **PACS 접근** | DICOM 파일이 있는 UNC 공유 폴더 접근 권한 |
| **EMR DB** | SQL Server 읽기 전용 계정 및 조회 뷰/쿼리 |
| **Claude API 키** | Anthropic API Key (`x-api-key`) |

---

## 설정 (appsettings.json)

[src/HospitalReport.App/appsettings.json](src/HospitalReport.App/appsettings.json) 을 환경에 맞게 채웁니다. **현재 값은 자리표시자**라 그대로는 동작하지 않습니다.

```jsonc
{
  "Pacs": {
    "RootPath": "\\\\Desktop-uebgim1\\sts",   // DICOM이 있는 UNC 공유 경로
    "SearchPattern": "*.dcm",
    "MaxFilesToScan": 5000,                     // 최근 수정순 상위 N개만 스캔
    "PreviewOutputPath": "C:\\Temp\\HospitalReportPreviews", // PNG 저장 폴더(자동 생성)
    "PreferredSeriesKeywords": [ "whole spine", "spine", "척추", "c-spine", ... ]
  },
  "EmrDb": {
    "ConnectionString": "Server=...;Database=...;User Id=readonly_user;Password=...;TrustServerCertificate=True;",
    "PatientQuery":     "SELECT TOP 1 ... FROM dbo.vw_patient_basic WHERE patient_no = @PatientId",
    "LatestChartQuery": "SELECT TOP 1 ... FROM dbo.vw_latest_chart  WHERE patient_no = @PatientId ORDER BY visit_date DESC"
  },
  "Claude": {
    "ApiKey":    "YOUR_ANTHROPIC_API_KEY",
    "ApiUrl":    "https://api.anthropic.com/v1/messages",
    "ApiVersion":"2023-06-01",
    "Model":     "claude-sonnet-4-5",
    "MaxTokens": 1400
  }
}
```

> 💡 `appsettings.json`은 `.csproj`에서 `CopyToOutputDirectory=PreserveNewest`로 설정돼 빌드 시 실행 폴더로 복사됩니다.
> 🔐 **API 키·DB 비밀번호는 절대 커밋하지 마세요.** ([보안 주의](#보안--개인정보-주의) 참고)

---

## 빌드 방법

> 이 PC는 `dotnet`이 이미 **User PATH에 등록**되어 있습니다. 새 터미널에서는 `dotnet`만 쳐도 됩니다.
> (PATH 미적용 환경이라면 `dotnet` 대신 `& "C:\Program Files\dotnet\dotnet.exe"` 를 사용)

```powershell
# 1) 패키지 복원
dotnet restore "CopyHospitalReport.sln"

# 2) 빌드
dotnet build "CopyHospitalReport.sln" -c Debug
```

빌드 산출물: `src/HospitalReport.App/bin/Debug/net8.0-windows/HospitalReport.App.exe`

---

## 실행 방법

### 방법 A — 빌드된 exe 직접 실행 (권장, 창이 안 닫힘)
```powershell
Start-Process "src\HospitalReport.App\bin\Debug\net8.0-windows\HospitalReport.App.exe"
```

### 방법 B — dotnet run (본인 대화형 터미널에서)
```powershell
dotnet run --project "src\HospitalReport.App"
```

> ⚠️ **참고**: 이 앱은 `Host.CreateDefaultBuilder()`(콘솔 라이프타임 포함)를 사용합니다.
> 그래서 **비대화형/백그라운드 환경**에서 `dotnet run`으로 띄우면 콘솔이 닫히는 순간 앱도 즉시 종료됩니다.
> **본인이 직접 여는 터미널에서는 정상적으로 창이 뜨고 유지**됩니다. GUI를 확실히 띄우려면 **방법 A**를 쓰세요.

---

## 사용 방법 (UI)

메인 화면 상단에서:

1. **환자번호** 입력 (필수), 필요 시 **환자명(보조)** 입력
   - 환자명은 DICOM `PatientName` 부분 매칭 보조용
2. **[조회]** 클릭 → 환자정보 · 최신 차트 · X-ray + 미리보기 로딩
3. **[레포트 생성]** 클릭 → Claude가 경과 레포트 초안 생성 (조회가 모두 성공해야 활성화)
4. 생성된 각 항목(요약/X-ray 설명/치료 경과/재진 안내/주의사항/카카오 문구)은 **화면에서 직접 수정 가능**
5. **[PACS 진단]** → PACS 폴더 접근 및 DICOM 태그를 점검(경로 오류 진단용)

하단 **상태바**에 진행 상황/오류 메시지가 표시됩니다.

---

## EMR DB 요구 스키마

쿼리는 `appsettings.json`에서 자유롭게 교체 가능하지만, **결과 컬럼 별칭(alias)** 은 아래 모델과 일치해야 Dapper가 매핑합니다.

**환자 (PatientQuery → [PatientInfo](src/HospitalReport.App/Models/PatientInfo.cs))**

| alias | 타입 |
|-------|------|
| `PatientId` | string |
| `PatientName` | string |
| `BirthDate` | string? |
| `Sex` | string? |
| `Age` | int? |

**차트 (LatestChartQuery → [ChartNote](src/HospitalReport.App/Models/ChartNote.cs))**

| alias | 타입 |
|-------|------|
| `VisitDate` | DateTime |
| `DoctorName` | string? |
| `ChiefComplaint` | string? |
| `Assessment` | string? |
| `Plan` | string? |
| `RawText` | string |

> 파라미터명은 `@PatientId` 로 고정입니다.

---

## 트러블슈팅

**`dotnet` 명령을 못 찾음 (`command not found`)**
- `dotnet`이 PATH에 없던 상태였습니다. 현재 `C:\Program Files\dotnet`을 **User PATH에 등록**해 둠. 적용하려면 **VS Code/터미널을 완전히 재시작**하세요.
- 임시로는 전체 경로 사용: `& "C:\Program Files\dotnet\dotnet.exe" ...`

**`dotnet run` 시 exit code 150 / "You must install or update .NET"**
- 이 PC 최초 `dotnet` 실행 직후의 **일회성 런타임 초기화(warm-up) 문제**였고, 현재는 해소되어 .NET 8 런타임(8.0.28)을 정상 인식합니다.
- 재발 시: `dotnet --list-runtimes` 로 `Microsoft.WindowsDesktop.App 8.x` 설치 여부 확인.

**`dotnet run`으로 띄우면 창이 바로 닫힘**
- 콘솔 라이프타임 + 비대화형 실행 조합 때문. → [실행 방법 A](#방법-a--빌드된-exe-직접-실행-권장-창이-안-닫힘) 로 exe 직접 실행.

**빌드/실행이 안 됨 (Linux/WSL)**
- WPF는 **Windows 전용**입니다. Linux/WSL/snap 환경에서는 빌드·실행 불가.

**PACS 경로 오류 (`PACS 경로를 찾을 수 없습니다`)**
- `Pacs.RootPath` UNC 경로 및 접근 권한 확인. **[PACS 진단]** 버튼으로 점검.

**Claude API 호출 실패**
- `Claude.ApiKey` 유효성, `Model` 이름, 네트워크(사내 프록시/방화벽) 확인.

**C# Dev Kit이 Microsoft 계정 로그인을 요구**
- 로그인을 요구하는 건 **C# Dev Kit** 확장뿐이며, 기본 **C# 확장**만으로도 IntelliSense·디버깅·빌드는 됩니다.
- Dev Kit 기능을 쓰려면: `Ctrl+Shift+P` → **`C# Dev Kit: Sign In`** → 개인 MS 계정으로 로그인(개인·학생·오픈소스 무료).

---

## 보안 / 개인정보 주의

- 이 앱은 **환자 개인정보(PHI)** 와 의료영상을 다룹니다. 반드시 **병원 내부망/승인된 환경**에서만 사용하세요.
- **`appsettings.json`의 API 키·DB 비밀번호를 저장소에 커밋하지 마세요.** 운영 시 사용자별/서버 환경변수나 시크릿 저장소로 분리 권장.
- X-ray 미리보기 PNG는 `Pacs.PreviewOutputPath`(기본 `C:\Temp\...`)에 저장됩니다. 주기적 정리/접근 통제를 권장합니다.
- 생성 레포트는 **의사 검토용 초안**입니다. 환자 전달 전 반드시 사람이 검수하세요.
```
