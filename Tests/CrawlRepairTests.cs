using System.Diagnostics;
using System.IO;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class CrawlRepairTests
{
    [Fact]
    public void StructuredStdoutCanBeSavedByHostWithoutAgentFileWrites()
    {
        var result = JsonSerializer.Serialize(new { status = "partial", summary = "到達範囲", observedRequestCount = 2, limitations = new[] { "一部未到達" }, findings = Array.Empty<object>() });
        var line = JsonSerializer.Serialize(new { type = "item.completed", item = new { type = "agent_message", text = result } });
        Assert.Equal(result, CodexExplorationRunner.StructuredResultMessage(line));
        Assert.Null(CodexExplorationRunner.StructuredResultMessage("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"進行中\"}}"));
        Assert.Null(CodexExplorationRunner.StructuredResultMessage("{\"type\":\"error\"}"));
    }

    [Fact]
    public async Task RejectsWrongStartPortBeforeCreatingRun()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.StartUrl = "http://example.test/index.php";
        project.AllowedOrigins = "http://example.test:4280";
        await Assert.ThrowsAsync<InvalidDataException>(() => new ExplorationPackageBuilder().BuildAsync(project));
        Assert.False(Directory.Exists(ProjectPaths.Category(project, "runs")));
    }

    [Fact]
    public async Task HarOnlyLandingIsImportedWithoutTreatingUnknownAuthenticationAsAnonymousOrImportingSecrets()
    {
        using var temp = new TestFolder();
        var stamp = DateTimeOffset.UtcNow.AddMinutes(-1);
        var entries = new[] { ("/login", "POST", 302), ("/home", "GET", 200), ("/failure", "GET", 0) }.Select(x => new
        {
            startedDateTime = stamp,
            request = new { method = x.Item2, url = "https://example.test" + x.Item1, postData = new { text = "SECRET" } },
            response = new { status = x.Item3, content = new { mimeType = "text/html", text = "SECRET" } }
        });
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "zap-ai-capture.har"), JsonSerializer.Serialize(new { log = new { entries } }));
        var collector = new RunObservationCollector();
        Assert.Equal(2, await collector.CollectAsync(temp.Path, "https://example.test", "未認証"));
        var text = await File.ReadAllTextAsync(Path.Combine(temp.Path, "observed-requests.jsonl"));
        Assert.DoesNotContain("SECRET", text);
        var items = await new RequestImporter().ImportAsync(Path.Combine(temp.Path, "observed-requests.jsonl"));
        Assert.All(items, x => { Assert.Equal("認証状態未確認", x.Role); Assert.Equal(stamp, x.ObservedAt); });
        Assert.Equal(2, await collector.CollectAsync(temp.Path, "https://example.test", "未認証"));
    }

    [Fact]
    public async Task RuntimeMcpConfigUsesOwnedBrowserAndLeavesUserConfigurationAlone()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        var run = await new ExplorationPackageBuilder().BuildAsync(project);
        await File.WriteAllTextAsync(Path.Combine(run, "browser-runtime.json"), "{\"status\":\"ready\",\"cdpEndpoint\":\"http://127.0.0.1:9333\"}");
        var setup = await new McpSetupService().ConfigureAsync(project, new(ExplorationProxyMode.Zap, "http://127.0.0.1:8090"), run);
        Assert.True(setup.Success, string.Join("\n", setup.Messages));
        var args = await McpSetupService.RuntimeArgumentsAsync(run);
        Assert.Contains(args, x => x.Contains("--cdp-endpoint"));
        Assert.DoesNotContain(args, x => x.Contains("browser_click") || x.Contains("browser_run_code"));
        Assert.True(File.Exists(Path.Combine(run, "mcp-setup.log")));
    }

    [Fact]
    public async Task LocalFixtureLoginContinuesNormalBrowsingAndSharesSessionWithMcp()
    {
        using var temp = new TestFolder();
        var node = EnvironmentProbe.FindNode()!;
        var info = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        info.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "crawl-integration.cjs"));
        info.ArgumentList.Add(AppContext.BaseDirectory);
        info.ArgumentList.Add(temp.Path);
        using var process = Process.Start(info)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(80));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { process.Kill(true); throw; }
        Assert.True(process.ExitCode == 0, await output + await error);
    }
}
