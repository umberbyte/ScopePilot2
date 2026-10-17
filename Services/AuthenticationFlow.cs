using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record HumanInterventionRequest(string Id, bool Authentication, string Reason, string Page, string Instruction);

public static partial class AuthenticationFlow
{
    public static bool IsAnonymous(string role) => string.IsNullOrWhiteSpace(role) ||
        role.Contains("未認証", StringComparison.OrdinalIgnoreCase) ||
        role.Equals("anonymous", StringComparison.OrdinalIgnoreCase) || role.Equals("guest", StringComparison.OrdinalIgnoreCase);

    public static bool LooksLikeLogin(string url, string title, bool passwordField, bool userField)
    {
        var loginPath = Uri.TryCreate(url, UriKind.Absolute, out var uri) && LoginPath().IsMatch(uri.AbsolutePath);
        var loginTitle = LoginText().IsMatch(title);
        return loginPath || loginTitle || (passwordField && userField);
    }

    public static void ValidateTarget(EngagementProject project)
    {
        ApiRequestFormatter.EnsureAllowed(project.StartUrl, project.AllowedOrigins);
        if (project.MaxPages < 1 || project.MaxRequests < 1 || project.MaxMinutes < 1)
            throw new InvalidDataException("ページ数・通信数・実行時間の上限は1以上にしてください。");
        if (!string.IsNullOrWhiteSpace(project.AfterAuthenticationUrl))
            ApiRequestFormatter.EnsureAllowed(project.AfterAuthenticationUrl, project.AllowedOrigins);
    }

    public static HumanInterventionRequest? ParseRequest(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            string Read(string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
            var reason = Read("reason");
            var instruction = Read("instruction");
            if (string.IsNullOrWhiteSpace(reason) || string.IsNullOrWhiteSpace(instruction)) return null;
            var id = Read("requestId");
            if (id.Length == 0) id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json)))[..24];
            if (id.Length > 128) return null;
            return new(id, Read("kind") == "authentication" || LoginText().IsMatch(reason), reason, Read("page"), instruction);
        }
        catch (JsonException) { return null; }
    }

    public static void WriteResume(string directory, string? authenticatedRole = null)
    {
        var request = ParseRequest(File.ReadAllText(Path.Combine(directory, "human-intervention.json")))
            ?? throw new InvalidDataException("手動操作の案内が更新中です。案内が表示されてから再開してください。");
        if (request.Authentication && IsAnonymous(authenticatedRole ?? ""))
            throw new InvalidDataException("認証後のロールを選択してから再開してください。");
        var signal = Path.Combine(directory, "resume.signal");
        var temporary = signal + ".tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(new
            {
                requestId = request.Id, confirmedAt = DateTimeOffset.Now,
                activeRole = authenticatedRole, verifyNavigation = request.Authentication
            }));
            File.Move(temporary, signal, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public static string DisplayUrl(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
        ? new UriBuilder(uri) { UserName = "", Password = "", Query = "", Fragment = "" }.Uri.GetLeftPart(UriPartial.Path) : "";

    public static string FormatNavigation(string json, EngagementProject project)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        var status = root.GetProperty("status").GetString();
        var url = root.GetProperty("actualUrl").GetString() ?? "";
        if (status != "authenticated") return $"認証後の到達先は未確認: {DisplayUrl(url)}";
        if (!root.TryGetProperty("loginFormVisible", out var login) || login.ValueKind != JsonValueKind.False)
            return "認証画面が残っています。探索ブラウザでログインを完了してください。";
        if (!root.TryGetProperty("authenticatedIndicatorVisible", out var indicator) || indicator.ValueKind != JsonValueKind.True)
            return $"認証後の到達先は未確認: {DisplayUrl(url)}";
        try { ApiRequestFormatter.EnsureAllowed(url, project.AllowedOrigins); }
        catch (InvalidDataException) { return "認証後の到達先が許可Origin外です。対象範囲を確認してください。"; }
        if (!string.IsNullOrWhiteSpace(project.AfterAuthenticationUrl))
        {
            var actual = new Uri(url);
            var expected = new Uri(project.AfterAuthenticationUrl);
            if (!string.Equals(actual.GetLeftPart(UriPartial.Authority), expected.GetLeftPart(UriPartial.Authority), StringComparison.OrdinalIgnoreCase) ||
                actual.AbsolutePath != expected.AbsolutePath || (expected.Query.Length > 0 && actual.Query != expected.Query))
                return $"指定した認証後の開始URLへ未到達: {DisplayUrl(url)}";
        }
        return $"認証後の到達先: {DisplayUrl(url)}";
    }

    [GeneratedRegex(@"/(?:login|log-in|signin|sign-in|sign_in|logon|authenticate)(?:\.[a-z0-9]+)?/?$", RegexOptions.IgnoreCase)]
    private static partial Regex LoginPath();
    [GeneratedRegex(@"ログイン|認証|サインイン|\blog[ -]?in\b|\bsign[ -]?in\b|\bauthentication\b|\bSSO\b|\bMFA\b", RegexOptions.IgnoreCase)]
    private static partial Regex LoginText();
}
