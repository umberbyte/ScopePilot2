namespace ScopePilot.Services;

public static class BurpProxyLocation
{
    public const string EnvironmentVariable = "SCOPEPILOT_BURP_PROXY_JAR";

    // 解決順序: アプリ設定（%APPDATA%の設定ファイル） → 環境変数 → 既定位置。
    public static string Resolve() => ResolvePath(AppSettingsService.Load().BurpMcpProxyJarPath,
        Environment.GetEnvironmentVariable(EnvironmentVariable),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ScopePilot"));

    internal static string ResolvePath(string? configuredPath, string? environmentPath, string dataDirectory) =>
        !string.IsNullOrWhiteSpace(configuredPath) ? Path.GetFullPath(configuredPath)
        : !string.IsNullOrWhiteSpace(environmentPath) ? Path.GetFullPath(environmentPath)
        : Path.Combine(dataDirectory, "mcp", "mcp-proxy-all.jar");
}
