using System.IO;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services;
using ScopePilot.ViewModels;
using Xunit;

namespace ScopePilot.Tests;

public sealed class AuthenticationFlowTests
{
    [Theory]
    [InlineData("http://192.168.0.27/login.php", "", false, false, true)]
    [InlineData("https://example.test/signin", "", false, false, true)]
    [InlineData("https://example.test/session", "", true, true, true)]
    [InlineData("https://example.test/auth", "サインイン", false, false, true)]
    [InlineData("https://example.test/change-password", "設定", true, false, false)]
    [InlineData("https://example.test/article", "account settings", false, false, false)]
    public void LoginHintsUsePathTitleAndInputTypesWithoutCredentials(string url, string title,
        bool password, bool user, bool expected) =>
        Assert.Equal(expected, AuthenticationFlow.LooksLikeLogin(url, title, password, user));

    [Fact]
    public async Task AuthenticationPageIsPassedToAiEvenWhenExcludedFromCandidateReview()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.DeferredCandidatePatterns.Add("GET https://example.test/login.php");
        var run = await new ExplorationPackageBuilder().BuildAsync(project);
        await File.WriteAllTextAsync(Path.Combine(run, "crawl-pages.jsonl"),
            "{\"url\":\"https://example.test/login.php\",\"title\":\"ログイン\",\"forms\":[{\"method\":\"POST\",\"action\":\"https://example.test/login.php\",\"fields\":[\"username\",\"password\"],\"hasPasswordField\":true,\"hasUserField\":true}]}\n");
        var input = await new AiInputBuilder().BuildAsync(run);
        Assert.True(input.RequiresAi);
        Assert.Equal(0, input.FormPatternCount);
        using var json = JsonDocument.Parse(await File.ReadAllTextAsync(input.Path));
        Assert.Equal("https://example.test/login.php", Assert.Single(json.RootElement.GetProperty("authenticationPages").EnumerateArray()).GetProperty("url").GetString());
    }

    [Fact]
    public async Task PromptIncludesAnonymousLoginAndPostLoginNavigationForBothProxies()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.AfterAuthenticationUrl = "https://example.test/dashboard";
        var run = await new ExplorationPackageBuilder().BuildAsync(project);
        await ExplorationPackageBuilder.ConfigureProxyPromptAsync(run, false);
        var prompt = await File.ReadAllTextAsync(Path.Combine(run, "prompt.md"));
        Assert.Contains("未認証を選択している場合も", prompt);
        Assert.Contains("ロールに関係なくユーザーに認証情報の入力を依頼", prompt);
        Assert.Contains("ユーザー名・パスワードを直接入力", prompt);
        Assert.Contains("再開ボタンはユーザーの操作完了の通知", prompt);
        Assert.Contains("ログイン前のai-input.jsonにない場合でも", prompt);
        Assert.Contains("認証後にブラウザを再起動したり", prompt);
        Assert.Contains("authentication-navigation.json", prompt);
        using var contract = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(run, "engagement.json")));
        Assert.Equal(project.AfterAuthenticationUrl, contract.RootElement.GetProperty("afterAuthenticationUrl").GetString());
        project.AfterAuthenticationUrl = "https://outside.test/dashboard";
        await Assert.ThrowsAsync<InvalidDataException>(() => new ExplorationPackageBuilder().BuildAsync(project));
    }

    [Fact]
    public void PartialAndRepeatedRequestsAreNotLostOrRepeatedButNewLoginFailureIsReported()
    {
        var inbox = new InterventionInbox();
        Assert.Null(inbox.Observe("{\"reason\":"));
        var first = Request("first");
        Assert.NotNull(inbox.Observe(first));
        Assert.Null(inbox.Observe(first));
        Assert.NotNull(inbox.Observe(Request("second", "ログインできませんでした")));
        inbox.Observe(null);
        Assert.NotNull(inbox.Observe(first));
    }

    [Fact]
    public void ResumeIsBoundToRequestAndSelectedAuthenticatedRoleWithoutCredentials()
    {
        using var temp = new TestFolder();
        var pending = Path.Combine(temp.Path, "human-intervention.json");
        File.WriteAllText(pending, Request("first"));
        Assert.Throws<InvalidDataException>(() => AuthenticationFlow.WriteResume(temp.Path, "未認証"));
        Assert.False(File.Exists(Path.Combine(temp.Path, "resume.signal")));
        AuthenticationFlow.WriteResume(temp.Path, "一般ユーザー");
        using var signal = JsonDocument.Parse(File.ReadAllText(Path.Combine(temp.Path, "resume.signal")));
        Assert.Equal("first", signal.RootElement.GetProperty("requestId").GetString());
        Assert.Equal("一般ユーザー", signal.RootElement.GetProperty("activeRole").GetString());
        Assert.True(signal.RootElement.GetProperty("verifyNavigation").GetBoolean());
        Assert.False(signal.RootElement.TryGetProperty("password", out _));
        File.WriteAllText(pending, Request("second"));
        AuthenticationFlow.WriteResume(temp.Path, "管理者");
        Assert.Contains("second", File.ReadAllText(Path.Combine(temp.Path, "resume.signal")));
    }

    [Theory]
    [InlineData("waiting", "https://example.test/login.php", true, "未確認")]
    [InlineData("authenticated", "https://example.test/login.php", true, "認証画面が残っています")]
    [InlineData("authenticated", "https://outside.test/dashboard", false, "許可Origin外")]
    [InlineData("authenticated", "https://example.test/profile", false, "未到達")]
    [InlineData("authenticated", "https://example.test/dashboard?token=SECRET", false, "認証後の到達先:")]
    public void ArrivalDisplaySeparatesPendingLoginOutOfScopeAndActualLanding(string status, string url, bool login, string expected)
    {
        var project = new EngagementProject { AllowedOrigins = "https://example.test", AfterAuthenticationUrl = "https://example.test/dashboard" };
        var text = AuthenticationFlow.FormatNavigation(JsonSerializer.Serialize(new { status, actualUrl = url, loginFormVisible = login, authenticatedIndicatorVisible = true }), project);
        Assert.Contains(expected, text);
        Assert.DoesNotContain("SECRET", text);
    }

    [Fact]
    public void ButtonConfirmationAndHiddenLoginFormWithoutPositiveIndicatorDoNotConfirmAuthentication()
    {
        var project = new EngagementProject { AllowedOrigins = "https://example.test" };
        Assert.Contains("未確認", AuthenticationFlow.FormatNavigation(
            "{\"status\":\"authenticated\",\"actualUrl\":\"https://example.test/login.php\",\"loginFormVisible\":false}", project));
    }

    [Fact]
    public void TargetPathCaseAndExplicitQueryMustMatchAndDisplayOmitsUrlCredentials()
    {
        var project = new EngagementProject { AllowedOrigins = "https://example.test", AfterAuthenticationUrl = "https://example.test/Dashboard?tab=users" };
        var record = new { status = "authenticated", actualUrl = "https://example.test/dashboard?tab=reports", loginFormVisible = false, authenticatedIndicatorVisible = true };
        Assert.Contains("未到達", AuthenticationFlow.FormatNavigation(JsonSerializer.Serialize(record), project));
        Assert.Equal("https://example.test/login.php", AuthenticationFlow.DisplayUrl("https://user:password@example.test/login.php?token=SECRET"));
    }

    [Fact]
    public void AuthenticationPromptAsksForDirectBrowserInputAndOffersAnAuthenticatedRole()
    {
        var vm = new MainViewModel();
        vm.UpdateRoleOptions();
        var shown = new List<string>();
        vm.ShowAuthenticationPrompt = shown.Add;
        vm.PrepareAuthenticationIntervention(Request("first"));
        Assert.True(vm.AuthenticationWaiting);
        Assert.False(AuthenticationFlow.IsAnonymous(vm.AuthenticationRole));
        Assert.Contains("探索ブラウザにユーザー名・パスワードを直接入力", Assert.Single(shown));
        Assert.Equal("ログイン後のページを確認して再開", vm.ResumeActionText);
    }

    private static string Request(string id, string reason = "認証が必要です") =>
        JsonSerializer.Serialize(new { requestId = id, kind = "authentication", reason, page = "https://example.test/login.php", instruction = "探索ブラウザへ入力してください。" });
}
