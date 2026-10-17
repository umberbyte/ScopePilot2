using System.Diagnostics;
using System.Net.Sockets;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed class EnvironmentProbe
{
    public const string NodeNotFoundMessage = "Node.jsが見つかりません。Node.jsのインストール先または SCOPEPILOT_NODE_PATH（node.exe のフルパス）を確認してください。";
    public async Task<IReadOnlyList<EnvironmentCheck>> CheckAsync(EngagementProject? project = null)
    {
        var codexPath = ResolveExecutable("codex.exe", FindCodexInstallations());
        var nodePath = FindNode();
        var npxPath = ResolveExecutable("npx.cmd", [Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "npx.cmd")]);
        // 画面探索のAIがGLMならzcode CLIを、それ以外はCodex CLIを確認する。
        var codex = project?.ExplorationAi?.Provider == DocumentAiProvider.Glm
            ? ProbeZcode()
            : await ProbeAsync("Codex CLI", codexPath, "--version");
        var node = await ProbeAsync("Node.js", nodePath, "--version");
        var npm = await ProbeAsync("npm / npx", npxPath, "--version");
        if (project is not null)
        {
            try
            {
                var selected = await ExplorationProxyService.SelectAsync(project.ExplorationProxy, ExplorationProxyService.ProbeBurpProxyAsync);
                if (selected == ExplorationProxyMode.Zap)
                    return [codex, node, npm,
                        new EnvironmentCheck("探索用ZAP", File.Exists(project.DiagnosticTools.ZapJarPath),
                            "ZAPのJAR: " + project.DiagnosticTools.ZapJarPath),
                        new EnvironmentCheck("ZAP用Java", File.Exists(project.DiagnosticTools.JavaPath),
                            "Java: " + project.DiagnosticTools.JavaPath)];
                return [codex, node, npm, new EnvironmentCheck("探索用Burp", true,
                    $"接続先: {project.ExplorationProxy.BurpProxyUrl}。Burp履歴MCPは任意です。")];
            }
            catch (Exception ex) { return [codex, node, npm, new EnvironmentCheck("探索用プロキシ", false, ex.Message)]; }
        }
        var burp = await ProbeTcpAsync("Burp MCP", "127.0.0.1", 9876, "BurpのMCPタブでサーバーを有効化してください");
        var burpProxy = await ProbeTcpAsync("Burp Proxy", "127.0.0.1", 8080, "BurpのProxy settingsでListenerを有効化してください");
        var proxyJar = BurpProxyLocation.Resolve();
        var externalProxy = new EnvironmentCheck("Burp stdioプロキシ", File.Exists(proxyJar), File.Exists(proxyJar)
            ? $"外部プロキシ: {proxyJar}" : $"Burp MCP拡張から取得したJARを配置してください: {proxyJar}");
        return [codex, node, npm, burp, burpProxy, externalProxy,
            new EnvironmentCheck("Playwright MCP", npm.Available, npm.Available
                ? $"npxを検出しました: {npxPath}"
                : "npxが見つかりません。Node.jsのnpm/npxを利用可能にしてください。")];
    }

    private static EnvironmentCheck ProbeZcode()
    {
        var launch = ApiDocumentAiRunner.FindLaunch(DocumentAiProvider.Glm);
        if (launch is null) return new("GLM（zcode）", false, "zcode CLI（%APPDATA%\\npm）とnode.jsが見つかりません。画面探索のAIをGLMにする場合はインストールしてください。");
        return AiConnectionChecker.GlmCredentialAvailable()
            ? new("GLM（zcode）", true, $"{launch.DisplayPath}（画面探索・認証はAPIキーまたはzcode login）")
            : new("GLM（zcode）", false, "APIキーもZ.aiサインインも確認できません。アプリ設定でAPIキーを登録するか zcode login でサインインしてください。");
    }

    private static async Task<EnvironmentCheck> ProbeAsync(string name, string? command, string arguments)
    {
        if (string.IsNullOrWhiteSpace(command)) return new(name, false, "実行ファイルが見つかりません。");
        try
        {
            var isCommandScript = Path.GetExtension(command).Equals(".cmd", StringComparison.OrdinalIgnoreCase) ||
                                  Path.GetExtension(command).Equals(".bat", StringComparison.OrdinalIgnoreCase);
            var startInfo = new ProcessStartInfo
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            if (isCommandScript)
            {
                startInfo.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
                startInfo.ArgumentList.Add("/d");
                startInfo.ArgumentList.Add("/c");
                startInfo.ArgumentList.Add(command);
                startInfo.ArgumentList.Add(arguments);
            }
            else
            {
                startInfo.FileName = command;
                startInfo.ArgumentList.Add(arguments);
            }

            using var process = Process.Start(startInfo);
            if (process is null) return new(name, false, "起動できませんでした。");
            var output = await process.StandardOutput.ReadToEndAsync();
            var error = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            var detail = string.IsNullOrWhiteSpace(output) ? error.Trim() : output.Trim();
            var version = detail.Split('\n').FirstOrDefault()?.Trim() ?? string.Empty;
            return new(name, process.ExitCode == 0, $"{version}  ({command})");
        }
        catch (Exception ex)
        {
            return new(name, false, ex.Message);
        }
    }

    private static string? ResolveExecutable(string fileName, IEnumerable<string> knownPaths)
    {
        foreach (var path in knownPaths.Where(File.Exists)) return path;
        var pathValues = new[]
        {
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Process),
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User),
            Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine)
        };
        foreach (var directory in pathValues.SelectMany(x => (x ?? string.Empty).Split(';', StringSplitOptions.RemoveEmptyEntries)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var candidate = Path.Combine(directory.Trim().Trim('"'), fileName);
                if (File.Exists(candidate)) return candidate;
            }
            catch { /* Broken PATH entries are ignored. */ }
        }
        return null;
    }

    public static string? FindNode() => ResolveNode(
        Environment.GetEnvironmentVariable("SCOPEPILOT_NODE_PATH"), AppContext.BaseDirectory,
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        new[] { EnvironmentVariableTarget.Process, EnvironmentVariableTarget.User, EnvironmentVariableTarget.Machine }
            .Select(target => Environment.GetEnvironmentVariable("PATH", target)));

    internal static string? ResolveNode(string? configuredPath, string applicationDirectory, string programFiles,
        string localApplicationData, string userProfile, IEnumerable<string?> pathValues)
    {
        var preferred = new[]
        {
            configuredPath?.Trim().Trim('"') ?? "",
            Path.Combine(applicationDirectory, "tools", "node", "node.exe"),
            Path.Combine(programFiles, "nodejs", "node.exe"),
            Path.Combine(localApplicationData, "Programs", "nodejs", "node.exe")
        };
        foreach (var path in preferred) if (File.Exists(path)) return Path.GetFullPath(path);
        foreach (var directory in pathValues.SelectMany(value => (value ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
                     .Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var path = Path.Combine(directory.Trim().Trim('"'), "node.exe");
                if (Path.IsPathFullyQualified(path) && File.Exists(path)) return path;
            }
            catch (ArgumentException) { /* Ignore malformed PATH entries. */ }
        }
        // Optional local runtime installed with the Codex desktop workspace dependencies.
        // An installed Node.js or an explicit selection always takes precedence.
        var bundled = Path.Combine(userProfile, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "bin", "node.exe");
        return File.Exists(bundled) ? bundled : null;
    }

    private static IEnumerable<string> FindCodexInstallations()
    {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenAI", "Codex", "bin");
        if (!Directory.Exists(root)) return [];
        return Directory.GetFiles(root, "codex.exe", SearchOption.AllDirectories)
            .OrderByDescending(File.GetLastWriteTimeUtc);
    }

    private static async Task<EnvironmentCheck> ProbeTcpAsync(string name, string host, int port, string failureHint)
    {
        try
        {
            using var client = new TcpClient();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await client.ConnectAsync(host, port, timeout.Token);
            return new(name, true, $"接続できました: http://{host}:{port}");
        }
        catch
        {
            return new(name, false, $"接続できません。{failureHint}: http://{host}:{port}");
        }
    }
}
