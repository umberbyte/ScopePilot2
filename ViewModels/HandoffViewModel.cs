using ScopePilot.Domain;
using ScopePilot.Infrastructure;
using ScopePilot.Services;

namespace ScopePilot.ViewModels;

public sealed partial class MainViewModel
{
    private readonly ZapHandoffService _zapHandoff = new();
    private readonly ZapCliRunner _zapRunner = new();
    private readonly ZapResultImporter _zapResults = new();
    private AsyncRelayCommand? _startZapCommand;
    private AsyncRelayCommand? _prepareZapAddonsCommand;
    private AsyncRelayCommand? _recordZapBrowserCommand;
    private string _zapActiveScanConfirmation = "";
    public const string ZapActiveScanConfirmationPhrase = "ACTIVE";
    public AsyncRelayCommand StartZapCommand => _startZapCommand ??= new AsyncRelayCommand(StartZapAsync,
        () => !IsRunning && IsZapTarget && (!ZapActiveScanEnabled || ZapActiveScanConfirmation == ZapActiveScanConfirmationPhrase));
    public AsyncRelayCommand PrepareZapAddonsCommand => _prepareZapAddonsCommand ??= new AsyncRelayCommand(() => RunZapPreparationAsync(false), () => !IsRunning && IsZapTarget);
    public AsyncRelayCommand RecordZapBrowserCommand => _recordZapBrowserCommand ??= new AsyncRelayCommand(() => RunZapPreparationAsync(true), () => !IsRunning && IsZapTarget);
    public int HandoffTargetIndex
    {
        get => (int)Project.DiagnosticTools.Target;
        set
        {
            if (IsRunning || value is not (0 or 1) || Project.DiagnosticTools.Target == (HandoffTarget)value) return;
            Project.DiagnosticTools.Target = (HandoffTarget)value;
            LastBurpExportDirectory = null;
            BurpScopeRegexes.Clear();
            BurpHandoffStatus = IsZapTarget ? "採用対象を確認してZAPパッケージを出力してください。診断開始には選択中のロールのHARが必要です。"
                : IsApiMode ? "採用したAPIリクエストをBurp Repeaterへ渡します。" : "採用候補のScope正規表現をBurpへ登録します。";
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(IsZapTarget));
            RaisePropertyChanged(nameof(IsBurpTarget));
            RaisePropertyChanged(nameof(HandoffDescription));
            RaisePropertyChanged(nameof(BurpExportActionText));
            StartZapCommand.RaiseCanExecuteChanged();
            PrepareZapAddonsCommand.RaiseCanExecuteChanged();
            RecordZapBrowserCommand.RaiseCanExecuteChanged();
            CopyNextBurpRegexCommand.RaiseCanExecuteChanged();
        }
    }
    public bool IsZapTarget { get => Project.DiagnosticTools.Target == HandoffTarget.Zap; set { if (value) HandoffTargetIndex = 1; } }
    public bool IsBurpTarget { get => !IsZapTarget; set { if (value) HandoffTargetIndex = 0; } }
    public bool ZapActiveScanEnabled
    {
        get => Project.DiagnosticTools.EnableZapActiveScan;
        set
        {
            if (Project.DiagnosticTools.EnableZapActiveScan == value) return;
            Project.DiagnosticTools.EnableZapActiveScan = value;
            ZapActiveScanConfirmation = "";
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(HandoffDescription));
            StartZapCommand.RaiseCanExecuteChanged();
            RefreshSaveState();
        }
    }
    public string ZapActiveScanConfirmation
    {
        get => _zapActiveScanConfirmation;
        set
        {
            if (_zapActiveScanConfirmation == value) return;
            _zapActiveScanConfirmation = value ?? "";
            RaisePropertyChanged();
            StartZapCommand.RaiseCanExecuteChanged();
        }
    }
    public string ZapActiveScanStrength
    {
        get => Project.DiagnosticTools.ActiveScanStrength;
        set
        {
            var normalized = ZapActiveScanProfile.NormalizeStrength(value);
            if (Project.DiagnosticTools.ActiveScanStrength == normalized) return;
            Project.DiagnosticTools.ActiveScanStrength = normalized;
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(HandoffDescription));
            RefreshSaveState();
        }
    }
    public string ZapActiveScanThreshold
    {
        get => Project.DiagnosticTools.ActiveScanThreshold;
        set
        {
            var normalized = ZapActiveScanProfile.NormalizeThreshold(value);
            if (Project.DiagnosticTools.ActiveScanThreshold == normalized) return;
            Project.DiagnosticTools.ActiveScanThreshold = normalized;
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(HandoffDescription));
            RefreshSaveState();
        }
    }
    public int ZapActiveScanMaxTargets
    {
        get => Project.DiagnosticTools.MaxActiveScanTargets;
        set
        {
            var normalized = ZapActiveScanProfile.NormalizeTargets(value);
            if (Project.DiagnosticTools.MaxActiveScanTargets == normalized) return;
            Project.DiagnosticTools.MaxActiveScanTargets = normalized;
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(HandoffDescription));
            RefreshSaveState();
        }
    }
    public bool ZapActiveScanIncludeReferenceHars
    {
        get => Project.DiagnosticTools.IncludeReferenceHars;
        set
        {
            if (Project.DiagnosticTools.IncludeReferenceHars == value) return;
            Project.DiagnosticTools.IncludeReferenceHars = value;
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(HandoffDescription));
            RefreshSaveState();
        }
    }
    public bool ZapActiveScanUseRecordedAuthentication
    {
        get => Project.DiagnosticTools.UseRecordedAuthentication;
        set
        {
            if (Project.DiagnosticTools.UseRecordedAuthentication == value) return;
            Project.DiagnosticTools.UseRecordedAuthentication = value;
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(HandoffDescription));
            RefreshSaveState();
        }
    }
    public string HandoffDescription => IsZapTarget
        ? ZapActiveScanEnabled
            ? $"ZAP: 保存済みHARを取り込み、採用済みURLへアクティブ診断を行います（強度{ZapActiveScanStrength}・閾値{ZapActiveScanThreshold}・対象上限{ZapActiveScanMaxTargets}件）。攻撃リクエストを送信するため、実行ごとの承認が必要です。"
            : "ZAP: Playwrightで正常操作を手動記録し、保存済みHARを解析します。必要add-onの導入と版記録、History・HAR・traceの保存に対応しています。"
        : BurpModeDescription;
    public string DiagnosticObservationSummary => $"ツール警告: {Project.DiagnosticObservations.Count}件（実影響未確認）";

    private async Task RunZapPreparationAsync(bool recordBrowser)
    {
        if (!await TryEnsureProjectAsync()) return;
        IsRunning = true;
        _runCancellation = new CancellationTokenSource(TimeSpan.FromMinutes(Math.Clamp(Project.MaxMinutes, 1, 120) + 5));
        var directory = ProjectPaths.Resolve(Project, $"runs/zap-{(recordBrowser ? "browser" : "addons")}-{DateTimeOffset.Now:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}");
        try
        {
            Directory.CreateDirectory(directory);
            LastBurpExportDirectory = directory;
            await File.WriteAllTextAsync(Path.Combine(directory, "engagement.json"), System.Text.Json.JsonSerializer.Serialize(new
            {
                mode = recordBrowser ? "zap-browser" : "zap-addons", activeRole = Project.ActiveRole,
                runStartedAt = DateTimeOffset.Now
            }));
            await ZapHandoffService.WriteStatusAsync(directory, "running", 0, null);
            await RecordProjectChangeAsync();
            if (recordBrowser)
            {
                var result = await new ZapBrowserRecordingService().RecordAsync(Project, directory, new Progress<string>(Log), _runCancellation.Token);
                foreach (var reference in result.Evidence) Project.Inputs.Add(reference);
                var har = result.Evidence.First(x => x.Kind == "har");
                var known = Project.Requests.Select(ObservedRequestIdentity.Build).ToHashSet(StringComparer.Ordinal);
                foreach (var request in await _importer.ImportAsync(ProjectPaths.Resolve(Project, har.LocalPath)))
                {
                    ApiRequestFormatter.EnsureAllowed(request.Url, Project.AllowedOrigins);
                    request.Role = har.Role;
                    request.Source = "Playwright手動記録（主体未確認）";
                    RequestImporter.Normalize(request);
                    if (known.Add(ObservedRequestIdentity.Build(request))) Project.Requests.Add(request);
                }
                GenerateCandidates();
                BurpHandoffStatus = $"Playwright記録: {result.Status} / ZAP Historyとの一致 {result.MatchedMessages}件。HARを保存しました。採用対象を確認して［ZAP診断を開始］へ進んでください。主体・実影響は未確認です。";
            }
            else
            {
                await new ZapAddonService().PrepareAsync(Project, directory, Path.Combine(directory, "zap-home"), new Progress<string>(Log), _runCancellation.Token, ZapActiveScanEnabled);
                await ZapHandoffService.WriteStatusAsync(directory, "prepared", 0, null);
                BurpHandoffStatus = "必要add-onを準備しました。導入ログ・版・SHA-256は出力フォルダーに保存しています。";
            }
            Log(BurpHandoffStatus);
        }
        catch (OperationCanceledException)
        {
            await ZapHandoffService.WriteStatusAsync(directory, "cancelled", 0, null);
            BurpHandoffStatus = "ZAPの準備・記録を停止しました。保存済み証拠は出力フォルダーで確認できます。";
            Log(BurpHandoffStatus);
        }
        catch (Exception ex)
        {
            await ZapHandoffService.WriteStatusAsync(directory, "failed", 0, null);
            BurpHandoffStatus = $"ZAPの準備・記録に失敗しました: {ex.Message}";
            Log(BurpHandoffStatus);
        }
        finally
        {
            _runCancellation.Dispose();
            _runCancellation = null;
            IsRunning = false;
            try { await RecordProjectChangeAsync(); await RefreshRunHistoryAsync(); await RefreshDataSummaryAsync(); }
            catch (Exception ex) { Log($"記録データの保存に失敗しました: {ex.Message}"); }
        }
    }

    private async Task ExportZapAsync()
    {
        try
        {
            var package = await _zapHandoff.BuildAsync(Project, AppSettingsService.Load().ActiveScanTuning());
            LastBurpExportDirectory = package.Directory;
            BurpHandoffStatus = package.MessageCount > 0
                ? $"保存済み通信 {package.MessageCount}件のZAPパッケージを準備しました。［ZAP診断を開始］でCLI実行できます。"
                : "未送信のAPI下書きを出力しました。診断開始には、選択中のロールで観測済み応答を含むHARが必要です。";
            await RecordProjectChangeAsync();
            await RefreshRunHistoryAsync();
            await RefreshDataSummaryAsync();
            Log($"ZAPパッケージ: {package.Directory}");
        }
        catch (Exception ex) { Log($"ZAP出力に失敗しました: {ex.Message}"); }
    }
    private async Task StartZapAsync()
    {
        if (!await TryEnsureProjectAsync()) return;
        var activeScanAcknowledged = !ZapActiveScanEnabled || ZapActiveScanConfirmation == ZapActiveScanConfirmationPhrase;
        if (!activeScanAcknowledged)
        {
            BurpHandoffStatus = "アクティブ診断を実行するには、警告を確認してACTIVEと入力してください。";
            Log(BurpHandoffStatus);
            return;
        }
        IsRunning = true;
        StartZapCommand.RaiseCanExecuteChanged();
        _runCancellation = new CancellationTokenSource();
        _runCancellation.CancelAfter(TimeSpan.FromMinutes(Math.Clamp(Project.MaxMinutes, 1, 120) + 5));
        try
        {
            await RecordProjectChangeAsync();
            var package = await _zapHandoff.BuildAsync(Project, AppSettingsService.Load().ActiveScanTuning());
            LastBurpExportDirectory = package.Directory;
            var result = await _zapRunner.RunAsync(Project, package, new Progress<string>(Log), _runCancellation.Token, activeScanAcknowledged,
                AppSettingsService.Load().ActiveScanTuning());
            if (result.Status is "completed" or "warnings" && result.ReportPath is not null)
            {
                var count = await _zapResults.ImportAsync(Project, result.ReportPath);
                BurpHandoffStatus = $"ZAP: {result.Status} / 新規警告 {count}件。警告は実影響未確認です。";
                Log(BurpHandoffStatus);
            }
            else { BurpHandoffStatus = $"ZAP実行に失敗しました（終了コード {result.ExitCode}）。出力フォルダーのログを確認してください。"; Log(BurpHandoffStatus); }
        }
        catch (OperationCanceledException) { BurpHandoffStatus = "ZAP診断を停止しました。保存済みのログは出力フォルダーで確認できます。"; Log(BurpHandoffStatus); }
        catch (Exception ex) { BurpHandoffStatus = $"ZAP診断を開始・完了できませんでした: {ex.Message}"; Log(BurpHandoffStatus); }
        finally
        {
            ZapActiveScanConfirmation = "";
            IsRunning = false;
            StartZapCommand.RaiseCanExecuteChanged();
            _runCancellation.Dispose();
            _runCancellation = null;
            RaisePropertyChanged(nameof(DiagnosticObservationSummary));
            try { await RecordProjectChangeAsync(); await RefreshRunHistoryAsync(); await RefreshDataSummaryAsync(); }
            catch (Exception ex) { Log($"診断データの保存に失敗しました: {ex.Message}"); }
        }
    }
    public async Task ImportZapReportAsync(string path)
    {
        if (IsRunning || !await TryEnsureProjectAsync()) return;
        try
        {
            var evidence = await ProjectPaths.ImportAsync(Project, path, "zap-report");
            var count = await _zapResults.ImportAsync(Project, ProjectPaths.Resolve(Project, evidence.LocalPath));
            Project.Inputs.Add(evidence);
            await RecordProjectChangeAsync();
            RaisePropertyChanged(nameof(DiagnosticObservationSummary));
            Log($"ZAP JSONレポートから新規警告{count}件を取り込みました（実影響未確認）。");
        }
        catch (Exception ex) { Log($"ZAP結果を取り込めませんでした: {ex.Message}"); }
    }
}
