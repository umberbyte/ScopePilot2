using System.Text.Json.Serialization;
using ScopePilot.Domain;

namespace ScopePilot.Services.WorkflowScan;

// ワークフロー診断（複数回の状態遷移・暗号解析・API操作を要する診断）の実行条件。
// 認証情報は案件設定から渡し、証跡ログへは決して書き出さない。
public sealed record WorkflowScanOptions(string BaseUrl, string Username, string Password)
{
    public int MaxRequests { get; init; } = 2000;
    public int RequestTimeoutSeconds { get; init; } = 15;
    // 既定では low / medium / high の3段階で実施する。impossible は対策済み比較実装のため対象外。
    public IReadOnlyList<string> SecurityLevels { get; init; } = ["low", "medium", "high"];
}

// 個別チェックの結果。Detect=true のものだけが所見化される。
public sealed class WorkflowScanCheckResult
{
    public string CheckId { get; set; } = "";
    public string Title { get; set; } = "";
    public string Category { get; set; } = "";
    public string Severity { get; set; } = "中";
    public string Confidence { get; set; } = "高";
    public string Cwe { get; set; } = "";
    public string SecurityLevel { get; set; } = "";
    public bool Detected { get; set; }
    public string Url { get; set; } = "";
    public string Method { get; set; } = "GET";
    public string Parameter { get; set; } = "";
    public string Description { get; set; } = "";
    public string Evidence { get; set; } = "";
    public string Remediation { get; set; } = "";
    public string Limitations { get; set; } = "";
}

public sealed class WorkflowScanHttpRequestLog
{
    public string Method { get; set; } = "";
    public string Url { get; set; } = "";
    public int Status { get; set; }
    public string Location { get; set; } = "";
    public string RequestPreview { get; set; } = "";
    public string ResponsePreview { get; set; } = "";
}

public sealed class WorkflowScanCheckLog
{
    public string CheckId { get; set; } = "";
    public string SecurityLevel { get; set; } = "";
    public bool Detected { get; set; }
    public string Note { get; set; } = "";
    public List<WorkflowScanHttpRequestLog> Requests { get; set; } = [];
}

public sealed class WorkflowScanResult
{
    public string RunDirectory { get; set; } = "";
    public string BaseUrl { get; set; } = "";
    public bool Authenticated { get; set; }
    public string OriginalSecurityLevel { get; set; } = "";
    public string TestedSecurityLevels { get; set; } = "";
    public int RequestCount { get; set; }
    public DateTimeOffset StartedAt { get; set; } = DateTimeOffset.Now;
    public DateTimeOffset EndedAt { get; set; } = DateTimeOffset.Now;
    public List<WorkflowScanCheckResult> Checks { get; set; } = [];
    public List<WorkflowScanCheckLog> CheckLogs { get; set; } = [];
}

public static class WorkflowScanFindingMapper
{
    // WorkflowScanCheckResult を案件の探索所見へ変換する。深刻度・確度は日本語ラベルに揃える。
    public static DiagnosticFinding ToFinding(WorkflowScanCheckResult check, string sourceRunDirectory) => new()
    {
        Title = check.Title,
        Severity = check.Severity,
        Confidence = check.Confidence,
        Category = check.Category,
        Status = "確認済み",
        Description = check.Description,
        Evidence = check.Evidence,
        AffectedUrls = check.Url,
        GuidelineBasis = string.IsNullOrEmpty(check.Cwe) ? "" : $"CWE-{check.Cwe}",
        Limitations = check.Limitations,
        SourceRunDirectory = sourceRunDirectory,
    };

    // 再実行時に同じ指摘が二重登録されないよう、表題と対象URLで指紋を作る。
    // 表題には必要に応じてセキュリティレベルを含めるため、レベル違いは別指摘になる。
    public static string Fingerprint(DiagnosticFinding finding) =>
        string.Join("|", finding.Title.Trim(), finding.AffectedUrls.Trim()).ToUpperInvariant();
}
