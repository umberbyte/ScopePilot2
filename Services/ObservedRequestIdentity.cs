using ScopePilot.Domain;

namespace ScopePilot.Services;

public static class ObservedRequestIdentity
{
    public static string Build(ObservedRequest request) =>
        $"{(request.Method ?? "GET").ToUpperInvariant()}\n{request.Url ?? string.Empty}\n{NormalizeRole(request.Role)}";

    public static string NormalizeRole(string? role)
    {
        if (string.IsNullOrWhiteSpace(role)) return "認証状態未確認";
        var value = role.Trim();
        if (value.Contains("未認証", StringComparison.OrdinalIgnoreCase) ||
            value.Contains("資格情報入力なし", StringComparison.OrdinalIgnoreCase) ||
            value.Contains("認証操作なし", StringComparison.OrdinalIgnoreCase) ||
            value.Equals("anonymous", StringComparison.OrdinalIgnoreCase) ||
            value.Equals("guest", StringComparison.OrdinalIgnoreCase)) return "未認証";
        if (value.Contains("未確認", StringComparison.OrdinalIgnoreCase) ||
            value.Contains("不明", StringComparison.OrdinalIgnoreCase)) return "認証状態未確認";
        return value;
    }

    public static bool IsAuthenticatedRole(string? role)
    {
        var normalized = NormalizeRole(role);
        return normalized is not ("未認証" or "認証状態未確認");
    }
}
