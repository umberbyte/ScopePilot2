using System.Text.RegularExpressions;

namespace ScopePilot.Services;

/// <summary>
/// Automation Frameworkの標準出力行を、アプリのログに流す簡潔な進行メッセージへ変換する。
/// 重要度の低い行（ジョブ設定行など）はnullを返す。全行はzap-run.logへそのまま書き込まれる。
/// </summary>
internal sealed class ZapOutputSummarizer(IReadOnlyList<string> activeScanTargets, bool reportJobProgress)
{
    private int _activeScanStarted;
    private int _activeScanFinished;

    private static readonly Dictionary<string, string> JobLabels = new()
    {
        ["import"] = "保存済み通信の取込",
        ["passiveScan-wait"] = "パッシブ診断",
        ["replacer"] = "認証Cookieの適用",
        ["activeScan"] = "アクティブ診断",
        ["report"] = "レポート生成",
    };

    public string? Summarize(string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return null;
        var trimmed = line.TrimEnd();
        if (trimmed.Contains("Automation plan succeeded!", StringComparison.Ordinal))
            return "ZAP: 計画の実行が完了しました。";
        if (trimmed.Contains("Automation plan ", StringComparison.Ordinal))
            return "ZAP: " + trimmed;
        var attacking = Regex.Match(trimmed, @"DEBUG (\w+?ScanRule) - Attacking at Attack Strength: (\S+)$");
        if (attacking.Success)
            return $"ZAP: 診断ルールを実行中: {attacking.Groups[1].Value.Replace("ScanRule", "", StringComparison.Ordinal)}（強度{attacking.Groups[2].Value}）";
        var alertFound = Regex.Match(trimmed, @"DEBUG ExtensionAlert - alertFound (.+) (\S+)$");
        if (alertFound.Success)
            return $"ZAP: 警告を検出: {alertFound.Groups[1].Value} {Shorten(alertFound.Groups[2].Value)}";
        if (trimmed.Contains(" ERROR ", StringComparison.Ordinal) || trimmed.Contains(" FATAL ", StringComparison.Ordinal))
            return "ZAP: " + (trimmed.Length > 300 ? trimmed[..300] + "…" : trimmed);
        if (trimmed.Contains(" WARN ", StringComparison.Ordinal))
            return "ZAP: [警告] " + (trimmed.Length > 300 ? trimmed[..300] + "…" : trimmed);
        if (!reportJobProgress) return null;
        var started = Regex.Match(trimmed, @"^Job (\S+) started$");
        if (started.Success) return StartedMessage(started.Groups[1].Value);
        var finished = Regex.Match(trimmed, @"^Job (\S+) finished, time taken: (\S+)$");
        if (finished.Success) return FinishedMessage(finished.Groups[1].Value, finished.Groups[2].Value);
        return null;
    }

    private string StartedMessage(string job)
    {
        if (job != "activeScan") return $"ZAP: {Label(job)}を開始しました。";
        _activeScanStarted++;
        if (_activeScanStarted > activeScanTargets.Count) return $"ZAP: {Label(job)}を開始しました。";
        return $"ZAP: {Label(job)}を実行中（{_activeScanStarted}/{activeScanTargets.Count}）: {Shorten(activeScanTargets[_activeScanStarted - 1])}";
    }

    private string FinishedMessage(string job, string time)
    {
        if (job != "activeScan") return $"ZAP: {Label(job)}を完了しました（所要 {time}）。";
        _activeScanFinished++;
        var scope = activeScanTargets.Count == 0 ? "" : $"（{_activeScanFinished}/{activeScanTargets.Count}）";
        return $"ZAP: {Label(job)}を完了しました{scope} 所要 {time}。";
    }

    private static string Label(string job) => JobLabels.TryGetValue(job, out var label) ? label : job;

    private static string Shorten(string url) => url.Length > 96 ? url[..96] + "…" : url;
}
