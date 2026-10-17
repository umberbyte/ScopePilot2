using Microsoft.Win32;
using ScopePilot.Services;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;

namespace ScopePilot;

public partial class LogWindow : Window
{
    private readonly Func<string> _readLog;
    private readonly Func<string, Task<string>> _saveLog;
    private readonly Func<string, Task<ClipboardCopyResult>> _copy;
    private readonly DispatcherTimer _autoRefresh;

    internal LogWindow(Func<string> readLog, Func<string, Task<string>> saveLog,
        Func<string, Task<ClipboardCopyResult>>? copy = null)
    {
        _readLog = readLog;
        _saveLog = saveLog;
        _copy = copy ?? ClipboardService.CopyTextAsync;
        _autoRefresh = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromSeconds(2) };
        _autoRefresh.Tick += (_, _) => FollowLatest();
        _autoRefresh.Start();
        InitializeComponent();
        RefreshLog();
        SourceInitialized += (_, _) => ThemeService.Apply(this);
        SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
        Closed += (_, _) => { _autoRefresh.Stop(); SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged; };
    }

    private void OnUserPreferenceChanged(object sender, UserPreferenceChangedEventArgs e) =>
        Dispatcher.BeginInvoke(() => ThemeService.Apply(this));

    internal bool IsAutoRefreshRunning => _autoRefresh.IsEnabled;

    // 先頭（最新）を表示している間だけ自動更新する。選択中や読み位置を下げている間は内容を保つ。
    internal void FollowLatest()
    {
        if (LogTextBox.SelectionLength > 0 || LogTextBox.VerticalOffset > 2) return;
        var latest = _readLog();
        if (LogTextBox.Text == latest) return;
        LogTextBox.Text = latest;
        LogTextBox.CaretIndex = 0;
        CopyAllButton.IsEnabled = SaveLogButton.IsEnabled = latest.Length > 0;
    }

    internal void RefreshLog()
    {
        LogTextBox.Text = _readLog();
        ResultText.Text = "表示中のログを更新しました。";
        CopyAllButton.IsEnabled = SaveLogButton.IsEnabled = LogTextBox.Text.Length > 0;
        UpdateSelectionButton();
    }

    private void UpdateSelectionButton()
    {
        if (CopySelectionButton is not null) CopySelectionButton.IsEnabled = LogTextBox.SelectionLength > 0;
    }
    private void Log_SelectionChanged(object sender, RoutedEventArgs e) => UpdateSelectionButton();
    private void Refresh_Click(object sender, RoutedEventArgs e) => RefreshLog();
    private void SelectAll_Click(object sender, RoutedEventArgs e) { LogTextBox.Focus(); LogTextBox.SelectAll(); }
    private async void CopyAll_Click(object sender, RoutedEventArgs e) => await CopyAsync(LogTextBox.Text);
    private async void CopySelection_Click(object sender, RoutedEventArgs e) => await CopyAsync(LogTextBox.SelectedText);
    private void Copy_CanExecute(object sender, CanExecuteRoutedEventArgs e) { e.CanExecute = LogTextBox.SelectionLength > 0; e.Handled = true; }
    private async void Copy_Executed(object sender, ExecutedRoutedEventArgs e) { e.Handled = true; await CopyAsync(LogTextBox.SelectedText); }

    internal async Task CopyAsync(string text) => ResultText.Text = (await _copy(text)).Message;

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        try { ResultText.Text = $"保存しました: {await _saveLog(LogTextBox.Text)}"; }
        catch (Exception ex) { ResultText.Text = $"ログを保存できませんでした: {ex.Message}"; }
    }
}
