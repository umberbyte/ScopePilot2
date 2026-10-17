using System.Net;
using System.Text;
using System.Text.Json;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record FindingReportResult(string Directory, string JsonPath, string HtmlPath, string CandidateChecklistPath,
    int FindingCount, int CandidateCount)
{
    public string MarkdownPath { get; init; } = "";
    public int AlertGroupCount { get; init; }
    public int UntranslatedGroupCount { get; init; }
    public int UnavailableEvidenceCount { get; init; }
}

public sealed class FindingReportService
{
    private readonly string? _reportsDirectory;

    public FindingReportService(string? reportsDirectory = null) => _reportsDirectory = reportsDirectory;

    public async Task<FindingReportResult> ExportAsync(EngagementProject project)
    {
        var root = _reportsDirectory is null ? ProjectPaths.Category(project, "reports") : Path.Combine(_reportsDirectory, project.Id.ToString("N"));
        var directory = Path.Combine(root, DateTimeOffset.Now.ToString("yyyyMMdd-HHmmss-fff"));
        Directory.CreateDirectory(directory);
        var jsonPath = Path.Combine(directory, "engagement-report.json");
        var htmlPath = Path.Combine(directory, "engagement-report.html");
        var checklistPath = Path.Combine(directory, "candidate-review.tsv");
        var markdownPath = Path.Combine(directory, "engagement-report.ja.md");
        var generatedAt = DateTimeOffset.Now;
        var japaneseReport = await new JapaneseDiagnosticReportService().BuildAsync(project, generatedAt);
        var selected = project.Candidates.Where(x => x.Selected).ToArray();
        var payload = new
        {
            generatedAt,
            projectId = project.Id,
            projectName = project.Name,
            startUrl = project.StartUrl,
            allowedOrigins = Split(project.AllowedOrigins),
            supportingOrigins = Split(project.SupportingOrigins),
            roles = Split(project.Roles),
            forbiddenActions = Split(project.ForbiddenActions),
            enabledGuidelines = EnabledGuidelines(project.Guidelines),
            coverage = BuildCoverage(project),
            selectedCandidates = selected.Select(CandidatePayload),
            excludedCandidates = project.Candidates.Where(x => !x.Selected).Select(CandidatePayload),
            findings = project.Findings.Select(x => ProjectPaths.PortableRunObject(project, x)),
            brunoVerifications = project.BrunoVerifications,
            toolObservations = project.DiagnosticObservations,
            disclaimer = "本レポートは探索時点の観測に基づく対象選定と所見の整理です。脆弱性の確定には診断担当者による再現確認が必要です。"
        };
        await File.WriteAllTextAsync(jsonPath, JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
        await File.WriteAllTextAsync(htmlPath, BuildHtml(project), new UTF8Encoding(false));
        await File.WriteAllTextAsync(markdownPath, japaneseReport.Markdown, new UTF8Encoding(false));
        // Summarize imported tool results and their source references.
        await File.WriteAllTextAsync(Path.Combine(directory, "diagnostic-summary.json"), JsonSerializer.Serialize(new
        {
            version = 1,
            unconfirmedToolAlertCount = project.DiagnosticObservations.Count,
            toolObservations = project.DiagnosticObservations.Select(x => new { x.Tool, x.RuleId, x.Severity, x.Confidence,
                x.Method, x.Url, x.Parameter, x.Role, state = x.State.ToString(), x.Evidence }),
            limitations = new[] { "外部診断ツールの警告を整理した結果です。内容の判断は診断担当者が行います。" }
        }, new JsonSerializerOptions { WriteIndented = true }));
        await File.WriteAllLinesAsync(checklistPath,
            new[] { "Selected\tDecision\tConfidence\tCategory\tMethod\tURL\tRole\tSimilarCount\tReason\tDiagnosticCaution\tGuidelineBasis" }
                .Concat(project.Candidates.Select(x => string.Join('\t',
                    x.Selected, Clean(x.Decision), Clean(x.Confidence), Clean(x.Category), Clean(x.Representative.Method),
                    Clean(x.Representative.Url), Clean(x.Representative.Role), x.SimilarCount, Clean(x.Reason),
                    Clean(x.DiagnosticCaution), Clean(x.GuidelineBasis)))), new UTF8Encoding(true));
        return new(directory, jsonPath, htmlPath, checklistPath, project.Findings.Count, selected.Length)
        {
            MarkdownPath = markdownPath, AlertGroupCount = japaneseReport.AlertGroupCount,
            UntranslatedGroupCount = japaneseReport.UntranslatedGroupCount, UnavailableEvidenceCount = japaneseReport.UnavailableEvidenceCount
        };
    }

    private static object CandidatePayload(DiagnosticCandidate candidate) => new
    {
        candidate.Selected,
        candidate.Decision,
        candidate.Confidence,
        candidate.Category,
        candidate.Pattern,
        candidate.SimilarCount,
        representative = new { candidate.Representative.Method, candidate.Representative.Url, candidate.Representative.Role, candidate.Representative.StatusCode, candidate.Representative.ContentType },
        candidate.Reason,
        candidate.DiagnosticCaution,
        candidate.GuidelineBasis,
        candidate.DecisionTrace
    };

    private static object BuildCoverage(EngagementProject project) => new
    {
        observedRequestCount = project.Requests.Count,
        candidateCount = project.Candidates.Count,
        selectedCandidateCount = project.Candidates.Count(x => x.Selected),
        findingCount = project.Findings.Count,
        methods = project.Requests.GroupBy(x => x.Method.ToUpperInvariant()).OrderBy(x => x.Key).ToDictionary(x => x.Key, x => x.Count()),
        statusCodes = project.Requests.GroupBy(x => x.StatusCode?.ToString() ?? "不明").OrderBy(x => x.Key).ToDictionary(x => x.Key, x => x.Count()),
        roles = project.Requests.GroupBy(x => string.IsNullOrWhiteSpace(x.Role) ? "未記録" : x.Role).OrderBy(x => x.Key).ToDictionary(x => x.Key, x => x.Count()),
        categories = project.Candidates.GroupBy(x => x.Category).OrderBy(x => x.Key).ToDictionary(x => x.Key, x => x.Count()),
        severity = project.Findings.GroupBy(x => x.Severity).OrderBy(x => x.Key).ToDictionary(x => x.Key, x => x.Count())
    };

    private static string BuildHtml(EngagementProject project)
    {
        var selected = project.Candidates.Where(x => x.Selected).ToArray();
        var sb = new StringBuilder();
        sb.Append("<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>ScopePilot 案件レポート</title>");
        sb.Append("<style>:root{color-scheme:light}body{font-family:Segoe UI,Meiryo,sans-serif;color:#172033;margin:32px;line-height:1.5}h1{border-bottom:3px solid #165DFF;padding-bottom:8px}h2{margin-top:32px;border-bottom:1px solid #DDE2E8;padding-bottom:5px}.cards{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px}.card{border:1px solid #DDE2E8;border-radius:7px;padding:12px}.number{font-size:24px;font-weight:700;color:#165DFF}.meta{color:#5E6C84}.notice{background:#FFF7E6;border:1px solid #F0B429;padding:12px;border-radius:6px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #DDE2E8;padding:7px;text-align:left;vertical-align:top}th{background:#F4F6F8}.finding{border:1px solid #DDE2E8;border-left:5px solid #165DFF;border-radius:6px;padding:16px;margin:16px 0;break-inside:avoid}.label{font-weight:600;margin-top:10px}pre{white-space:pre-wrap;word-break:break-word;background:#F4F6F8;padding:10px;border-radius:4px}a{color:#165DFF}@media print{body{margin:12mm}.finding,tr{break-inside:avoid}}</style></head><body>");
        sb.Append($"<h1>ScopePilot 案件レポート</h1><p>案件: {Encode(project.Name)}<br>開始URL: {Link(project.StartUrl)}<br>生成日時: {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}</p>");
        sb.Append("<div class=\"notice\"><strong>扱い:</strong> 本レポートは探索時点の観測に基づく対象選定と所見の整理です。脆弱性の確定には診断担当者による再現確認が必要です。</div>");
        sb.Append("<h2>サマリー</h2><div class=\"cards\">");
        AppendCard(sb, "観測通信", project.Requests.Count); AppendCard(sb, "代表候補", project.Candidates.Count);
        AppendCard(sb, "採用候補", selected.Length); AppendCard(sb, "診断所見", project.Findings.Count); sb.Append("</div>");

        sb.Append("<h2>案件範囲と制約</h2>");
        AppendList(sb, "診断を許可されたOrigin", Split(project.AllowedOrigins));
        AppendList(sb, "表示・認証に必要な対象外Origin", Split(project.SupportingOrigins));
        AppendList(sb, "認証ロール", Split(project.Roles));
        AppendList(sb, "自動実行しない操作", Split(project.ForbiddenActions));
        AppendList(sb, "参照ガイドライン", EnabledGuidelines(project.Guidelines));

        sb.Append("<h2>探索カバレッジ</h2>");
        AppendBreakdown(sb, "HTTPメソッド", project.Requests.GroupBy(x => x.Method.ToUpperInvariant()).Select(x => (x.Key, x.Count())));
        AppendBreakdown(sb, "応答ステータス", project.Requests.GroupBy(x => x.StatusCode?.ToString() ?? "不明").Select(x => (x.Key, x.Count())));
        AppendBreakdown(sb, "観測ロール", project.Requests.GroupBy(x => string.IsNullOrWhiteSpace(x.Role) ? "未記録" : x.Role).Select(x => (x.Key, x.Count())));
        AppendBreakdown(sb, "候補分類", project.Candidates.GroupBy(x => x.Category).Select(x => (x.Key, x.Count())));

        sb.Append("<h2>採用した診断対象候補</h2><table><thead><tr><th>分類</th><th>Method / URL</th><th>ロール</th><th>類似数</th><th>選定理由</th><th>診断時の注意</th></tr></thead><tbody>");
        foreach (var candidate in selected)
            sb.Append($"<tr><td>{Encode(candidate.Category)}</td><td>{Encode(candidate.Representative.Method)} {Link(candidate.Representative.Url)}</td><td>{Encode(candidate.Representative.Role)}</td><td>{candidate.SimilarCount:N0}</td><td>{Encode(candidate.Reason)}</td><td>{Encode(candidate.DiagnosticCaution)}</td></tr>");
        if (selected.Length == 0) sb.Append("<tr><td colspan=\"6\">採用候補はありません。</td></tr>");
        sb.Append("</tbody></table>");

        sb.Append("<h2>診断所見</h2>");
        sb.Append($"<p>取り込んだツール警告: {project.DiagnosticObservations.Count}件。内容は診断担当者が確認してください。</p>");
        if (project.Findings.Count == 0) sb.Append("<p>探索結果から取り込まれた診断所見はありません。候補一覧は診断実施時の作業対象として確認してください。</p>");
        foreach (var finding in project.Findings)
        {
            sb.Append("<section class=\"finding\">");
            sb.Append($"<h3>{Encode(finding.Title)}</h3><p class=\"meta\">深刻度: {Encode(finding.Severity)} / 確信度: {Encode(finding.Confidence)} / 分類: {Encode(finding.Category)} / 状態: {Encode(finding.Status)}</p>");
            AppendBlock(sb, "説明", finding.Description); AppendBlock(sb, "観測根拠", finding.Evidence);
            AppendBlock(sb, "対象URL", finding.AffectedUrls); AppendBlock(sb, "参照基準", finding.GuidelineBasis);
            AppendBlock(sb, "制約・未確認事項", finding.Limitations); sb.Append("</section>");
        }
        sb.Append($"<h2>除外候補</h2><p>{project.Candidates.Count(x => !x.Selected):N0}件。詳細は同時出力されるcandidate-review.tsvとengagement-report.jsonを参照してください。</p>");
        return sb.Append("</body></html>").ToString();
    }

    private static void AppendCard(StringBuilder sb, string label, int value) => sb.Append($"<div class=\"card\"><div class=\"meta\">{Encode(label)}</div><div class=\"number\">{value:N0}</div></div>");

    private static void AppendList(StringBuilder sb, string label, IEnumerable<string> values)
    {
        var list = values.Where(x => !string.IsNullOrWhiteSpace(x)).ToArray();
        sb.Append($"<div class=\"label\">{Encode(label)}</div><ul>");
        foreach (var value in list) sb.Append($"<li>{Encode(value)}</li>");
        if (list.Length == 0) sb.Append("<li>なし</li>");
        sb.Append("</ul>");
    }

    private static void AppendBreakdown(StringBuilder sb, string label, IEnumerable<(string Key, int Count)> values)
    {
        sb.Append($"<div class=\"label\">{Encode(label)}</div><p>");
        sb.Append(string.Join(" / ", values.OrderByDescending(x => x.Count).ThenBy(x => x.Key).Select(x => $"{Encode(x.Key)}: {x.Count:N0}")));
        sb.Append("</p>");
    }

    private static void AppendBlock(StringBuilder sb, string label, string value)
    {
        if (!string.IsNullOrWhiteSpace(value)) sb.Append($"<div class=\"label\">{Encode(label)}</div><pre>{Encode(value)}</pre>");
    }

    private static string[] EnabledGuidelines(GuidelineSelectionOptions? options)
    {
        options ??= new();
        return new[]
        {
            (options.WebAppPentestGuidelines, "WebAppPentestGuidelines v1.2"), (options.OwaspTop10, "OWASP Top 10:2025"),
            (options.Asvs, "OWASP ASVS 5.0"), (options.Wstg, "OWASP WSTG 4.2"), (options.Aisvs, "OWASP AISVS 1.0"),
            (options.CloudNativeTop10, "OWASP Cloud Native Application Security Top 10"), (options.Ds221, "デジタル庁 DS-221")
        }.Where(x => x.Item1).Select(x => x.Item2).ToArray();
    }

    private static string[] Split(string value) => (value ?? string.Empty).Split(['\r', '\n', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    private static string Link(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" ? $"<a href=\"{Encode(uri.AbsoluteUri)}\">{Encode(value)}</a>" : Encode(value);
    private static string Clean(string value) => (value ?? string.Empty).Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
    private static string Encode(string value) => WebUtility.HtmlEncode(value ?? string.Empty);
}
