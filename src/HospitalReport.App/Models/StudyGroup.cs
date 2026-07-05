using System.Collections.ObjectModel;
using HospitalReport.App.Helpers;

namespace HospitalReport.App.Models;

// 촬영 목록의 모달리티별 아코디언 그룹.
public class StudyGroup : ObservableObject
{
    private bool _isExpanded;

    public string GroupName { get; set; } = string.Empty;
    public int Order { get; set; }
    public ObservableCollection<StudyItem> Items { get; } = new();

    public bool IsExpanded
    {
        get => _isExpanded;
        set => SetProperty(ref _isExpanded, value);
    }

    public string Header => $"{GroupName}  ({Items.Count}건)";
}
