using Microsoft.Win32;
using ScopePilot.Services;
using System.Windows;

namespace ScopePilot;

public partial class ZapAlertDetailsWindow : Window
{
    private readonly ZapAlertDetails _details;
    public ZapAlertDetailsWindow(ZapAlertDetails details)
    {
        _details = details;
        InitializeComponent();
        DataContext = details;
        SourceInitialized += (_, _) => ThemeService.Apply(this);
        SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
        Closed += (_, _) => SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
    }
    private void OnUserPreferenceChanged(object sender, UserPreferenceChangedEventArgs e) => Dispatcher.BeginInvoke(() => ThemeService.Apply(this));
    private void Close_Click(object sender, RoutedEventArgs e) => Close();
    private void OpenReportFolder_Click(object sender, RoutedEventArgs e)
    {
        try { WorkspacePathOpener.Open(System.IO.Path.GetDirectoryName(_details.ReportPath)!); }
        catch (Exception ex) { MessageBox.Show(this, ex.Message, "ScopePilot", MessageBoxButton.OK, MessageBoxImage.Warning); }
    }
}
