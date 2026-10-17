using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services;
using ScopePilot.ViewModels;
using Xunit;

namespace ScopePilot.Tests;

public sealed class ExplorationProxyTests
{
    [Theory]
    [InlineData(ExplorationProxyMode.Auto, true, ExplorationProxyMode.Burp)]
    [InlineData(ExplorationProxyMode.Auto, false, ExplorationProxyMode.Zap)]
    [InlineData(ExplorationProxyMode.Burp, true, ExplorationProxyMode.Burp)]
    [InlineData(ExplorationProxyMode.Zap, false, ExplorationProxyMode.Zap)]
    public async Task SelectionUsesOnlyRequestedProviderAndFallsBackBeforeStarting(ExplorationProxyMode requested,
        bool available, ExplorationProxyMode expected)
    {
        var calls = 0;
        var result = await ExplorationProxyService.SelectAsync(new() { Mode = requested }, (_, _) =>
        { calls++; return Task.FromResult(available); });
        Assert.Equal(expected, result);
        Assert.Equal(requested == ExplorationProxyMode.Zap ? 0 : 1, calls);
        await Assert.ThrowsAsync<IOException>(() => ExplorationProxyService.SelectAsync(
            new() { Mode = ExplorationProxyMode.Burp }, (_, _) => Task.FromResult(false)));
    }

    [Theory]
    [InlineData("http://outside.example.test:8080")]
    [InlineData("http://0.0.0.0:8080")]
    [InlineData("https://127.0.0.1:8080")]
    [InlineData("http://user:password@127.0.0.1:8080")]
    [InlineData("http://127.0.0.1:8080/path")]
    [InlineData("http://127.0.0.1:8080/?token=secret")]
    public void ProxySettingsRejectRemoteAddressesAndEmbeddedSecrets(string url) =>
        Assert.Throws<InvalidDataException>(() => ExplorationProxyService.ValidateLocalProxy(url));

