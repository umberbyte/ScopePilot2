using System.Text;
using System.Text.RegularExpressions;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public static class ApiRequestFormatter
{
    private static readonly Regex Token = new("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", RegexOptions.CultureInvariant);

    public static Uri ValidateUrl(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Any(char.IsControl) ||
            !Uri.TryCreate(value, UriKind.Absolute, out var url) || url.Scheme is not ("http" or "https") ||
            !string.IsNullOrEmpty(url.UserInfo) || !string.IsNullOrEmpty(url.Fragment))
            throw new InvalidDataException("URLは認証情報とフラグメントを含まないhttp/httpsの完全なURLにしてください。");
        return url;
    }

    public static void EnsureAllowed(string value, string allowedOrigins)
    {
        var url = ValidateUrl(value);
        var allowed = allowedOrigins.Split(['\r', '\n', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(ValidateUrl).Select(x => x.GetLeftPart(UriPartial.Authority))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!allowed.Contains(url.GetLeftPart(UriPartial.Authority)))
            throw new InvalidDataException($"許可Originの範囲外です: {url.GetLeftPart(UriPartial.Authority)}");
    }

    public static string Format(ApiRequestDraft draft)
    {
        var url = ValidateUrl(draft.Url);
        var method = (draft.Method ?? string.Empty).Trim().ToUpperInvariant();
        if (!Token.IsMatch(method)) throw new InvalidDataException("HTTPメソッドが不正です。");
        var headers = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in (draft.HeadersText ?? string.Empty).Replace("\r\n", "\n").Split('\n'))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var separator = line.IndexOf(':');
            if (separator < 1 || !Token.IsMatch(line[..separator]))
                throw new InvalidDataException("ヘッダーは1行に Name: value の形式で入力してください。");
            var name = line[..separator];
            var value = line[(separator + 1)..].Trim();
            if (value.Any(c => char.IsControl(c) && c != '\t')) throw new InvalidDataException("ヘッダー値に制御文字があります。");
            // The application owns framing; model-provided lengths must not survive body edits.
            if (name.Equals("Host", StringComparison.OrdinalIgnoreCase) || name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
            if (name.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Transfer-Encodingには対応していません。本文は通常形式で指定してください。");
            if (!seen.Add(name)) throw new InvalidDataException($"重複ヘッダーを確認してください: {name}");
            headers.Add($"{name}: {value}");
        }
        var body = draft.Body ?? string.Empty;
        var output = new StringBuilder().Append(method).Append(' ').Append(url.PathAndQuery).Append(" HTTP/1.1\r\nHost: ").Append(url.Authority).Append("\r\n");
        foreach (var header in headers) output.Append(header).Append("\r\n");
        if (body.Length > 0 || method is "POST" or "PUT" or "PATCH")
            output.Append("Content-Length: ").Append(Encoding.UTF8.GetByteCount(body)).Append("\r\n");
        return output.Append("\r\n").Append(body).ToString();
    }
}
