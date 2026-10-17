using Microsoft.Win32;
using ScopePilot.Services;
using ScopePilot.ViewModels;
using ScopePilot.Domain;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;

namespace ScopePilot;

public partial class MainWindow : Window
{
    private readonly MainViewModel _viewModel = new();
    private LogWindow? _logWindow;
    private bool _zapDetailsOpening;

    private async void ImportBrunoEvidence_Click(object sender, RoutedEventArgs e)
    {
        if (!_viewModel.CanConvertWordReport) return;
        try
        {
            if (new BrunoEvidenceWindow(_viewModel.Project) { Owner = this }.ShowDialog() == true)
            {
                if (!await _viewModel.SaveCurrentProjectAsync())
                    ShowProjectError("Brunoの通信記録はプロジェクト内に作成されましたが、プロジェクトファイルを保存できませんでした。ログを確認し、［保存］を再実行してください。");
            }
        }
        catch (Exception ex) { ShowProjectError($"Bruno確認を取り込めませんでした。\n{ex.Message}"); }
    }

    private async void ZapAlertDetails_Click(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        if (sender is Button { DataContext: DiagnosticObservation observation }) await OpenZapAlertDetailsAsync(observation);
    }
    private async void ZapAlertRow_DoubleClick(object sender, MouseButtonEventArgs e)
    {
        var source = e.OriginalSource as DependencyObject;
        while (source is not null && source is not DataGridRow)
        {
            if (source is Button) return;
            source = source is System.Windows.Media.Visual or System.Windows.Media.Media3D.Visual3D
                ? System.Windows.Media.VisualTreeHelper.GetParent(source) : LogicalTreeHelper.GetParent(source);
        }
        if (source is DataGridRow { Item: DiagnosticObservation observation })
        { e.Handled = true; await OpenZapAlertDetailsAsync(observation); }
    }
    private async Task OpenZapAlertDetailsAsync(DiagnosticObservation observation)
    {
        if (_zapDetailsOpening) return;
        _zapDetailsOpening = true;
        try
        {
            var project = _viewModel.Project;
            var details = await new ZapAlertDetailsService().ReadAsync(project, observation);
            if (!ReferenceEquals(project, _viewModel.Project)) return;
            new ZapAlertDetailsWindow(details) { Owner = this }.Show();
        }
        catch (Exception ex) { ShowProjectError($"ZAP警告の詳細を読めませんでした。\n{ex.Message}"); }
        finally { _zapDetailsOpening = false; }
    }
    public MainWindow() : this(true) { }

