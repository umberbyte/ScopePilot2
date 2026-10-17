using System.Text.Json;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record McpSetupResult(bool Success, IReadOnlyList<string> Messages)
{
    public bool UseBurpMcp { get; init; }
    public bool DisableBurpMcp { get; init; }
}
internal sealed record McpRuntimeServer(string Command, string[] Args, string[] EnabledTools);

public sealed class McpSetupService
{
    public async Task<McpSetupResult> ConfigureAsync(EngagementProject project, ExplorationProxyEndpoint? endpoint = null, string? runDirectory = null)
    {
        var messages = new List<string>();
        var node = EnvironmentProbe.FindNode();
        var cli = Path.Combine(AppContext.BaseDirectory, "tools", "playwright-runtime", "node_modules", "@playwright", "mcp", "cli.js");
        // 画面探索のAI（Codex CLIまたはGLM（zcode））の実行環境を確認する。
        if (project.ExplorationAi?.Provider == DocumentAiProvider.Glm)
        {
            if (ApiDocumentAiRunner.FindLaunch(DocumentAiProvider.Glm) is null) messages.Add("[失敗] zcode CLI（npmグローバル）が見つかりません。");
            if (!File.Exists(ZcodeExplorationRunner.McpToolFilterPath())) messages.Add($"[失敗] MCPツールフィルターが見つかりません: {ZcodeExplorationRunner.McpToolFilterPath()}");
        }
        else if (ApiDocumentAiRunner.FindLaunch(DocumentAiProvider.Codex) is null) messages.Add("[失敗] Codex CLIが見つかりません。");
        if (node is null || !File.Exists(node)) messages.Add("[失敗] " + EnvironmentProbe.NodeNotFoundMessage);
        if (!File.Exists(cli)) messages.Add($"[失敗] Playwright MCP本体が見つかりません: {cli}");
        if (runDirectory is null)
        {
            if (messages.Count == 0) messages.Add("[OK] 必要な実行ファイルを確認しました。MCP設定は実行ごとに準備します。");
            return new(!messages.Any(x => x.StartsWith("[失敗]")), messages);
        }
        ProjectPaths.EnsureChild(ProjectPaths.Root(project), runDirectory);
        var servers = new Dictionary<string, McpRuntimeServer>();
        try
        {
            if (messages.Count > 0) return new(false, messages);
            using var browser = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(runDirectory, "browser-runtime.json")));
            if (browser.RootElement.GetProperty("status").GetString() != "ready") throw new InvalidDataException("探索ブラウザが停止しています。");
            var cdp = browser.RootElement.GetProperty("cdpEndpoint").GetString()!;
            var uri = ExplorationProxyService.ValidateLocalProxy(cdp);
            if (!uri.IsLoopback) throw new InvalidDataException("探索ブラウザはローカル接続が必要です。");
            var output = ProjectPaths.Resolve(project, "outputs/playwright");
            Directory.CreateDirectory(output);
            servers["playwright"] = new(node!, [cli, "--cdp-endpoint", cdp, "--ignore-https-errors", "--timeout-action", "15000", "--timeout-navigation", "20000", "--output-dir", output],
                ["browser_tabs", "browser_snapshot", "browser_navigate", "browser_network_requests", "browser_take_screenshot"]);
            messages.Add("[OK] Playwright MCPは現在の探索ブラウザへ接続します。認証セッションを引き継ぎます。");
            var java = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "BurpSuite", "jre", "bin", "java.exe");
            var jar = BurpProxyLocation.Resolve();
            var useBurp = endpoint?.Provider == ExplorationProxyMode.Burp && File.Exists(java) && File.Exists(jar) &&
                await ExplorationProxyService.CanConnectAsync(new Uri("http://127.0.0.1:9876"));
            if (useBurp) servers["burp"] = new(java, ["-jar", jar, "--sse-url", "http://127.0.0.1:9876"], ["get_proxy_http_history", "get_proxy_http_history_regex"]);
            messages.Add(useBurp ? "[OK] Burp履歴MCPを今回の実行に追加しました。" : "[OK] PlaywrightとHARの通信記録を使用します。");
            await File.WriteAllTextAsync(Path.Combine(runDirectory, "codex-mcp-config.json"), JsonSerializer.Serialize(servers, new JsonSerializerOptions { WriteIndented = true }));
            return new(true, messages) { UseBurpMcp = useBurp };
        }
        catch (Exception ex) { messages.Add($"[失敗] MCP準備: {ex.GetType().Name}: {ex.Message}"); return new(false, messages); }
        finally
        {
            await File.WriteAllLinesAsync(Path.Combine(runDirectory, "mcp-setup.log"), messages);
        }
    }

    internal static async Task<string[]> RuntimeArgumentsAsync(string runDirectory)
    {
        var servers = JsonSerializer.Deserialize<Dictionary<string, McpRuntimeServer>>(await File.ReadAllTextAsync(Path.Combine(runDirectory, "codex-mcp-config.json")))
            ?? throw new InvalidDataException("実行用MCP設定がありません。");
        var args = new List<string>();
        foreach (var (name, server) in servers)
        {
            if (name is not ("playwright" or "burp")) throw new InvalidDataException("未知のMCP設定です。");
            void Set(string key, string value) { args.Add("--config"); args.Add($"mcp_servers.{name}.{key}={value}"); }
            Set("command", JsonSerializer.Serialize(server.Command));
            Set("args", JsonSerializer.Serialize(server.Args));
            Set("enabled_tools", JsonSerializer.Serialize(server.EnabledTools));
            Set("default_tools_approval_mode", "\"approve\"");
            Set("required", name == "playwright" ? "true" : "false");
        }
        return args.ToArray();
    }

    internal static bool MatchesConfiguration(string json, IReadOnlyList<string> command, IReadOnlyDictionary<string, string>? environment = null)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.TryGetProperty("enabled", out var enabled) && enabled.ValueKind == JsonValueKind.False) return false;
            var transport = root.GetProperty("transport");
            if (transport.GetProperty("type").GetString() != "stdio" || !string.Equals(transport.GetProperty("command").GetString(), command[0], StringComparison.OrdinalIgnoreCase)) return false;
            if (!transport.GetProperty("args").EnumerateArray().Select(x => x.GetString()).SequenceEqual(command.Skip(1), StringComparer.Ordinal)) return false;
            if (environment is not null)
                foreach (var pair in environment)
                    if (!transport.GetProperty("env").TryGetProperty(pair.Key, out var value) || value.GetString() != pair.Value) return false;
            return true;
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or IndexOutOfRangeException) { return false; }
    }
}
