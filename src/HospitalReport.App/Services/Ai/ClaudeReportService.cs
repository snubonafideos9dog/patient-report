using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using HospitalReport.App.Configuration;
using HospitalReport.App.Models;
using HospitalReport.App.Services.Interfaces;
using HospitalReport.App.Services.Report;

namespace HospitalReport.App.Services.Ai;

public class ClaudeReportService : IClaudeReportService
{
    private readonly HttpClient _httpClient;
    private readonly AppSettings _settings;

    public ClaudeReportService(HttpClient httpClient, AppSettings settings)
    {
        _httpClient = httpClient;
        _settings = settings;
    }

    public async Task<GeneratedReport> GenerateReportAsync(
        PatientInfo patient,
        ChartNote? chart,
        StudyItem study,
        string? previewImagePath,
        CancellationToken cancellationToken = default)
    {
        var systemPrompt = """
        당신은 병원 환자에게 전달할 '경과 레포트'를 작성하는 보조자다.
        반드시 한국어로만 작성한다.
        과장 금지, 단정적 확진 표현 금지.
        환자 친화적인 문장으로 쓴다.
        불필요한 민감정보 반복 금지.
        의사 최종 검토 전 단계의 초안이라는 전제를 유지한다.
        진료 차트가 제공되지 않은 경우, 영상 검사명과 영상 소견 위주로 일반적인 안내를 작성한다.
        반드시 아래 JSON 객체만 출력한다. 마크다운 코드블록 금지.

        {
          "summaryTitle": "",
          "summaryText": "",
          "xrayFindingsPatientFriendly": "",
          "treatmentProgress": "",
          "nextVisitReason": "",
          "caution": "",
          "shortKakaoMessage": ""
        }
        """;

        var chartSection = chart is null
            ? """
            [진료 차트]
            - (EMR 차트 정보 없음: 아래 영상 정보만으로 작성)
            """
            : $"""
            [최신 진료 차트]
            - 진료일: {chart.VisitDate:yyyy-MM-dd}
            - 담당의: {chart.DoctorName}
            - 주호소: {chart.ChiefComplaint}
            - Assessment: {chart.Assessment}
            - Plan: {chart.Plan}
            - 원문차트:
            {chart.RawText}
            """;

        var userText = $"""
        [환자 정보]
        - 환자번호: {patient.PatientId}
        - 환자명: {patient.PatientName}
        - 나이: {patient.Age}
        - 성별: {patient.Sex}

        {chartSection}

        [영상 검사 정보]
        - 촬영일: {study.StudyDate:yyyy-MM-dd}
        - 종류: {study.ModalityGroup} ({study.Modality})
        - 검사명: {study.StudyDescription}
        - 시리즈: {study.SeriesDescription}
        - 영상 수: {study.ImageCount}장

        [작성 목표]
        - 환자가 이해하기 쉬운 검사/경과 설명
        - (차트가 있으면) 현재 치료 경과 요약, 없으면 영상 검사 위주 안내
        - 재진 필요성 자연스럽게 안내
        - 과도한 공포 유발 금지, 단정적 확진 금지
        - shortKakaoMessage는 120자 안팎으로 작성
        """;

        var contentBlocks = new List<object>();

        if (!string.IsNullOrWhiteSpace(previewImagePath) && File.Exists(previewImagePath))
        {
            var imageBytes = await File.ReadAllBytesAsync(previewImagePath, cancellationToken);
            contentBlocks.Add(new
            {
                type = "image",
                source = new
                {
                    type = "base64",
                    media_type = "image/png",
                    data = Convert.ToBase64String(imageBytes)
                }
            });
        }

        contentBlocks.Add(new
        {
            type = "text",
            text = userText
        });

        var payload = new
        {
            model = _settings.Claude.Model,
            max_tokens = _settings.Claude.MaxTokens,
            system = systemPrompt,
            messages = new[]
            {
                new
                {
                    role = "user",
                    content = contentBlocks.ToArray()
                }
            }
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, _settings.Claude.ApiUrl);
        request.Headers.Add("x-api-key", _settings.Claude.ApiKey);
        request.Headers.Add("anthropic-version", _settings.Claude.ApiVersion);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content = new StringContent(
            JsonSerializer.Serialize(payload),
            Encoding.UTF8,
            "application/json");

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"Claude API 호출 실패: {response.StatusCode}\n{responseBody}");
        }

        var text = ExtractFirstTextBlock(responseBody);
        var cleaned = CleanJson(text);

        var result = JsonSerializer.Deserialize<GeneratedReport>(
            cleaned,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

        if (result is null)
            throw new InvalidOperationException("Claude 응답 JSON 파싱 실패");

        return result;
    }

    public async Task<PostureAnalysisReport> GenerateComparisonReportAsync(
        PatientInfo patient,
        StudyItem beforeStudy,
        StudyItem afterStudy,
        ComparisonImageSet images,
        CancellationToken cancellationToken = default)
    {
        var systemPrompt = """
        당신은 정형/재활 영상의학 판독 보조자다. 치료 전/후 전척추 X-ray(전면 AP, 측면 Lateral)를
        비교해 척추·골반의 정렬과 자세 변화를 분석한다.
        반드시 한국어로 작성한다.
        이것은 '참고용 초안'이며 의사의 최종 판독·진단을 대체하지 않는다.
        단정적 확진, 수치 과장, 근거 없는 추정은 금지한다.
        실제로 영상에서 보이는 부위/소견만 다룬다(보이지 않으면 넣지 않는다).
        각 부위 변화는 반드시 개선/유지/관찰필요/악화 중 하나로 표기한다.
        각 소견에는 가장 잘 보이는 뷰 하나를 view(전면 또는 측면)로 지정한다.
        전면(AP)에서는 좌우 체중편향·척추측만(scoliosis)·골반 비대칭 등을,
        측면(Lateral)에서는 경추전만·흉추후만·머리전방자세·골반 전방이동 등을 위주로 본다.
        region 이름에는 부위(머리/경추/흉추/요추/골반/체중편향/측만 등)가 드러나게 쓴다.
        반드시 아래 JSON만 출력한다. 마크다운 코드블록 금지.

        {
          "title": "",
          "subtitle": "",
          "overallSummary": "",
          "findings": [
            { "region": "", "change": "개선|유지|관찰필요|악화", "view": "전면|측면", "details": ["", ""] }
          ],
          "overallAssessment": ["", ""]
        }
        """;

        var contentBlocks = new List<object>();

        AddResizedImageBlock(contentBlocks, images.BeforeFrontal);
        AddText(contentBlocks, $"↑ [치료 전 · 전면(AP)] 촬영일 {beforeStudy.StudyDate:yyyy-MM-dd}, {beforeStudy.StudyDescription}");
        AddResizedImageBlock(contentBlocks, images.BeforeLateral);
        AddText(contentBlocks, images.BeforeLateral != null ? "↑ [치료 전 · 측면(Lateral)]" : "");
        AddResizedImageBlock(contentBlocks, images.AfterFrontal);
        AddText(contentBlocks, $"↑ [치료 후 · 전면(AP)] 촬영일 {afterStudy.StudyDate:yyyy-MM-dd}, {afterStudy.StudyDescription}");
        AddResizedImageBlock(contentBlocks, images.AfterLateral);
        AddText(contentBlocks, images.AfterLateral != null ? "↑ [치료 후 · 측면(Lateral)]" : "");

        AddText(contentBlocks, $"""
            [환자] {patient.PatientName} / 번호 {patient.PatientId} / {patient.Sex} / {patient.Age}세

            위 치료 전/후 (전면·측면) 영상을 비교해 다음을 JSON으로 작성하라:
            - title: 레포트 제목 (예: "X-ray 치료 전/후 개선 분석")
            - subtitle: 비교 기간과 핵심을 한 줄로 (두 촬영일 포함)
            - overallSummary: 전반적 체형/정렬 변화 요약 2~3문장
            - findings: 확인 가능한 부위별 항목. region(부위명), change, view, details(짧은 불릿 1~3개). 부위별로 5~7개 권장.
            - overallAssessment: 종합평가 체크 항목 3~5개
            영상만으로 판단 불가한 부위는 넣지 말 것.
            """);

        var payload = new
        {
            model = _settings.Claude.Model,
            max_tokens = Math.Max(_settings.Claude.MaxTokens, 3500),
            system = systemPrompt,
            messages = new[]
            {
                new { role = "user", content = contentBlocks.ToArray() }
            }
        };

        var responseBody = await SendAsync(payload, cancellationToken);
        var text = ExtractFirstTextBlock(responseBody);
        var cleaned = CleanJson(text);

        var result = JsonSerializer.Deserialize<PostureAnalysisReport>(
            cleaned,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

        if (result is null)
            throw new InvalidOperationException("Claude 응답 JSON 파싱 실패");

        return result;
    }

    public async Task<StudyReadingReport> GenerateStudyReadingReportAsync(
        PatientInfo patient,
        ChartNote? chart,
        StudyItem study,
        string? frontalImagePath,
        string? lateralImagePath,
        CancellationToken cancellationToken = default)
    {
        var systemPrompt = """
        당신은 정형·재활 영상의학 판독 보조자다. 한 시점에 촬영된 X-ray(전면 AP, 있으면 측면 Lateral)를
        보고 척추·골반의 정렬과 자세에 대한 '단일 판독 소견 초안'을 작성한다.
        반드시 한국어로 작성한다.
        이것은 '참고용 초안'이며 의사의 최종 판독·진단을 대체하지 않는다.
        단정적 확진, 수치 과장, 근거 없는 추정은 금지한다.
        실제로 영상에서 보이는 부위/소견만 다룬다(보이지 않으면 넣지 않는다).
        전면(AP)에서는 좌우 체중편향·척추측만(scoliosis)·골반 비대칭·어깨 높이 차이 등을,
        측면(Lateral)에서는 경추전만·흉추후만·머리전방자세(FHP)·골반 전방이동 등을 위주로 본다.
        문진/차트가 제공되면 그 맥락(주호소·부위)을 판독에 반영하고 ClinicalContext에 한두 문장으로 요약한다.
        문진/차트가 없으면 ClinicalContext는 빈 문자열로 둔다.
        반드시 아래 JSON만 출력한다. 마크다운 코드블록 금지.

        {
          "title": "",
          "subtitle": "",
          "clinicalContext": "",
          "findings": [
            { "region": "", "details": ["", ""] }
          ],
          "impression": "",
          "recommendations": ["", ""]
        }
        """;

        var contentBlocks = new List<object>();

        AddResizedImageBlock(contentBlocks, frontalImagePath);
        AddText(contentBlocks, frontalImagePath != null
            ? $"↑ [전면(AP)] 촬영일 {study.StudyDate:yyyy-MM-dd}, {study.StudyDescription}"
            : "");
        AddResizedImageBlock(contentBlocks, lateralImagePath);
        AddText(contentBlocks, lateralImagePath != null ? "↑ [측면(Lateral)]" : "");

        var chartSection = chart is null
            ? "[문진/차트] (EMR 미연동: 영상 소견 위주로 판독)"
            : $"""
            [문진/초진차트]
            - 진료일: {chart.VisitDate:yyyy-MM-dd}
            - 담당의: {chart.DoctorName}
            - 주호소: {chart.ChiefComplaint}
            - Assessment: {chart.Assessment}
            - Plan: {chart.Plan}
            - 원문:
            {chart.RawText}
            """;

        AddText(contentBlocks, $"""
            [환자] {patient.PatientName} / 번호 {patient.PatientId} / {patient.Sex} / {patient.Age}세
            [영상] {study.ModalityGroup}({study.Modality}) · {study.StudyDescription} · {study.ImageCount}장

            {chartSection}

            위 단일 촬영본을 판독해 다음을 JSON으로 작성하라:
            - title: 판독지 제목 (예: "전척추 X-ray 자세·정렬 판독")
            - subtitle: 촬영일과 핵심을 한 줄로
            - clinicalContext: 문진/차트가 있으면 반영 요약(없으면 빈 문자열)
            - findings: 확인 가능한 부위별 소견. region(부위명), details(짧은 불릿 1~3개). 부위별로 4~7개 권장.
            - impression: 종합 소견/인상 2~3문장
            - recommendations: 권고사항 2~4개
            영상만으로 판단 불가한 부위는 넣지 말 것.
            """);

        var payload = new
        {
            model = _settings.Claude.Model,
            max_tokens = Math.Max(_settings.Claude.MaxTokens, 3000),
            system = systemPrompt,
            messages = new[]
            {
                new { role = "user", content = contentBlocks.ToArray() }
            }
        };

        var responseBody = await SendAsync(payload, cancellationToken);
        var text = ExtractFirstTextBlock(responseBody);
        var cleaned = CleanJson(text);

        var result = JsonSerializer.Deserialize<StudyReadingReport>(
            cleaned,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

        if (result is null)
            throw new InvalidOperationException("Claude 응답 JSON 파싱 실패");

        return result;
    }

    private static void AddText(List<object> blocks, string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        blocks.Add(new { type = "text", text });
    }

    private static void AddResizedImageBlock(List<object> blocks, string? imagePath)
    {
        if (string.IsNullOrWhiteSpace(imagePath) || !File.Exists(imagePath))
            return;

        var jpeg = ImageUtil.ToResizedJpeg(imagePath, 1400);
        blocks.Add(new
        {
            type = "image",
            source = new
            {
                type = "base64",
                media_type = "image/jpeg",
                data = Convert.ToBase64String(jpeg)
            }
        });
    }

    private async Task<string> SendAsync(object payload, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, _settings.Claude.ApiUrl);
        request.Headers.Add("x-api-key", _settings.Claude.ApiKey);
        request.Headers.Add("anthropic-version", _settings.Claude.ApiVersion);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content = new StringContent(
            JsonSerializer.Serialize(payload),
            Encoding.UTF8,
            "application/json");

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Claude API 호출 실패: {response.StatusCode}\n{body}");

        return body;
    }

    private static string ExtractFirstTextBlock(string responseJson)
    {
        using var doc = JsonDocument.Parse(responseJson);

        if (!doc.RootElement.TryGetProperty("content", out var contentArray))
            throw new InvalidOperationException("Claude 응답에 content가 없습니다.");

        foreach (var item in contentArray.EnumerateArray())
        {
            if (item.TryGetProperty("type", out var typeProp) &&
                typeProp.GetString() == "text" &&
                item.TryGetProperty("text", out var textProp))
            {
                return textProp.GetString() ?? string.Empty;
            }
        }

        throw new InvalidOperationException("Claude 응답에서 text 블록을 찾지 못했습니다.");
    }

    private static string CleanJson(string text)
    {
        var cleaned = text.Trim();

        if (cleaned.StartsWith("```"))
        {
            cleaned = cleaned.Replace("```json", string.Empty, StringComparison.OrdinalIgnoreCase)
                             .Replace("```", string.Empty);
        }

        return cleaned.Trim();
    }
}
