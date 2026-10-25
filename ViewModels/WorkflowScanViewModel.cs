using ScopePilot.Infrastructure;
using ScopePilot.Services;
using ScopePilot.Services.WorkflowScan;

namespace ScopePilot.ViewModels;

// ワークフロー診断：状態遷移・複数role比較・トークン系列分析・暗号解析・API操作を要する
// 脆弱性（ZAPの単一リクエスト診断では検出できないもの）を対象へ直接実行する部分ViewModel。
public sealed partial class MainViewModel
{
    private readonly WorkflowScanService _workflowScan = new();
    private AsyncRelayCommand? _startWorkflowScanCommand;
    private string _workflowScanStatus = "";

    public AsyncRelayCommand StartWorkflowScanCommand => _startWorkflowScanCommand ??= new AsyncRelayCommand(StartWorkflowScanAsync,
        () => !IsRunning && !IsApiMode);

    public string WorkflowScanStatus
    {
        get => _workflowScanStatus;
        private set { _workflowScanStatus = value; RaisePropertyChanged(); }
    }

    private async Task StartWorkflowScanAsync()
    {
        if (!await TryEnsureProjectAsync()) return;
        var username = Project.DiagnosticTools.WorkflowScanUsername.Trim();
        var password = Project.DiagnosticTools.WorkflowScanPassword;
        if (username.Length == 0 || password.Length == 0)
        {
            WorkflowScanStatus = "ワークフロー診断には診断用アカウント（ユーザー名・パスワード）が必要です。［診断ツールへ］タブのワークフロー診断欄に入力してください。";
            Log(WorkflowScanStatus);
            return;
        }
        IsRunning = true;
        StartWorkflowScanCommand.RaiseCanExecuteChanged();
        _runCancellation = new CancellationTokenSource();
        _runCancellation.CancelAfter(TimeSpan.FromMinutes(Math.Clamp(Project.MaxMinutes, 1, 120) + 5));
        try
        {
            var options = new WorkflowScanOptions(Project.StartUrl, username, password)
            {
                MaxRequests = Math.Min(Math.Max(Project.MaxRequests, 100), 2000)
            };
            var result = await _workflowScan.RunAsync(Project, options, message => Log(message), _runCancellation.Token);
            var imported = 0;
            foreach (var check in result.Checks)
            {
                var finding = WorkflowScanFindingMapper.ToFinding(check, result.RunDirectory);
                var fingerprint = WorkflowScanFindingMapper.Fingerprint(finding);
                var existing = Project.Findings.FirstOrDefault(item => WorkflowScanFindingMapper.Fingerprint(item) == fingerprint);
                if (existing is not null) Project.Findings.Remove(existing);
                Project.Findings.Add(finding);
                imported++;
            }
            WorkflowScanStatus = $"ワークフロー診断: {imported}件の所見を記録しました（リクエスト {result.RequestCount}件、検証レベル {result.TestedSecurityLevels}）。所見は診断レポートへ反映されます。";
            Log(WorkflowScanStatus);
        }
        catch (OperationCanceledException) { WorkflowScanStatus = "ワークフロー診断を停止しました。"; Log(WorkflowScanStatus); }
        catch (Exception ex) { WorkflowScanStatus = $"ワークフロー診断に失敗しました: {ex.Message}"; Log(WorkflowScanStatus); }
        finally
        {
            IsRunning = false;
            StartWorkflowScanCommand.RaiseCanExecuteChanged();
            _runCancellation.Dispose();
            _runCancellation = null;
            RefreshSummary();
            try { await RecordProjectChangeAsync(); await RefreshRunHistoryAsync(); await RefreshDataSummaryAsync(); }
            catch (Exception ex) { Log($"診断データの保存に失敗しました: {ex.Message}"); }
        }
    }
}
