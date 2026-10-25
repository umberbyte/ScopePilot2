using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class ZapExtensionTests
{
    [Fact]
    public void AutomationPlanCollectsRequestAndResponseEvidence()
    {
        var plan = ZapHandoffService.CreatePlan(["https://example.test/path"], 1);
        Assert.Contains("template: traditional-json-plus", plan);
        Assert.DoesNotContain("template: traditional-json\n", plan);
    }

    [Theory]
    [InlineData("https://example.test/security.php")]
    [InlineData("https://example.test/setup.php?reset=1")]
    public void ConfigurationPagesAreExcludedFromActiveScan(string url)
    {
        Assert.True(ZapHandoffService.IsActiveScanExcluded(url));
        Assert.False(ZapHandoffService.IsActiveScanExcluded("https://example.test/vulnerabilities/sqli/"));
    }

    [Fact]
    public async Task MissingAddonIsInstalledOnlyIntoProjectCacheAndInventoryDetectsTampering()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.DiagnosticTools.ZapJarPath = Path.Combine(temp.Path, "zap.jar");
        project.DiagnosticTools.JavaPath = Path.Combine(temp.Path, "java.exe");
        await File.WriteAllTextAsync(project.DiagnosticTools.ZapJarPath, "fixture");
        await File.WriteAllTextAsync(project.DiagnosticTools.JavaPath, "fixture");
        var install = Path.Combine(temp.Path, "plugin");
        Directory.CreateDirectory(install);
        foreach (var id in ZapAddonService.RequiredIds.Where(x => x != "exim")) Addon(install, id);
        var requests = new List<string>();
        var service = new ZapAddonService(async (_, home, args, log, _) =>
        {
            if (args[0] == "-addoninstall") { requests.Add(args[1]); Addon(Path.Combine(home, "plugin"), args[1]); }
            await File.WriteAllTextAsync(log, "Installed Add-ons: [" + string.Join(", ", ZapAddonService.RequiredIds.Select(id => $"[id={id}, version=1.0.0]")) + "]");
            return 0;
        });
        var run = ProjectPaths.Resolve(project, "runs/addons");
        Directory.CreateDirectory(run);
        var snapshot = await service.PrepareAsync(project, run, Path.Combine(run, "zap-home"), null, CancellationToken.None);
        Assert.Equal(new[] { "exim" }, requests);
        Assert.False(File.Exists(Path.Combine(install, "exim-release-1.zap")));
        Assert.Contains(snapshot.Addons, x => x.Id == "exim" && x.Version == "1.0.0");
        await snapshot.VerifyAsync(CancellationToken.None);
        await File.AppendAllTextAsync(project.DiagnosticTools.ZapJarPath, "changed");
        await Assert.ThrowsAsync<InvalidDataException>(() => snapshot.VerifyAsync(CancellationToken.None));
    }

    [Fact]
    public async Task FailedAddonInstallationBlocksPreparation()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.DiagnosticTools.ZapJarPath = Path.Combine(temp.Path, "zap.jar");
        project.DiagnosticTools.JavaPath = Path.Combine(temp.Path, "java.exe");
        await File.WriteAllTextAsync(project.DiagnosticTools.ZapJarPath, "fixture");
        await File.WriteAllTextAsync(project.DiagnosticTools.JavaPath, "fixture");
        var service = new ZapAddonService((_, _, _, _, _) => Task.FromResult(1));
        var run = ProjectPaths.Resolve(project, "runs/addons");
        Directory.CreateDirectory(run);
        await Assert.ThrowsAsync<IOException>(() => service.PrepareAsync(project, run, Path.Combine(run, "zap-home"), null, CancellationToken.None));
        Assert.False(File.Exists(Path.Combine(run, "zap-environment.json")));
    }

    [Fact]
    public void HistoryCorrelationRequiresSameSessionAndConsumesEachMessageOnce()
    {
        using var har = JsonDocument.Parse("""
        {"log":{"entries":[
          {"request":{"method":"POST","url":"https://example.test/action","headers":[{"name":"Cookie","value":"SID=one"},{"name":"Authorization","value":"Bearer SECRET"}],"postData":{"text":"body"}},"response":{"status":200}},
          {"request":{"method":"POST","url":"https://example.test/action","headers":[{"name":"Cookie","value":"SID=one"},{"name":"Authorization","value":"Bearer SECRET"}],"postData":{"text":"body"}},"response":{"status":200}}
        ]}}
        """);
        using var history = JsonDocument.Parse("""
        {"messages":[
          {"id":"1","requestHeader":"POST https://example.test/action HTTP/1.1\r\nCookie: SID=other\r\nAuthorization: Bearer SECRET\r\n","requestBody":"body","responseHeader":"HTTP/1.1 200 OK\r\n"},
          {"id":"2","requestHeader":"POST https://example.test/action HTTP/1.1\r\nCookie: SID=one\r\nAuthorization: Bearer SECRET\r\n","requestBody":"body","responseHeader":"HTTP/1.1 200 OK\r\n"}
        ]}
        """);
        var matches = ZapCaptureCorrelator.Match(har.RootElement, history.RootElement);
        Assert.Equal("2", matches[0].MessageId);
        Assert.Null(matches[1].MessageId);
        Assert.DoesNotContain("SECRET", JsonSerializer.Serialize(matches));
        Assert.DoesNotContain("SID", JsonSerializer.Serialize(matches));
    }

    [InstalledZapFact]
    public Task InstalledZapAndPlaywrightRecordNormalPageWithTraceAndHistoryCorrelation() => RecordFixtureAsync(false);

    [InstalledZapFact]
    public Task StoppingInstalledPlaywrightFlushesEvidenceBeforeOwnedZapStops() => RecordFixtureAsync(true);

    private static async Task RecordFixtureAsync(bool stop)
    {
        using var temp = new TestFolder();
        await using var server = new PageServer();
        var project = temp.Project();
        project.StartUrl = server.Url + "/";
        project.AllowedOrigins = server.Url;
        project.ActiveRole = "手動テスト";
        project.MaxRequests = 20;
        project.MaxMinutes = 1;
        project.DiagnosticTools.ZapJarPath = Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_ZAP_JAR")!;
        project.DiagnosticTools.JavaPath = Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_JAVA")!;
        var run = ProjectPaths.Resolve(project, "runs/browser");
        using var token = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        var progress = new InlineProgress(message => { if (stop && message.StartsWith("Playwright記録中")) token.Cancel(); });
        var result = await new ZapBrowserRecordingService().RecordAsync(project, run, progress, token.Token, fixture: true);
        Assert.True(result.MatchedMessages > 0, await File.ReadAllTextAsync(Path.Combine(run, "browser-console.log")));
        Assert.Equal("recorded", result.Status);
        Assert.Contains(result.Evidence, x => x.Kind == "playwright-trace");
        Assert.Equal(project.ActiveRole, result.Evidence.Single(x => x.Kind == "har").Role);
        foreach (var reference in result.Evidence) await ProjectPaths.VerifyAsync(project, reference);
        using var correlation = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(run, "browser-zap-correlation.json")));
        Assert.False(correlation.RootElement.GetProperty("identityVerified").GetBoolean());
        Assert.Equal(JsonValueKind.Null, correlation.RootElement.GetProperty("effectObserved").ValueKind);
        using var summary = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(run, "browser-summary.json")));
        if (stop) Assert.Equal("user_stopped", summary.RootElement.GetProperty("stopReason").GetString());
        using var config = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(run, "browser-config.json")));
        Assert.False(await ExplorationProxyService.CanConnectAsync(new Uri(config.RootElement.GetProperty("proxy").GetString()!)));
        var retained = Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_ZAP_ARTIFACTS");
        if (!string.IsNullOrEmpty(retained))
        {
            Directory.CreateDirectory(retained);
            foreach (var file in new[] { "browser-zap-correlation.json", "zap-environment.json", "browser-console.log", "browser-summary.json" })
                File.Copy(Path.Combine(run, file), Path.Combine(retained, file), true);
        }
    }

    private static void Addon(string directory, string id)
    {
        Directory.CreateDirectory(directory);
        using var zip = ZipFile.Open(Path.Combine(directory, $"{id}-release-1.zap"), ZipArchiveMode.Create);
        using var writer = new StreamWriter(zip.CreateEntry("ZapAddOn.xml").Open());
        writer.Write("<zapaddon><version>1.0.0</version></zapaddon>");
    }

    private sealed class InlineProgress(Action<string> report) : IProgress<string>
    {
        public void Report(string value) => report(value);
    }

    private sealed class PageServer : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _task;
        public string Url { get; }
        public PageServer()
        {
            _listener.Start();
            Url = $"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}";
            _task = ServeAsync();
        }
        private async Task ServeAsync()
        {
            try
            {
                while (!_stop.IsCancellationRequested)
                {
                    using var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                    await using var stream = client.GetStream();
                    using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, leaveOpen: true);
                    while (!string.IsNullOrEmpty(await reader.ReadLineAsync(_stop.Token))) { }
                    var body = Encoding.UTF8.GetBytes("<html><body>normal local fixture<img src='/image'></body></html>");
                    await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: SID=fixture; Path=/\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n"), _stop.Token);
                    await stream.WriteAsync(body, _stop.Token);
                }
            }
            catch (OperationCanceledException) { }
        }
        public async ValueTask DisposeAsync() { _stop.Cancel(); _listener.Stop(); await _task; _stop.Dispose(); }
    }
}
