using ScopePilot.Infrastructure;
using ScopePilot.Services;
using ScopePilot.Services.WordReports;

namespace ScopePilot.ViewModels;

public sealed partial class MainViewModel
{
    private bool _wordConversionRunning;
    private string _wordReportStatusText = "Markdownレポートを選択してWord形式に変換できます。";
    private string? _lastWordReportPath;
    public string? LastMarkdownReportPath { get; private set; }
    public bool CanConvertWordReport => !IsRunning && !_wordConversionRunning;
    public bool IsWordConversionRunning => _wordConversionRunning;
    public bool HasWordReport => !string.IsNullOrWhiteSpace(_lastWordReportPath);
    public string WordReportStatusText { get => _wordReportStatusText; private set => SetProperty(ref _wordReportStatusText, value); }
    public RelayCommand OpenWordReportCommand { get; private set; } = null!;

    private void InitializeWordReportCommands() => OpenWordReportCommand = new RelayCommand(() =>
    {
        if (_lastWordReportPath is not null)
        {
            ProjectPaths.EnsureChild(ProjectPaths.Root(Project), _lastWordReportPath);
            OpenRunPath(_lastWordReportPath, "Wordレポート");
        }
    }, () => HasWordReport && CanConvertWordReport);

    internal void RememberMarkdownReport(string path) => LastMarkdownReportPath = path;
    private void RefreshWordReportCommands()
    {
        RaisePropertyChanged(nameof(CanConvertWordReport)); RaisePropertyChanged(nameof(HasWordReport));
        OpenWordReportCommand?.RaiseCanExecuteChanged();
    }
    private void ResetWordReport()
    {
        LastMarkdownReportPath = null; _lastWordReportPath = null;
        WordReportStatusText = "Markdownレポートを選択してWord形式に変換できます。";
        RefreshWordReportCommands();
    }

    public async Task<WordReportResult?> ConvertMarkdownReportAsync(string path)
    {
        if (!CanConvertWordReport || !await TryEnsureProjectAsync()) return null;
        _wordConversionRunning = true; IsRunning = true; RefreshWordReportCommands();
        WordReportStatusText = "Wordレポートに変換しています。";
        try
        {
            var result = await new MarkdownWordReportService().ConvertAsync(Project, path);
            LastMarkdownReportPath = result.MarkdownPath; _lastWordReportPath = result.WordPath;
            WordReportStatusText = $"Wordレポートを保存しました{(result.Warnings.Count > 0 ? $"（注意{result.Warnings.Count}件。ログを確認してください）" : "")}: {ProjectPaths.Relative(Project, result.WordPath)}";
            Log($"Wordレポート: {result.WordPath}");
            foreach (var warning in result.Warnings) Log($"Word変換: {warning}");
            await RefreshDataSummaryAsync();
            return result;
        }
        catch (Exception ex)
        {
            WordReportStatusText = $"Wordレポートへの変換に失敗しました: {ex.Message}";
            Log(WordReportStatusText); ShowProjectError?.Invoke(WordReportStatusText);
            return null;
        }
        finally { _wordConversionRunning = false; IsRunning = false; RefreshWordReportCommands(); }
    }
}
