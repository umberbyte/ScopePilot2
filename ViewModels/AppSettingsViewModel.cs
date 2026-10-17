using ScopePilot.Domain;
using ScopePilot.Infrastructure;
using ScopePilot.Services;

namespace ScopePilot.ViewModels;

// アプリ設定画面（ユーザー単位・%APPDATA%の設定ファイル）のViewModel部分。
public sealed partial class MainViewModel
{
    private AppSettings? _appSettings;
    private RelayCommand? _saveAppSettingsCommand;
    private AsyncRelayCommand? _checkAllAiConnectionsCommand;
    private AsyncRelayCommand? _checkCodexConnectionCommand;
    private AsyncRelayCommand? _checkClaudeConnectionCommand;
    private AsyncRelayCommand? _checkGlmConnectionCommand;
    private RelayCommand? _clearGlmApiKeyCommand;
    private string _codexConnectionStatusText = string.Empty;
    private string _claudeConnectionStatusText = string.Empty;
    private string _glmConnectionStatusText = string.Empty;
    // 画面で入力中のGLM APIキー（平文）。［設定を保存］で暗号化して登録し、入力欄は空に戻す。
    private string _glmApiKeyInput = string.Empty;
    // 保存・登録解除の後にPasswordBoxを空へ戻すための通知（PasswordBoxはバインドできないため）。
    public event Action? GlmApiKeyInputCleared;
    public AppSettings AppSettings => _appSettings ??= AppSettingsService.Load();
    public string AppSettingsPath => AppSettingsService.SettingsPath;
    public RelayCommand SaveAppSettingsCommand => _saveAppSettingsCommand ??= new RelayCommand(SaveAppSettings);
    public AsyncRelayCommand CheckAllAiConnectionsCommand => _checkAllAiConnectionsCommand ??= new AsyncRelayCommand(
        () => Task.WhenAll(CheckCodexConnectionAsync(), CheckClaudeConnectionAsync(), CheckGlmConnectionAsync()));
    public AsyncRelayCommand CheckCodexConnectionCommand => _checkCodexConnectionCommand ??= new AsyncRelayCommand(CheckCodexConnectionAsync);
    public AsyncRelayCommand CheckClaudeConnectionCommand => _checkClaudeConnectionCommand ??= new AsyncRelayCommand(CheckClaudeConnectionAsync);
    public AsyncRelayCommand CheckGlmConnectionCommand => _checkGlmConnectionCommand ??= new AsyncRelayCommand(CheckGlmConnectionAsync);
    public RelayCommand ClearGlmApiKeyCommand => _clearGlmApiKeyCommand ??= new RelayCommand(ClearGlmApiKey);

    public string CodexConnectionStatusText
    {
        get => _codexConnectionStatusText;
        private set => SetProperty(ref _codexConnectionStatusText, value);
    }

    public string ClaudeConnectionStatusText
    {
        get => _claudeConnectionStatusText;
        private set => SetProperty(ref _claudeConnectionStatusText, value);
    }

    public string GlmConnectionStatusText
    {
        get => _glmConnectionStatusText;
        private set => SetProperty(ref _glmConnectionStatusText, value);
    }

    public string GlmApiKeyInput
    {
        get => _glmApiKeyInput;
        set => _glmApiKeyInput = value ?? string.Empty;
    }

    // 登録状態の表示。キーの値そのものは表示しない。
    public string GlmApiKeyStatusText
    {
        get
        {
            var source = AppSettingsService.GlmApiKeySource(AppSettings);
            if (source == "設定ファイル") return "APIキー: 登録済み（設定ファイルへDPAPIで暗号化して保存）。GLMはこのキーで実行します。";
            if (source.Length > 0) return $"APIキー: 未登録（{source} のキーで実行します）。";
            return "APIキー: 未登録。zcode login のZ.aiサインインで実行します。";
        }
    }

