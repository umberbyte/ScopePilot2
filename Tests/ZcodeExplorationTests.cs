using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class ZcodeExplorationTests
{
    private static readonly string[] AllowedTools = ["browser_tabs", "browser_snapshot", "browser_navigate", "browser_network_requests", "browser_take_screenshot"];

    // 許可リスト外のツールは tools/list から除かれ、tools/call は転送されずに拒否される。
    [Fact]
    public async Task McpToolFilter_HidesAndBlocksToolsOutsideAllowList()
    {
        using var temp = new TempDirectory();
        var node = EnvironmentProbe.FindNode()!;
        var server = Path.Combine(temp.Path, "fake-mcp.js");
        // 受け取ったtools/callを記録し、どのツールでも成功を返す偽のMCPサーバー。
        await File.WriteAllTextAsync(server, """
            const fs = require('fs'); const log = process.argv[2]; let buf = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
              const m = JSON.parse(line);
              if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'browser_navigate' }, { name: 'browser_click' }, { name: 'browser_run_code_unsafe' }] } }) + '\n');
              else if (m.method === 'tools/call') { fs.appendFileSync(log, m.params.name + '\n'); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [] } }) + '\n'); }
              else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n'); } });
            process.stdin.on('end', () => process.exit(0));
            """);
        var calls = Path.Combine(temp.Path, "calls.txt");
        var info = new ProcessStartInfo(node)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false)
        };
        foreach (var arg in new[] { ZcodeExplorationRunner.McpToolFilterPath(), "--allow", string.Join(',', AllowedTools), "--", node, server, calls })
            info.ArgumentList.Add(arg);
        using var process = Process.Start(info)!;
        var stderr = process.StandardError.ReadToEndAsync();
        await process.StandardInput.WriteLineAsync("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}");
        await process.StandardInput.WriteLineAsync("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_click\",\"arguments\":{}}}");
        await process.StandardInput.WriteLineAsync("{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_navigate\",\"arguments\":{}}}");
        await process.StandardInput.FlushAsync();
        var responses = new Dictionary<int, JsonElement>();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        while (responses.Count < 3)
        {
            var line = await process.StandardOutput.ReadLineAsync(timeout.Token) ?? throw new InvalidDataException("フィルターが応答を返しませんでした。" + await stderr);
            using var document = JsonDocument.Parse(line);
            responses[document.RootElement.GetProperty("id").GetInt32()] = document.RootElement.Clone();
        }
        process.StandardInput.Close();
        await process.WaitForExitAsync(timeout.Token);

        var listed = responses[1].GetProperty("result").GetProperty("tools").EnumerateArray().Select(x => x.GetProperty("name").GetString()!).ToArray();
        Assert.Equal(["browser_navigate"], listed);
        Assert.Contains("not allowed", responses[2].GetProperty("error").GetProperty("message").GetString());
        Assert.True(responses[3].TryGetProperty("result", out _));
        // 拒否したツールはサーバーへ転送されない。
        Assert.Equal(["browser_navigate"], (await File.ReadAllLinesAsync(calls)).Where(x => x.Length > 0).ToArray());
        Assert.Contains("blocked tool call: browser_click", await stderr);
    }

    [Fact]
    public async Task ZcodeExploration_UsesCodexMcpServersBehindFilterAndIsolatedSettings()
    {
        using var temp = new TempDirectory();
        var servers = new Dictionary<string, object>
        {
            ["playwright"] = new { Command = @"C:\Program Files\nodejs\node.exe", Args = new[] { @"C:\pw\cli.js", "--cdp-endpoint", "http://127.0.0.1:9333" }, EnabledTools = AllowedTools }
        };
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "codex-mcp-config.json"), JsonSerializer.Serialize(servers));
        using var settings = JsonDocument.Parse(await ZcodeExplorationRunner.BuildSettingsAsync(temp.Path, @"C:\Program Files\nodejs\node.exe", @"C:\app\tools\mcp-tool-filter.js"));
        var root = settings.RootElement;
        Assert.False(root.GetProperty("plugins").GetProperty("enabled").GetBoolean());
        Assert.False(root.GetProperty("hooks").GetProperty("enabled").GetBoolean());
        Assert.False(root.GetProperty("features").GetProperty("subagent").GetBoolean());
        var playwright = root.GetProperty("mcp").GetProperty("servers").GetProperty("playwright");
        Assert.Equal(@"C:\Program Files\nodejs\node.exe", playwright.GetProperty("command").GetString());
        var args = playwright.GetProperty("args").EnumerateArray().Select(x => x.GetString()!).ToArray();
        Assert.Equal([@"C:\app\tools\mcp-tool-filter.js", "--allow", string.Join(',', AllowedTools), "--", @"C:\Program Files\nodejs\node.exe", @"C:\pw\cli.js", "--cdp-endpoint", "http://127.0.0.1:9333"], args);

        // 未知のMCPサーバーは登録しない。
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "codex-mcp-config.json"),
            JsonSerializer.Serialize(new Dictionary<string, object> { ["other"] = new { Command = "x", Args = Array.Empty<string>(), EnabledTools = new[] { "a" } } }));
        await Assert.ThrowsAsync<InvalidDataException>(() => ZcodeExplorationRunner.BuildSettingsAsync(temp.Path, "node", "filter"));

        var launch = new CliLaunch(@"C:\Program Files\nodejs\node.exe", @"C:\npm\zcode.js");
        var info = ZcodeExplorationRunner.CreateStartInfo(launch, "run", "glm-5.3-flash", "{\"type\":\"object\"}", zcodeProviderFile: null);
        var list = info.ArgumentList.ToList();
        Assert.Equal(@"C:\npm\zcode.js", list[0]);
        Assert.EndsWith("{\"type\":\"object\"}", list[list.IndexOf("-p") + 1], StringComparison.Ordinal);
        Assert.EndsWith(ZcodeExplorationRunner.PromptFileName, list[list.IndexOf("--attach") + 1], StringComparison.Ordinal);
        Assert.Equal("account:zai-individual-coding-plan/GLM-5.3-Flash", list[list.IndexOf("--model") + 1]);
        // 組み込みツール（シェル・ファイル・Web・ワークフローのコード評価）を除外する。
        var disallowed = list[list.IndexOf("--disallowed-tools") + 1].Split(' ');
        Assert.Contains("Bash", disallowed);
        Assert.Contains("WebFetch", disallowed);
        Assert.Contains("EvalWorkflowSnippet", disallowed);
        Assert.Equal(Path.Combine("run", ZcodeExplorationRunner.SettingsFileName), info.EnvironmentVariables["ZCODE_CLI_SETTINGS_FILE"]);
    }

    [Fact]
    public void ZcodeExplorationResult_IsAcceptedOnlyWhenRequiredFieldsExist()
    {
        const string valid = "{\"status\":\"partial\",\"summary\":\"確認しました\",\"observedRequestCount\":3,\"limitations\":[],\"findings\":[]}";
        var stdout = "ZCode Built-in skipped (not-due)\n" + JsonSerializer.Serialize(new { response = "```json\n" + valid + "\n```" });
        Assert.NotNull(ZcodeExplorationRunner.ExtractResult(stdout));
        Assert.Null(ZcodeExplorationRunner.ExtractResult(JsonSerializer.Serialize(new { response = "{\"status\":\"success\",\"summary\":\"x\"}" })));
        Assert.Null(ZcodeExplorationRunner.ExtractResult("出力なし"));
    }

    [Fact]
    public void ExplorationAiSelection_DefaultsToCodexAndSwitchesModelForGlm()
    {
        var model = new ViewModels.MainViewModel();
        Assert.Equal(0, model.ExplorationAiIndex);
        Assert.False(model.ExplorationAiModelEnabled);
        model.ExplorationAiIndex = 1;
        Assert.Equal(DocumentAiProvider.Glm, model.Project.ExplorationAi.Provider);
        Assert.True(model.ExplorationAiModelEnabled);
        model.ExplorationAiModelIndex = 1;
        Assert.Equal("glm-5.3-flash", model.Project.ExplorationAi.Model);
        model.ExplorationAiIndex = 0;
        Assert.Equal(DocumentAiProvider.Codex, model.Project.ExplorationAi.Provider);
        Assert.Equal(string.Empty, model.Project.ExplorationAi.Model);
    }

    // AIを切り替えるとモデルは一番上の候補へ戻り、ドロップダウンは表示名で選択を同期する。
    [Fact]
    public void ModelLabel_ResetsToFirstCandidateWhenAiChanges()
    {
        var model = new ViewModels.MainViewModel();
        model.DocModelLabel = model.DocModelOptions[1];
        Assert.Equal(1, model.DocModelIndex);
        model.DocProviderIndex = 1;
        Assert.Equal(model.DocModelOptions[0], model.DocModelLabel);
        model.DocModelLabel = null;   // 候補の置き換え中に渡されるnullは無視する
        Assert.Equal(0, model.DocModelIndex);
        model.ApiModelLabel = model.ApiModelOptions[2];
        model.ApiProviderIndex = 2;
        Assert.Equal(model.ApiModelOptions[0], model.ApiModelLabel);
        model.ExplorationAiIndex = 1;
        model.ExplorationAiModelLabel = model.ExplorationAiModelOptions[1];
        Assert.Equal("glm-5.3-flash", model.Project.ExplorationAi.Model);
    }

    // 認証ロールの入力中は案件全体の変更通知を出さず（日本語入力の変換中の文字を消さない）、選択中のロールを保持する。
    [Fact]
    public void RoleEditing_KeepsSelectedRoleWithoutRefreshingWholeProject()
    {
        var model = new ViewModels.MainViewModel();
        model.Project.Roles = "未認証\n一般ユーザー";
        model.UpdateRoleOptions(refreshProject: true);
        model.ActiveRole = "一般ユーザー";
        var projectNotifications = 0;
        model.PropertyChanged += (_, e) => { if (e.PropertyName == nameof(model.Project)) projectNotifications++; };

        model.Project.Roles = "未認証\n一般ユーザー\n管理者";
        model.UpdateRoleOptions();
        Assert.Equal(["未認証", "一般ユーザー", "管理者"], model.RoleOptions);
        Assert.Equal("一般ユーザー", model.ActiveRole);

        // すべて消しても未認証が残り、続けて入力できる。
        model.Project.Roles = string.Empty;
        model.UpdateRoleOptions();
        Assert.Equal(["未認証"], model.RoleOptions);
        Assert.Equal("未認証", model.ActiveRole);
        model.Project.Roles = "閲覧者";
        model.UpdateRoleOptions();
        Assert.Equal(["未認証", "閲覧者"], model.RoleOptions);
        Assert.Equal(0, projectNotifications);
        // 選択欄が候補の更新中に渡すnullは無視する。
        model.ActiveRole = null!;
        Assert.Equal("未認証", model.ActiveRole);
    }

    private sealed class TempDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ScopePilot.Tests", Guid.NewGuid().ToString("N"));
        public TempDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() { try { Directory.Delete(Path, recursive: true); } catch { } }
    }
}
