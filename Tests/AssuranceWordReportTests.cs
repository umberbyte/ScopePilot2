using System.IO;
using System.Text.Json;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using ScopePilot.Domain;
using ScopePilot.Services;
using ScopePilot.Services.Reports;
using ScopePilot.Services.WordReports;
using W = DocumentFormat.OpenXml.Wordprocessing;
using Xunit;

namespace ScopePilot.Tests;

public sealed class AssuranceWordReportTests
{
    [Fact]
    public async Task StructuredModelMapsProjectWithoutLeakingSecretsAndWordIsValid()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.Name = "架空ECサイト診断";
        project.StartUrl = "https://shop.example.test/login?token=QUERY_SECRET#section";
        project.AllowedOrigins = "https://shop.example.test";
        project.Roles = "未認証";
        project.ForbiddenActions = "削除";
        project.Report = new()
        {
            SystemName = "架空ECサイト", ClientName = "架空株式会社 情報システム部", ServiceProvider = "ScopePilot 診断チーム",
            Author = "担当者A", Reviewer = "担当者B", Conclusion = "確認済みの指摘を優先して対応してください。",
            AssessmentStartedAt = new(2026, 10, 24, 9, 0, 0, TimeSpan.FromHours(9)),
            AssessmentEndedAt = new(2026, 10, 24, 9, 2, 0, TimeSpan.FromHours(9))
        };
        await new ProjectStore().SaveAsync(project);
        var reloaded = await new ProjectStore().LoadAsync(project.ProjectFilePath);
        Assert.Equal("架空株式会社 情報システム部", reloaded.Report.ClientName);
        var source = ProjectPaths.Resolve(project, "inputs/zap.json");
        Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        await File.WriteAllTextAsync(source, """
        {"site":[{"alerts":[{"pluginid":"10038","name":"Content Security Policy Header Not Set","riskcode":"2","confidence":"3",
          "cweid":"693","desc":"<p>Diagnostic detail for CVE-2026-12345.</p>","solution":"<p>Set a restrictive Content-Security-Policy header.</p>",
          "reference":"https://owasp.org/www-project-secure-headers/","instances":[{
            "uri":"https://shop.example.test/login?token=QUERY_SECRET","method":"POST","param":"token","attack":"ATTACK_VALUE",
            "evidence":"missing Content-Security-Policy","otherinfo":"External interaction was not required.",
            "request-header":"POST /login?token=QUERY_SECRET HTTP/1.1\r\nHost: shop.example.test\r\nAuthorization: Bearer RAW_AUTH_SECRET\r\nCookie: sid=RAW_COOKIE_SECRET\r\nContent-Type: application/json\r\n",
            "request-body":"{\"email\":\"person@example.test\",\"password\":\"RAW_PASSWORD\"}",
            "response-header":"HTTP/1.1 200 OK\r\nSet-Cookie: sid=RAW_COOKIE_SECRET\r\nX-Powered-By: PHP/8.3\r\nContent-Type: application/json\r\n",
            "response-body":"{\"email\":\"person@example.test\",\"result\":\"ok\"}"}]}]}]}
        """);
        var evidence = await ProjectPaths.EvidenceAsync(project, source, "zap-report", "/site/0/alerts/0/instances/0");
        project.DiagnosticObservations.Add(new()
        {
            Tool = "ZAP", RuleId = "10038", Title = "Content Security Policy Header Not Set", Severity = "2", Confidence = "3",
            Url = project.StartUrl, Method = "GET", Role = "未認証", Evidence = evidence,
            ImportedAt = new(2026, 10, 23, 10, 0, 0, TimeSpan.FromHours(9))
        });
        project.Findings.Add(new()
        {
            FindingId = "F-ACCOUNT-001", Title = "アカウント情報の表示確認", Category = "認証・認可", Severity = "high",
            Status = "確認済み", Description = "別利用者の情報が表示されることを確認しました。",
            Evidence = "Authorization: Bearer RAW_AUTH_SECRET\nCookie: sid=RAW_COOKIE_SECRET",
            AffectedUrls = "https://shop.example.test/account?id=QUERY_SECRET", GuidelineBasis = "OWASP Top 10 A01",
            ObservedAt = new(2026, 10, 23, 11, 0, 0, TimeSpan.FromHours(9))
        });
        project.Requests.Add(new() { Method = "GET", Url = "https://shop.example.test/login", StatusCode = 200, Role = "未認証",
            ObservedAt = new(2026, 10, 22, 8, 0, 0, TimeSpan.FromHours(9)) });
        project.Candidates.Add(new()
        {
            Selected = false, Decision = "対象外", Reason = "静的アセットのため能動診断対象外",
            Representative = new() { Method = "GET", Url = "https://shop.example.test/assets/site.css", StatusCode = 200 }
        });

