namespace ScopePilot.Domain;

// ユーザー単位のアプリケーション設定。案件（EngagementProject）には保存しない。
// Services.AppSettingsService が %APPDATA%\ScopePilot\settings.json へ読み書きする。
public sealed class AppSettings
{
    // ZAPの実行環境（案件設定で空欄のときに使用する既定値）
    public string ZapJarPath { get; set; } = string.Empty;
    public string JavaPath { get; set; } = string.Empty;
    // ZAPアクティブ診断のチューニング（ZapScanTuningの既定値と同じ範囲で正規化する）
    public int MaxRuleDurationInMins { get; set; } = 1;
    public int MaxAlertsPerRule { get; set; } = 10;
    public int DelayInMs { get; set; } = 100;
    public int ThreadPerHost { get; set; } = 1;
    public bool ScanHeadersAllRequests { get; set; }
    public bool AddQueryParam { get; set; }
    // Burp MCPプロキシのJAR位置（空欄なら環境変数SCOPEPILOT_BURP_PROXY_JAR、既定位置の順に解決する）
    public string BurpMcpProxyJarPath { get; set; } = string.Empty;
    // GLM（Z.ai Coding Plan）のAPIキー。Windows DPAPI（CurrentUser）で暗号化した "dpapi:" 付きBase64で保存する。
    // 空欄ならzcode自身のZ.aiサインイン（zcode login）を使う。
    public string GlmApiKey { get; set; } = string.Empty;

    public ZapScanTuning ActiveScanTuning() => new(
        MaxRuleDurationInMins, MaxAlertsPerRule, DelayInMs, ThreadPerHost, ScanHeadersAllRequests, AddQueryParam);
}
