using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record BrunoExchangeDisplay(string Request, string Response, string Error);

public static partial class BrunoEvidenceReportFormatter
{
    internal static string RedactForReport(string value) => RedactBody(value ?? "");
    internal static string RedactUrlForReport(string value) => RedactUrl(value ?? "");
    internal static bool IsSensitiveFieldForReport(string value) => IsSensitiveKey(value ?? "");
    internal static string RedactHttpForReport(string header, string body, bool request)
    {
        var normalized = (header ?? "").Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
        var lines = normalized.Split('\n');
        if (request && lines.Length > 0) lines[0] = RedactRequestLine(lines[0]);
        var output = RedactBody(string.Join('\n', lines).TrimEnd());
        var safeBody = RedactBody(body ?? "").Trim();
        if (safeBody.Length > 0) output = output.Length == 0 ? safeBody : output + "\n\n" + safeBody;
        return LimitTranscript(output);
    }

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

    private static string RedactRequestLine(string value)
    {
        var match = RequestLine().Match(value);
        if (!match.Success) return value;
        var target = match.Groups["target"].Value;
        var absolute = Uri.TryCreate(target, UriKind.Absolute, out _);
        var candidate = absolute ? target : "https://scopepilot.invalid" + (target.StartsWith('/') ? target : "/" + target);
        var redacted = RedactUrl(candidate);
        if (!absolute && Uri.TryCreate(redacted, UriKind.Absolute, out var parsed))
            redacted = parsed.PathAndQuery;
        return $"{match.Groups["method"].Value} {redacted} {match.Groups["version"].Value}";
    }

    private static string RedactBody(string value)
    {
        value = value.Length > 100_000 ? value[..100_000] + "\n[本文は100,000文字で省略。原本を参照]" : value;
        value = HeaderSecret().Replace(value, "$1[伏せ字]");
        value = JsonSecret().Replace(value, "$1[伏せ字]$3");
        value = JsonPersonalData().Replace(value, "$1[個人情報伏せ字]$3");
        value = FormSecret().Replace(value, "$1[伏せ字]");
        value = EmailAddress().Replace(value, "[メールアドレス伏せ字]");
        value = BearerToken().Replace(value, "$1[伏せ字]");
        value = InvalidXmlCharacter().Replace(value, "�");
        return value;
    }

    private static string LimitTranscript(string value) => value.Length <= 24_000
        ? value : value[..24_000] + "\n[提出用表示は24,000文字で省略。原本を参照]";

    private static bool IsSensitiveKey(string value) => Regex.IsMatch(value,
        @"(?i)(authorization|cookie|password|passwd|secret|token|api[_-]?key|session|csrf|credential)");

    [GeneratedRegex("(?i)(\"(?:[^\"]*?(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|session|csrf|credential)[^\"]*)\"\\s*:\\s*\")[^\"]*(\")")]
    private static partial Regex JsonSecret();

    [GeneratedRegex("(?i)(\"(?:e-?mail|phone|telephone|address|first[_-]?name|last[_-]?name|full[_-]?name|ssn|credit[_-]?card|card[_-]?number)\"\\s*:\\s*\")[^\"]*(\")")]
    private static partial Regex JsonPersonalData();

    [GeneratedRegex("(?i)((?:^|[&;\\s])(?:[^=&\\s]*(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|session|csrf|credential)[^=&\\s]*)=)[^&;\\s]*")]
    private static partial Regex FormSecret();

    [GeneratedRegex("(?im)^((?:authorization|cookie|set-cookie|x-api-key|api-key|password|passwd|secret|token|session|csrf|credential)\\s*:\\s*).*$")]
    private static partial Regex HeaderSecret();

    [GeneratedRegex("^(?<method>[A-Za-z]+)\\s+(?<target>\\S+)\\s+(?<version>HTTP/\\d(?:\\.\\d)?)$")]
    private static partial Regex RequestLine();

    [GeneratedRegex(@"(?i)(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9.-])")]
    private static partial Regex EmailAddress();

    [GeneratedRegex(@"(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}")]
    private static partial Regex BearerToken();

    [GeneratedRegex("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]")]
    private static partial Regex InvalidXmlCharacter();
}
