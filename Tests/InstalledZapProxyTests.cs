using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class InstalledZapProxyTests
{
    [InstalledZapFact]
    public async Task InstalledDaemonProxiesLocalHttpHttpsAndCrawlerThenExportsHarAndStops()
    {
        using var temp = new TestFolder();
        await using var http = new LocalPageServer(false);
        await using var https = new LocalPageServer(true);
        var project = temp.Project();
        project.StartUrl = http.Url + "/";
        project.AllowedOrigins = http.Url + "\n" + https.Url;
        project.DiagnosticTools.ZapJarPath = Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_ZAP_JAR")!;
        project.DiagnosticTools.JavaPath = Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_JAVA")!;
        project.ExplorationProxy.Mode = ExplorationProxyMode.Zap;
        project.ExplorationProxy.ZapPort = 0;
        project.MaxPages = 3;
        project.MaxRequests = 20;
        var run = await new ExplorationPackageBuilder().BuildAsync(project);
        using var token = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        await using var session = await new ExplorationProxyService().OpenAsync(project, run, null, token.Token);
        using var client = new HttpClient(new HttpClientHandler
        {
            Proxy = new WebProxy(session.Endpoint.Url) { BypassProxyOnLocal = false }, UseProxy = true,
            ServerCertificateCustomValidationCallback = (_, _, _, _) => true
        });
        Assert.Contains("local fixture", await client.GetStringAsync(project.StartUrl, token.Token));
        Assert.Contains("local fixture", await client.GetStringAsync(https.Url + "/", token.Token));
        var api = session.ZapApi!;
        Assert.True(await api.MessageCountAsync(token.Token) >= 2);
        var first = Path.Combine(run, "first.har");
        Assert.True(await api.ExportHarAsync(first, 0, 20, project.AllowedOrigins, token.Token) >= 2);
        using var original = JsonDocument.Parse(await File.ReadAllTextAsync(first));
        Assert.Contains(original.RootElement.GetProperty("log").GetProperty("entries").EnumerateArray(), x =>
            x.GetProperty("request").GetProperty("url").GetString()!.StartsWith("https://"));
        var cutoff = await api.MessageCountAsync(token.Token);
        Assert.Contains("local fixture", await client.GetStringAsync(http.Url + "/details", token.Token));
        var second = Path.Combine(run, "second.har");
        Assert.Equal(1, await api.ExportHarAsync(second, cutoff, 20, project.AllowedOrigins, token.Token));

        var log = new List<string>();
        var beforeCrawl = await api.MessageCountAsync(token.Token);
        var crawl = await new FastCrawlerRunner().RunAsync(run, new Progress<string>(message => { lock (log) log.Add(message); }), token.Token);
        Assert.True(crawl.ExitCode == 0, string.Join("\n", log));
        Assert.False(crawl.ProxyUnavailable);
        Assert.True(File.Exists(Path.Combine(run, "fast-capture.har")));
        var requests = await new RequestImporter().ImportAsync(Path.Combine(run, "fast-observed-requests.jsonl"));
        Assert.Contains(requests, x => x.Url == project.StartUrl && x.StatusCode == 200);
        Assert.True(await api.MessageCountAsync(token.Token) > beforeCrawl, "Crawler traffic must be recorded by ZAP, including loopback requests.");
        Assert.True(await ExplorationProxyService.ProbeBurpProxyAsync(new Uri(session.Endpoint.Url), token.Token));
        await session.DisposeAsync();
        Assert.False(await ExplorationProxyService.CanConnectAsync(new Uri(session.Endpoint.Url)));
        Assert.True(Directory.Exists(Path.Combine(run, "zap-proxy-home")));
        using var runtime = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(run, "exploration-proxy.json")));
        Assert.Equal("stopped", runtime.RootElement.GetProperty("status").GetString());
        Assert.Equal("Zap", runtime.RootElement.GetProperty("provider").GetString());
        if (Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_ZAP_ARTIFACTS") is { Length: > 0 } output)
        {
            Directory.CreateDirectory(output);
            foreach (var file in new[] { "zap-proxy-console.log", "exploration-proxy.json", "fast-crawl-summary.json", "first.har", "second.har" })
                File.Copy(Path.Combine(run, file), Path.Combine(output, file), true);
        }
    }

    private sealed class LocalPageServer : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private readonly X509Certificate2? _certificate;
        private readonly Task _task;
        public string Url { get; }
        public LocalPageServer(bool tls)
        {
            if (tls)
            {
                using var key = RSA.Create(2048);
                var request = new CertificateRequest("CN=localhost", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
                var names = new SubjectAlternativeNameBuilder();
                names.AddIpAddress(IPAddress.Loopback);
                request.CertificateExtensions.Add(names.Build());
                using var certificate = request.CreateSelfSigned(DateTimeOffset.Now.AddMinutes(-1), DateTimeOffset.Now.AddHours(1));
                _certificate = X509CertificateLoader.LoadPkcs12(certificate.Export(X509ContentType.Pfx), null);
            }
            _listener.Start();
            Url = $"{(tls ? "https" : "http")}://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}";
            _task = ServeAsync();
        }
        private async Task ServeAsync()
        {
            try
            {
                while (!_stop.IsCancellationRequested)
                {
                    using var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                    await using Stream stream = _certificate is null ? client.GetStream() : new SslStream(client.GetStream());
                    if (stream is SslStream ssl)
                        await ssl.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = _certificate }, _stop.Token);
                    using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                    var line = await reader.ReadLineAsync(_stop.Token);
                    var path = line?.Split(' ')[1] ?? "/";
                    while (!string.IsNullOrEmpty(await reader.ReadLineAsync(_stop.Token))) { }
                    var found = path is "/" or "/details";
                    var body = found ? "<html><head><title>local fixture</title></head><body><a href=\"/details\">details</a></body></html>" : "missing";
                    var bytes = Encoding.UTF8.GetBytes(body);
                    var header = Encoding.ASCII.GetBytes($"HTTP/1.1 {(found ? "200 OK" : "404 Not Found")}\r\nContent-Type: text/html\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n");
                    await stream.WriteAsync(header, _stop.Token);
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
            _certificate?.Dispose();
            _stop.Dispose();
        }
    }
}
