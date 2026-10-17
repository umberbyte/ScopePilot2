using Microsoft.Win32;
using ScopePilot.Domain;
using ScopePilot.Services;
using System.Text.Json;
using System.Windows;

namespace ScopePilot;

public partial class BrunoEvidenceWindow : Window
{
    private readonly EngagementProject _project;
    private readonly BrunoCaptureService _service = new();
    private string? _harPath;

    public BrunoEvidenceWindow(EngagementProject project)
    {
        _project = project;
        InitializeComponent();
        RoleBox.Text = project.ActiveRole;
        SourceInitialized += (_, _) => ThemeService.Apply(this);
        SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
        Closed += (_, _) => SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
    }

    private void OnUserPreferenceChanged(object sender, UserPreferenceChangedEventArgs e) =>
        Dispatcher.BeginInvoke(() => ThemeService.Apply(this));

    private async void ChooseHar_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog { Title = "Brunoの通信を記録したHARを選択", Filter = "HTTP Archive (*.har;*.json)|*.har;*.json" };
        if (dialog.ShowDialog(this) != true) return;
        ErrorLabel.Text = "";
        try
        {
            var entries = await _service.PreviewAsync(dialog.FileName);
            _harPath = dialog.FileName;
            HarPathLabel.Text = dialog.FileName;
            EntriesGrid.ItemsSource = entries;
            if (entries.Count > 0) EntriesGrid.SelectedIndex = 0;
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException)
        { ErrorLabel.Text = ex.Message; }
    }

    private async void Import_Click(object sender, RoutedEventArgs e)
    {
        if (_harPath is null || EntriesGrid.SelectedItem is not BrunoHarEntry selected)
        { ErrorLabel.Text = "HARの通信を1件選択してください。"; return; }
        ImportButton.IsEnabled = false;
        ErrorLabel.Text = "";
        try
        {
            await _service.ImportAsync(_project, _harPath, selected.Index, TitleBox.Text,
                (BrunoVerificationStatus)StatusBox.SelectedIndex, ResultBox.Text,
                ReasonBox.Text, RequiredInputBox.Text, RoleBox.Text);
            DialogResult = true;
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException or JsonException)
        { ErrorLabel.Text = ex.Message; }
        finally { ImportButton.IsEnabled = true; }
    }

    private void Cancel_Click(object sender, RoutedEventArgs e) => DialogResult = false;
}
