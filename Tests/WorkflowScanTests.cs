using System.IO;
using ScopePilot.Domain;
using ScopePilot.Services;
using ScopePilot.Services.Reports;
using ScopePilot.Services.WorkflowScan;
using Xunit;
using static ScopePilot.Tests.WorkflowScanTestHelpers;

namespace ScopePilot.Tests;

public static class WorkflowScanTestHelpers
{
    // DVWA回帰テスト用の案件。対象は FakeDvwaServer のベースURL。
    public static EngagementProject NewProject(string baseUrl)
    {
        var root = Path.Combine(Path.GetTempPath(), "scopepilot-workflow-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return new EngagementProject
        {
            Name = "DVWA回帰",
            StartUrl = baseUrl,
            AllowedOrigins = baseUrl,
            ProjectFilePath = Path.Combine(root, "test.scopepilot.json"),
            MaxRequests = 5000,
            MaxMinutes = 60,
            Roles = "未認証\n認証ユーザー",
            ActiveRole = "認証ユーザー"
        };
    }
}

// DVWAが意図して含む18分類の脆弱性（docs/DVWA-INTENTIONAL-VULNERABILITIES.md）を
// ワークフロー診断が取りこぼしなく検出できることを確認する回帰テスト。
public sealed class WorkflowScanTests
{
    // DVWA-DETECTION-GAP-ANALYSIS.md の検出漏れ12分類＋部分漏れ2分類＋セクション5の副ギャップに対応するチェックID。
    private static readonly string[] ExpectedCheckIds =
    [
        "brute-force",             // ブルートフォース対策の不備 (CWE-307)
        "csrf-password",           // CSRF (CWE-352)
        "file-upload",             // 無制限・危険なファイルアップロード (CWE-434)
        "captcha-bypass",          // CAPTCHA迂回 (CWE-602/489)
        "weak-session",            // 推測可能なセッションID (CWE-330)
        "xss-reflected",           // XSS 反射型 (CWE-79)
        "xss-stored",              // XSS 格納型 (CWE-79)
        "xss-dom",                 // XSS DOM型 (CWE-79)
        "csp-bypass",              // CSP迂回 (CWE-693/79)
        "client-side-token",       // クライアント側制御への依存 (CWE-602)
        "authorization-bypass",    // 認可不備 (CWE-862)
        "bac-open-access",         // アクセス制御の不備 (CWE-862/639)
        "open-redirect",           // オープンリダイレクト (CWE-601)
        "crypto-xor",              // 反復XOR・固定鍵 (CWE-327/321)
        "crypto-ecb",              // ECBトークン改ざん (CWE-327)
        "crypto-cbc-oracle",       // CBCパディングオラクル (CWE-203)
        "api-legacy",              // 廃止APIの機微情報露出 (CWE-200)
        "api-mass-assignment",     // マスアサインメント (CWE-915)
        "api-command-injection",   // API経由のOSコマンドインジェクション (CWE-78)
        "sqli-verify",             // SQLインジェクションのURL単位確認 (CWE-89)
        "lfi"                      // ローカルファイルインクルージョン (CWE-98/22)
    ];

