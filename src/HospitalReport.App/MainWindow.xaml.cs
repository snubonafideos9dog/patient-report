using HospitalReport.App.ViewModels;
using System.Windows;

namespace HospitalReport.App;

public partial class MainWindow : Window
{
    public MainWindow(MainViewModel viewModel)
    {
        InitializeComponent();
        DataContext = viewModel;
    }
}
