using System.IO;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class JapaneseReportTests
{
    private static async Task<EngagementProject> ProjectAsync(string projectPath)
    {
        var project = new EngagementProject
        {
            Name = "日本語レポートサンプル（架空のテストデータ）", ProjectFilePath = projectPath,
            StartUrl = "https://example.test/login?token=QUERY_SECRET", AllowedOrigins = "https://example.test", ActiveRole = "未認証"
        };
        var original = ProjectPaths.Resolve(project, "inputs/zap.json");
        Directory.CreateDirectory(Path.GetDirectoryName(original)!);
        await File.WriteAllTextAsync(original, """
        {"site":[{"alerts":[
          {"pluginid":"10038","name":"Content Security Policy (CSP) Header Not Set","riskcode":"2","confidence":"3","cweid":"693","wascid":"15",
           "desc":"<p>A Content Security Policy header was not observed.</p>","solution":"<p>Configure a Content-Security-Policy header.</p>",
           "reference":"https://www.zaproxy.org/docs/alerts/10038/",
           "instances":[{"uri":"https://example.test/login?token=QUERY_SECRET","method":"GET","evidence":"RAW_EVIDENCE_SECRET","attack":"RAW_ATTACK_SECRET"},
                        {"uri":"https://example.test/account","method":"GET","evidence":"RAW_BODY_SECRET"}]},
          {"pluginid":"10021","name":"X-Content-Type-Options Header Missing","riskcode":"1","confidence":"2","cweid":"693","wascid":"15",
           "desc":"<p>The nosniff setting was not observed.</p>","solution":"<p>Set X-Content-Type-Options: nosniff.</p>",
           "instances":[{"uri":"https://example.test/login","method":"GET"}]}
        ]}]}
        """);
        Assert.Equal(3, await new ZapResultImporter().ImportAsync(project, original));
        project.Requests.Add(new() { Url = project.StartUrl, PageTitle = "ログイン", ObservedAt = new(2026, 10, 11, 10, 0, 0, TimeSpan.FromHours(9)) });
        project.Candidates.Add(new() { Selected = true, Representative = project.Requests[0] });
        return project;
    }

    [Fact]
    public async Task ExportContainsJapaneseOverviewGroupedDetailsAndVerifiedSourcesWithoutRawInstanceValues()
    {
        using var temp = new TestFolder();
        var project = await ProjectAsync(temp.Project().ProjectFilePath);
        var result = await new FindingReportService().ExportAsync(project);
        var markdown = await File.ReadAllTextAsync(result.MarkdownPath);
        Assert.Equal(2, result.AlertGroupCount);
        Assert.Equal(0, result.UntranslatedGroupCount);
        Assert.Equal(0, result.UnavailableEvidenceCount);
        Assert.Contains("## 2. 実施概要", markdown);
        Assert.Contains("## 5. 指摘事項一覧", markdown);
        Assert.Contains("## 6. 指摘事項詳細", markdown);
        Assert.Contains("CSP ヘッダーの設定に関する警告", markdown);
        Assert.Contains("対応案", markdown);
        Assert.Contains("X-Content-Type-Options: nosniff", markdown);
        Assert.Contains("| 中 | 1 | 2 |", markdown);
        Assert.Contains("| 低 | 1 | 1 |", markdown);
        Assert.Contains("照合済み", markdown);
        Assert.Contains(project.DiagnosticObservations[0].Evidence.Sha256, markdown);
        Assert.Contains("/site/0/alerts/0/instances/1", markdown);
        Assert.Contains("総合評価 | 未判定", markdown);
        foreach (var secret in new[] { "QUERY_SECRET", "RAW_EVIDENCE_SECRET", "RAW_ATTACK_SECRET", "RAW_BODY_SECRET" })
            Assert.DoesNotContain(secret, markdown);
        Assert.DoesNotContain("<p>", markdown);
        Assert.True(File.Exists(result.HtmlPath));
        Assert.True(File.Exists(result.JsonPath));
        Assert.True(File.Exists(result.CandidateChecklistPath));
    }

    [Fact]
    public async Task ChangedOrMissingOriginalIsRecordedWithoutDroppingWarningOrTrustingChangedText()
    {
        using var temp = new TestFolder();
        var project = await ProjectAsync(temp.Project().ProjectFilePath);
        var path = ProjectPaths.Resolve(project, project.DiagnosticObservations[0].Evidence.LocalPath);
        await File.WriteAllTextAsync(path, """{"site":[{"alerts":[]}],"description":"UNTRUSTED_CHANGED_TEXT"}""");
        var changed = await new JapaneseDiagnosticReportService().BuildAsync(project, DateTimeOffset.Now);
        Assert.Equal(3, changed.UnavailableEvidenceCount);
        Assert.Equal(2, changed.AlertGroupCount);
        Assert.Contains("SHA-256が一致しません", changed.Markdown);
        Assert.DoesNotContain("UNTRUSTED_CHANGED_TEXT", changed.Markdown);
        File.Delete(path);
        var missing = await new JapaneseDiagnosticReportService().BuildAsync(project, DateTimeOffset.Now);
        Assert.Equal(3, missing.UnavailableEvidenceCount);
        Assert.Contains("原本を読み取れません", missing.Markdown);
        foreach (var item in project.DiagnosticObservations) item.Evidence = item.Evidence with { LocalPath = "../outside.json" };
        var outside = await new JapaneseDiagnosticReportService().BuildAsync(project, DateTimeOffset.Now);
        Assert.Equal(3, outside.UnavailableEvidenceCount);
    }

    [Fact]
    public async Task UnknownRulesRetainVerifiedOriginalAndEscapeMarkdownAndHtml()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        var path = ProjectPaths.Resolve(project, "inputs/unknown.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(new
        {
            site = new[] { new { alerts = new[] { new
            {
                pluginid = "999999", name = "Unknown | [link](javascript:alert(1))", riskcode = "3", confidence = "2",
                desc = "<p>Original &amp; context.</p>\n# forged heading\n![image](https://outside.test/track)",
                solution = "Review the original rule.",
                instances = new[] { new { uri = "https://example.test/api", method = "GET" } }
            } } } }
        }));
        await new ZapResultImporter().ImportAsync(project, path);
        var report = await new JapaneseDiagnosticReportService().BuildAsync(project, DateTimeOffset.Now);
        Assert.Equal(1, report.UntranslatedGroupCount);
        Assert.Contains("日本語解説未登録", report.Markdown);
        Assert.Contains("Original &amp; context", report.Markdown);
        Assert.DoesNotContain("\n# forged heading", report.Markdown);
        Assert.DoesNotContain("![image](https://outside.test/track)", report.Markdown);
        Assert.Contains(@"\[link\]", report.Markdown);
        Assert.Contains(@"Unknown \|", report.Markdown);
        Assert.Contains("検証済み原文", report.Markdown);
    }

    [Fact]
    public async Task EmptyResultsDoNotDeclareSafetyAndRolesRemainSeparate()
    {
        using var temp = new TestFolder();
        var empty = await new JapaneseDiagnosticReportService().BuildAsync(temp.Project(), DateTimeOffset.Now);
        Assert.Contains("未実施・未観測", empty.Markdown);
        Assert.Contains("未判定", empty.Markdown);
        var project = await ProjectAsync(temp.Project().ProjectFilePath);
        var first = project.DiagnosticObservations[0];
        project.DiagnosticObservations.Add(new()
        {
            Tool = first.Tool, RuleId = first.RuleId, Title = first.Title, Severity = first.Severity, Confidence = first.Confidence,
            Url = first.Url, Method = first.Method, Role = "管理者", Evidence = first.Evidence
        });
        project.Findings.Add(new() { Title = "記録済みの探索所見", Description = "仕様との照合が必要", Severity = "low", Status = "要確認" });
        var report = await new JapaneseDiagnosticReportService().BuildAsync(project, DateTimeOffset.Now);
        Assert.Equal(3, report.AlertGroupCount);
        Assert.Contains("管理者", report.Markdown);
        Assert.Contains("### F-001 記録済みの探索所見", report.Markdown);
        Assert.DoesNotContain("| low |", report.Markdown);
    }

    [Fact]
    public async Task WriteReviewableSampleWhenArtifactsDirectoryIsProvided()
    {
        var directory = Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_REPORT_ARTIFACTS");
        if (string.IsNullOrWhiteSpace(directory)) return;
        Directory.CreateDirectory(directory);
        var project = await ProjectAsync(Path.Combine(directory, "sample.scopepilot.json"));
        // Fictional values only. This fixture is never sent to a target server.
        await new ProjectStore().SaveAsync(project);
        var result = await new FindingReportService().ExportAsync(project);
        await File.WriteAllTextAsync(Path.Combine(directory, "latest-report-path.txt"), result.MarkdownPath);
        File.Copy(result.MarkdownPath, Path.Combine(directory, "engagement-report.ja.md"), true);
        Assert.True(File.Exists(result.MarkdownPath));
    }
}
