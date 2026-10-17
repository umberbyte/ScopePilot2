using System.Diagnostics;
using System.Text;

namespace ScopePilot.Services;

public sealed record FastCrawlResult(int ExitCode, bool Cancelled, bool ProxyUnavailable)
{
    public string Status { get; init; } = "failed";
    public bool AuthenticationBlocked { get; init; }
}

public sealed class FastCrawlerRunner
{
    private Process? _process;
    private Task? _output;
    private Task? _error;
    private StreamWriter? _log;

    public async Task<FastCrawlResult> RunAsync(string runDirectory, IProgress<string> progress, CancellationToken cancellationToken,
        Action<string>? interventionDetected = null, Action<string>? navigationDetected = null, bool headless = false)
    {
        await CloseAsync();
        var node = EnvironmentProbe.FindNode();
        var script = Path.Combine(AppContext.BaseDirectory, "tools", "fast-crawl.js");
        if (node is null) throw new FileNotFoundException(EnvironmentProbe.NodeNotFoundMessage);
        if (!File.Exists(script)) throw new FileNotFoundException("高速クローラが見つかりません。", script);

        var startInfo = new ProcessStartInfo
        {
            FileName = node,
            WorkingDirectory = runDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
            UseShellExecute = false,
            CreateNoWindow = true
        };
        startInfo.ArgumentList.Add(script);
        startInfo.ArgumentList.Add(runDirectory);
        var interactive = interventionDetected is not null;
        if (interactive) startInfo.ArgumentList.Add("--interactive");
        if (headless) startInfo.ArgumentList.Add("--headless");

        var process = Process.Start(startInfo) ?? throw new InvalidOperationException("高速クローラを起動できませんでした。");
        _process = process;
        _log = new StreamWriter(new FileStream(Path.Combine(runDirectory, "crawler-run.log"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false)) { AutoFlush = true };
        var log = TextWriter.Synchronized(_log);
        var completed = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        IProgress<(string Kind, string Json)> events = new Progress<(string Kind, string Json)>(item =>
        {
            if (item.Kind == "INTERVENTION") interventionDetected?.Invoke(item.Json);
            else navigationDetected?.Invoke(item.Json);
        });
        progress.Report($"高速GETクローラを開始しました (PID {process.Id})。");
        using var registration = cancellationToken.Register(() => TryStop(process));
        _output = ReadLinesAsync(process.StandardOutput, line =>
        {
            log.WriteLine(line);
            if (line.StartsWith("CRAWL_DONE "))
            {
                try { using var json = System.Text.Json.JsonDocument.Parse(line[11..]); completed.TrySetResult(json.RootElement.GetProperty("exitCode").GetInt32()); }
                catch (System.Text.Json.JsonException) { }
            }
            else if (line.StartsWith("INTERVENTION ")) events.Report(("INTERVENTION", line[13..]));
            else if (line.StartsWith("NAVIGATION ")) events.Report(("NAVIGATION", line[11..]));
            else progress.Report(line);
        }, CancellationToken.None);
        _error = ReadLinesAsync(process.StandardError, line => { log.WriteLine(line); progress.Report($"Crawler: {line}"); }, CancellationToken.None);
        var cancelled = false;
        int exitCode = 1;
        try
        {
            var exited = process.WaitForExitAsync(cancellationToken);
            if (interactive && await Task.WhenAny(completed.Task, exited) == completed.Task) exitCode = await completed.Task;
            else { await exited; exitCode = process.ExitCode; }
        }
        catch (OperationCanceledException) { cancelled = true; TryStop(process); await process.WaitForExitAsync(); exitCode = process.ExitCode; }
        if (cancelled || process.HasExited) await CloseAsync();
        var summaryPath = Path.Combine(runDirectory, "fast-crawl-summary.json");
        if (!File.Exists(summaryPath)) return new(cancelled ? -1 : exitCode, cancelled, false);
        using var summary = System.Text.Json.JsonDocument.Parse(await File.ReadAllTextAsync(summaryPath));
        var root = summary.RootElement;
        return new(cancelled ? -1 : exitCode,
            cancelled, await ReadProxyUnavailableAsync(runDirectory))
        { Status = root.GetProperty("status").GetString() ?? "failed", AuthenticationBlocked = root.TryGetProperty("authenticationBlocked", out var blocked) && blocked.GetBoolean() };
    }

    public async Task CloseAsync()
    {
        if (_process is not { } process) return;
        try
        {
            if (!process.HasExited)
            {
                try { await process.StandardInput.WriteLineAsync("close"); await process.StandardInput.FlushAsync(); } catch (IOException) { }
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try { await process.WaitForExitAsync(timeout.Token); } catch (OperationCanceledException) { TryStop(process); await process.WaitForExitAsync(); }
            }
            if (_output is not null && _error is not null) await Task.WhenAll(_output, _error);
        }
        finally { _process = null; process.Dispose(); _log?.Dispose(); _log = null; }
    }

    public void Stop() { if (_process is { HasExited: false } process) TryStop(process); }

    private static async Task ReadLinesAsync(StreamReader reader, Action<string> handle, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(token);
            if (line is null) break;
            if (!string.IsNullOrWhiteSpace(line)) handle(line);
        }
    }

    private static async Task IgnoreCancellation(Task task) { try { await task; } catch (OperationCanceledException) { } }
    private static void TryStop(Process process) { try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { } }

    private static async Task<bool> ReadProxyUnavailableAsync(string runDirectory)
    {
        var summaryPath = Path.Combine(runDirectory, "fast-crawl-summary.json");
        if (!File.Exists(summaryPath)) return false;
        try
        {
            await using var stream = File.OpenRead(summaryPath);
            using var document = await System.Text.Json.JsonDocument.ParseAsync(stream);
            return document.RootElement.TryGetProperty("failureCode", out var code) &&
                   string.Equals(code.GetString(), "proxy-unavailable", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }
}
