using System.Net;
using System.Net.Sockets;
using System.Net.Http;
using System.Text;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed class ExplorationProxyService
{
    public static Uri ValidateLocalProxy(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "http" ||
            (!uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) &&
             (!IPAddress.TryParse(uri.Host.Trim('[', ']'), out var ip) || !IPAddress.IsLoopback(ip))) ||
            uri.AbsolutePath != "/" || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.UserInfo.Length > 0)
            throw new InvalidDataException("探索用プロキシはhttp://127.0.0.1:8080のようなローカルのHTTP接続先を指定してください。");
        return uri;
    }

    public static async Task<bool> CanConnectAsync(Uri uri, CancellationToken cancellationToken = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));
        try
        {
            using var client = new TcpClient();
            await client.ConnectAsync(uri.DnsSafeHost, uri.Port, timeout.Token);
            return true;
        }
        catch (Exception ex) when (ex is SocketException or OperationCanceledException)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return false;
        }
    }

    public static async Task<ExplorationProxyMode> SelectAsync(ExplorationProxySettings settings,
        Func<Uri, CancellationToken, Task<bool>> probe, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!Enum.IsDefined(settings.Mode)) throw new InvalidDataException("探索用プロキシの選択が不正です。");
        if (settings.Mode == ExplorationProxyMode.Zap) return ExplorationProxyMode.Zap;
        var uri = ValidateLocalProxy(settings.BurpProxyUrl);
        if (await probe(uri, cancellationToken)) return ExplorationProxyMode.Burp;
        if (settings.Mode == ExplorationProxyMode.Burp)
            throw new IOException($"Burpの接続先 {uri.GetLeftPart(UriPartial.Authority)} に接続できません。");
        return ExplorationProxyMode.Zap;
    }

    public static async Task<bool> ProbeBurpProxyAsync(Uri uri, CancellationToken cancellationToken = default)
    {
        if (!await CanConnectAsync(uri, cancellationToken)) return false;
        // Verify HTTP forwarding against a temporary loopback fixture, never a project target.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var nonce = Guid.NewGuid().ToString("N");
        var serve = ServeProbeAsync(listener, nonce, timeout.Token);
        try
        {
            using var client = new HttpClient(new HttpClientHandler
            {
                UseProxy = true, Proxy = new WebProxy(uri) { BypassProxyOnLocal = false }, AllowAutoRedirect = false
            }) { MaxResponseContentBufferSize = 16 * 1024 };
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            return await client.GetStringAsync($"http://127.0.0.1:{port}/scopepilot-proxy-probe", timeout.Token) == nonce;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return false;
        }
        finally
        {
            timeout.Cancel();
            listener.Stop();
            await serve;
        }
    }

    private static async Task ServeProbeAsync(TcpListener listener, string nonce, CancellationToken token)
    {
        try
        {
            using var socket = await listener.AcceptTcpClientAsync(token);
            await using var stream = socket.GetStream();
            using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
            while (!string.IsNullOrEmpty(await reader.ReadLineAsync(token))) { }
            var response = Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Length: {nonce.Length}\r\nConnection: close\r\n\r\n{nonce}");
            await stream.WriteAsync(response, token);
        }
        catch (Exception ex) when (ex is OperationCanceledException or SocketException or IOException) { }
    }

    public async Task<ExplorationProxySession> OpenAsync(EngagementProject project, string runDirectory,
        IProgress<string>? progress, CancellationToken cancellationToken)
    {
        ProjectPaths.EnsureChild(ProjectPaths.Root(project), runDirectory);
        var provider = await SelectAsync(project.ExplorationProxy, ProbeBurpProxyAsync, cancellationToken);
        if (provider == ExplorationProxyMode.Burp)
        {
            var endpoint = new ExplorationProxyEndpoint(provider, ValidateLocalProxy(project.ExplorationProxy.BurpProxyUrl).GetLeftPart(UriPartial.Authority));
            var session = new ExplorationProxySession(endpoint, runDirectory, project.ExplorationProxy.Mode, null);
            await session.WriteRuntimeAsync();
            progress?.Report($"探索用プロキシ: Burp ({endpoint.Url})");
            return session;
        }
        if (project.ExplorationProxy.Mode == ExplorationProxyMode.Auto)
            progress?.Report("Burpへ接続できないため、探索用ZAPを起動します。");
        var zap = await ManagedZapProxy.StartAsync(project, runDirectory, progress, cancellationToken);
        var result = new ExplorationProxySession(new(provider, zap.Url), runDirectory, project.ExplorationProxy.Mode, zap);
        try { await result.WriteRuntimeAsync(); }
        catch { await zap.DisposeAsync(); throw; }
        return result;
    }
}
