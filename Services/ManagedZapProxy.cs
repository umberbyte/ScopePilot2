using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed class ManagedZapProxy : IAsyncDisposable
{
    private readonly Process _process;
    private readonly Task _logTask;
    private int _disposed;
    public bool IsAlive => _disposed == 0 && !_process.HasExited;
    public ZapProxyApi Api { get; }
    public string Url { get; }
    private ManagedZapProxy(Process process, string url, string key, string logPath)
    {
        _process = process;
        Url = url;
        Api = new(url, key);
        _logTask = SaveLogAsync(process, logPath, key);
    }

    public static ProcessStartInfo CreateStartInfo(DiagnosticToolSettings tools, string directory, int port, string key)
    {
        // 案件側で空欄のときはアプリ設定（%APPDATA%）の既定パスを使う。
        AppSettingsService.ApplyZapToolDefaults(tools);
        if (!File.Exists(tools.ZapJarPath) || !Path.GetExtension(tools.ZapJarPath).Equals(".jar", StringComparison.OrdinalIgnoreCase) ||
            !File.Exists(tools.JavaPath) || !Path.GetFileName(tools.JavaPath).Equals("java.exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("ZAPのJARとJavaのjava.exeを指定してください（案件設定またはアプリ設定）。");
        var home = Path.Combine(directory, "zap-proxy-home");
        Directory.CreateDirectory(home);
        var start = new ProcessStartInfo(tools.JavaPath)
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        foreach (var argument in new[] { "-jar", Path.GetFullPath(tools.ZapJarPath), "-daemon", "-silent",
            "-host", "127.0.0.1", "-port", port.ToString(), "-dir", home, "-newsession", Path.Combine(home, "session"),
            "-config", $"api.key={key}", "-config", "api.disablekey=false",
            "-config", "api.addrs.addr.name=127.0.0.1", "-config", "api.addrs.addr.regex=false" }) start.ArgumentList.Add(argument);
        start.Environment["TEMP"] = home;
        start.Environment["TMP"] = home;
        return start;
    }

    public static async Task<ManagedZapProxy> StartAsync(EngagementProject project, string directory,
        IProgress<string>? progress, CancellationToken token, int? portOverride = null)
    {
        token.ThrowIfCancellationRequested();
        ProjectPaths.EnsureChild(ProjectPaths.Root(project), directory);
        var port = portOverride ?? project.ExplorationProxy.ZapPort;
        if (port is < 0 or > 65535) throw new InvalidDataException("ZAPポートは0～65535で指定してください。0は自動割当です。");
        var reservation = new TcpListener(IPAddress.Loopback, port);
        try { reservation.Start(); port = ((IPEndPoint)reservation.LocalEndpoint).Port; }
        catch (SocketException ex) { throw new IOException("ZAPポートが使用中です。別のポートか0（自動割当）を指定してください。", ex); }
        finally { reservation.Stop(); }
        var key = Guid.NewGuid().ToString("N");
        var process = Process.Start(CreateStartInfo(project.DiagnosticTools, directory, port, key))
            ?? throw new IOException("探索用ZAPを起動できませんでした。");
        var zap = new ManagedZapProxy(process, $"http://127.0.0.1:{port}", key, Path.Combine(directory, "zap-proxy-console.log"));
        progress?.Report($"探索用ZAPを起動しています: {zap.Url}");
        using var startup = CancellationTokenSource.CreateLinkedTokenSource(token);
        startup.CancelAfter(TimeSpan.FromSeconds(90));
        try
        {
            string version;
            while (true)
            {
                startup.Token.ThrowIfCancellationRequested();
                if (process.HasExited) throw new IOException($"ZAPが起動中に終了しました（終了コード{process.ExitCode}）。zap-proxy-console.logを確認してください。");
                try { version = await zap.Api.VersionAsync(startup.Token); if (version.Length > 0) break; }
                catch (Exception ex) when (ex is System.Net.Http.HttpRequestException or IOException or System.Text.Json.JsonException or OperationCanceledException) { }
                await Task.Delay(500, startup.Token);
            }
            await zap.Api.EnsureSafeModeAsync(startup.Token);
            progress?.Report($"探索用プロキシ: ZAP {version} / Safeモード ({zap.Url})");
            return zap;
        }
        catch
        {
            await zap.DisposeAsync();
            token.ThrowIfCancellationRequested();
            if (startup.IsCancellationRequested) throw new IOException("ZAPの起動確認が90秒以内に完了しませんでした。ログを確認してください。");
            throw;
        }
    }

    private static async Task SaveLogAsync(Process process, string path, string key)
    {
        await using var writer = new StreamWriter(path);
        var log = TextWriter.Synchronized(writer);
        async Task ReadAsync(StreamReader reader)
        {
            while (await reader.ReadLineAsync() is { } line)
                log.WriteLine(line.Replace(key, "<API-KEY>", StringComparison.Ordinal));
        }
        await Task.WhenAll(ReadAsync(process.StandardOutput), ReadAsync(process.StandardError));
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        if (!_process.HasExited)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try { await Api.ShutdownAsync(timeout.Token); await _process.WaitForExitAsync(timeout.Token); }
            catch (Exception ex) when (ex is System.Net.Http.HttpRequestException or IOException or OperationCanceledException) { }
            if (!_process.HasExited) { _process.Kill(entireProcessTree: true); await _process.WaitForExitAsync(); }
        }
        await _logTask;
        Api.Dispose();
        _process.Dispose();
    }
}
