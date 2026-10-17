using System.Diagnostics;
using System.Text;
using ScopePilot.Domain;

namespace ScopePilot.Services;

// 入力ドキュメントの補助情報抽出を実行する。APIドキュメントモードと同じ
// プロバイダー・モデル・推論レベルの選択（ExplorationDocumentSettings）を使う。
public sealed class DocumentHintRunner
{
    private Process? _process;

    internal static ProcessStartInfo CreateStartInfo(CliLaunch launch, DocumentAiProvider provider, string runDirectory,
        string? model = null, AiReasoningLevel reasoning = AiReasoningLevel.Middle, string? glmSchema = null,
        string? zcodeProviderFile = null)
    {
        var modelId = DocumentAiCatalog.NormalizeModel(provider, model);
        var info = new ProcessStartInfo(launch.FileName)
        {
            WorkingDirectory = runDirectory, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false)
        };
        var args = launch.PrefixArguments.ToList();
        if (provider == DocumentAiProvider.Codex)
            args.AddRange(new[] { "exec", "--model", modelId, "--json", "--color", "never", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                "--config", "approval_policy=\"never\"", "--config", "features.shell_tool=false", "--config", "features.apply_patch_freeform=false",
                "--config", "web_search=\"disabled\"", "--config", $"model_reasoning_effort=\"{ApiDocumentAiRunner.CodexReasoningEffort(reasoning)}\"",
                "--skip-git-repo-check", "--cd", runDirectory,
                "--output-schema", Path.Combine(runDirectory, "hint-schema.json"),
                "--output-last-message", Path.Combine(runDirectory, "document-hints-result.json"), "-" });
        else if (provider == DocumentAiProvider.Glm)
            args.AddRange(new[] { "-p", ApiDocumentAiRunner.ZcodePrompt(glmSchema ?? DocumentHintService.Schema),
                "--attach", Path.Combine(runDirectory, "prompt.md"),
                "--model", DocumentAiCatalog.ZcodeModelId(modelId, zcodeProviderFile is not null),
                "--disallowed-tools", ApiDocumentAiRunner.ZcodeDisallowedTools,
                "--json", "--no-color", "--cwd", runDirectory });
        else
            args.AddRange(new[] { "--safe-mode", "-p", "--model", modelId, "--output-format", "json", "--json-schema", DocumentHintService.Schema,
                "--settings", "{\"disableAllHooks\":true}", "--tools", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--no-session-persistence" });
        foreach (var arg in args) info.ArgumentList.Add(arg);
        if (provider == DocumentAiProvider.Claude)
            info.EnvironmentVariables["MAX_THINKING_TOKENS"] = ApiDocumentAiRunner.ClaudeThinkingTokens(reasoning).ToString();
        if (provider == DocumentAiProvider.Glm)
            info.EnvironmentVariables["ZCODE_CLI_SETTINGS_FILE"] = Path.Combine(runDirectory, ApiDocumentAiRunner.ZcodeSettingsFileName);
        if (provider == DocumentAiProvider.Glm && zcodeProviderFile is not null)
            info.EnvironmentVariables["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"] = zcodeProviderFile;
        return info;
    }

    // Failureは失敗時に利用者へ示す原因（GLMのみ。判別できなければnull）。
    public async Task<(int ExitCode, bool Cancelled, string ResultPath, string? Failure)> RunAsync(
        string runDirectory, ExplorationDocumentSettings document, IProgress<string> progress, CancellationToken cancellationToken)
    {
        var provider = document.AiProvider;
        var launch = ApiDocumentAiRunner.FindLaunch(provider) ?? throw new FileNotFoundException(provider == DocumentAiProvider.Glm
            ? "GLMの実行にはzcode CLI（npmグローバル）とnode.jsが必要です。アプリ設定でAPIキーを登録するか、zcode login でZ.aiへサインインしてください。"
            : $"{DocumentAiCatalog.DisplayName(provider)}が見つかりません。インストールしてログインしてください。");
        var model = DocumentAiCatalog.NormalizeModel(provider, document.Model);
        var prompt = await File.ReadAllTextAsync(Path.Combine(runDirectory, "prompt.md"), cancellationToken);
        var resultPath = Path.Combine(runDirectory, "document-hints-result.json");
        if (provider == DocumentAiProvider.Glm) ApiDocumentAiRunner.WriteZcodeRuntimeFiles(runDirectory);
        using var apiKeyFile = provider == DocumentAiProvider.Glm ? ApiDocumentAiRunner.CreateZcodeApiKeyFile(model) : null;
        using var process = Process.Start(CreateStartInfo(launch, provider, runDirectory, model, document.ReasoningLevel, zcodeProviderFile: apiKeyFile?.Path))
            ?? throw new InvalidOperationException($"{DocumentAiCatalog.DisplayName(provider)}を起動できませんでした。");
        _process = process;
        progress.Report($"{DocumentAiCatalog.DisplayName(provider)}（{model}{ApiDocumentAiRunner.ReasoningSuffix(provider, document.ReasoningLevel)}）が入力ドキュメントから探索の補助情報を抽出しています (PID {process.Id})。");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        using var registration = cancellationToken.Register(Stop);
        var cancelled = false;
        Exception? inputError = null;
        try
        {
            if (provider == DocumentAiProvider.Glm) process.StandardInput.Close();
            else
            {
                await process.StandardInput.WriteAsync(prompt.AsMemory(), cancellationToken);
                process.StandardInput.Close();
            }
            await process.WaitForExitAsync(cancellationToken);
        }
        catch (Exception ex) when (cancellationToken.IsCancellationRequested && ex is OperationCanceledException or IOException)
        {
            cancelled = true;
            Stop();
            await process.WaitForExitAsync();
        }
        catch (Exception ex)
        {
            inputError = ex;
            Stop();
            await process.WaitForExitAsync();
        }
        finally { _process = null; }
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        await File.WriteAllTextAsync(Path.Combine(runDirectory, "document-hints-run.log"),
            $"{ApiDocumentAiRunner.RunLogHeader(provider, model, document.ReasoningLevel, apiKeyFile is not null)} exit={process.ExitCode}; cancelled={cancelled}\n{stderr}\n{stdout}", new UTF8Encoding(false));
        if (inputError is not null)
            throw new IOException($"{DocumentAiCatalog.DisplayName(provider)}への入力を完了できませんでした。document-hints-run.logを確認してください。", inputError);
        if (!cancelled && process.ExitCode == 0 && provider is DocumentAiProvider.Claude or DocumentAiProvider.Glm)
            await File.WriteAllTextAsync(resultPath, provider == DocumentAiProvider.Glm
                ? ApiDocumentAiRunner.ExtractZcodeResult(stdout) : ApiDocumentAiRunner.ExtractClaudeResult(stdout), new UTF8Encoding(false));
        var failure = process.ExitCode != 0 && !cancelled && provider == DocumentAiProvider.Glm
            ? ApiDocumentAiRunner.ZcodeFailureSummary(stderr + "\n" + stdout) : null;
        return (process.ExitCode, cancelled, resultPath, failure);
    }

    public void Stop()
    {
        try { if (_process is { HasExited: false } process) process.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }
}
