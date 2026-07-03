namespace HospitalReport.App.Models;

public class PatientInfo
{
    public string PatientId { get; set; } = string.Empty;
    public string PatientName { get; set; } = string.Empty;
    public string? BirthDate { get; set; }
    public string? Sex { get; set; }
    public int? Age { get; set; }
}
