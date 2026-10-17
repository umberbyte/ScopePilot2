using System.IO;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class DocumentHintTests
{
    [Fact]
    public async Task Parse_KeepsOnlyAllowedOriginEndpoints_AndRecordsLimitations()
    {
        var project = Project();
        var sha = DocumentHintService.Sha256(project.ExplorationDocument.Content);
        var hints = await DocumentHintService.ParseAsync(HintJson(), project, sha);
        Assert.Equal("partial", hints.Status);
        var endpoint = Assert.Single(hints.Endpoints);
        Assert.Equal("https://example.test/admin/users", endpoint.Url);
        Assert.Equal("admin-page", endpoint.Kind);
        Assert.Equal("high", endpoint.Priority);
        Assert.Contains(hints.Limitations, x => x.Contains("許可Origin外"));
        Assert.Equal(new[] { "https://example.test/admin/users" }, DocumentHintService.CrawlTargets(hints));
        Assert.Equal(sha, hints.SourceSha256);
        Assert.True(DocumentHintService.IsUsable(hints, sha));
        Assert.False(DocumentHintService.IsUsable(hints, "different"));
        Assert.Single(hints.Authentication);
        Assert.Equal("管理者", hints.Authentication[0].Role);
        Assert.Single(hints.PriorityRules);
        Assert.Single(hints.ApiVariations);
        Assert.Contains("メンテ", hints.Notes[0]);
    }

    [Fact]
    public async Task Parse_RejectsInvalidStatus()
    {
        var project = Project();
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            DocumentHintService.ParseAsync(JsonSerializer.Serialize(new { status = "unknown", summary = "x",
                limitations = new string[0], endpoints = new object[0], authentication = new object[0],
                priorityRules = new object[0], apiVariations = new object[0], notes = new string[0] }), project, "sha"));
    }

    [Fact]
    public async Task Package_IncludesDocumentHintsAndCrawlTargets()
    {
        using var temp = new TempDirectory();
        var project = Project(Path.Combine(temp.Path, "project.scopepilot.json"));
        var sha = DocumentHintService.Sha256(project.ExplorationDocument.Content);
        project.ExplorationDocument.Hints = await DocumentHintService.ParseAsync(HintJson(), project, sha);
        project.ExplorationDocument.Hints.ExtractedBy = "Claude Code CLI（claude-sonnet-5-5・推論High）";
        var run = await new ExplorationPackageBuilder(temp.Path).BuildAsync(project);
        Assert.True(File.Exists(Path.Combine(run, DocumentHintService.RunFileName)));
        using var engagement = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(run, "engagement.json")));
        var documentHints = engagement.RootElement.GetProperty("documentHints");
        Assert.Equal("Claude Code CLI（claude-sonnet-5-5・推論High）", documentHints.GetProperty("extractedBy").GetString());
        var target = Assert.Single(documentHints.GetProperty("crawlTargets").EnumerateArray());
        Assert.Equal("https://example.test/admin/users", target.GetString());
        Assert.Single(documentHints.GetProperty("authentication").EnumerateArray());
        // 文書が変わってSHAが合わないヒントは同梱しない。
        project.ExplorationDocument.Content = "変更後の文書";
        var stale = await new ExplorationPackageBuilder(temp.Path).BuildAsync(project);
        using var staleEngagement = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(stale, "engagement.json")));
        Assert.True(staleEngagement.RootElement.TryGetProperty("documentHints", out var staleHints) &&
                    staleHints.ValueKind == JsonValueKind.Null);
        Assert.False(File.Exists(Path.Combine(stale, DocumentHintService.RunFileName)));
    }

    [Fact]
    public async Task AiInput_AppliesDocumentPriorityAndParameters_AndMarksUnobservedEndpoints()
    {
        using var temp = new TempDirectory();
        var run = Path.Combine(temp.Path, "run");
        Directory.CreateDirectory(run);
        await File.WriteAllTextAsync(Path.Combine(run, "engagement.json"), JsonSerializer.Serialize(new
        {
            StartUrl = "https://example.test/", activeRole = "未認証", allowedOrigins = new[] { "https://example.test" }
        }));
        await File.WriteAllLinesAsync(Path.Combine(run, "fast-observed-requests.jsonl"), new[]
        {
            JsonSerializer.Serialize(new { method = "GET", url = "https://example.test/about", statusCode = 200, contentType = "text/html", source = "PlaywrightFastCrawler", role = "未認証", pageTitle = "", observedAt = DateTimeOffset.Now }),
            JsonSerializer.Serialize(new { method = "GET", url = "https://example.test/profile", statusCode = 200, contentType = "text/html", source = "PlaywrightFastCrawler", role = "未認証", pageTitle = "", observedAt = DateTimeOffset.Now }),
            JsonSerializer.Serialize(new { method = "GET", url = "https://example.test/api/users", statusCode = 200, contentType = "application/json", source = "PlaywrightFastCrawler", role = "未認証", pageTitle = "", observedAt = DateTimeOffset.Now })
        });
        var project = Project();
        var sha = DocumentHintService.Sha256(project.ExplorationDocument.Content);
        await File.WriteAllTextAsync(Path.Combine(run, DocumentHintService.RunFileName),
            JsonSerializer.Serialize(await DocumentHintService.ParseAsync(HintJson(), project, sha)));

        var result = await new AiInputBuilder().BuildAsync(run);
        using var input = JsonDocument.Parse(await File.ReadAllTextAsync(result.Path));
        var patterns = input.RootElement.GetProperty("requestPatterns").EnumerateArray().ToArray();
        // 文書優先(高)の profile が通常パターンの前に来る。
        Assert.Equal("https://example.test/profile", patterns[0].GetProperty("representativeUrl").GetString());
        Assert.Equal("high", patterns[0].GetProperty("documentPriority").GetString());
        Assert.Contains(patterns[0].GetProperty("reasons").EnumerateArray(), x => x.GetString()!.Contains("文書優先"));
        var apiPattern = patterns.Single(x => x.GetProperty("representativeUrl").GetString() == "https://example.test/api/users");
        Assert.NotNull(apiPattern.TryGetProperty("documentParameters", out var parameters) && parameters.ValueKind is JsonValueKind.Object ? parameters : null);
        Assert.Equal("page", parameters.GetProperty("Parameters")[0].GetProperty("Name").GetString());
        var documentHints = input.RootElement.GetProperty("documentHints");
        var endpoint = Assert.Single(documentHints.GetProperty("endpoints").EnumerateArray());
        Assert.False(endpoint.GetProperty("observed").GetBoolean());
    }

    [Fact]
    public void HintRunner_StartInfo_ReflectsSelectedProviderModelAndReasoning()
    {
        var codex = DocumentHintRunner.CreateStartInfo(new CliLaunch("codex.exe", string.Empty), DocumentAiProvider.Codex, "run", "gpt-6-luna", AiReasoningLevel.Highest);
        Assert.Contains("--model", codex.ArgumentList);
        Assert.Contains("gpt-6-luna", codex.ArgumentList);
        Assert.Contains("model_reasoning_effort=\"xhigh\"", codex.ArgumentList);
        Assert.Equal(System.IO.Path.Combine("run", "hint-schema.json"), codex.ArgumentList[codex.ArgumentList.ToList().IndexOf("--output-schema") + 1]);
        Assert.Equal(System.IO.Path.Combine("run", "document-hints-result.json"), codex.ArgumentList[codex.ArgumentList.ToList().IndexOf("--output-last-message") + 1]);

        var claude = DocumentHintRunner.CreateStartInfo(new CliLaunch("claude.exe", string.Empty), DocumentAiProvider.Claude, "run", "claude-sonnet-5-5", AiReasoningLevel.Low);
        Assert.Contains("--safe-mode", claude.ArgumentList);
        Assert.Contains("claude-sonnet-5-5", claude.ArgumentList);
        Assert.Contains(DocumentHintService.Schema, claude.ArgumentList);
        Assert.Equal("1024", claude.EnvironmentVariables["MAX_THINKING_TOKENS"]);
        Assert.False(claude.EnvironmentVariables.ContainsKey("ANTHROPIC_BASE_URL"));

        // GLM（zcode）は添付プロンプトと分離設定で実行する。
        var glm = DocumentHintRunner.CreateStartInfo(new CliLaunch("node.exe", @"C:\npm\zcode.js"), DocumentAiProvider.Glm, "run", model: null, reasoning: AiReasoningLevel.Middle);
        Assert.Equal(@"C:\npm\zcode.js", glm.ArgumentList[0]);
        Assert.EndsWith("prompt.md", glm.ArgumentList.ToList()[glm.ArgumentList.ToList().IndexOf("--attach") + 1], StringComparison.Ordinal);
        Assert.Equal("account:zai-individual-coding-plan/GLM-5.3", glm.ArgumentList.ToList()[glm.ArgumentList.ToList().IndexOf("--model") + 1]);
        Assert.Contains("--disallowed-tools", glm.ArgumentList);
        Assert.Equal(Path.Combine("run", ApiDocumentAiRunner.ZcodeSettingsFileName), glm.EnvironmentVariables["ZCODE_CLI_SETTINGS_FILE"]);
    }

    [Fact]
    public void DocSelection_SupportsProviderModelAndReasoning_ForExplorationDocument()
    {
        var model = new ViewModels.MainViewModel();
        Assert.Equal(DocumentAiProvider.Codex, model.Project.ExplorationDocument.AiProvider);
        Assert.Equal(AiReasoningLevel.Middle, model.Project.ExplorationDocument.ReasoningLevel);
        model.DocProviderIndex = 1;
        Assert.Equal(DocumentAiProvider.Claude, model.Project.ExplorationDocument.AiProvider);
        Assert.Equal("claude-opus-5-5", model.Project.ExplorationDocument.Model);
        Assert.Equal(new[] { "Opus 5.5", "Sonnet 5.5", "Fable 5.1" }, model.DocModelOptions);
        model.DocModelIndex = 2;
        Assert.Equal("claude-fable-5-1", model.Project.ExplorationDocument.Model);
        model.DocReasoningIndex = 3;
        Assert.Equal(AiReasoningLevel.Low, model.Project.ExplorationDocument.ReasoningLevel);
        // 探索用ドキュメントのAI選択はAPIドキュメントモード側へ影響しない。
        Assert.Equal(DocumentAiProvider.Codex, model.Project.ApiDocument.Provider);
        Assert.Equal(string.Empty, model.Project.ApiDocument.Model);
    }

    private static EngagementProject Project(string filePath = "")
    {
        var project = new EngagementProject
        {
            ProjectFilePath = filePath, Name = "文書テスト", StartUrl = "https://example.test/",
            AllowedOrigins = "https://example.test",
            ExplorationDocument = new ExplorationDocumentSettings { FileName = "spec.md", Content = "仕様書の内容" }
        };
        return project;
    }

    private static string HintJson() => JsonSerializer.Serialize(new
    {
        status = "partial", summary = "抽出しました", limitations = new[] { "一部未読" },
        endpoints = new object[]
        {
            new { url = "https://example.test/admin/users", kind = "admin-page", priority = "high", reason = "ユーザー管理画面", sourceReference = "#/3.1" },
            new { url = "https://outside.test/api", kind = "api", priority = "normal", reason = "範囲外", sourceReference = "#/4" },
            new { url = "relative/path", kind = "api", priority = "normal", reason = "相対パス", sourceReference = "#/5" }
        },
        authentication = new[] { new { role = "管理者", method = "フォーム認証", location = "§2", note = "初期アカウントの記載あり", sourceReference = "#/2" } },
        priorityRules = new[] { new { category = "個人情報", keywords = new[] { "profile" }, priority = "high", note = "機微な情報" } },
        apiVariations = new[] { new { endpoint = "https://example.test/api/users",
            parameters = new object[] { new { name = "page", example = "1", required = false } }, sourceReference = "#/6" } },
        notes = new[] { "メンテナンス時間の記載あり" }
    });

    private sealed class TempDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ScopePilot.Tests", Guid.NewGuid().ToString("N"));
        public TempDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() { if (Directory.Exists(Path)) Directory.Delete(Path, true); }
    }
}
