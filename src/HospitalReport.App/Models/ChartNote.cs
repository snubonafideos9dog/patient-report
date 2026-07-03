namespace HospitalReport.App.Models;

public class ChartNote
{
    public DateTime VisitDate { get; set; }
    public string? DoctorName { get; set; }
    public string? ChiefComplaint { get; set; }
    public string? Assessment { get; set; }
    public string? Plan { get; set; }
    public string RawText { get; set; } = string.Empty;
}