        var generatedAt = new DateTimeOffset(2026, 10, 23, 12, 0, 0, TimeSpan.FromHours(9));
        var report = await new ReportDocumentV2Builder().BuildAsync(project, generatedAt);
        var serialized = JsonSerializer.Serialize(report);
        Assert.Equal("scopepilot-assurance-ja-v2", report.TemplateId);
        Assert.Equal("High", report.Summary.HighestSeverity);
        Assert.Equal(1, report.Summary.SeverityCounts["High"]);
        Assert.Equal(1, report.Summary.ValidationCounts["確認済み"]);
        Assert.Contains(report.Findings, x => x.Id == "F-ACCOUNT-001" && x.ValidationStatus == "確認済み");
        var zapFinding = Assert.Single(report.Findings, x => x.Source == "ZAP");
        Assert.Contains("CWE-693", zapFinding.CweIds);
        Assert.Contains("OWASP Top 10 2021 A05", zapFinding.GuidelineReferences.Single());
        Assert.Contains("CVE-2026-12345", zapFinding.CveIds);
        Assert.Contains("POST /login?token=", zapFinding.TechnicalEvidence.Request);
        Assert.Contains("伏せ字", zapFinding.TechnicalEvidence.Request);
        Assert.Contains("Authorization: [伏せ字]", zapFinding.TechnicalEvidence.Request);
        Assert.DoesNotContain("person@example.test", zapFinding.TechnicalEvidence.Response);
        Assert.Contains("[伏せ字]", report.Findings.Single(x => x.Id == "F-ACCOUNT-001").Reproduction.Actual);
        Assert.DoesNotContain("QUERY_SECRET", serialized);
        Assert.DoesNotContain("RAW_AUTH_SECRET", serialized);
        Assert.DoesNotContain("RAW_COOKIE_SECRET", serialized);
        Assert.DoesNotContain("RAW_PASSWORD", serialized);
        Assert.DoesNotContain("person@example.test", serialized);
        Assert.Contains(report.Evidence, x => x.Sha256 == evidence.Sha256 && x.RelatedFindingIds.Count > 0);
        Assert.Contains(ReportDocumentV2Builder.AutomatedAssessmentAssumption, report.Assessment.Assumptions);
        Assert.Contains("設定変更", report.Assessment.ForbiddenActions);
        Assert.Equal(new DateTimeOffset(2026, 10, 22, 8, 0, 0, TimeSpan.FromHours(9)), report.Assessment.StartedAt);
        Assert.Contains("認証セッション（Cookie観測）", report.Assessment.Roles);
        Assert.Contains(report.Coverage, x => x.ControlId == "SCOPE-001" && x.Targets.Any(y => y.Contains("HTTP 200")));
        Assert.Contains(report.Coverage, x => x.ControlId == "SCOPE-EXCLUDED" && x.Targets.Any(y => y.Contains("静的アセット")));

