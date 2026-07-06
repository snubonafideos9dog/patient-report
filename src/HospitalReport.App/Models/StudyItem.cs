using HospitalReport.App.Helpers;

namespace HospitalReport.App.Models;

// 환자의 촬영 리스트에 표시되는 스터디 1건 (DICOM StudyInstanceUID 기준으로 묶음).
public class StudyItem : ObservableObject
{
    private bool _isSelected;

    public string PatientId { get; set; } = string.Empty;
    public string PatientName { get; set; } = string.Empty;
    public string? PatientSex { get; set; }
    public string? PatientBirthDate { get; set; }

    public string StudyInstanceUid { get; set; } = string.Empty;
    public DateTime? StudyDate { get; set; }
    public string StudyTimeText { get; set; } = string.Empty;   // HHmmss (실시간 목록 정렬용, 최근 촬영 순)
    public string Modality { get; set; } = string.Empty;        // CR, US, RF ...
    public string ModalityGroup { get; set; } = string.Empty;    // X-ray, 초음파, C-ARM ...
    public string StudyDescription { get; set; } = string.Empty;
    public string SeriesDescription { get; set; } = string.Empty;

    public string RepresentativeFilePath { get; set; } = string.Empty;
    public int ImageCount { get; set; }

    // 스터디에 속한 전체 이미지 파일(시간/instance 순 정렬).
    public List<string> ImageFiles { get; set; } = new();

    // 뷰 정보 포함 이미지 목록(전척추: AP + Lateral 구분용).
    public List<StudyImage> Images { get; set; } = new();

    // 전면(AP/PA) 대표 파일. 뷰 태그 없으면 첫 이미지.
    public string? FrontalFile =>
        Images.FirstOrDefault(i => IsFrontal(i.ViewPosition))?.FilePath
        ?? Images.FirstOrDefault()?.FilePath
        ?? (string.IsNullOrEmpty(RepresentativeFilePath) ? null : RepresentativeFilePath);

    // 측면(LAT/LL/RL) 대표 파일. 뷰 태그 없고 2매 이상이면 전면이 아닌 다른 장을 측면으로 추정.
    public string? LateralFile
    {
        get
        {
            var lat = Images.FirstOrDefault(i => IsLateral(i.ViewPosition))?.FilePath;
            if (lat != null) return lat;
            if (Images.Count >= 2)
            {
                var front = FrontalFile;
                return Images.Select(i => i.FilePath).FirstOrDefault(p => p != front);
            }
            return null;
        }
    }

    public bool HasLateral => LateralFile != null;

    // 정면(AP/PA) 계열. STAND AP 등 변형 포함, 오블리크/굴곡/신전/축상은 제외.
    private static bool IsFrontal(string? vp)
    {
        var v = (vp ?? "").Trim().ToUpperInvariant();
        if (v.Contains("OBL") || v.Contains("FLEX") || v.Contains("EXT") || v.Contains("AXIAL")) return false;
        return v.Contains("AP") || v.Contains("PA");
    }

    // 측면(LATERAL/LL/RL) 계열. STAND LAT 등 포함, 굴곡/신전(측면 스트레스)은 제외해 중립측면 우선.
    private static bool IsLateral(string? vp)
    {
        var v = (vp ?? "").Trim().ToUpperInvariant();
        if (v.Contains("FLEX") || v.Contains("EXT") || v.Contains("OBL")) return false;
        return v.Contains("LAT") || v is "LL" or "RL";
    }

    // 리스트에서 현재 선택 여부(하이라이트용).
    public bool IsSelected { get => _isSelected; set => SetProperty(ref _isSelected, value); }

    // 리스트 표시용
    public string DateText => StudyDate?.ToString("yyyy-MM-dd") ?? "날짜미상";

    public static string ToModalityGroup(string? modality)
    {
        var m = (modality ?? "").Trim().ToUpperInvariant();
        return m switch
        {
            "CR" or "DX" or "DR" => "X-ray",
            "US" => "초음파",
            "CT" => "CT",
            "RF" or "XA" => "C-ARM",
            "EMG" or "XC" => "EMG",
            "MR" => "MRI",
            "MG" => "유방촬영",
            "" => "기타",
            _ => m
        };
    }

    // 리스트 그룹 정렬 순서: X-ray → 초음파 → CT → C-ARM → EMG → 그 외
    public static int GroupOrder(string group) => group switch
    {
        "X-ray" => 1,
        "초음파" => 2,
        "CT" => 3,
        "C-ARM" => 4,
        "EMG" => 5,
        _ => 99
    };
}

// 스터디 내 개별 이미지(뷰 정보 포함).
public class StudyImage
{
    public string FilePath { get; set; } = string.Empty;
    public string ViewPosition { get; set; } = string.Empty;  // AP, PA, LAT, LL ...
    public int InstanceNumber { get; set; }
}
