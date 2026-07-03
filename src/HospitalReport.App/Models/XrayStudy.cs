namespace HospitalReport.App.Models;

public class XrayStudy
{
    public string FilePath { get; set; } = string.Empty;
    public string PatientId { get; set; } = string.Empty;
    public string? PatientName { get; set; }
    public DateTime? StudyDate { get; set; }
    public string? Modality { get; set; }
    public string? StudyDescription { get; set; }
    public string? SeriesDescription { get; set; }
    public string? SopInstanceUid { get; set; }
    public int MatchScore { get; set; }
}
