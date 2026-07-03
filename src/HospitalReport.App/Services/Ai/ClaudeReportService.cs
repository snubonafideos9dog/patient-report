using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using HospitalReport.App.Configuration;
using HospitalReport.App.Models;
using HospitalReport.App.Services.Interfaces;

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
        ChartNote chart,
        XrayStudy xrayStudy,
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

        var userText = $"""
        [환자 정보]
        - 환자번호: {patient.PatientId}
        - 환자명: {patient.PatientName}
        - 나이: {patient.Age}
        - 성별: {patient.Sex}

        [최신 진료 차트]
        - 진료일: {chart.VisitDate:yyyy-MM-dd}
        - 담당의: {chart.DoctorName}
        - 주호소: {chart.ChiefComplaint}
        - Assessment: {chart.Assessment}
        - Plan: {chart.Plan}
        - 원문차트:
        {chart.RawText}

        [X-ray 정보]
        - 촬영일: {xrayStudy.StudyDate:yyyy-MM-dd}
        - Modality: {xrayStudy.Modality}
        - StudyDescription: {xrayStudy.StudyDescription}
        - SeriesDescription: {xrayStudy.SeriesDescription}

        [작성 목표]
        - 환자가 이해하기 쉬운 경과 설명
        - 현재 치료 경과 요약
        - 재진 필요성 자연스럽게 안내
        - 과도한 공포 유발 금지
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
