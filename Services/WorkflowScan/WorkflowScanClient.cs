using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ScopePilot.Services.WorkflowScan;

// ワークフロー診断専用のHTTPクライアント。Cookie管理・リクエスト数上限・証跡ログを担う。
// リダイレクトは自動追従せず、呼び出し側で追従 hop を制御・記録できるようにする。
public sealed partial class WorkflowScanClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly Dictionary<string, string> _cookies = [];
    private readonly Uri _baseUri;
    private readonly int _maxRequests;
    private readonly int _maxBodyLog = 600;
    private readonly List<WorkflowScanHttpRequestLog> _currentLog = [];
    private string[] _redactionValues = [];

    public int RequestCount { get; private set; }
    public Uri BaseUri => _baseUri;

    public WorkflowScanClient(WorkflowScanOptions options)
    {
        _baseUri = new Uri(options.BaseUrl.TrimEnd('/') + "/");
        _maxRequests = options.MaxRequests;
        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.All,
            ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
        };
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(options.RequestTimeoutSeconds) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("ScopePilot2-WorkflowScan/1.0");
    }

    public void Dispose() => _http.Dispose();

    // 認証情報などログに出せない値を伏せ字にした状態で証跡を残すための設定。
    public void SetRedactionValues(IEnumerable<string> values)
    {
        _redactionValues = values.Where(v => !string.IsNullOrWhiteSpace(v)).Distinct().OrderByDescending(v => v.Length).ToArray();
    }

    public IReadOnlyList<WorkflowScanHttpRequestLog> TakeRequestLog()
    {
        var log = _currentLog.ToList();
        _currentLog.Clear();
        return log;
    }

    public string CookieHeader => string.Join("; ", _cookies.Select(kv => $"{kv.Key}={kv.Value}"));

    public async Task<WorkflowScanResponse> GetAsync(string pathAndQuery, CancellationToken token = default) =>
        await SendAsync("GET", pathAndQuery, null, null, token);

    public Task<WorkflowScanResponse> PostFormAsync(string pathAndQuery, IReadOnlyDictionary<string, string> form, CancellationToken token = default) =>
        SendAsync("POST", pathAndQuery, new FormUrlEncodedContent(form), "application/x-www-form-urlencoded", token);

    public Task<WorkflowScanResponse> PostJsonAsync(string pathAndQuery, string json, CancellationToken token = default) =>
        SendAsync("POST", pathAndQuery, new StringContent(json, Encoding.UTF8, "application/json"), "application/json", token);

    public Task<WorkflowScanResponse> PutJsonAsync(string pathAndQuery, string json, CancellationToken token = default) =>
        SendAsync("PUT", pathAndQuery, new StringContent(json, Encoding.UTF8, "application/json"), "application/json", token);

    public Task<WorkflowScanResponse> PostMultipartAsync(string pathAndQuery, string fieldName, string fileName, string contentType, byte[] fileBytes,
        IReadOnlyDictionary<string, string> fields, CancellationToken token = default)
    {
        var boundary = "scopepilot-" + Guid.NewGuid().ToString("N")[..16];
        var head = new StringBuilder();
        foreach (var (name, value) in fields)
            head.Append($"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n");
        head.Append($"--{boundary}\r\nContent-Disposition: form-data; name=\"{fieldName}\"; filename=\"{fileName}\"\r\n");
        head.Append($"Content-Type: {contentType}\r\n\r\n");
        var headBytes = Encoding.UTF8.GetBytes(head.ToString());
        var tailBytes = Encoding.UTF8.GetBytes($"\r\n--{boundary}--\r\n");
        var body = new byte[headBytes.Length + fileBytes.Length + tailBytes.Length];
        Buffer.BlockCopy(headBytes, 0, body, 0, headBytes.Length);
        Buffer.BlockCopy(fileBytes, 0, body, headBytes.Length, fileBytes.Length);
        Buffer.BlockCopy(tailBytes, 0, body, headBytes.Length + fileBytes.Length, tailBytes.Length);
        return SendAsync("POST", pathAndQuery, new ByteArrayContent(body), $"multipart/form-data; boundary={boundary}", token);
    }

    // 3xx を手動で追従する。open redirect の立証には hop を残したいので自動追従を既定にしない。
    public async Task<WorkflowScanResponse> FollowAsync(WorkflowScanResponse response, int maxHops = 3, CancellationToken token = default)
    {
        var current = response;
        for (var hop = 0; hop < maxHops && current.IsRedirect; hop++)
        {
            if (string.IsNullOrWhiteSpace(current.Location)) break;
            var next = new Uri(_baseUri, current.Location);
            current.RedirectChain.Add(next.ToString());
            current = await GetAsync(next.PathAndQuery, token);
        }
        return current;
    }

    public string Url(string pathAndQuery) => new Uri(_baseUri, pathAndQuery.StartsWith('/') ? pathAndQuery : "/" + pathAndQuery).ToString();

    private async Task<WorkflowScanResponse> SendAsync(string method, string pathAndQuery, HttpContent? content, string? contentType, CancellationToken token)
    {
        if (RequestCount >= _maxRequests)
            throw new InvalidOperationException($"ワークフロー診断のリクエスト上限（{_maxRequests}件）に達しました。");
        RequestCount++;
        var target = new Uri(_baseUri, pathAndQuery.StartsWith('/') ? pathAndQuery : "/" + pathAndQuery);
        using var request = new HttpRequestMessage(new HttpMethod(method), target);
        if (content is not null)
        {
            request.Content = content;
            if (contentType is not null) request.Content.Headers.Remove("Content-Type");
            if (contentType is not null) request.Content.Headers.TryAddWithoutValidation("Content-Type", contentType);
        }
        if (_cookies.Count > 0)
            request.Headers.TryAddWithoutValidation("Cookie", CookieHeader);
        request.Headers.Referrer = new Uri(_baseUri, "index.php");
        string requestPreview = "";
        if (content is FormUrlEncodedContent or StringContent or ByteArrayContent)
        {
            try { requestPreview = Preview(await content.ReadAsStringAsync(token)); } catch (ObjectDisposedException) { }
        }
        using var response = await _http.SendAsync(request, token);
        var body = await response.Content.ReadAsStringAsync(token);
        var result = new WorkflowScanResponse
        {
            StatusCode = (int)response.StatusCode,
            Location = response.Headers.Location?.ToString() ?? "",
            Body = body,
            ContentType = string.Join("", response.Content.Headers.Where(h => h.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)).SelectMany(h => h.Value)),
            ContentSecurityPolicy = string.Join("", response.Headers.Where(h => h.Key.Equals("Content-Security-Policy", StringComparison.OrdinalIgnoreCase)).SelectMany(h => h.Value)),
            FinalUrl = target.ToString()
        };
        foreach (var setCookie in response.Headers.Where(h => h.Key.Equals("Set-Cookie", StringComparison.OrdinalIgnoreCase)).SelectMany(h => h.Value))
        {
            var pair = setCookie.Split(';', 2)[0].Split('=', 2);
            if (pair.Length == 2) _cookies[pair[0].Trim()] = pair[1].Trim();
            result.SetCookieValues.Add(setCookie.Split(';', 2)[0]);
        }
        _currentLog.Add(new WorkflowScanHttpRequestLog
        {
            Method = method,
            Url = Redact(target.PathAndQuery),
            Status = result.StatusCode,
            Location = Redact(result.Location),
            RequestPreview = requestPreview,
            ResponsePreview = Preview(body)
        });
        return result;
    }

    private string Preview(string value)
    {
        var text = value.Length > _maxBodyLog ? value[.._maxBodyLog] + "…(切り詰め)" : value;
        return Regex.Replace(Redact(text), @"\r?\n", " ");
    }

    // クエリ文字列・リダイレクト先にも認証情報が現れるため、長さに関係なく伏せ字化する。
    private string Redact(string value)
    {
        foreach (var secret in _redactionValues)
            value = value.Replace(secret, "*****");
        return value;
    }

    public static string ExtractMatch(string body, Regex pattern)
    {
        var match = pattern.Match(body);
        return match.Success ? match.Groups[1].Value : "";
    }
}

public sealed class WorkflowScanResponse
{
    public int StatusCode { get; set; }
    public string Body { get; set; } = "";
    public string Location { get; set; } = "";
    public string ContentType { get; set; } = "";
    public string ContentSecurityPolicy { get; set; } = "";
    public string FinalUrl { get; set; } = "";
    public List<string> SetCookieValues { get; } = [];
    public List<string> RedirectChain { get; } = [];
    public bool IsRedirect => StatusCode is >= 300 and < 400;
    public bool Contains(string value, StringComparison comparison = StringComparison.Ordinal) => Body.Contains(value, comparison);
}