    [Fact]
    public async Task DetectsAllDvwaVulnerabilityCategories()
    {
        using var server = new FakeDvwaServer("admin", "SecretPass123");
        var project = NewProject(server.BaseUrl);
        var service = new WorkflowScanService();
        var result = await service.RunAsync(project, new WorkflowScanOptions(server.BaseUrl, "admin", "SecretPass123"));

        Assert.True(result.Authenticated);
        var detectedIds = result.Checks.Select(x => x.CheckId).ToHashSet();
        var missing = ExpectedCheckIds.Where(id => !detectedIds.Contains(id)).ToList();
        Assert.True(missing.Count == 0, $"未検出のチェック: {string.Join(", ", missing)}\n検出済み: {string.Join(", ", detectedIds)}");

        // レベル別に挙動が変わる暗号モジュール: XOR=low / ECB=medium / CBCオラクル=high
        Assert.Contains(result.Checks, x => x.CheckId == "crypto-xor" && x.SecurityLevel == "low");
        Assert.Contains(result.Checks, x => x.CheckId == "crypto-ecb" && x.SecurityLevel == "medium");
        Assert.Contains(result.Checks, x => x.CheckId == "crypto-cbc-oracle" && x.SecurityLevel == "high");

        // セッションIDの生成規則はレベルごとに判定される（連番・時刻・MD5連番）。
        var weakSessionLevels = result.Checks.Where(x => x.CheckId == "weak-session").Select(x => x.SecurityLevel).ToHashSet();
        Assert.Superset(weakSessionLevels, new HashSet<string> { "low", "medium", "high" });

        // LFI（ローカルファイル読取りの成立証拠）は全レベルで確認する。
        var lfiLevels = result.Checks.Where(x => x.CheckId == "lfi").Select(x => x.SecurityLevel).ToHashSet();
        Assert.Superset(lfiLevels, new HashSet<string> { "low", "medium", "high" });

        // SQLインジェクションはURL単位（通常型・ブラインド型）で確認する。
        var sqliUrls = result.Checks.Where(x => x.CheckId == "sqli-verify").Select(x => x.Url).ToHashSet();
        Assert.Contains(sqliUrls, url => url.Contains("vulnerabilities/sqli/") && !url.Contains("blind"));
        Assert.Contains(sqliUrls, url => url.Contains("sqli_blind"));

        // オープンリダイレクトは low/medium/high の各実装ファイルで確認する。
        Assert.Equal(3, result.Checks.Count(x => x.CheckId == "open-redirect"));

        // すべての所見が報告書に必要な内容を持つ。
        foreach (var check in result.Checks)
        {
            Assert.False(string.IsNullOrWhiteSpace(check.Title));
            Assert.False(string.IsNullOrWhiteSpace(check.Description));
            Assert.False(string.IsNullOrWhiteSpace(check.Evidence));
            Assert.False(string.IsNullOrWhiteSpace(check.Remediation));
            Assert.Contains(check.Severity, new[] { "重大", "高", "中", "低", "情報" });
            Assert.True(int.TryParse(check.Cwe, out _), $"CWE番号が数値でない: {check.Cwe}");
        }

        // 実行記録と証跡が案件フォルダーへ保存される。
        var runDirectory = ProjectPaths.Resolve(project, result.RunDirectory);
        Assert.True(Directory.Exists(runDirectory), $"run dir: {runDirectory}");
        Assert.True(File.Exists(Path.Combine(runDirectory, "workflow-scan.json")));
        Assert.True(File.Exists(Path.Combine(runDirectory, "engagement.json")));
        var engagement = await File.ReadAllTextAsync(Path.Combine(runDirectory, "engagement.json"));
        Assert.Contains("workflow-scan", engagement);

        // 認証情報は証跡ログへ露出しない。
        var evidenceLog = await File.ReadAllTextAsync(Path.Combine(runDirectory, "workflow-scan.json"));
        Assert.DoesNotContain("SecretPass123", evidenceLog);
        Assert.InRange(result.RequestCount, 100, 2000);
    }

    [Fact]
    public async Task RestoresSecurityLevelAfterScan()
    {
        using var server = new FakeDvwaServer("admin", "SecretPass123") { SecurityLevel = "medium" };
        var project = NewProject(server.BaseUrl);
        await new WorkflowScanService().RunAsync(project, new WorkflowScanOptions(server.BaseUrl, "admin", "SecretPass123"));
        Assert.Equal("medium", server.SecurityLevel);
    }

    [Fact]
    public async Task LoginFailureCompletesWithoutFindings()
    {
        using var server = new FakeDvwaServer("admin", "SecretPass123");
        var project = NewProject(server.BaseUrl);
        var result = await new WorkflowScanService().RunAsync(project, new WorkflowScanOptions(server.BaseUrl, "admin", "wrong-password"));
        Assert.False(result.Authenticated);
        Assert.Empty(result.Checks);
        Assert.True(server.LoginAttempted);
    }

    [Fact]
    public async Task RunHistoryRecognizesWorkflowScanMode()
    {
        using var server = new FakeDvwaServer("admin", "SecretPass123");
        var project = NewProject(server.BaseUrl);
        await new WorkflowScanService().RunAsync(project, new WorkflowScanOptions(server.BaseUrl, "admin", "SecretPass123"));
        var runs = await new RunHistoryService().ListAsync(project);
        var entry = runs.FirstOrDefault(x => x.Directory.Contains("workflow-", StringComparison.Ordinal));
        Assert.NotNull(entry);
        Assert.Equal("ScopePilot", entry!.Tool);
        Assert.Contains("ワークフロー診断", entry.StatusDisplay, StringComparison.Ordinal);
    }

    [Fact]
    public async Task FindingsFlowIntoDiagnosticReports()
    {
        using var server = new FakeDvwaServer("admin", "SecretPass123");
        var project = NewProject(server.BaseUrl);
        var result = await new WorkflowScanService().RunAsync(project, new WorkflowScanOptions(server.BaseUrl, "admin", "SecretPass123"));
        foreach (var check in result.Checks)
            project.Findings.Add(WorkflowScanFindingMapper.ToFinding(check, result.RunDirectory));

        var markdown = await new JapaneseDiagnosticReportService().BuildAsync(project, DateTimeOffset.Now);
        Assert.Contains("CSRF", markdown.Markdown);
        Assert.Contains("パディングオラクル", markdown.Markdown);
        Assert.Contains("マスアサインメント", markdown.Markdown);

        var document = await new ReportDocumentV2Builder().BuildAsync(project, DateTimeOffset.Now);
        var recorded = document.Findings.Where(x => x.Id.StartsWith("F-", StringComparison.Ordinal)).ToList();
        Assert.True(recorded.Count >= ExpectedCheckIds.Length, $"記録所見数: {recorded.Count}");
        Assert.Contains(recorded, x => x.Title.Contains("CSRF"));
        Assert.Contains(recorded, x => x.Title.Contains("ECB"));
        Assert.Contains(recorded, x => x.Title.Contains("セッションID"));
    }

