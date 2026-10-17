using Microsoft.Win32;
using ScopePilot.Services;
using System.Windows;

namespace ScopePilot;

public enum ProjectStartupAction { Cancel, OpenProjectFolder, CreateProjectFolder }
public partial class ProjectStartupWindow : Window
{
    public ProjectStartupAction SelectedAction { get; private set; } = ProjectStartupAction.Cancel;
    public ProjectStartupWindow()
    {
        InitializeComponent();
        SourceInitialized += (_, _) => ThemeService.Apply(this);
        SystemEvents.UserPreferenceChanged += PreferenceChanged;
        Closed += (_, _) => SystemEvents.UserPreferenceChanged -= PreferenceChanged;
    }
    private void PreferenceChanged(object sender, UserPreferenceChangedEventArgs e) => Dispatcher.InvokeAsync(() => ThemeService.Apply(this));
    private void Open_Click(object sender, RoutedEventArgs e) { SelectedAction = ProjectStartupAction.OpenProjectFolder; DialogResult = true; }
    private void Create_Click(object sender, RoutedEventArgs e) { SelectedAction = ProjectStartupAction.CreateProjectFolder; DialogResult = true; }
}
