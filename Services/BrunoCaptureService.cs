using System.Text;
using System.Text.Json;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record BrunoHarEntry(int Index, string Method, string Url, int ResponseStatus, DateTimeOffset? StartedAt);

public sealed class BrunoCaptureService
{
    public const long MaxHarBytes = 50L * 1024 * 1024;

    public async Task<IReadOnlyList<BrunoHarEntry>> PreviewAsync(string harPath)
    {
        using var document = await ReadHarAsync(harPath);
        var entries = Entries(document);
        if (entries.GetArrayLength() > 2000) throw new InvalidDataException("HARは2000通信以下にしてください。");
        var previews = new List<BrunoHarEntry>();
        for (var i = 0; i < entries.GetArrayLength(); i++)
        {
            var entry = entries[i];
            if (entry.ValueKind != JsonValueKind.Object) throw new InvalidDataException("HARの通信形式が正しくありません。");
            var request = RequiredObject(entry, "request");
            var response = RequiredObject(entry, "response");
            var method = RequiredString(request, "method");
            var url = RequiredString(request, "url");
            var status = RequiredInt(response, "status");
            DateTimeOffset? startedAt = entry.TryGetProperty("startedDateTime", out var date) &&
                date.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(date.GetString(), out var parsed) ? parsed : null;
            previews.Add(new(i, method, url, status, startedAt));
        }
        return previews;
    }

    public async Task<BrunoVerification> ImportAsync(EngagementProject project, string harPath, int entryIndex,
        string title, BrunoVerificationStatus status, string result, string blockReason, string requiredInput, string role)
    {
        ProjectPaths.CheckProjectFile(project);
        title = RequiredUserText(title, "確認項目", 200);
        result = RequiredUserText(result, "確認結果", 4000);
        if (status == BrunoVerificationStatus.Blocked)
        {
            blockReason = RequiredUserText(blockReason, "未実施・中断の理由", 2000);
            requiredInput = RequiredUserText(requiredInput, "再開に必要な入力・改善", 2000);
        }
        using var document = await ReadHarAsync(harPath);
        var entries = Entries(document);
        if (entries.GetArrayLength() > 2000) throw new InvalidDataException("HARは2000通信以下にしてください。");
        if (entryIndex < 0 || entryIndex >= entries.GetArrayLength()) throw new InvalidDataException("HARの通信を選択してください。");
        var entry = entries[entryIndex];
        if (entry.ValueKind != JsonValueKind.Object) throw new InvalidDataException("HARの通信形式が正しくありません。");
        var request = RequiredObject(entry, "request");
        var response = RequiredObject(entry, "response");
        var method = RequiredString(request, "method");
        var url = RequiredString(request, "url");
        var responseStatus = RequiredInt(response, "status");
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
            throw new InvalidDataException("HTTPまたはHTTPSの通信だけを取り込めます。");
        if (responseStatus < 100 || responseStatus > 599) throw new InvalidDataException("応答が記録された通信を選択してください。");
        var allowed = project.AllowedOrigins.Split(['\r', '\n'], StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(x => Uri.TryCreate(x, UriKind.Absolute, out var origin) ? origin.GetLeftPart(UriPartial.Authority) : "")
            .Where(x => x.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (allowed.Count > 0 && !allowed.Contains(uri.GetLeftPart(UriPartial.Authority)))
            throw new InvalidDataException("通信のOriginが案件の許可対象に含まれていません。");
        var id = Guid.NewGuid().ToString("N");
        var folder = ProjectPaths.Resolve(project, $"inputs/bruno/{id}");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "exchange.har.json");
        var temporary = path + ".tmp";
        try
        {
            var source = JsonSerializer.Serialize(new { log = new { version = "1.2", entries = new[] { entry } } },
                new JsonSerializerOptions { WriteIndented = true });
            await File.WriteAllTextAsync(temporary, source, new UTF8Encoding(false));
            File.Move(temporary, path);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        var evidence = await ProjectPaths.EvidenceAsync(project, path, "bruno-http-exchange", "/log/entries/0");
        var item = new BrunoVerification
        {
            Id = id, Title = title, Status = status, Result = result,
            BlockReason = blockReason.Trim(), RequiredInput = requiredInput.Trim(),
            Method = method, Url = url, ResponseStatus = responseStatus,
            Role = role.Trim(), Exchange = evidence
        };
        project.BrunoVerifications.Add(item);
        return item;
    }

    internal static async Task<JsonDocument> ReadHarAsync(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length == 0 || info.Length > MaxHarBytes)
            throw new InvalidDataException("HARファイルは空でない50MB以下のファイルを選択してください。");
        await using var stream = File.OpenRead(path);
        try { return await JsonDocument.ParseAsync(stream, new JsonDocumentOptions { MaxDepth = 64 }); }
        catch (JsonException ex) { throw new InvalidDataException("HARをJSONとして読み取れません。", ex); }
    }

    internal static JsonElement Entries(JsonDocument document)
    {
        if (!document.RootElement.TryGetProperty("log", out var log) ||
            !log.TryGetProperty("entries", out var entries) || entries.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("HARのlog.entriesがありません。");
        return entries;
    }

    internal static JsonElement RequiredObject(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Object ? value :
        throw new InvalidDataException($"HARの{name}がありません。");

    internal static string RequiredString(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" :
        throw new InvalidDataException($"HARの{name}がありません。");

    internal static int RequiredInt(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) ? number :
        throw new InvalidDataException($"HARの{name}がありません。");

    private static string RequiredUserText(string value, string name, int maxLength)
    {
        value = value.Trim();
        if (value.Length == 0 || value.Length > maxLength)
            throw new InvalidDataException($"{name}を1～{maxLength}文字で入力してください。");
        return value;
    }
}
