using System.Diagnostics;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record AiConnectionCheck(bool Ok, string Label, string Detail);

// アプリ設定画面の「AIの接続状況を確認」。実行環境・認証情報を確認するだけで、
// モデルへの生成要求（課金対象）は行わない。AIごとに個別にも確認できる。
public sealed class AiConnectionChecker
{
    public async Task<IReadOnlyList<AiConnectionCheck>> CheckAllAsync(CancellationToken cancellationToken) =>
        [await CheckCodexAsync(cancellationToken), await CheckClaudeAsync(), await CheckGlmAsync(cancellationToken)];

    public async Task<AiConnectionCheck> CheckCodexAsync(CancellationToken cancellationToken)
    {
        var launch = ApiDocumentAiRunner.FindLaunch(DocumentAiProvider.Codex);
        if (launch is null)
            return new(false, "Codex CLI", "codex.exeが見つかりません。インストールしてログインしてください。");
        var (exitCode, output, error) = await RunAsync(launch, ["login", "status"], cancellationToken);
        var text = (output + Environment.NewLine + error).Trim();
        if (text.Contains("not logged in", StringComparison.OrdinalIgnoreCase) || exitCode != 0)
            return new(false, "Codex CLI",
                $"ログインを確認できませんでした（終了コード {exitCode}）。codex login でログインしてください。");
        return new(true, "Codex CLI", $"ログイン済みです（{launch.DisplayPath}）。");
    }

    public Task<AiConnectionCheck> CheckClaudeAsync()
    {
        var launch = ApiDocumentAiRunner.FindLaunch(DocumentAiProvider.Claude);
        if (launch is null)
            return Task.FromResult(new AiConnectionCheck(false, "Claude Code CLI",
                "claude.exeが見つかりません。%USERPROFILE%\\.local\\bin または %APPDATA%\\npm（node_modules\\@anthropic-ai\\claude-code\\bin）へインストールしてログインしてください。"));
        var credentials = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", ".credentials.json");
        if (!File.Exists(credentials) && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY")))
            return Task.FromResult(new AiConnectionCheck(false, "Claude Code CLI",
                $"実行ファイルは確認しましたが認証情報が見つかりません。claude でログインするか ANTHROPIC_API_KEY を設定してください。"));
        return Task.FromResult(new AiConnectionCheck(true, "Claude Code CLI",
            $"実行ファイルと認証情報を確認しました（{launch.DisplayPath}）。ログイン状態は実行時にも確認します。"));
    }

    // 画面の編集中（未保存）の設定ではなく、保存済み設定で確認する（実行時と同じ解決順）。
    public async Task<AiConnectionCheck> CheckGlmAsync(CancellationToken cancellationToken, AppSettings? appSettings = null)
    {
        var launch = ApiDocumentAiRunner.FindLaunch(DocumentAiProvider.Glm);
        if (launch is null)
            return new(false, "GLM（Z.ai・zcode）",
                "zcode CLI（%APPDATA%\\npm）とnode.jsが見つかりません。npmグローバルへインストールしてください。");
        var (_, output, error) = await RunAsync(launch, ["--version"], cancellationToken);
        var version = (output + Environment.NewLine + error).Trim();
        var versionNote = version.Length == 0 ? string.Empty : $"（{version.Split('\n')[0].Trim()}）";
        // APIキー（設定ファイル・環境変数）を優先し、未登録ならzcode loginのサインインを使う。キーの有効性は実行時に確認する。
        var keySource = AppSettingsService.GlmApiKeySource(appSettings);
        if (keySource.Length > 0)
            return new(true, "GLM（Z.ai・zcode）",
                $"zcode{versionNote}とAPIキー（{keySource}）を確認しました（{launch.DisplayPath}）。キーの有効性は実行時に確認します。");
        if (!ZcodeSignedIn())
            return new(false, "GLM（Z.ai・zcode）",
                $"zcodeは見つかりました{versionNote}が、APIキーもZ.aiサインインも確認できません。APIキーを登録するか zcode login でサインインしてください。");
        return new(true, "GLM（Z.ai・zcode）",
            $"zcode{versionNote}とZ.aiサインイン（zcode login）を確認しました（{launch.DisplayPath}）。");
    }

    // GLMの実行に使える認証（APIキーまたはzcode loginのサインイン）があるか。
    internal static bool GlmCredentialAvailable() => AppSettingsService.ResolveGlmApiKey().Length > 0 || ZcodeSignedIn();

    // zcodeのサインイン状態は共有資格情報ファイルの存在で確認する（ZCODE_CLI_CREDENTIALS_FILEで上書き可）。
    internal static bool ZcodeSignedIn()
    {
        var credentials = Environment.GetEnvironmentVariable("ZCODE_CLI_CREDENTIALS_FILE") is { Length: > 0 } overridden
            ? overridden
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".zcode", "v2", "credentials.json");
        return File.Exists(credentials);
    }

    private static async Task<(int ExitCode, string Output, string Error)> RunAsync(CliLaunch launch, IReadOnlyList<string> args, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        var info = new ProcessStartInfo(launch.FileName)
        {
            WorkingDirectory = Path.GetDirectoryName(launch.FileName) ?? string.Empty,
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var arg in launch.PrefixArguments.Concat(args)) info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new InvalidOperationException($"{Path.GetFileName(launch.DisplayPath)}を起動できませんでした。");
        try
        {
            var stdout = await process.StandardOutput.ReadToEndAsync(timeout.Token);
            var stderr = await process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            return (process.ExitCode, stdout, stderr);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
            return (-1, string.Empty, "確認がタイムアウトしました。");
        }
        catch (Exception ex)
        {
            return (-1, string.Empty, ex.Message);
        }
    }
}
