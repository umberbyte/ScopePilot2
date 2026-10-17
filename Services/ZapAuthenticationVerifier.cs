using System.Net.Http;
using System.Text.RegularExpressions;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record ZapAuthVerification(string RequestedUrl, string FinalUrl, int StatusCode, bool Success, string Reason);

// Pre-scan reachability check: replays the recorded session cookie against one known
// authenticated page before any attack request is authorized. Read-only GET only.
public class ZapAuthenticationVerifier
{
    private static readonly Regex LoginPath =
        new(@"(?:login|log-?in|sign-?in|signin|logon|authenticate)(?:\.[a-z0-9]+)?/?$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public virtual async Task<ZapAuthVerification> VerifyAsync(EngagementProject project, ZapPackage package, CancellationToken token)
    {
        var requestedRaw = project.AfterAuthenticationUrl.Length > 0 ? project.AfterAuthenticationUrl : package.RecordedTargets.FirstOrDefault();
        if (string.IsNullOrWhiteSpace(requestedRaw) ||
            !Uri.TryCreate(requestedRaw, UriKind.Absolute, out var requested) || requested.Scheme is not ("http" or "https"))
            return new(requestedRaw ?? "", requestedRaw ?? "", 0, false, "認証後URLが未設定のため到達確認できません。案件設定で認証後URLを入力してください。");
        if (package.AuthCookieHeader is null || package.AuthCookieHeader.Length == 0)
            return new(requested.AbsoluteUri, requested.AbsoluteUri, 0, false, "再利用できるセッションCookieがHARにありません。");
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(20)
        };
        var current = requested;
        var statusCode = 0;
        try
        {
            for (var redirects = 0; redirects <= 5; redirects++)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, current);
                request.Headers.TryAddWithoutValidation("Cookie", package.AuthCookieHeader);
                request.Headers.UserAgent.ParseAdd("ScopePilot-AuthVerification/1");
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
                statusCode = (int)response.StatusCode;
                if (statusCode is < 300 or >= 400 || response.Headers.Location is null) break;
                var location = response.Headers.Location;
                if (!location.IsAbsoluteUri) location = new Uri(current, location);
                if (location.Scheme is not ("http" or "https"))
                    return Fail(requested, current, statusCode, $"リダイレクト先の方式が不正です（{location.Scheme}）。");
                try { ApiRequestFormatter.EnsureAllowed(location.AbsoluteUri, project.AllowedOrigins); }
                catch (InvalidDataException)
                { return Fail(requested, current, statusCode, "リダイレクト先が許可Originの外です。"); }
                current = location;
            }
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        { return Fail(requested, current, statusCode, "到達確認が時間内に完了しませんでした。"); }
        catch (HttpRequestException ex)
        { return Fail(requested, current, statusCode, $"対象へ接続できませんでした（{ex.Message}）。"); }
        if (statusCode >= 400)
            return Fail(requested, current, statusCode, $"HTTP {statusCode}。認証後ページに到達できませんでした。");
        if (LoginPath.IsMatch(current.AbsolutePath) && !LoginPath.IsMatch(requested.AbsolutePath))
            return Fail(requested, current, statusCode, "ログイン画面へリダイレクトされました。記録済みセッションが無効です。");
        return new(requested.AbsoluteUri, current.AbsoluteUri, statusCode, true, "認証後ページに到達できました。");
    }

    private static ZapAuthVerification Fail(Uri requested, Uri current, int statusCode, string reason) =>
        new(requested.AbsoluteUri, current.AbsoluteUri, statusCode, false, reason);
}
