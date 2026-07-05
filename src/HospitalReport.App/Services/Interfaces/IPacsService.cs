using HospitalReport.App.Models;

namespace HospitalReport.App.Services.Interfaces;

public interface IPacsService
{
    // 환자번호로 그 환자의 촬영 스터디 목록을 최신순으로 가져온다 (EMR 불필요, PACS 폴더만 사용).
    Task<IReadOnlyList<StudyItem>> GetStudiesForPatientAsync(string patientId, CancellationToken cancellationToken = default);

    // 선택한 스터디의 대표 이미지를 PNG로 렌더링해 경로를 반환.
    Task<string?> RenderPreviewAsync(string dicomFilePath, CancellationToken cancellationToken = default);

    // (기존 흐름 호환) 환자의 최신 X-ray 1건 자동 선택.
    Task<XrayStudy?> GetLatestStudyAsync(string patientId, string? patientName = null, CancellationToken cancellationToken = default);
    Task<string?> RenderPreviewAsync(XrayStudy study, CancellationToken cancellationToken = default);
}