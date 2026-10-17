using System.Text.Json;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed class RunObservationCollector
{
    public async Task<int> CollectAsync(string directory, string allowedOrigins, string role)
    {
        var importer = new RequestImporter();
        var result = new Dictionary<string, ObservedRequest>(StringComparer.Ordinal);
        foreach (var name in new[] { "fast-observed-requests.jsonl", "ai-observed-requests.jsonl", "observed-requests.jsonl" })
        {
            var path = Path.Combine(directory, name);
            if (!File.Exists(path)) continue;
            foreach (var r in await importer.ImportAsync(path))
            {
                if (!Allowed(r, allowedOrigins)) continue;
                var key = ObservedRequestIdentity.Build(r);
                if (!result.ContainsKey(key)) result[key] = r;
            }
        }
        DateTimeOffset? authenticationTime = null;
        string verifiedRole = "認証状態未確認";
        var navigationPath = Path.Combine(directory, "authentication-navigation.json");
        if (File.Exists(navigationPath))
        {
            using var navigation = JsonDocument.Parse(await File.ReadAllTextAsync(navigationPath));
            var root = navigation.RootElement;
            if (root.GetProperty("status").GetString() == "authenticated" && root.GetProperty("loginFormVisible").ValueKind == JsonValueKind.False && root.GetProperty("authenticatedIndicatorVisible").ValueKind == JsonValueKind.True)
            {
                var landing = root.GetProperty("actualUrl").GetString()!;
                ApiRequestFormatter.EnsureAllowed(landing, allowedOrigins);
                verifiedRole = root.GetProperty("activeRole").GetString() ?? role;
                if (AuthenticationFlow.IsAnonymous(verifiedRole)) verifiedRole = "認証状態未確認";
                authenticationTime = result.Values.Where(x => AuthenticationFlow.DisplayUrl(x.Url) == landing && ObservedRequestIdentity.IsAuthenticatedRole(x.Role))
                    .Select(x => (DateTimeOffset?)x.ObservedAt).Min() ?? root.GetProperty("checkedAt").GetDateTimeOffset();
            }
        }
        foreach (var name in new[] { "fast-capture.har", "zap-fast-capture.har", "zap-ai-capture.har" })
        {
            var path = Path.Combine(directory, name);
            if (!File.Exists(path)) continue;
            foreach (var r in await importer.ImportAsync(path))
            {
                if (!Allowed(r, allowedOrigins)) continue;
                var match = result.Values.Where(x => x.Url == r.Url && x.Method == r.Method && Math.Abs((x.ObservedAt - r.ObservedAt).TotalSeconds) < 5)
                    .MinBy(x => Math.Abs((x.ObservedAt - r.ObservedAt).TotalSeconds));
                r.Role = match?.Role ?? (authenticationTime.HasValue ? r.ObservedAt >= authenticationTime ? verifiedRole : "未認証" : "認証状態未確認");
                r.Source = name;
                var key = ObservedRequestIdentity.Build(r);
                if (!result.TryGetValue(key, out var old)) result[key] = r;
                else if (!old.PageInspected && r.ObservedAt > old.ObservedAt) { old.StatusCode = r.StatusCode; old.ContentType = r.ContentType; old.ObservedAt = r.ObservedAt; }
            }
        }
        var output = Path.Combine(directory, "observed-requests.jsonl");
        var temp = output + ".tmp";
        await File.WriteAllLinesAsync(temp, result.Values.OrderBy(x => x.ObservedAt).Select(x => JsonSerializer.Serialize(x)));
        File.Move(temp, output, true);
        return result.Count;
    }
    private static bool Allowed(ObservedRequest request, string origins)
    {
        if (request.StatusCode is <= 0) return false;
        try { ApiRequestFormatter.EnsureAllowed(request.Url, origins); return true; }
        catch (InvalidDataException) { return false; }
    }
}