    [Fact]
    public async Task SettingsAreManuallySavedAndIndependentOfHandoffTarget()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        await new ProjectStore().SaveAsync(project);
        var original = await File.ReadAllTextAsync(project.ProjectFilePath);
        var vm = new MainViewModel();
        Assert.True(await vm.OpenProjectAsync(project.ProjectFilePath));
        Assert.Equal(0, vm.ExplorationProxyModeIndex);
        vm.ExplorationProxyModeIndex = 2;
        vm.Project.ExplorationProxy.ZapPort = 0;
        Assert.False(vm.IsZapTarget);
        Assert.True(vm.HasUnsavedChanges);
        Assert.Equal(original, await File.ReadAllTextAsync(project.ProjectFilePath));
        Assert.True(await vm.SaveCurrentProjectAsync());
        var restored = await new ProjectStore().LoadAsync(project.ProjectFilePath);
        Assert.Equal(ExplorationProxyMode.Zap, restored.ExplorationProxy.Mode);
        Assert.Equal(0, restored.ExplorationProxy.ZapPort);
        Assert.Equal(HandoffTarget.BurpSuite, restored.DiagnosticTools.Target);
        Assert.Equal(ExplorationProxyMode.Auto, JsonSerializer.Deserialize<EngagementProject>("{\"Name\":\"old\"}")!.ExplorationProxy.Mode);
    }

    [Fact]
    public async Task BurpSessionRecordsActualEndpointAndNeverStopsExistingListener()
    {
        using var temp = new TestFolder();
        await using var listener = new LocalProxyFixture(true);
            var project = temp.Project();
            project.ExplorationProxy.BurpProxyUrl = listener.Url;
            var run = await new ExplorationPackageBuilder().BuildAsync(project);
            await using (var session = await new ExplorationProxyService().OpenAsync(project, run, null, CancellationToken.None))
            {
                Assert.Equal(ExplorationProxyMode.Burp, session.Endpoint.Provider);
                Assert.Null(session.ZapApi);
            }
            Assert.True(await ExplorationProxyService.CanConnectAsync(new Uri(project.ExplorationProxy.BurpProxyUrl)));
            using var runtime = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(run, "exploration-proxy.json")));
            Assert.Equal("Burp", runtime.RootElement.GetProperty("provider").GetString());
            Assert.Equal("stopped", runtime.RootElement.GetProperty("status").GetString());
            Assert.Equal(project.ExplorationProxy.BurpProxyUrl, runtime.RootElement.GetProperty("url").GetString());
            Assert.Equal(project.ExplorationProxy.BurpProxyUrl, Assert.Single(await new RunHistoryService().ListAsync(project)).ProxyDisplay.Split(" / ")[1]);
    }

    [Fact]
    public async Task OpenTcpPortServingAnOrdinaryApplicationIsNotAnAvailableProxy()
    {
        await using var application = new LocalProxyFixture(false);
        Assert.True(await ExplorationProxyService.CanConnectAsync(new Uri(application.Url)));
        Assert.False(await ExplorationProxyService.ProbeBurpProxyAsync(new Uri(application.Url)));
        var selected = await ExplorationProxyService.SelectAsync(new() { BurpProxyUrl = application.Url }, ExplorationProxyService.ProbeBurpProxyAsync);
        Assert.Equal(ExplorationProxyMode.Zap, selected);
    }

    [Fact]
    public async Task BusyZapPortIsRejectedWithoutStoppingExistingListener()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            project.ExplorationProxy.Mode = ExplorationProxyMode.Zap;
            project.ExplorationProxy.ZapPort = ((IPEndPoint)listener.LocalEndpoint).Port;
            var run = await new ExplorationPackageBuilder().BuildAsync(project);
            await Assert.ThrowsAsync<IOException>(() => new ExplorationProxyService().OpenAsync(project, run, null, CancellationToken.None));
            Assert.True(await ExplorationProxyService.CanConnectAsync(new Uri($"http://127.0.0.1:{project.ExplorationProxy.ZapPort}")));
            Assert.False(File.Exists(Path.Combine(run, "zap-proxy-console.log")));
        }
        finally { listener.Stop(); }
    }

    [Fact]
    public async Task CancelledStartupDoesNotCreateDaemonFiles()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.ExplorationProxy.Mode = ExplorationProxyMode.Zap;
        var run = await new ExplorationPackageBuilder().BuildAsync(project);
        using var token = new CancellationTokenSource();
        token.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => new ExplorationProxyService().OpenAsync(project, run, null, token.Token));
        Assert.False(Directory.Exists(Path.Combine(run, "zap-proxy-home")));
    }

    [Fact]
    public async Task MonitorStopsAfterConnectionLossAndDoesNotSelectAnotherBackend()
    {
        using var temp = new TestFolder();
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var url = $"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}";
        listener.Stop();
        await using var session = new ExplorationProxySession(new(ExplorationProxyMode.Burp, url), temp.Path, ExplorationProxyMode.Auto, null);
        var disconnected = 0;
        using var token = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await session.MonitorAsync(() => disconnected++, token.Token);
        Assert.Equal(1, disconnected);
        Assert.Equal(ExplorationProxyMode.Burp, session.Endpoint.Provider);
    }

    [Fact]
    public async Task ZapApiUsesOnlyLocalLifecycleAndRecordedHarWithOriginAndPhaseFiltering()
    {
        using var temp = new TestFolder();
        var handler = new RecordedApiHandler();
        using var api = new ZapProxyApi("http://127.0.0.1:8090", "SECRET-KEY", handler);
        Assert.Equal("fixture", await api.VersionAsync(CancellationToken.None));
        await api.EnsureSafeModeAsync(CancellationToken.None);
        var path = Path.Combine(temp.Path, "capture.har");
        Assert.Equal(120, await api.ExportHarAsync(path, 10, 120, "https://example.test", CancellationToken.None));
        using var har = JsonDocument.Parse(await File.ReadAllTextAsync(path));
        var entries = har.RootElement.GetProperty("log").GetProperty("entries");
        Assert.Equal(120, entries.GetArrayLength());
        Assert.Contains("/item/10", entries[0].GetProperty("request").GetProperty("url").GetString());
        Assert.All(entries.EnumerateArray(), x => Assert.StartsWith("https://example.test/", x.GetProperty("request").GetProperty("url").GetString()));
        Assert.Contains(handler.Paths, x => x.EndsWith("start=10&count=100"));
        Assert.Contains(handler.Paths, x => x.EndsWith("start=110&count=20"));
        Assert.DoesNotContain("SECRET-KEY", await File.ReadAllTextAsync(path));
        await api.ShutdownAsync(CancellationToken.None);
        Assert.DoesNotContain(handler.Paths, x => x.Contains("scan") || x.Contains("sendRequest") || x.Contains("spider"));
    }

    [Fact]
    public async Task ZapPromptAndRuntimeDisableBurpWithoutRemovingProjectDocuments()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.ExplorationDocument.Content = "# 対象仕様\n一覧の説明";
        var run = await new ExplorationPackageBuilder().BuildAsync(project);
        await ExplorationPackageBuilder.ConfigureProxyPromptAsync(run, false);
        var prompt = await File.ReadAllTextAsync(Path.Combine(run, "prompt.md"));
        Assert.DoesNotContain("Burp MCPではget_proxy_http_history", prompt);
        Assert.DoesNotContain("ブラウザ通信はBurp Proxy", prompt);
        Assert.Contains("exploration-proxy.json", prompt);
        Assert.Contains("reference-document.txt", prompt);
        Assert.Contains("許可origin外を診断対象に含めず", prompt);
        await using var session = new ExplorationProxySession(new(ExplorationProxyMode.Zap, "http://127.0.0.1:8090"), run, ExplorationProxyMode.Auto, null)
        { DisableBurpMcp = true };
        await session.WriteRuntimeAsync();
        Assert.Equal(new[] { "--config", "mcp_servers.burp.enabled=false" }, await CodexExplorationRunner.BurpRuntimeArgumentsAsync(run));
        session.DisableBurpMcp = false;
        await session.WriteRuntimeAsync();
        Assert.Empty(await CodexExplorationRunner.BurpRuntimeArgumentsAsync(run));
    }

    [Fact]
    public void DaemonArgumentsKeepProfileAndSessionInsideRunAndBindOnlyLoopback()
    {
        using var temp = new TestFolder();
        var tools = new DiagnosticToolSettings { ZapJarPath = Path.Combine(temp.Path, "zap.jar"), JavaPath = Path.Combine(temp.Path, "java.exe") };
        File.WriteAllText(tools.ZapJarPath, "fixture");
        File.WriteAllText(tools.JavaPath, "fixture");
        var start = ManagedZapProxy.CreateStartInfo(tools, temp.Path, 8090, "key");
        var args = start.ArgumentList.ToArray();
        Assert.Contains("-daemon", args);
        Assert.Contains("-silent", args);
        Assert.Equal("127.0.0.1", args[Array.IndexOf(args, "-host") + 1]);
        Assert.StartsWith(temp.Path, args[Array.IndexOf(args, "-dir") + 1]);
        Assert.StartsWith(temp.Path, args[Array.IndexOf(args, "-newsession") + 1]);
        Assert.Contains("api.disablekey=false", args);
        Assert.DoesNotContain(".*", args);
        Assert.True(start.CreateNoWindow);
    }

    private sealed class RecordedApiHandler : HttpMessageHandler
    {
        public List<string> Paths { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal("127.0.0.1", request.RequestUri!.Host);
            Assert.Equal("SECRET-KEY", Assert.Single(request.Headers.GetValues("X-ZAP-API-Key")));
            var path = request.RequestUri.PathAndQuery;
            Paths.Add(path);
            Assert.DoesNotContain("SECRET-KEY", path);
            object result = path.Contains("/version/") ? new { version = "fixture" }
                : path.Contains("/view/mode/") ? new { mode = "safe" }
                : path.Contains("/numberOfMessages/") ? new { numberOfMessages = "210" }
                : new { Result = "OK" };
            if (path.Contains("/exportHar/"))
            {
                var values = request.RequestUri.Query.TrimStart('?').Split('&').Select(x => x.Split('=')).ToDictionary(x => x[0], x => int.Parse(x[1]));
                result = new { log = new { entries = Enumerable.Range(values["start"], values["count"]).Select(i =>
                    new { request = new { method = "GET", url = $"https://example.test/item/{i}" }, response = new { status = 200 } }).Cast<object>()
                    .Append(new { request = new { url = "https://outside.test/secret" } })
                    .Append(new { request = new { url = "https://example.test:8443/other-port" } }) } };
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(result), Encoding.UTF8, "application/json") });
        }
    }

    private sealed class LocalProxyFixture : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private readonly bool _forward;
        private readonly Task _task;
        public string Url { get; }
        public LocalProxyFixture(bool forward)
        {
            _forward = forward;
            _listener.Start();
            Url = $"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}";
            _task = ServeAsync();
        }
        private async Task ServeAsync()
        {
            try
            {
                while (true)
                {
                    using var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                    await using var stream = client.GetStream();
                    using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                    var request = await reader.ReadLineAsync(_stop.Token);
                    if (request is null) continue;
                    while (!string.IsNullOrEmpty(await reader.ReadLineAsync(_stop.Token))) { }
                    var body = "ordinary-web-application";
                    if (_forward)
                    {
                        var target = new Uri(request.Split(' ')[1]);
                        Assert.True(target.IsLoopback);
                        using var http = new HttpClient(new HttpClientHandler { UseProxy = false });
                        body = await http.GetStringAsync(target, _stop.Token);
                    }
                    var bytes = Encoding.UTF8.GetBytes(body);
                    await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n"), _stop.Token);
                    await stream.WriteAsync(bytes, _stop.Token);
                }
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
            catch (SocketException) when (_stop.IsCancellationRequested) { }
        }
        public async ValueTask DisposeAsync()
        {
            _stop.Cancel();
            _listener.Stop();
            await _task;
            _stop.Dispose();
        }
    }
}