        var output = ProjectPaths.Resolve(project, "reports/qa/report-v2.docx");
        await new AssuranceWordReportService().WriteAsync(report, output);
        using var document = WordprocessingDocument.Open(output, false);
        var errors = new OpenXmlValidator().Validate(document).ToArray();
        Assert.True(errors.Length == 0, string.Join("\n", errors.Select(x => x.Description + " at " + x.Path?.XPath)));
        var body = document.MainDocumentPart!.Document!.Body!;
        Assert.Contains("Web アプリケーション脆弱性診断報告書", body.InnerText);
        Assert.Contains("10  特記事項", body.InnerText);
        Assert.Contains("F-ACCOUNT-001", body.InnerText);
        Assert.Contains("診断時に収集したHTTP証跡", body.InnerText);
        Assert.Contains("Request", body.InnerText);
        Assert.Contains("Response", body.InnerText);
        Assert.DoesNotContain("RAW_AUTH_SECRET", body.InnerText);
        Assert.NotNull(body.GetFirstChild<W.SectionProperties>()?.GetFirstChild<W.TitlePage>());
    }

    [Fact]
    public async Task FindingExportWritesMarkdownStructuredJsonAndV2WordTogether()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.Name = "統合出力確認";
        project.StartUrl = "https://example.test";
        await new ProjectStore().SaveAsync(project);
        project.Findings.Add(new() { FindingId = "F-001", Title = "確認事項", Severity = "low", Status = "要確認", Description = "担当者確認が必要です。" });

        var result = await new FindingReportService().ExportAsync(project);

        Assert.True(File.Exists(result.MarkdownPath));
        Assert.True(File.Exists(result.StructuredReportPath));
        Assert.True(File.Exists(result.WordReportPath));
        using var json = JsonDocument.Parse(await File.ReadAllTextAsync(result.StructuredReportPath));
        Assert.Equal("2", json.RootElement.GetProperty("FormatVersion").GetString());
        Assert.Equal("scopepilot-assurance-ja-v2", json.RootElement.GetProperty("TemplateId").GetString());
        using var word = WordprocessingDocument.Open(result.WordReportPath, false);
        var errors = new OpenXmlValidator().Validate(word).ToArray();
        Assert.True(errors.Length == 0, string.Join("\n", errors.Select(x => x.Description + " at " + x.Path?.XPath)));
    }

    [Fact]
    public async Task WritesReviewableV2SampleWhenArtifactsDirectoryIsProvided()
    {
        var directory = Environment.GetEnvironmentVariable("SCOPEPILOT_REPORT_V2_QA");
        if (string.IsNullOrWhiteSpace(directory)) return;
        Directory.CreateDirectory(directory);
        var project = new EngagementProject
        {
            ProjectFilePath = Path.Combine(directory, "sample.scopepilot.json"), Name = "架空予約サービス診断",
            StartUrl = "https://booking.example.test", AllowedOrigins = "https://booking.example.test", Roles = "未認証\n一般ユーザー\n管理者",
            Report = new()
            {
                SystemName = "架空予約サービス", ClientName = "サンプル株式会社", ServiceProvider = "ScopePilot セキュリティチーム",
                Author = "診断担当者", Reviewer = "レビュー担当者", Classification = "関係者限定",
                Conclusion = "確認済み指摘1件と追加確認が必要な警告1件があります。確認済み指摘を優先して対応してください。",
                Priorities = "F-001のアクセス制御を修正する\n修正後に一般ユーザーと管理者で再診断する",
                MajorLimitations = "決済操作と通知送信は実施していません。"
            }
        };
        await new ProjectStore().SaveAsync(project);
        project.Requests.Add(new() { Url = "https://booking.example.test/login", PageTitle = "ログイン", Role = "未認証", StatusCode = 200 });
        project.Requests.Add(new() { Url = "https://booking.example.test/reservations", PageTitle = "予約一覧", Role = "一般ユーザー", StatusCode = 200 });
        var zapPath = ProjectPaths.Resolve(project, "inputs/zap-fixture.json");
        Directory.CreateDirectory(Path.GetDirectoryName(zapPath)!);
        await File.WriteAllTextAsync(zapPath, """
        {"site":[{"alerts":[{"pluginid":"10038","name":"Content Security Policy Header Not Set","riskcode":"2","confidence":"3",
          "cweid":"693","desc":"<p>Content-Security-Policyヘッダーが応答に設定されていません。</p>",
          "solution":"<p>必要な配信元だけを許可するContent-Security-Policyヘッダーを設定してください。</p>",
          "reference":"https://owasp.org/www-project-secure-headers/","instances":[{
            "uri":"https://booking.example.test/login?session=SAMPLE_SECRET","method":"GET","param":"session","attack":"unsafe-inline",
            "evidence":"Content-Security-Policy header not found","otherinfo":"外部サービスへの通信は観測されませんでした。",
            "request-header":"GET /login?session=SAMPLE_SECRET HTTP/1.1\r\nHost: booking.example.test\r\nCookie: sid=SAMPLE_SECRET\r\nAccept: text/html\r\n",
            "request-body":"","response-header":"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nSet-Cookie: sid=SAMPLE_SECRET\r\n",
            "response-body":"<html><body><h1>ログイン</h1><p>user@example.test</p></body></html>"}]}]}]}
        """);
        var zapEvidence = await ProjectPaths.EvidenceAsync(project, zapPath, "zap-report", "/site/0/alerts/0/instances/0");
        project.DiagnosticObservations.Add(new()
        {
            Tool = "ZAP", RuleId = "10038", Title = "Content Security Policy Header Not Set", Severity = "2", Confidence = "3",
            Url = "https://booking.example.test/login?session=SAMPLE_SECRET", Method = "GET", Role = "未認証", Evidence = zapEvidence
        });
        project.Findings.Add(new()
        {
            FindingId = "F-001", Title = "他利用者の予約情報を参照できる", Category = "認証・認可", Severity = "high",
            Confidence = "高", Status = "確認済み", Description = "予約IDを変更すると、別利用者の予約情報が表示されました。",
            Evidence = "GET /reservations/102 HTTP/1.1\nAuthorization: Bearer SAMPLE_SECRET",
            AffectedUrls = "https://booking.example.test/reservations/102", GuidelineBasis = "OWASP Top 10 A01 / WSTG-ATHZ-04",
            Limitations = "更新・削除操作は実施していません。"
        });
        var result = await new FindingReportService(directory).ExportAsync(project);
        File.Copy(result.WordReportPath, Path.Combine(directory, "ScopePilot-v2-QA.docx"), true);
        File.Copy(result.StructuredReportPath, Path.Combine(directory, "ScopePilot-v2-QA.json"), true);
    }
}