    [Fact]
    public void SessionPatternAnalysisDetectsDvwaGenerationRules()
    {
        Assert.Equal("単純連番", WorkflowScanChecks.AnalyzeSessionPattern(["1", "2", "3", "4"])!.Value.Name);
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
        Assert.Equal("現在時刻", WorkflowScanChecks.AnalyzeSessionPattern([now, now, now])!.Value.Name);
        var md5of7 = Convert.ToHexString(System.Security.Cryptography.MD5.HashData("7"u8.ToArray())).ToLowerInvariant();
        Assert.Equal("連番のMD5（7）", WorkflowScanChecks.AnalyzeSessionPattern([md5of7, md5of7])!.Value.Name);
        Assert.Null(WorkflowScanChecks.AnalyzeSessionPattern(["xk29fja0w83", "pqq1zlm4vc9"]));
    }

    [Fact]
    public void RepeatingXorKeyIsRecoveredFromKnownPlaintext()
    {
        var key = "wachtwoord"u8.ToArray();
        var plain = "the password is Olifant and more text to cover the whole key"u8.ToArray();
        var cipher = new byte[plain.Length];
        for (var i = 0; i < plain.Length; i++) cipher[i] = (byte)(plain[i] ^ key[i % key.Length]);
        var stream = cipher.Zip(plain, (a, b) => (byte)(a ^ b)).ToArray();
        var recovered = WorkflowScanCryptoApiChecks.DetectRepeatingKey(stream);
        Assert.NotNull(recovered);
        Assert.Equal("wachtwoord", System.Text.Encoding.ASCII.GetString(recovered!));
        var randomBytes = new byte[64];
        Random.Shared.NextBytes(randomBytes);
        Assert.Null(WorkflowScanCryptoApiChecks.DetectRepeatingKey(randomBytes));
    }

    [Fact]
    public void DomSinkDetectionRequiresSourceAndSink()
    {
        Assert.NotNull(WorkflowScanChecks.FindDomSink("var lang = location.href.substring(10);\ndocument.write(lang);"));
        Assert.Null(WorkflowScanChecks.FindDomSink("document.write('static content');"));
        Assert.Null(WorkflowScanChecks.FindDomSink("var x = location.href;"));
    }

    [Fact]
    public void CspOriginParsingIgnoresSelfKeyword()
    {
        var origins = WorkflowScanChecks.ParseExternalScriptOrigins("script-src 'self' https://pastebin.com example.com cdn.jsdelivr.net;");
        Assert.Equal(3, origins.Count);
        Assert.Contains("https://pastebin.com", origins);
    }

    [Fact]
    public void ClientSideTokenCandidatesMatchDeliveredLogic()
    {
        var candidates = WorkflowScanChecks.ClientSideTokenCandidates("success");
        var md5 = Convert.ToHexString(System.Security.Cryptography.MD5.HashData("fhpprff"u8.ToArray())).ToLowerInvariant();
        Assert.Equal(md5, candidates[0]);                       // low: md5(rot13)
        Assert.Equal("XXsseccusXX", candidates[1]);              // medium: reverse(XX…XX)
        var inner = "XX" + new string("success".Reverse().ToArray());
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.ASCII.GetBytes(
                Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.ASCII.GetBytes(inner))).ToLowerInvariant() + "ZZ"))).ToLowerInvariant();
        Assert.Equal(sha, candidates[2]);                        // high: sha256(sha256(...)+ZZ)
    }

    [Fact]
    public void RedirectHostParsingHandlesProtocolRelativeUrls()
    {
        Assert.True(WorkflowScanChecks.TryGetHost("//scopepilot-check.invalid/x", out var host));
        Assert.Equal("scopepilot-check.invalid", host);
        Assert.True(WorkflowScanChecks.TryGetHost("https://evil.test/y", out var secureHost));
        Assert.Equal("evil.test", secureHost);
        Assert.False(WorkflowScanChecks.TryGetHost("login.php", out _));
    }

    [Fact]
    public void SensitiveJsonFieldFinderDetectsPasswordHashes()
    {
        var fields = WorkflowScanCryptoApiChecks.FindSensitiveJsonFields("""[{"id":1,"name":"tony","level":0,"password":"1c8bfe8f"}]""");
        Assert.Contains("password", fields);
        Assert.Empty(WorkflowScanCryptoApiChecks.FindSensitiveJsonFields("""[{"id":1,"name":"tony"}]"""));
    }
}
