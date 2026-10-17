using System.Text.Json;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed class ExplorationProxySession(ExplorationProxyEndpoint endpoint, string directory,
    ExplorationProxyMode requested, ManagedZapProxy? zap) : IAsyncDisposable
{
    public ExplorationProxyEndpoint Endpoint { get; } = endpoint;
    public ZapProxyApi? ZapApi => zap?.Api;
    public bool UseBurpMcp { get; set; }
    public bool DisableBurpMcp { get; set; }
    private readonly DateTimeOffset _startedAt = DateTimeOffset.Now;
    public Task WriteRuntimeAsync(string status = "ready") => File.WriteAllTextAsync(Path.Combine(directory, "exploration-proxy.json"),
        JsonSerializer.Serialize(new { requested = requested.ToString(), provider = Endpoint.Provider.ToString(), url = Endpoint.Url,
            useBurpMcp = UseBurpMcp, disableBurpMcp = DisableBurpMcp, startedAt = _startedAt, status }, new JsonSerializerOptions { WriteIndented = true }));
    public async ValueTask DisposeAsync()
    {
        try { if (zap is not null) await zap.DisposeAsync(); }
        finally { await WriteRuntimeAsync("stopped"); }
    }

    public async Task MonitorAsync(Action disconnected, CancellationToken token)
    {
        try
        {
            var failures = 0;
            while (true)
            {
                await Task.Delay(2000, token);
                var connected = zap is null
                    ? await ExplorationProxyService.CanConnectAsync(new Uri(Endpoint.Url), token)
                    : zap.IsAlive;
                failures = connected ? 0 : failures + 1;
                if (failures < 2) continue;
                disconnected();
                return;
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }
}
