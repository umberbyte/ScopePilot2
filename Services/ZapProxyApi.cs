using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using ScopePilot.Domain;

namespace ScopePilot.Services;

// This client exposes only lifecycle and recorded-message operations.
public sealed class ZapProxyApi : IDisposable
{
    private readonly HttpClient _client;
    public ZapProxyApi(string url, string apiKey, HttpMessageHandler? handler = null)
    {
        _client = new HttpClient(handler ?? new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
        {
            BaseAddress = ExplorationProxyService.ValidateLocalProxy(url),
            Timeout = TimeSpan.FromSeconds(10), MaxResponseContentBufferSize = 64 * 1024 * 1024
        };
        _client.DefaultRequestHeaders.Add("X-ZAP-API-Key", apiKey);
    }

    public async Task<string> VersionAsync(CancellationToken token) =>
        (await GetJsonAsync("JSON/core/view/version/", token)).GetProperty("version").GetString() ?? "";

    public async Task EnsureSafeModeAsync(CancellationToken token)
    {
        var result = await GetJsonAsync("JSON/core/action/setMode/?mode=safe", token);
        if (result.GetProperty("Result").GetString() != "OK" ||
            (await GetJsonAsync("JSON/core/view/mode/", token)).GetProperty("mode").GetString() != "safe")
            throw new IOException("ZAPをSafeモードに設定できませんでした。");
    }

    public async Task<int> MessageCountAsync(CancellationToken token) =>
        int.Parse((await GetJsonAsync("JSON/core/view/numberOfMessages/", token)).GetProperty("numberOfMessages").GetString()!);

    public async Task<JsonElement> InstalledAddonsAsync(CancellationToken token) =>
        (await GetJsonAsync("JSON/autoupdate/view/installedAddons/", token)).GetProperty("installedAddons");

    public async Task WaitForPassiveDrainAsync(TimeSpan limit, CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(limit);
        try
        {
            while (int.Parse((await GetJsonAsync("JSON/pscan/view/recordsToScan/", timeout.Token))
                .GetProperty("recordsToScan").ToString()) > 0)
                await Task.Delay(250, timeout.Token);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        { throw new IOException("ZAPのパッシブ待機が時間上限に達しました。未完了として記録します。"); }
    }

    public async Task ExportHistoryAsync(string path, int limit, CancellationToken token)
    {
        var count = Math.Min(limit, await MessageCountAsync(token));
        var messages = new JsonArray();
        var length = 0;
        for (var start = 0; start < count; start += 100)
        {
            var batch = await GetJsonAsync($"JSON/core/view/messages/?start={start}&count={Math.Min(100, count - start)}", token);
            foreach (var message in batch.GetProperty("messages").EnumerateArray())
            {
                var raw = message.GetRawText();
                length += raw.Length;
                if (length > 64 * 1024 * 1024) throw new IOException("ZAP Historyが保存上限を超えました。");
                messages.Add(JsonNode.Parse(raw));
            }
        }
        await File.WriteAllTextAsync(path, new JsonObject { ["messages"] = messages }.ToJsonString(), token);
    }

    public async Task<int> ExportHarAsync(string path, int start, int limit, string allowedOrigins, CancellationToken token)
    {
        if (start < 0 || limit < 1) throw new ArgumentOutOfRangeException(nameof(start));
        var count = Math.Min(limit, Math.Max(0, await MessageCountAsync(token) - start));
        var entries = new JsonArray();
        var totalCharacters = 0;
        for (var offset = 0; offset < count; offset += 100)
        {
            var pageSize = Math.Min(100, count - offset);
            var page = await _client.GetStringAsync($"OTHER/exim/other/exportHar/?start={start + offset}&count={pageSize}", token);
            totalCharacters += page.Length;
            if (totalCharacters > 64 * 1024 * 1024) throw new InvalidDataException("ZAPのHAR出力が64MBの上限を超えました。通信上限を小さくして再実行してください。");
            var batch = JsonNode.Parse(page)?["log"]?["entries"]?.AsArray()
                ?? throw new InvalidDataException("ZAPのHAR出力を読めません。Import/Exportアドオンを確認してください。");
            foreach (var entry in batch)
            {
                var url = entry?["request"]?["url"]?.GetValue<string>();
                if (string.IsNullOrWhiteSpace(url)) continue;
                try { ApiRequestFormatter.EnsureAllowed(url, allowedOrigins); }
                catch (InvalidDataException) { continue; }
                entries.Add(entry!.DeepClone());
            }
        }
        var har = new JsonObject { ["log"] = new JsonObject
        {
            ["version"] = "1.2", ["creator"] = new JsonObject { ["name"] = "ScopePilot ZAP capture", ["version"] = "1" },
            ["entries"] = entries
        } };
        var temporary = path + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, har.ToJsonString(), token);
            File.Move(temporary, path, overwrite: false);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        return entries.Count;
    }

    public async Task ShutdownAsync(CancellationToken token) =>
        _ = await GetJsonAsync("JSON/core/action/shutdown/", token);

    private async Task<JsonElement> GetJsonAsync(string path, CancellationToken token)
    {
        using var document = JsonDocument.Parse(await _client.GetStringAsync(path, token));
        if (document.RootElement.TryGetProperty("code", out _)) throw new IOException("ZAP APIが要求を処理できませんでした。");
        return document.RootElement.Clone();
    }
    public void Dispose() => _client.Dispose();
}
