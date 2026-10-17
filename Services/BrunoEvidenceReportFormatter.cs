using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record BrunoExchangeDisplay(string Request, string Response, string Error);

public static partial class BrunoEvidenceReportFormatter
{
    public static async Task<BrunoExchangeDisplay> ReadAsync(EngagementProject project, BrunoVerification item)
    {
        try
        {
            await ProjectPaths.VerifyAsync(project, item.Exchange);
            using var document = await BrunoCaptureService.ReadHarAsync(ProjectPaths.Resolve(project, item.Exchange.LocalPath));
            var entries = BrunoCaptureService.Entries(document);
            if (entries.GetArrayLength() != 1) throw new InvalidDataException("証拠の通信件数が一致しません。");
            var entry = entries[0];
            var request = BrunoCaptureService.RequiredObject(entry, "request");
            var response = BrunoCaptureService.RequiredObject(entry, "response");
            var method = BrunoCaptureService.RequiredString(request, "method");
            var url = BrunoCaptureService.RequiredString(request, "url");
            var status = BrunoCaptureService.RequiredInt(response, "status");
            if (method != item.Method || url != item.Url || status != item.ResponseStatus)
                throw new InvalidDataException("登録内容と証拠の通信が一致しません。");
            var requestText = new StringBuilder().Append(method).Append(' ').Append(RedactUrl(url)).AppendLine(" HTTP/1.1");
            AppendHeaders(requestText, request);
            if (request.TryGetProperty("postData", out var postData) && postData.ValueKind == JsonValueKind.Object &&
                postData.TryGetProperty("text", out var body) && body.ValueKind == JsonValueKind.String)
                requestText.AppendLine().Append(RedactBody(body.GetString() ?? ""));
            var responseText = new StringBuilder().Append("HTTP/1.1 ").Append(status).Append(' ')
                .AppendLine(response.TryGetProperty("statusText", out var statusText) && statusText.ValueKind == JsonValueKind.String ? statusText.GetString() : "");
            AppendHeaders(responseText, response);
            if (response.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Object &&
                content.TryGetProperty("text", out var responseBody) && responseBody.ValueKind == JsonValueKind.String)
            {
                var value = responseBody.GetString() ?? "";
                if (content.TryGetProperty("encoding", out var encoding) &&
                    encoding.ValueKind == JsonValueKind.String && encoding.GetString() == "base64")
                {
                    try { value = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(value)); }
                    catch (Exception ex) when (ex is FormatException or DecoderFallbackException) { value = "[バイナリ応答本文。原本を参照]"; }
                }
                responseText.AppendLine().Append(RedactBody(value));
            }
            return new(requestText.ToString(), responseText.ToString(), "");
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or JsonException or ArgumentException or UnauthorizedAccessException)
        { return new("", "", "原本を照合できません: " + ex.Message); }
    }

    private static void AppendHeaders(StringBuilder output, JsonElement message)
    {
        if (!message.TryGetProperty("headers", out var headers) || headers.ValueKind != JsonValueKind.Array) return;
        foreach (var header in headers.EnumerateArray().Take(150))
        {
            if (header.ValueKind != JsonValueKind.Object ||
                !header.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String ||
                !header.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.String) continue;
            var key = name.GetString() ?? "";
            var secret = IsSensitiveKey(key);
            output.Append(key).Append(": ").AppendLine(secret ? "[伏せ字]" : RedactBody(value.GetString() ?? ""));
        }
    }

    private static string RedactUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return value;
        var builder = new UriBuilder(uri) { UserName = "", Password = "", Fragment = "" };
        builder.Query = Regex.Replace(builder.Query.TrimStart('?'), @"(?<key>[^&=]+)=(?<value>[^&]*)", match =>
            IsSensitiveKey(WebUtility.UrlDecode(match.Groups["key"].Value)) ? match.Groups["key"].Value + "=[伏せ字]" : match.Value);
        return builder.Uri.ToString();
    }

    private static string RedactBody(string value)
    {
        value = value.Length > 100_000 ? value[..100_000] + "\n[本文は100,000文字で省略。原本を参照]" : value;
        value = JsonSecret().Replace(value, "$1[伏せ字]$3");
        value = FormSecret().Replace(value, "$1[伏せ字]");
        return value;
    }

    private static bool IsSensitiveKey(string value) => Regex.IsMatch(value,
        @"(?i)(authorization|cookie|password|passwd|secret|token|api[_-]?key|session|csrf|credential)");

    [GeneratedRegex("(?i)(\"(?:[^\"]*?(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|session|csrf|credential)[^\"]*)\"\\s*:\\s*\")[^\"]*(\")")]
    private static partial Regex JsonSecret();

    [GeneratedRegex("(?i)((?:^|[&;\\s])(?:[^=&\\s]*(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|session|csrf|credential)[^=&\\s]*)=)[^&;\\s]*")]
    private static partial Regex FormSecret();
}
