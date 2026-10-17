using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ScopePilot.Services;

public sealed record ZapHistoryMatch(int BrowserEntry, string? MessageId, string RequestSha256, int? HistoryEntry)
{
    public string BrowserPointer => $"/log/entries/{BrowserEntry}";
    public string? HistoryPointer => HistoryEntry is int index ? $"/messages/{index}" : null;
}

// A matched request is transport evidence, never an authentication or impact verdict.
public static class ZapCaptureCorrelator
{
    public static IReadOnlyList<ZapHistoryMatch> Match(JsonElement har, JsonElement history)
    {
        var remaining = history.GetProperty("messages").EnumerateArray().Select((message, index) => (Message: message, Index: index)).ToList();
        var result = new List<ZapHistoryMatch>();
        var index = 0;
        foreach (var entry in har.GetProperty("log").GetProperty("entries").EnumerateArray())
        {
            var request = entry.GetProperty("request");
            var url = new Uri(request.GetProperty("url").GetString()!);
            var method = request.GetProperty("method").GetString()!;
            var cookie = Header(request, "Cookie");
            var auth = Header(request, "Authorization");
            var body = request.TryGetProperty("postData", out var post) && post.TryGetProperty("text", out var text) ? text.GetString() ?? "" : "";
            var fingerprint = Hash($"{method}\n{url.AbsoluteUri}\n{cookie}\n{auth}\n{body}");
            var status = entry.GetProperty("response").GetProperty("status").GetInt32();
            var hasBody = request.TryGetProperty("postData", out var data);
            var comparableBody = !hasBody || data.TryGetProperty("text", out _);
            var found = comparableBody ? remaining.FindIndex(message => Matches(message.Message, method, url, cookie, auth, body, status)) : -1;
            string? id = null;
            int? historyIndex = null;
            if (found >= 0) { id = remaining[found].Message.GetProperty("id").ToString(); historyIndex = remaining[found].Index; remaining.RemoveAt(found); }
            result.Add(new(index++, id, fingerprint, historyIndex));
        }
        return result;
    }

    private static bool Matches(JsonElement message, string method, Uri url, string cookie, string auth, string body, int status)
    {
        var raw = message.GetProperty("requestHeader").GetString() ?? "";
        var lines = raw.Split('\n').Select(x => x.TrimEnd('\r')).ToArray();
        var first = lines[0].Split(' ');
        if (first.Length < 3 || first[0] != method) return false;
        var headers = lines.Skip(1).Where(x => x.Contains(':')).Select(x => (Name: x[..x.IndexOf(':')], Value: x[(x.IndexOf(':') + 1)..].Trim())).ToArray();
        string Get(string name) => string.Join("; ", headers.Where(x => x.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).Select(x => x.Value));
        var target = first[1];
        var sameUrl = Uri.TryCreate(target, UriKind.Absolute, out var absolute) && absolute.Scheme is "http" or "https"
            ? absolute.AbsoluteUri == url.AbsoluteUri
            : target == url.PathAndQuery && Get("Host").Equals(url.Authority, StringComparison.OrdinalIgnoreCase);
        var response = (message.GetProperty("responseHeader").GetString() ?? "").Split(' ');
        return sameUrl && Get("Cookie") == cookie && Get("Authorization") == auth &&
            (message.GetProperty("requestBody").GetString() ?? "") == body &&
            response.Length > 1 && int.TryParse(response[1], out var actualStatus) && actualStatus == status;
    }

    private static string Header(JsonElement request, string name) => request.TryGetProperty("headers", out var headers)
        ? string.Join("; ", headers.EnumerateArray().Where(x => x.GetProperty("name").GetString()!.Equals(name, StringComparison.OrdinalIgnoreCase))
            .Select(x => x.GetProperty("value").GetString())) : "";
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}
