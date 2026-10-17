using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using ScopePilot.Domain;

namespace ScopePilot.Services;

// アプリケーション設定（ユーザー単位）の読み書き。
// Windowsの作法に従い、ローミングプロファイルの %APPDATA%\ScopePilot\settings.json に置く。
public static class AppSettingsService
{
    public static string SettingsDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ScopePilot");
    public static string SettingsPath => Path.Combine(SettingsDirectory, "settings.json");
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true, Converters = { new JsonStringEnumConverter() }
    };

    public static AppSettings Load()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return new AppSettings();
            var loaded = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(SettingsPath), Options);
            return loaded is null ? new AppSettings() : Normalize(loaded);
        }
        catch (IOException) { return new AppSettings(); }
        catch (JsonException) { return new AppSettings(); }
        // 読めない設定は既定値で起動し、保存時に上書きして回復させる。
        catch (UnauthorizedAccessException) { return new AppSettings(); }
    }

    public static void Save(AppSettings settings)
    {
        Directory.CreateDirectory(SettingsDirectory);
        File.WriteAllText(SettingsPath, JsonSerializer.Serialize(Normalize(settings), Options));
    }

    public static AppSettings Normalize(AppSettings settings) => new()
    {
        ZapJarPath = settings.ZapJarPath ?? string.Empty,
        JavaPath = settings.JavaPath ?? string.Empty,
        MaxRuleDurationInMins = ZapScanTuning.NormalizeRuleDuration(settings.MaxRuleDurationInMins),
        MaxAlertsPerRule = ZapScanTuning.NormalizeAlertsPerRule(settings.MaxAlertsPerRule),
        DelayInMs = ZapScanTuning.NormalizeDelay(settings.DelayInMs),
        ThreadPerHost = ZapScanTuning.NormalizeThreads(settings.ThreadPerHost),
        ScanHeadersAllRequests = settings.ScanHeadersAllRequests,
        AddQueryParam = settings.AddQueryParam,
        BurpMcpProxyJarPath = settings.BurpMcpProxyJarPath ?? string.Empty,
        GlmApiKey = ProtectSecret(settings.GlmApiKey)
    };

    private const string DpapiPrefix = "dpapi:";
    private static readonly byte[] SecretEntropy = Encoding.UTF8.GetBytes("ScopePilot.AppSettings.GlmApiKey");

    // 平文はDPAPIで暗号化し、暗号化済みの値はそのまま保持する（再暗号化しない）。
    internal static string ProtectSecret(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var trimmed = value.Trim();
        if (trimmed.StartsWith(DpapiPrefix, StringComparison.Ordinal)) return trimmed;
        var protectedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(trimmed), SecretEntropy, DataProtectionScope.CurrentUser);
        return DpapiPrefix + Convert.ToBase64String(protectedBytes);
    }

    // 復号できない値（別ユーザー・破損）は未登録として扱う。
    internal static string UnprotectSecret(string? stored)
    {
        if (string.IsNullOrWhiteSpace(stored)) return string.Empty;
        if (!stored.StartsWith(DpapiPrefix, StringComparison.Ordinal)) return stored.Trim();
        try
        {
            var bytes = ProtectedData.Unprotect(Convert.FromBase64String(stored[DpapiPrefix.Length..]), SecretEntropy, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(bytes);
        }
        catch (CryptographicException) { return string.Empty; }
        catch (FormatException) { return string.Empty; }
    }

    // GLMのAPIキー。設定ファイル → 環境変数 ZAI_API_KEY → Z_AI_API_KEY の順に解決する。空ならzcode loginを使う。
    public static string ResolveGlmApiKey(AppSettings? appSettings = null)
    {
        var stored = UnprotectSecret((appSettings ?? Load()).GlmApiKey);
        if (stored.Length > 0) return stored;
        foreach (var name in new[] { "ZAI_API_KEY", "Z_AI_API_KEY" })
            if (Environment.GetEnvironmentVariable(name) is { Length: > 0 } value) return value.Trim();
        return string.Empty;
    }

    public static string GlmApiKeySource(AppSettings? appSettings = null)
    {
        if (UnprotectSecret((appSettings ?? Load()).GlmApiKey).Length > 0) return "設定ファイル";
        foreach (var name in new[] { "ZAI_API_KEY", "Z_AI_API_KEY" })
            if (Environment.GetEnvironmentVariable(name) is { Length: > 0 }) return $"環境変数 {name}";
        return string.Empty;
    }

    // 案件側のZAP/Javaパスが空欄のとき、アプリ設定の既定で補う（変更はメモリ上のみ）。
    public static void ApplyZapToolDefaults(DiagnosticToolSettings tools, AppSettings? appSettings = null)
    {
        var defaults = appSettings ?? Load();
        if (string.IsNullOrWhiteSpace(tools.ZapJarPath) && !string.IsNullOrWhiteSpace(defaults.ZapJarPath))
            tools.ZapJarPath = defaults.ZapJarPath;
        if (string.IsNullOrWhiteSpace(tools.JavaPath) && !string.IsNullOrWhiteSpace(defaults.JavaPath))
            tools.JavaPath = defaults.JavaPath;
    }
}
