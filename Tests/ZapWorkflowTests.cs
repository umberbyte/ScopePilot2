using System.IO;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class ZapWorkflowTests
{
    private static async Task<EngagementProject> CapturedProject(TestFolder temp)
    {
        var project = temp.Project();
        project.Candidates.Add(new() { Selected = true, Pattern = "GET https://example.test/api", Representative = new() { Url = "https://example.test/api" } });
        var file = Path.Combine(temp.Path, "capture.har");
        await File.WriteAllTextAsync(file, """
        {"log":{"entries":[
          {"request":{"method":"GET","url":"https://example.test/api"},"response":{"status":200,"content":{"mimeType":"application/json","text":"{}"}}},
          {"request":{"method":"GET","url":"https://example.test/ignored"},"response":{"status":200}},
          {"request":{"method":"GET","url":"https://outside.test/api"},"response":{"status":200}},
          {"request":{"method":"GET","url":"https://example.test/api"},"response":{"status":0}}
        ]}}
        """);
        project.Inputs.Add((await ProjectPaths.ImportAsync(project, file, "har")) with { Role = project.ActiveRole });
        return project;
    }

    [Fact]
    public async Task PassivePlanContainsOnlyAdoptedRecordedTrafficAndPortablePaths()
    {
        using var temp = new TestFolder();
        var project = await CapturedProject(temp);
        var package = await new ZapHandoffService().BuildAsync(project);
        Assert.Equal(1, package.MessageCount);
        var plan = await File.ReadAllTextAsync(package.PlanPath);
        Assert.Contains("type: har", plan);
        Assert.DoesNotContain("sendRequests:", plan);
        Assert.Contains("passiveScan-wait", plan);
        Assert.DoesNotContain("activeScan", plan);
        Assert.DoesNotContain("spider", plan);
        Assert.DoesNotContain("requestor", plan);
        Assert.DoesNotContain(ProjectPaths.Root(project), plan);
        var har = await File.ReadAllTextAsync(package.HarPath);
        Assert.DoesNotContain("outside.test", har);
        Assert.DoesNotContain("ignored", har);
        Assert.Equal("ZAP", Assert.Single(await new RunHistoryService().ListAsync(project)).Tool);
    }

    [Fact]
    public async Task ActivePlanIsExplicitScopedConservativeAndRequiresPerRunAcknowledgement()
    {
        using var temp = new TestFolder();
        var project = await CapturedProject(temp);
        project.DiagnosticTools.EnableZapActiveScan = true;
        project.Candidates.Add(new()
        {
            Selected = true, Pattern = "GET https://example.test/not-recorded",
            Representative = new() { Url = "https://example.test/not-recorded" }
        });
        project.DiagnosticTools.ZapJarPath = Path.Combine(temp.Path, "zap.jar");
        project.DiagnosticTools.JavaPath = Path.Combine(temp.Path, "java.exe");
        await File.WriteAllTextAsync(project.DiagnosticTools.ZapJarPath, "test stub");
        await File.WriteAllTextAsync(project.DiagnosticTools.JavaPath, "test stub");
        var package = await new ZapHandoffService().BuildAsync(project);
        Assert.True(package.ActiveScan);
        Assert.Equal("zap-active.yaml", Path.GetFileName(package.PlanPath));
        var plan = await File.ReadAllTextAsync(package.PlanPath);
        Assert.Contains("type: activeScan", plan);
        Assert.Contains("url: \"https://example.test/api\"", plan);
        Assert.Contains("'^https://example\\.test/api(?:\\?.*)?$'", plan);
        Assert.Contains("defaultStrength: Low", plan);
        Assert.Contains("defaultThreshold: Medium", plan);
        Assert.Contains("delayInMs: 100", plan);
        Assert.Contains("threadPerHost: 1", plan);
        Assert.Contains("maxAlertsPerRule: 10", plan);
        Assert.DoesNotContain("outside.test", plan);
        Assert.DoesNotContain("not-recorded", plan);
        Assert.DoesNotContain("type: spider", plan);
        Assert.DoesNotContain("type: requestor", plan);
        Assert.DoesNotContain("type: replacer", plan);

        var calls = 0;
        var runner = new ZapCliRunner(async (_, p, _, action, _, _, _) =>
        {
            calls++;
            if (action == "-autorun")
                await File.WriteAllTextAsync(Path.Combine(p.Directory, "reports", "zap-report.json"), "{\"site\":[]}");
            return 0;
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            runner.RunAsync(project, package, null, CancellationToken.None));
        Assert.Equal(0, calls);
        Assert.False(File.Exists(Path.Combine(package.Directory, "zap-active-authorization.json")));

        var result = await runner.RunAsync(project, package, null, CancellationToken.None, activeScanAcknowledged: true);
        Assert.Equal("completed", result.Status);
        Assert.Equal(2, calls);
        var authorization = await File.ReadAllTextAsync(Path.Combine(package.Directory, "zap-active-authorization.json"));
        Assert.Contains("interactive-ACTIVE", authorization);
        Assert.Contains("https://example.test/api", authorization);
    }

    [Fact]
    public async Task ActiveScanSettingsPropagateToPlanAndAuthorization()
    {
        using var temp = new TestFolder();
        var project = await CapturedProject(temp);
        project.DiagnosticTools.EnableZapActiveScan = true;
        project.DiagnosticTools.ActiveScanStrength = "Medium";
        project.DiagnosticTools.ActiveScanThreshold = "Low";
        project.DiagnosticTools.ZapJarPath = Path.Combine(temp.Path, "zap.jar");
        project.DiagnosticTools.JavaPath = Path.Combine(temp.Path, "java.exe");
        await File.WriteAllTextAsync(project.DiagnosticTools.ZapJarPath, "test stub");
        await File.WriteAllTextAsync(project.DiagnosticTools.JavaPath, "test stub");
        var package = await new ZapHandoffService().BuildAsync(project);
        var plan = await File.ReadAllTextAsync(package.PlanPath);
        Assert.Contains("defaultStrength: Medium", plan);
        Assert.Contains("defaultThreshold: Low", plan);
        Assert.DoesNotContain("type: replacer", plan);
        var runner = new ZapCliRunner(async (_, p, _, action, _, _, _) =>
        {
            if (action == "-autorun")
                await File.WriteAllTextAsync(Path.Combine(p.Directory, "reports", "zap-report.json"), "{\"site\":[]}");
            return 0;
        });
        var result = await runner.RunAsync(project, package, null, CancellationToken.None, activeScanAcknowledged: true);
        Assert.Equal("completed", result.Status);
        var authorization = await File.ReadAllTextAsync(Path.Combine(package.Directory, "zap-active-authorization.json"));
        Assert.Contains("\"strength\": \"Medium\"", authorization);
        Assert.Contains("\"threshold\": \"Low\"", authorization);
    }

    [Fact]
    public async Task ScanTuningPropagatesToPlanAndAuthorization()
    {
        using var temp = new TestFolder();
        var project = await CapturedProject(temp);
        project.DiagnosticTools.EnableZapActiveScan = true;
        project.DiagnosticTools.ZapJarPath = Path.Combine(temp.Path, "zap.jar");
        project.DiagnosticTools.JavaPath = Path.Combine(temp.Path, "java.exe");
        await File.WriteAllTextAsync(project.DiagnosticTools.ZapJarPath, "test stub");
        await File.WriteAllTextAsync(project.DiagnosticTools.JavaPath, "test stub");
        var tuning = new ZapScanTuning(5, 50, 250, 2, ScanHeadersAllRequests: true, AddQueryParam: true);
        var package = await new ZapHandoffService().BuildAsync(project, tuning);
        var plan = await File.ReadAllTextAsync(package.PlanPath);
        Assert.Contains("maxRuleDurationInMins: 5", plan);
        Assert.Contains("maxAlertsPerRule: 50", plan);
        Assert.Contains("delayInMs: 250", plan);
        Assert.Contains("threadPerHost: 2", plan);
        Assert.Contains("scanHeadersAllRequests: true", plan);
        Assert.Contains("addQueryParam: true", plan);
        var runner = new ZapCliRunner(async (_, p, _, action, _, _, _) =>
        {
            if (action == "-autorun")
                await File.WriteAllTextAsync(Path.Combine(p.Directory, "reports", "zap-report.json"), "{\"site\":[]}");
            return 0;
        });
        var result = await runner.RunAsync(project, package, null, CancellationToken.None, activeScanAcknowledged: true, tuning);
        Assert.Equal("completed", result.Status);
        var authorization = await File.ReadAllTextAsync(Path.Combine(package.Directory, "zap-active-authorization.json"));
        Assert.Contains("\"maxRuleDurationInMins\": 5", authorization);
        Assert.Contains("\"delayInMs\": 250", authorization);
        Assert.Contains("\"threadPerHost\": 2", authorization);
        // 範囲外の値は正規化される。
        var clamped = new ZapScanTuning(99, 0, -5, 9, false, false).Normalized();
        Assert.Equal(new ZapScanTuning(10, 10, 0, 4, false, false), clamped);
    }

    [Fact]
    public async Task MaxTargetsIsConfigurableAndStillEnforced()
    {
        using var temp = new TestFolder();
        var project = await CapturedProject(temp);
        project.DiagnosticTools.EnableZapActiveScan = true;
        project.Candidates.Add(new() { Selected = true, Pattern = "GET https://example.test/api2", Representative = new() { Url = "https://example.test/api2" } });
        var file = Path.Combine(temp.Path, "two.har");
        await File.WriteAllTextAsync(file, """
        {"log":{"entries":[
          {"request":{"method":"GET","url":"https://example.test/api","headers":[{"name":"Cookie","value":"a=1"}]},"response":{"status":200}},
          {"request":{"method":"GET","url":"https://example.test/api2","headers":[{"name":"Cookie","value":"a=1; b=2"}]},"response":{"status":200}}
        ]}}
        """);
        project.Inputs.Add((await ProjectPaths.ImportAsync(project, file, "har")) with { Role = project.ActiveRole });
        project.DiagnosticTools.MaxActiveScanTargets = 1;
        await Assert.ThrowsAsync<InvalidOperationException>(() => new ZapHandoffService().BuildAsync(project));
        project.DiagnosticTools.MaxActiveScanTargets = 2;
        var package = await new ZapHandoffService().BuildAsync(project);
        Assert.Equal(2, package.RecordedTargets.Count);
    }

    [Fact]
    public async Task ReferenceHarsAreOptIn()
    {
        using var temp = new TestFolder();
        var project = await CapturedProject(temp);
        project.Candidates.Add(new() { Selected = true, Pattern = "GET https://example.test/from-proxy", Representative = new() { Url = "https://example.test/from-proxy" } });
        var file = Path.Combine(temp.Path, "reference.har");
        await File.WriteAllTextAsync(file, """
        {"log":{"entries":[
          {"request":{"method":"GET","url":"https://example.test/from-proxy"},"response":{"status":200}}
        ]}}
        """);
        project.Inputs.Add((await ProjectPaths.ImportAsync(project, file, "har")) with { Role = project.ActiveRole, Kind = "har-reference" });
        var excluded = await new ZapHandoffService().BuildAsync(project);
        Assert.Equal(1, excluded.MessageCount);
        project.DiagnosticTools.IncludeReferenceHars = true;
        var included = await new ZapHandoffService().BuildAsync(project);
        Assert.Equal(2, included.MessageCount);
        Assert.Contains("https://example.test/from-proxy", included.RecordedTargets);
    }

    [Fact]
    public void CookieScopeMatchesWholeUrlsUnderZapFullMatchSemantics()
    {
        var scope = ZapHandoffService.BuildCookieScope(["https://Example.test/vulnerabilities/sqli/?id=1"]);
        var pattern = "\\A(?:" + scope[1..^1] + ")\\z";
        Assert.Matches(pattern, "https://example.test/vulnerabilities/sqli/?id=1");
        Assert.Matches(pattern, "https://example.test/");
        Assert.Matches(pattern, "https://example.test");
        Assert.DoesNotMatch(pattern, "https://other.test/x");
        Assert.DoesNotMatch(pattern, "https://example.test.evil.test/x");
    }

    [Fact]
    public async Task RecordedAuthenticationInjectsSessionCookieAndVerifiesBeforeExecution()
    {
        using var temp = new TestFolder();
        var project = await CapturedProject(temp);
        project.AfterAuthenticationUrl = "https://example.test/api";
        project.DiagnosticTools.EnableZapActiveScan = true;
        project.DiagnosticTools.UseRecordedAuthentication = true;
        project.DiagnosticTools.ZapJarPath = Path.Combine(temp.Path, "zap.jar");
        project.DiagnosticTools.JavaPath = Path.Combine(temp.Path, "java.exe");
        await File.WriteAllTextAsync(project.DiagnosticTools.ZapJarPath, "test stub");
        await File.WriteAllTextAsync(project.DiagnosticTools.JavaPath, "test stub");
        var file = Path.Combine(temp.Path, "auth.har");
        await File.WriteAllTextAsync(file, """
        {"log":{"entries":[
          {"request":{"method":"GET","url":"https://example.test/api","headers":[{"name":"Cookie","value":"fixtureSession=secret-value; pref=dark"}]},"response":{"status":200}}
        ]}}
        """);
        project.Inputs.Add((await ProjectPaths.ImportAsync(project, file, "har")) with { Role = project.ActiveRole });
        var package = await new ZapHandoffService().BuildAsync(project);
        Assert.True(package.UseRecordedAuthentication);
        Assert.Equal(new[] { "fixtureSession", "pref" }, package.AuthCookieNames);
        var plan = await File.ReadAllTextAsync(package.PlanPath);
        Assert.Contains("type: replacer", plan);
        Assert.Contains("scopepilot-session-cookie", plan);
        Assert.Contains("matchType: req_header", plan);
        Assert.Contains("url: \"^(?:https://example\\\\.test)(?:[/:?#].*)?$\"", plan);
        Assert.Contains("fixtureSession=secret-value; pref=dark", plan);

        var calls = 0;
        var verifications = 0;
        var runner = new ZapCliRunner(async (_, p, _, action, _, _, _) =>
        {
            calls++;
            if (action == "-autorun")
                await File.WriteAllTextAsync(Path.Combine(p.Directory, "reports", "zap-report.json"), "{\"site\":[]}");
            return 0;
        }, (_, _, _) =>
        {
            verifications++;
            return Task.FromResult(new ZapAuthVerification("https://example.test/api", "https://example.test/api", 200, true, "認証後ページに到達できました。"));
        });
        var result = await runner.RunAsync(project, package, null, CancellationToken.None, activeScanAcknowledged: true);
        Assert.Equal("completed", result.Status);
        Assert.Equal(1, verifications);
        var authorization = await File.ReadAllTextAsync(Path.Combine(package.Directory, "zap-active-authorization.json"));
        Assert.Contains("fixtureSession", authorization);
        Assert.DoesNotContain("secret-value", authorization);
        Assert.Contains("\"verified\": true", authorization);

        var refusing = new ZapCliRunner((_, _, _, _, _, _, _) => throw new InvalidOperationException("must not run"),
            (_, _, _) => Task.FromResult(new ZapAuthVerification("https://example.test/api", "https://example.test/login.php", 302, false, "ログイン画面へリダイレクトされました。")));
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            refusing.RunAsync(project, package, null, CancellationToken.None, activeScanAcknowledged: true));
        Assert.Equal(2, calls);
        Assert.False(File.Exists(Path.Combine(package.Directory, "zap-run.log")));
    }

    [Fact]
    public async Task DraftsDoNotCreateSyntheticResponsesAndOtherRolesAreExcluded()
    {
        using var temp = new TestFolder();
        var project = await CapturedProject(temp);
        project.Mode = InputMode.ApiDocument;
        project.ApiRequests.Add(new() { Selected = true, Url = "https://example.test/api" });
        project.ActiveRole = "管理者";
        var package = await new ZapHandoffService().BuildAsync(project);
        Assert.Equal(0, package.MessageCount);
        Assert.False(File.Exists(package.PlanPath));
        Assert.True(File.Exists(Path.Combine(package.Directory, "requests", "0001.http")));
        await Assert.ThrowsAsync<InvalidOperationException>(() => new ZapCliRunner().RunAsync(project, package, null, CancellationToken.None));
    }

    [Fact]
    public async Task AlteredInputIsRejectedBeforePackageGeneration()
    {
        using var temp = new TestFolder();
        var project = await CapturedProject(temp);
        await File.AppendAllTextAsync(ProjectPaths.Resolve(project, project.Inputs[0].LocalPath), " ");
        await Assert.ThrowsAsync<InvalidDataException>(() => new ZapHandoffService().BuildAsync(project));
    }

    [Theory]
    [InlineData(0, "completed")]
    [InlineData(2, "warnings")]
    [InlineData(1, "failed")]
    public async Task CliValidationPrecedesExecutionAndWarningsRemainDistinct(int exitCode, string expected)
    {
        using var temp = new TestFolder();
        var project = await CapturedProject(temp);
        project.DiagnosticTools.ZapJarPath = Path.Combine(temp.Path, "zap.jar");
        project.DiagnosticTools.JavaPath = Path.Combine(temp.Path, "java.exe");
        await File.WriteAllTextAsync(project.DiagnosticTools.ZapJarPath, "test stub");
        await File.WriteAllTextAsync(project.DiagnosticTools.JavaPath, "test stub");
        var package = await new ZapHandoffService().BuildAsync(project);
        var actions = new List<string>();
        var runner = new ZapCliRunner(async (_, p, _, action, _, _, _) =>
        {
            actions.Add(action);
            if (action == "-autocheck") return 0;
            await File.WriteAllTextAsync(Path.Combine(p.Directory, "reports", "zap-report.json"), "{\"site\":[]}");
            return exitCode;
        });
        var result = await runner.RunAsync(project, package, null, CancellationToken.None);
        Assert.Equal(new[] { "-autocheck", "-autorun" }, actions);
        Assert.Equal(expected, result.Status);
        await File.AppendAllTextAsync(package.PlanPath, "\n- type: activeScan");
        await Assert.ThrowsAsync<InvalidDataException>(() => runner.RunAsync(project, package, null, CancellationToken.None));
        Assert.Equal(2, actions.Count);
    }

    [Fact]
    public async Task CancellationIsRecordedAndNoExecutionFollowsCancelledValidation()
    {
        using var temp = new TestFolder();
        var project = await CapturedProject(temp);
        project.DiagnosticTools.ZapJarPath = Path.Combine(temp.Path, "zap.jar");
        project.DiagnosticTools.JavaPath = Path.Combine(temp.Path, "java.exe");
        await File.WriteAllTextAsync(project.DiagnosticTools.ZapJarPath, "test stub");
        await File.WriteAllTextAsync(project.DiagnosticTools.JavaPath, "test stub");
        var package = await new ZapHandoffService().BuildAsync(project);
        using var token = new CancellationTokenSource();
        var runner = new ZapCliRunner((_, _, _, _, _, _, _) => { token.Cancel(); throw new OperationCanceledException(); });
        await Assert.ThrowsAsync<OperationCanceledException>(() => runner.RunAsync(project, package, null, token.Token));
        Assert.Contains("cancelled", await File.ReadAllTextAsync(Path.Combine(package.Directory, "zap-summary.json")));
    }

    [Fact]
    public void ZapOutputSummarizerReportsJobProgressTargetsAndErrors()
    {
        var summarizer = new ZapOutputSummarizer(["http://example.test/vulnerabilities/sqli/", "http://example.test/vulnerabilities/xss_r/"], reportJobProgress: true);
        Assert.Null(summarizer.Summarize("Job activeScan set url = http://example.test/vulnerabilities/sqli/"));
        Assert.Null(summarizer.Summarize(""));
        Assert.Equal("ZAP: 保存済み通信の取込を開始しました。", summarizer.Summarize("Job import started"));
        Assert.Equal("ZAP: 保存済み通信の取込を完了しました（所要 00:00:01）。", summarizer.Summarize("Job import finished, time taken: 00:00:01"));
        var running = summarizer.Summarize("Job activeScan started");
        Assert.Contains("アクティブ診断を実行中（1/2）", running);
        Assert.Contains("/vulnerabilities/sqli/", running);
        Assert.Contains("(1/2)", summarizer.Summarize("Job activeScan finished, time taken: 00:02:40"));
        Assert.Contains("(2/2)", summarizer.Summarize("Job activeScan started"));
        Assert.Equal(
            "ZAP: 診断ルールを実行中: PathTraversal（強度MEDIUM）",
            summarizer.Summarize("2026-10-12 13:33:30,786 [ZAP-ActiveScanner-0] DEBUG PathTraversalScanRule - Attacking at Attack Strength: MEDIUM"));
        var alertLine = summarizer.Summarize(
            "2026-10-12 13:33:29,489 [ZAP-PassiveScan-9] DEBUG ExtensionAlert - alertFound Content Security Policy (CSP) Header Not Set http://example.test/vulnerabilities/csp/");
        Assert.StartsWith("ZAP: 警告を検出: Content Security Policy (CSP) Header Not Set ", alertLine);
        Assert.Contains("/vulnerabilities/csp/", alertLine);
        Assert.StartsWith("ZAP: ", summarizer.Summarize("2026-10-12 13:33:31,000 [ZAP-PassiveScan-1] WARN  SqlScanRule - slow response"));
        Assert.Equal("ZAP: 計画の実行が完了しました。", summarizer.Summarize("Automation plan succeeded!"));
        Assert.StartsWith("ZAP: ", summarizer.Summarize("910 [main] ERROR org.parosproxy.paros - boom"));
        Assert.StartsWith("ZAP: [警告] ", summarizer.Summarize("910 [main] WARN  org.zaproxy.zap.extension.ascan - deprecated option"));
        Assert.Null(summarizer.Summarize("Defaulting ZAP install dir to C:\\Program Files\\ZAP"));
    }

    [Fact]
    public void ZapOutputSummarizerStaysQuietWhenProgressReportingIsOff()
    {
        var summarizer = new ZapOutputSummarizer(Array.Empty<string>(), reportJobProgress: false);
        Assert.Null(summarizer.Summarize("Job activeScan started"));
        Assert.Null(summarizer.Summarize("Job import finished, time taken: 00:00:01"));
        Assert.StartsWith("ZAP: ", summarizer.Summarize("910 [main] ERROR org.parosproxy.paros - boom"));
        Assert.Equal("ZAP: 計画の実行が完了しました。", summarizer.Summarize("Automation plan succeeded!"));
    }

    [Fact]
    public async Task ImportedAlertsAreUnconfirmedScopedDeduplicatedAndDoNotStoreRawSecrets()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        Directory.CreateDirectory(ProjectPaths.Category(project, "inputs"));
        var path = ProjectPaths.Resolve(project, "inputs/zap.json");
        await File.WriteAllTextAsync(path, """
        {"site":[{"alerts":[{"pluginid":"10020","name":"Missing header","riskcode":"1","confidence":"2","instances":[
          {"uri":"https://example.test/api?token=SECRET","method":"GET","param":"","attack":"SECRET","evidence":"SECRET"},
          {"uri":"https://outside.test/api","method":"GET"}]}]}]}
        """);
        var importer = new ZapResultImporter();
        Assert.Equal(1, await importer.ImportAsync(project, path));
        Assert.Equal(0, await importer.ImportAsync(project, path));
        var observation = Assert.Single(project.DiagnosticObservations);
        Assert.Equal(DiagnosisState.TargetAlertEffectUnconfirmed, observation.State);
        Assert.Equal("/site/0/alerts/0/instances/0", observation.Evidence.Pointer);
        Assert.DoesNotContain("SECRET", JsonSerializer.Serialize(observation));
        Assert.Empty(project.Findings);
        project.ActiveRole = "一般ユーザー";
        Assert.Equal(1, await importer.ImportAsync(project, path));
    }

}