    // UI regression checks can instantiate the window without loading or changing user data.
    internal MainWindow(bool initializeProject)
    {
        InitializeComponent();
        Title = $"ScopePilot {typeof(MainWindow).Assembly.GetName().Version?.ToString(3)}";
        DataContext = _viewModel;
        _viewModel.ChooseNewProjectFile = () =>
        {
            var parent = new OpenFolderDialog { Title = "新規プロジェクトフォルダーの作成先を選択", InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments) };
            if ((IsVisible ? parent.ShowDialog(this) : parent.ShowDialog()) != true) return null;
            var name = new NewProjectFolderWindow();
            if (IsVisible) name.Owner = this;
            if (name.ShowDialog() != true) return null;
            try { return ProjectWorkspaceService.CreateFolder(parent.FolderName, name.FolderName); }
            catch (Exception ex) { ShowProjectError(ex.Message); return null; }
        };
        _viewModel.ChooseOpenProjectFile = () =>
        {
            var dialog = new OpenFolderDialog { Title = "プロジェクトフォルダーを開く", InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments) };
            if ((IsVisible ? dialog.ShowDialog(this) : dialog.ShowDialog()) != true) return null;
            try { return ProjectWorkspaceService.FindProjectFile(dialog.FolderName); }
            catch (Exception ex) { ShowProjectError(ex.Message); return null; }
        };
        _viewModel.ShowProjectError = ShowProjectError;
        _viewModel.GlmApiKeyInputCleared += () => GlmApiKeyBox.Clear();
        _viewModel.ShowAuthenticationPrompt = message =>
        {
            if (!IsVisible) return;
            Navigation.SelectedItem = Navigation.Items.OfType<ListBoxItem>().FirstOrDefault(item => item.Tag is "1");
            Activate();
            MessageBox.Show(this, message, "認証情報を探索ブラウザに入力してください", MessageBoxButton.OK, MessageBoxImage.Information);
        };
        _viewModel.CommitPendingEdits = () =>
        {
            if (Keyboard.FocusedElement is TextBox input && Window.GetWindow(input) == this)
            {
                input.GetBindingExpression(TextBox.TextProperty)?.UpdateSource();
                if (Validation.GetHasError(input)) return false;
            }
            foreach (var grid in FindDataGrids(Workspace))
                if (!grid.IsReadOnly && (!grid.CommitEdit(DataGridEditingUnit.Cell, true) || !grid.CommitEdit(DataGridEditingUnit.Row, true))) return false;
            return true;
        };
        _viewModel.ConfirmDiscardChanges = () => MessageBox.Show(this,
            "未保存の変更があります。変更を破棄して続行しますか？\n保存する場合はキャンセルし、画面の［保存］を押してください。",
            "未保存の変更", MessageBoxButton.OKCancel, MessageBoxImage.Warning, MessageBoxResult.Cancel) == MessageBoxResult.OK;
        SourceInitialized += (_, _) => ThemeService.Apply(this);
        SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
        Closed += (_, _) => { SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged; _logWindow?.Close(); };
        Closing += (_, e) =>
        {
            if (!IsVisible) return;
            if (_viewModel.IsRunning) { e.Cancel = true; ShowProjectError(_viewModel.IsWordConversionRunning ? "Wordレポートの変換が終わってからアプリを閉じてください。" : "実行中の処理を停止してからアプリを閉じてください。"); }
            else if (!_viewModel.CanDiscardChanges()) e.Cancel = true;
        };
        Navigation.SelectedIndex = 1;
    }

    public Task<bool> StartProjectAsync(ProjectStartupAction action) => action switch
    {
        ProjectStartupAction.OpenProjectFolder => _viewModel.OpenSelectedProjectAsync(),
        ProjectStartupAction.CreateProjectFolder => _viewModel.CreateNewProjectAsync(),
        _ => Task.FromResult(false)
    };
    private void ShowProjectError(string message)
    {
        if (IsVisible) MessageBox.Show(this, message, "ScopePilot", MessageBoxButton.OK, MessageBoxImage.Warning);
        else MessageBox.Show(message, "ScopePilot", MessageBoxButton.OK, MessageBoxImage.Warning);
    }
    private void Window_SourceUpdated(object sender, System.Windows.Data.DataTransferEventArgs e) => _viewModel.RefreshSaveState();
    private static IEnumerable<DataGrid> FindDataGrids(DependencyObject element)
    {
        for (var index = 0; index < System.Windows.Media.VisualTreeHelper.GetChildrenCount(element); index++)
        {
            var child = System.Windows.Media.VisualTreeHelper.GetChild(element, index);
            if (child is DataGrid grid) yield return grid;
            foreach (var nested in FindDataGrids(child)) yield return nested;
        }
    }

    private void ChooseZapJar_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        var dialog = new OpenFileDialog { Title = "ZAPのJARファイル", Filter = "ZAP JAR|zap*.jar" };
        if (dialog.ShowDialog(this) == true) { _viewModel.Project.DiagnosticTools.ZapJarPath = dialog.FileName; _viewModel.RefreshSaveState(); DataContext = null; DataContext = _viewModel; }
    }
    private void ChooseJava_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        var dialog = new OpenFileDialog { Title = "Javaの実行ファイル", Filter = "Java|java.exe" };
        if (dialog.ShowDialog(this) == true) { _viewModel.Project.DiagnosticTools.JavaPath = dialog.FileName; _viewModel.RefreshSaveState(); DataContext = null; DataContext = _viewModel; }
    }
    private void ChooseAppZapJar_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        var dialog = new OpenFileDialog { Title = "アプリ設定のZAP JARファイル", Filter = "ZAP JAR|zap*.jar" };
        if (dialog.ShowDialog(this) == true) { _viewModel.AppSettings.ZapJarPath = dialog.FileName; DataContext = null; DataContext = _viewModel; }
    }
    private void ChooseAppJava_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        var dialog = new OpenFileDialog { Title = "アプリ設定のJavaの実行ファイル", Filter = "Java|java.exe" };
        if (dialog.ShowDialog(this) == true) { _viewModel.AppSettings.JavaPath = dialog.FileName; DataContext = null; DataContext = _viewModel; }
    }
    private void ChooseAppBurpJar_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        var dialog = new OpenFileDialog { Title = "Burp MCPプロキシのJARファイル", Filter = "JAR|*.jar" };
        if (dialog.ShowDialog(this) == true) { _viewModel.AppSettings.BurpMcpProxyJarPath = dialog.FileName; DataContext = null; DataContext = _viewModel; }
    }
    // PasswordBoxはバインドできないため、入力中のキーをコードビハインドからViewModelへ渡す。
    private void GlmApiKeyBox_PasswordChanged(object sender, RoutedEventArgs e) =>
        _viewModel.GlmApiKeyInput = GlmApiKeyBox.Password;
    private void ResetAppSettings_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        _viewModel.ResetAppSettings();
        DataContext = null;
        DataContext = _viewModel;
    }
    private async void ImportZapReport_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog { Title = "ZAP Traditional JSONレポートを取り込む", Filter = "ZAPレポート|*.json" };
        if (dialog.ShowDialog(this) == true) await _viewModel.ImportZapReportAsync(dialog.FileName);
    }
    private async void ImportLegacyProject_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        var source = new OpenFileDialog { Title = "旧保存ルートのprojects内の案件JSONを選択", Filter = "旧案件JSON|*.json" };
        if (source.ShowDialog(this) != true) return;
        var destination = _viewModel.ChooseNewProjectFile?.Invoke();
        if (!string.IsNullOrWhiteSpace(destination)) await _viewModel.ImportLegacyProjectAsync(source.FileName, destination);
    }

    private void Navigation_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (Workspace is not null && Navigation.SelectedItem is ListBoxItem { Tag: string tag } && int.TryParse(tag, out var index))
            Workspace.SelectedIndex = index;
    }

    private void Navigate_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string tag }) NavigateTo(tag);
    }

    private void NavigateTo(string tag)
    {
        Navigation.SelectedItem = Navigation.Items.OfType<ListBoxItem>().FirstOrDefault(item => item.Tag?.ToString() == tag);
    }

    private void Window_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (Keyboard.Modifiers != ModifierKeys.Control) return;
        if (e.Key == Key.S && _viewModel.SaveCommand.CanExecute(null))
        {
            _viewModel.SaveCommand.Execute(null);
            e.Handled = true;
        }
        else if (e.Key == Key.F)
        {
            NavigateTo(_viewModel.ReviewPageTag);
            Dispatcher.BeginInvoke(() =>
            {
                if (_viewModel.IsApiMode) ApiRequestsGrid.Focus();
                else { CandidateSearchBox.Focus(); CandidateSearchBox.SelectAll(); }
            });
            e.Handled = true;
        }
    }

    private async void CandidateSelection_Click(object sender, RoutedEventArgs e)
    {
        if (!_viewModel.IsRunning && sender is CheckBox { DataContext: ScopePilot.Domain.DiagnosticCandidate candidate })
            await _viewModel.UpdateCandidateDecisionAsync(candidate);
    }

    private void ResetCandidateDecisions_Click(object sender, RoutedEventArgs e)
    {
        if (!_viewModel.ResetCandidateDecisionsCommand.CanExecute(null)) return;
        if (MessageBox.Show(this, "この案件の採用・除外の記録を解除し、観測済みの通信から再判定します。続行しますか？",
            "候補の判断をリセット", MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No) == MessageBoxResult.Yes)
            _viewModel.ResetCandidateDecisionsCommand.Execute(null);
    }

    private void OnUserPreferenceChanged(object sender, UserPreferenceChangedEventArgs e) =>
        Dispatcher.BeginInvoke(() => ThemeService.Apply(this));

    private async void Import_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        var dialog = new OpenFileDialog
        {
            Title = "クローリング結果を取り込む",
            Filter = "対応ファイル (*.har;*.jsonl;*.txt)|*.har;*.jsonl;*.txt|HAR (*.har)|*.har|JSON Lines (*.jsonl)|*.jsonl|URL一覧 (*.txt)|*.txt"
        };
        if (dialog.ShowDialog(this) == true) await _viewModel.ImportAsync(dialog.FileName);
    }

    private async void ReadApiDocument_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        var dialog = new OpenFileDialog
        {
            Title = "APIドキュメントを読み込む",
            Filter = "API仕様書 (*.json;*.yaml;*.yml;*.md;*.html;*.htm;*.txt)|*.json;*.yaml;*.yml;*.md;*.html;*.htm;*.txt|すべてのファイル (*.*)|*.*"
        };
        if (dialog.ShowDialog(this) == true) await _viewModel.ReadApiDocumentAsync(dialog.FileName);
    }

    private async void ConvertMarkdownWord_Click(object sender, RoutedEventArgs e)
    {
        if (!_viewModel.CanConvertWordReport) return;
        try
        {
            var report = _viewModel.LastMarkdownReportPath;
            var reports = ProjectPaths.Category(_viewModel.Project, "reports");
            var dialog = new OpenFileDialog
            {
                Title = "Wordへ変換するMarkdownレポートを選択",
                Filter = "Markdownレポート (*.md;*.markdown)|*.md;*.markdown",
                CheckFileExists = true,
                InitialDirectory = report is not null ? System.IO.Path.GetDirectoryName(report) : System.IO.Directory.Exists(reports) ? reports : ProjectPaths.Root(_viewModel.Project),
                FileName = report is not null ? System.IO.Path.GetFileName(report) : ""
            };
            if (dialog.ShowDialog(this) == true) await _viewModel.ConvertMarkdownReportAsync(dialog.FileName);
        }
        catch (Exception ex) { ShowProjectError(ex.Message); }
    }

    private async void ReadExplorationDocument_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        var dialog = new OpenFileDialog
        {
            Title = "対象の仕様書・操作手順を読み込む",
            Filter = "テキスト文書 (*.md;*.txt;*.html;*.htm;*.json;*.yaml;*.yml)|*.md;*.txt;*.html;*.htm;*.json;*.yaml;*.yml",
            CheckFileExists = true
        };
        if (dialog.ShowDialog(this) == true) await _viewModel.ReadExplorationDocumentAsync(dialog.FileName);
    }

    private void ApiRequestSelection_Click(object sender, RoutedEventArgs e) => _viewModel.RefreshSaveState();
    private async void SaveApiRequest_Click(object sender, RoutedEventArgs e) => await _viewModel.SaveApiRequestChangesAsync();

    private async void CopyLog_Click(object sender, RoutedEventArgs e)
    {
        LogCopyStatus.Text = (await ClipboardService.CopyTextAsync(_viewModel.ConsoleText)).Message;
    }

    private void ShowLog_Click(object sender, RoutedEventArgs e)
    {
        if (_logWindow is not null) { _logWindow.WindowState = WindowState.Normal; _logWindow.Activate(); return; }
        _logWindow = new LogWindow(() => _viewModel.ConsoleText, text => LogExportService.SaveAsync(_viewModel.Project, text)) { Owner = this };
        _logWindow.Closed += (_, _) => _logWindow = null;
        _logWindow.Show();
    }

    private void LogCopy_CanExecute(object sender, CanExecuteRoutedEventArgs e)
    {
        e.CanExecute = ExecutionLogTextBox.SelectionLength > 0;
        e.Handled = true;
    }

    private async void LogCopy_Executed(object sender, ExecutedRoutedEventArgs e)
    {
        e.Handled = true;
        LogCopyStatus.Text = (await ClipboardService.CopyTextAsync(ExecutionLogTextBox.SelectedText)).Message;
    }

    private void CandidateUrl_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string value } ||
            !Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https")) return;

        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"URLをブラウザで開けませんでした。\n{ex.Message}", "ScopePilot",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void CandidateGrid_CellEditEnding(object sender, DataGridCellEditEndingEventArgs e)
    {
        if (e.EditAction == DataGridEditAction.Commit && e.Column.Header?.ToString() == "採用" &&
            e.Row.Item is ScopePilot.Domain.DiagnosticCandidate candidate)
            Dispatcher.BeginInvoke(new Action(() => _ = _viewModel.UpdateCandidateDecisionAsync(candidate)));
    }

    private void GuidelineCheckBox_Click(object sender, RoutedEventArgs e) =>
        Dispatcher.BeginInvoke(new Action(() => _ = _viewModel.ApplyGuidelineSelectionAsync()));

    private void RunArtifact_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string fileName }) _viewModel.OpenSelectedRunArtifact(fileName);
    }

    private void RolesTextBox_TextChanged(object sender, TextChangedEventArgs e) =>
        Dispatcher.BeginInvoke(new Action(_viewModel.UpdateRoleOptions));

    private async void DeleteSelectedRun_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        if (_viewModel.SelectedRun is null)
        {
            MessageBox.Show(this, "実行履歴の一覧で削除する探索実行を選択してください。", "ScopePilot", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var answer = MessageBox.Show(this,
            $"{_viewModel.SelectedRun.StartedAtDisplay} の探索実行フォルダーを削除します。\n案件へ取り込み済みの通信は残ります。続行しますか？",
            "探索実行データの削除", MessageBoxButton.YesNo, MessageBoxImage.Warning);
        if (answer == MessageBoxResult.Yes) await _viewModel.DeleteSelectedRunAsync();
    }

    private async void DeleteGeneratedArtifacts_Click(object sender, RoutedEventArgs e)
    {
        if (_viewModel.IsRunning) return;
        var answer = MessageBox.Show(this,
            "現在の案件で生成したBurp出力とレポートを削除します。案件、観測通信、探索実行履歴は残ります。続行しますか？",
            "生成物の削除", MessageBoxButton.YesNo, MessageBoxImage.Warning);
        if (answer == MessageBoxResult.Yes) await _viewModel.DeleteGeneratedArtifactsAsync();
    }
}