    private void SaveAppSettings()
    {
        try
        {
            // 入力欄が空なら既存のAPIキー登録は変更しない。
            var key = GlmApiKeyInput.Trim();
            if (key.Length > 0) AppSettings.GlmApiKey = key;
            AppSettingsService.Save(AppSettings);
            _appSettings = AppSettingsService.Load();
            ClearGlmApiKeyInput();
            RaisePropertyChanged(nameof(AppSettings));
            RaisePropertyChanged(nameof(GlmApiKeyStatusText));
            Log($"アプリ設定を保存しました: {AppSettingsPath}{(key.Length > 0 ? "（GLMのAPIキーを暗号化して登録）" : string.Empty)}");
        }
        catch (Exception ex)
        {
            Log($"アプリ設定を保存できませんでした: {ex.Message}");
            ShowProjectError?.Invoke($"アプリ設定を保存できませんでした。{Environment.NewLine}{ex.Message}");
        }
    }

    public void RefreshAppSettingsBindings()
    {
        _appSettings = null;
        RaisePropertyChanged(nameof(AppSettings));
        RaisePropertyChanged(nameof(GlmApiKeyStatusText));
    }

    // 既定値に戻しても、登録済みのAPIキーは保持する（解除は［登録を解除］で行う）。
    public void ResetAppSettings()
    {
        _appSettings = new AppSettings { GlmApiKey = AppSettings.GlmApiKey };
        RaisePropertyChanged(nameof(AppSettings));
        Log("アプリ設定の編集内容を既定値に戻しました（GLMのAPIキーの登録は保持）。［設定を保存］で確定します。");
    }

    // 登録解除は保存済み設定へ直ちに反映する（画面上の他の未保存の編集は保存しない）。
    private void ClearGlmApiKey()
    {
        try
        {
            var saved = AppSettingsService.Load();
            saved.GlmApiKey = string.Empty;
            AppSettingsService.Save(saved);
            AppSettings.GlmApiKey = string.Empty;
            ClearGlmApiKeyInput();
            RaisePropertyChanged(nameof(GlmApiKeyStatusText));
            Log("GLMのAPIキーの登録を解除しました。");
        }
        catch (Exception ex)
        {
            Log($"GLMのAPIキーの登録を解除できませんでした: {ex.Message}");
            ShowProjectError?.Invoke($"GLMのAPIキーの登録を解除できませんでした。{Environment.NewLine}{ex.Message}");
        }
    }

    private void ClearGlmApiKeyInput()
    {
        _glmApiKeyInput = string.Empty;
        GlmApiKeyInputCleared?.Invoke();
    }

    private Task CheckCodexConnectionAsync() =>
        CheckAiConnectionAsync(checker => checker.CheckCodexAsync(CancellationToken.None), text => CodexConnectionStatusText = text);
    private Task CheckClaudeConnectionAsync() =>
        CheckAiConnectionAsync(checker => checker.CheckClaudeAsync(), text => ClaudeConnectionStatusText = text);
    private Task CheckGlmConnectionAsync() =>
        CheckAiConnectionAsync(checker => checker.CheckGlmAsync(CancellationToken.None), text => GlmConnectionStatusText = text);

    // AIごとの確認の共通処理。結果はそのAIの欄とアプリのログへ出す。
    private async Task CheckAiConnectionAsync(Func<AiConnectionChecker, Task<AiConnectionCheck>> check, Action<string> show)
    {
        try
        {
            show("確認しています…");
            var result = await check(new AiConnectionChecker());
            show(FormatAiCheck(result));
            Log($"AI接続確認 {result.Label}: {FormatAiCheck(result)}");
        }
        catch (Exception ex)
        {
            show($"確認できませんでした: {ex.Message}");
            Log($"AIの接続状況を確認できませんでした: {ex.Message}");
        }
    }

    private static string FormatAiCheck(AiConnectionCheck check) =>
        $"[{(check.Ok ? "OK" : "要設定")}] {check.Detail}";
}
