using System.Text.Json;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed class RequestImporter
{
    public async Task<IReadOnlyList<ObservedRequest>> ImportAsync(string path)
    {
        var extension = Path.GetExtension(path).ToLowerInvariant();
        return extension switch
        {
            ".har" => await ImportHarAsync(path),
            ".jsonl" => await ImportJsonLinesAsync(path),
            ".txt" => await ImportUrlListAsync(path),
            _ => throw new InvalidOperationException("対応形式は HAR、JSONL、URL一覧TXTです。")
        };
    }

    private static async Task<IReadOnlyList<ObservedRequest>> ImportHarAsync(string path)
    {
        await using var stream = File.OpenRead(path);
        using var document = await JsonDocument.ParseAsync(stream);
        if (!document.RootElement.TryGetProperty("log", out var log) ||
            !log.TryGetProperty("entries", out var entries))
            throw new InvalidDataException("HARの log.entries が見つかりません。収集ツールからHARを再出力してください。");

        var result = new List<ObservedRequest>();
        foreach (var entry in entries.EnumerateArray())
        {
            var request = entry.GetProperty("request");
            var response = entry.TryGetProperty("response", out var responseElement) ? responseElement : default;
            var contentType = string.Empty;
            if (response.ValueKind == JsonValueKind.Object && response.TryGetProperty("content", out var content) &&
                content.TryGetProperty("mimeType", out var mimeType)) contentType = mimeType.GetString() ?? string.Empty;

            result.Add(new ObservedRequest
            {
                Method = request.GetProperty("method").GetString() ?? "GET",
                Url = request.GetProperty("url").GetString() ?? string.Empty,
                StatusCode = response.ValueKind == JsonValueKind.Object && response.TryGetProperty("status", out var status)
                    ? status.GetInt32() : null,
                ContentType = contentType,
                Source = "HAR",
                ObservedAt = entry.TryGetProperty("startedDateTime", out var time) && time.TryGetDateTimeOffset(out var stamp) ? stamp : DateTimeOffset.Now
            });
        }
        return result;
    }

    private static async Task<IReadOnlyList<ObservedRequest>> ImportJsonLinesAsync(string path)
    {
        var result = new List<ObservedRequest>();
        var lineNumber = 0;
        foreach (var line in await File.ReadAllLinesAsync(path))
        {
            lineNumber++;
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                var item = JsonSerializer.Deserialize<ObservedRequest>(line,
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                if (item is not null)
                {
                    Normalize(item);
                    if (Uri.TryCreate(item.Url, UriKind.Absolute, out _)) result.Add(item);
                }
            }
            catch (JsonException ex)
            {
                throw new InvalidDataException($"JSONLの{lineNumber}行目を読み取れません。", ex);
            }
        }
        return result;
    }

    public static void Normalize(ObservedRequest request)
    {
        request.Id = string.IsNullOrWhiteSpace(request.Id) ? Guid.NewGuid().ToString("N") : request.Id;
        request.Method = string.IsNullOrWhiteSpace(request.Method) ? "GET" : request.Method;
        request.Url ??= string.Empty;
        request.ContentType ??= string.Empty;
        request.Source = string.IsNullOrWhiteSpace(request.Source) ? "Import" : request.Source;
        request.Role ??= string.Empty;
        request.PageTitle ??= string.Empty;
        request.FormFieldNames ??= [];
    }

    private static async Task<IReadOnlyList<ObservedRequest>> ImportUrlListAsync(string path)
    {
        return (await File.ReadAllLinesAsync(path))
            .Select(x => x.Trim())
            .Where(x => !string.IsNullOrWhiteSpace(x) && !x.StartsWith('#'))
            .Where(x => Uri.TryCreate(x, UriKind.Absolute, out var uri) && (uri.Scheme is "http" or "https"))
            .Distinct(StringComparer.Ordinal)
            .Select(x => new ObservedRequest { Url = x, Method = "GET", Source = "URL list" })
            .ToArray();
    }
}
