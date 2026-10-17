using ScopePilot.Domain;
using ScopePilot.Services;

namespace ScopePilot.ViewModels;

public sealed partial class MainViewModel
{
    public Func<string?>? ChooseNewProjectFile { get; set; }
    public Func<string?>? ChooseOpenProjectFile { get; set; }
    public Func<bool>? ConfirmDiscardChanges { get; set; }
    public Action<string>? ShowProjectError { get; set; }
    public Func<bool>? CommitPendingEdits { get; set; }
    private string _savedProjectSnapshot = "";
    public bool HasUnsavedChanges => !string.IsNullOrWhiteSpace(Project.ProjectFilePath) && _store.Snapshot(Project) != _savedProjectSnapshot;
    public string SaveStateText => HasUnsavedChanges ? "未保存の変更があります。［保存］でプロジェクトファイルに保存してください。" : "プロジェクトファイルは保存済みです。";
    public string ProjectLocation => string.IsNullOrWhiteSpace(Project.ProjectFilePath)
        ? "プロジェクトを開くか新規作成してください。" : Project.ProjectFilePath;

    public void RefreshSaveState()
    {
        RaisePropertyChanged(nameof(HasUnsavedChanges));
        RaisePropertyChanged(nameof(SaveStateText));
    }
    private Task RecordProjectChangeAsync() { RefreshSaveState(); return Task.CompletedTask; }
    private Task EnsureProjectAsync()
    {
        if (string.IsNullOrWhiteSpace(Project.ProjectFilePath)) throw new InvalidOperationException("プロジェクトフォルダーを開くか、新規作成してください。");
        ProjectPaths.CheckProjectFile(Project);
        return Task.CompletedTask;
    }
    private async Task<bool> TryEnsureProjectAsync()
    {
        try { await EnsureProjectAsync(); return true; }
        catch (Exception ex) { Log(ex.Message); return false; }
    }
    public async Task<bool> SaveCurrentProjectAsync()
    {
        try
        {
            if (CommitPendingEdits?.Invoke() == false) throw new InvalidOperationException("入力内容を確定できませんでした。入力欄を確認してください。");
            await EnsureProjectAsync();
            await _store.SaveAsync(Project);
            _savedProjectSnapshot = _store.Snapshot(Project);
            RefreshSaveState();
            Log($"プロジェクトファイルを保存しました: {Project.ProjectFilePath}");
            return true;
        }
        catch (Exception ex) { Log($"保存失敗: {ex.Message}"); ShowProjectError?.Invoke($"保存できませんでした。\n{ex.Message}"); return false; }
    }
    public bool CanDiscardChanges()
    {
        var committed = CommitPendingEdits?.Invoke() != false;
        return committed && !HasUnsavedChanges || ConfirmDiscardChanges?.Invoke() == true;
    }
    private async Task NewProjectAsync() => await CreateNewProjectAsync();
    public async Task<bool> CreateNewProjectAsync()
    {
        if (IsRunning || !CanDiscardChanges()) return false;
        try
        {
            var path = ChooseNewProjectFile?.Invoke();
            if (string.IsNullOrWhiteSpace(path)) return false;
            if (File.Exists(path)) throw new IOException("既存のプロジェクトは［プロジェクトフォルダーを開く］から選択してください。");
            var created = new EngagementProject { ProjectFilePath = Path.GetFullPath(path), Name = Path.GetFileName(Path.GetDirectoryName(path))! };
            await _store.SaveAsync(created); // The explicit create action generates the initial project file.
            Project = created;
            await ProjectOpenedAsync();
            return true;
        }
        catch (Exception ex) { Log($"プロジェクトを作成できませんでした: {ex.Message}"); ShowProjectError?.Invoke(ex.Message); return false; }
    }
    private async Task LoadProjectAsync() => await OpenSelectedProjectAsync();
    public async Task<bool> OpenSelectedProjectAsync()
    {
        if (IsRunning || !CanDiscardChanges()) return false;
        var path = ChooseOpenProjectFile?.Invoke();
        return !string.IsNullOrWhiteSpace(path) && await OpenProjectAsync(path, discardConfirmed: true);
    }
    public async Task<bool> OpenProjectAsync(string path, bool discardConfirmed = false)
    {
        if (IsRunning || (!discardConfirmed && !CanDiscardChanges())) return false;
        try
        {
            var loaded = await _store.LoadAsync(path);
            Project = loaded;
            if (Project.Status is ProjectStatus.Crawling or ProjectStatus.WaitingForHuman or ProjectStatus.Organizing)
                Project.Status = ProjectStatus.Paused;
            await ProjectOpenedAsync();
            return true;
        }
        catch (Exception ex) { Log($"プロジェクトを開けませんでした: {ex.Message}"); ShowProjectError?.Invoke(ex.Message); return false; }
    }
    private async Task ProjectOpenedAsync()
    {
        UpdateRoleOptions();
        CandidateSearch = "";
        SetCandidateReviewFilter("すべて");
        ResetBurpHandoff();
        _currentRunDirectory = null;
        InterventionText = "";
        ResetAuthenticationState();
        ResetWordReport();
        SelectedCandidate = null;
        SelectedFinding = null;
        LastBackupPath = null;
        Logs.Clear();
        RefreshFilteredCandidates();
        await RefreshRunHistoryAsync();
        await RefreshDataSummaryAsync();
        _savedProjectSnapshot = _store.Snapshot(Project);
        RefreshSaveState();
        RaisePropertyChanged(nameof(ProjectLocation));
        RaisePropertyChanged(nameof(HandoffTargetIndex));
        RaisePropertyChanged(nameof(IsZapTarget));
        RaisePropertyChanged(nameof(IsBurpTarget));
        ZapActiveScanConfirmation = "";
        RaisePropertyChanged(nameof(ZapActiveScanEnabled));
        RaisePropertyChanged(nameof(HandoffDescription));
        RaisePropertyChanged(nameof(DiagnosticObservationSummary));
        StartZapCommand.RaiseCanExecuteChanged();
        PrepareZapAddonsCommand.RaiseCanExecuteChanged();
        RecordZapBrowserCommand.RaiseCanExecuteChanged();
        Log($"プロジェクトを開きました: {Project.ProjectFilePath}");
        RefreshSummary();
    }
    private void OpenProjectFolder()
    {
        if (string.IsNullOrWhiteSpace(Project.ProjectFilePath)) { Log("プロジェクトフォルダーを開くか新規作成してください。"); return; }
        OpenRunPath(ProjectPaths.Root(Project), "プロジェクトフォルダー");
    }
    public async Task ImportLegacyProjectAsync(string source, string destination)
    {
        if (IsRunning || !CanDiscardChanges()) return;
        try
        {
            Project = await new LegacyProjectImporter().ImportAsync(source, destination);
            await ProjectOpenedAsync();
            Log("旧案件のコピーを移行しました。移行元は保持されています。");
        }
        catch (Exception ex) { Log($"旧案件を移行できませんでした: {ex.Message}"); ShowProjectError?.Invoke(ex.Message); }
    }
}
