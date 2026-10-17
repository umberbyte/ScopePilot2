using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using ScopePilot.Domain;
using ScopePilot.Services;
using ScopePilot.ViewModels;
using Xunit;

namespace ScopePilot.Tests;

public sealed class ApiDocumentTests
{
    [Fact]
    public void GeneratedRequests_KeepBodySourceAndPlaceholders_WithoutObservedResponses()
    {
        var project = Project();
        var result = ApiDocumentService.ParseResult(ResultJson(), project, "run");
        var request = Assert.Single(result.Requests);
        Assert.Equal("https://api.example.test/v1/pets/42?expand=owner", request.Url);
        Assert.Equal("POST", request.Method);
        Assert.Contains("日本語", request.Body);
        Assert.Contains("paths", request.SourceReference);
        Assert.Contains("TOKEN", Assert.Single(request.UnresolvedValues));
        Assert.False(request.Selected);
        Assert.Empty(project.Requests);
        Assert.Empty(project.Findings);
        Assert.Equal("partial", result.Status);
    }

    [Theory]
    [InlineData("https://outside.example.test/pets")]
    [InlineData("//outside.example.test/pets")]
    [InlineData("/pets#fragment")]
    [InlineData("/pets\r\nInjected: x")]
    public void ModelOutput_RejectsNonRelativeOrMalformedPaths(string path) =>
        Assert.Throws<InvalidDataException>(() => ApiDocumentService.ParseResult(ResultJson(path), Project(), "run"));

    [Fact]
    public void ModelOutput_RejectsInjectedHeaderValues_AndExcessRequests()
    {
        Assert.Throws<InvalidDataException>(() => ApiDocumentService.ParseResult(ResultJson(headerValue: "x\r\nInjected: value"), Project(), "run"));
        var project = Project();
        project.MaxRequests = 1;
        Assert.Throws<InvalidDataException>(() => ApiDocumentService.ParseResult(ResultJson(count: 2), project, "run"));
    }

    [Fact]
    public async Task Export_UsesReviewedEditsAndUtf8Length_AndEnforcesCurrentScope()
    {
        using var temp = new TempDirectory();
        var project = Project();
        var request = Assert.Single(ApiDocumentService.ParseResult(ResultJson(), project, "run").Requests);
        project.ApiRequests.Add(request);
        var exporter = new ApiRequestExportService(temp.Path);
        await Assert.ThrowsAsync<InvalidOperationException>(() => exporter.ExportAsync(project));
        request.Selected = true;
        request.Body = "{\"name\":\"修正済み\"}";
        request.HeadersText += "\nContent-Length: 9999\nHost: wrong.example.test";
        var exported = await exporter.ExportAsync(project);
        var raw = await File.ReadAllTextAsync(System.IO.Path.Combine(exported.Directory, "requests", "0001.http"));
        Assert.StartsWith("POST /v1/pets/42?expand=owner HTTP/1.1\r\nHost: api.example.test\r\n", raw);
        Assert.Contains($"Content-Length: {Encoding.UTF8.GetByteCount(request.Body)}\r\n\r\n{request.Body}", raw);
        Assert.DoesNotContain("wrong.example.test", raw);
        Assert.True(File.Exists(System.IO.Path.Combine(exported.Directory, "api-request-checklist.tsv")));
        project.AllowedOrigins = "https://different.example.test";
        await Assert.ThrowsAsync<InvalidDataException>(() => exporter.ExportAsync(project));
        Assert.Throws<InvalidDataException>(() => ApiRequestFormatter.EnsureAllowed("http://api.example.test/v1", "https://api.example.test"));
        Assert.Throws<InvalidDataException>(() => ApiRequestFormatter.EnsureAllowed("https://api.example.test:8443/v1", "https://api.example.test"));
    }

    [Fact]
    public void OldProjects_DefaultToWeb_AndApiSettingsAndDraftsRoundTrip()
    {
        var options = new JsonSerializerOptions { Converters = { new JsonStringEnumConverter() } };
        Assert.Equal(InputMode.WebExploration, JsonSerializer.Deserialize<EngagementProject>("{\"Name\":\"old\"}", options)!.Mode);
        var project = Project();
        project.ApiDocument.Provider = DocumentAiProvider.Claude;
        project.ApiDocument.Model = "claude-opus-5-5";
        project.ApiDocument.ReasoningLevel = AiReasoningLevel.Low;
        project.ApiRequests.Add(Assert.Single(ApiDocumentService.ParseResult(ResultJson(), project, "run").Requests));
        project.ApiRequests[0].Selected = true;
        var restored = JsonSerializer.Deserialize<EngagementProject>(JsonSerializer.Serialize(project, options), options)!;
        Assert.Equal(InputMode.ApiDocument, restored.Mode);
        Assert.Equal(DocumentAiProvider.Claude, restored.ApiDocument.Provider);
        Assert.Equal("claude-opus-5-5", restored.ApiDocument.Model);
        Assert.Equal(AiReasoningLevel.Low, restored.ApiDocument.ReasoningLevel);
        Assert.Equal(project.ApiDocument.Content, restored.ApiDocument.Content);
        Assert.Equal(project.ApiRequests[0].RawRequest, restored.ApiRequests[0].RawRequest);
        Assert.True(restored.ApiRequests[0].Selected);
    }

    [Fact]
    public async Task ApiPackageAndHistory_KeepGeneratedCountSeparateFromObservationCounts()
    {
        using var temp = new TempDirectory();
        var project = Project();
        var run = await new ApiDocumentService(temp.Path).BuildAsync(project);
        Assert.True(File.Exists(System.IO.Path.Combine(run, "api-document.txt")));
        Assert.False(File.Exists(System.IO.Path.Combine(run, "fast-observed-requests.jsonl")));
        await File.WriteAllTextAsync(System.IO.Path.Combine(run, "api-document-summary.json"),
            "{\"status\":\"partial\",\"summary\":\"generated\",\"requestCount\":7,\"limitations\":[\"external ref\"]}");
        var history = Assert.Single(await new RunHistoryService(temp.Path).ListAsync(project.Id));
        Assert.Equal(InputMode.ApiDocument, history.Mode);
        Assert.Equal(0, history.FastRequestCount);
        Assert.Equal(0, history.AiObservedCount);
        Assert.Equal(7, history.RequestPatternCount);
        Assert.Contains("external ref", history.Limitations);
        using var schema = JsonDocument.Parse(ApiDocumentService.ResultSchema);
        Assert.Equal("object", schema.RootElement.GetProperty("type").GetString());
    }

    [Fact]
    public void ApiMode_DisablesMcpSetup_AndBothProvidersUseStdinWithStructuredOutput()
    {
        var model = new MainViewModel();
        model.ProjectModeIndex = 1;
        Assert.True(model.IsApiMode);
        Assert.False(model.SetupMcpCommand.CanExecute(null));
        Assert.Equal("8", model.ReviewPageTag);
        var codex = ApiDocumentAiRunner.CreateStartInfo(new CliLaunch("codex.exe", string.Empty), DocumentAiProvider.Codex, "run");
        Assert.True(codex.RedirectStandardInput);
        Assert.Contains("--ignore-user-config", codex.ArgumentList);
        Assert.Contains("read-only", codex.ArgumentList);
        Assert.Contains("--output-schema", codex.ArgumentList);
        var claude = ApiDocumentAiRunner.CreateStartInfo(new CliLaunch("claude.exe", string.Empty), DocumentAiProvider.Claude, "run");
        Assert.True(claude.RedirectStandardInput);
        Assert.Contains("--json-schema", claude.ArgumentList);
        Assert.Contains("--strict-mcp-config", claude.ArgumentList);
        Assert.Contains("--safe-mode", claude.ArgumentList);
        Assert.DoesNotContain("--bare", claude.ArgumentList);
        Assert.Equal("", claude.ArgumentList[claude.ArgumentList.ToList().IndexOf("--tools") + 1]);
        var wrapped = JsonSerializer.Serialize(new { is_error = false, structured_output = JsonDocument.Parse(ResultJson()).RootElement });
        Assert.Single(ApiDocumentService.ParseResult(ApiDocumentAiRunner.ExtractClaudeResult(wrapped), Project(), "run").Requests);
        Assert.Throws<InvalidDataException>(() => ApiDocumentAiRunner.ExtractClaudeResult("{\"is_error\":true}"));
    }

    [Fact]
    public void AiSelection_SupportsGlmCodexAndClaudeModelsWithReasoningLevels()
    {
        var model = new MainViewModel();
        model.ProjectModeIndex = 1;
        Assert.Equal(3, Enum.GetValues<DocumentAiProvider>().Length);
        Assert.Equal(4, Enum.GetValues<AiReasoningLevel>().Length);
        model.ApiProviderIndex = 2;
        Assert.Equal(DocumentAiProvider.Glm, model.Project.ApiDocument.Provider);
        Assert.Equal(new[] { "GLM-5.3", "GLM-5.3 flash" }, model.ApiModelOptions);
        Assert.Equal("glm-5.3", model.Project.ApiDocument.Model);
        model.ApiModelIndex = 1;
        Assert.Equal("glm-5.3-flash", model.Project.ApiDocument.Model);
        model.ApiReasoningIndex = 0;
        Assert.Equal(AiReasoningLevel.Highest, model.Project.ApiDocument.ReasoningLevel);

        var codex = ApiDocumentAiRunner.CreateStartInfo(new CliLaunch("codex.exe", string.Empty), DocumentAiProvider.Codex, "run", "gpt-6-luna", AiReasoningLevel.Highest);
        Assert.Contains("--model", codex.ArgumentList);
        Assert.Contains("gpt-6-luna", codex.ArgumentList);
        Assert.Contains("model_reasoning_effort=\"xhigh\"", codex.ArgumentList);
        var claude = ApiDocumentAiRunner.CreateStartInfo(new CliLaunch("claude.exe", string.Empty), DocumentAiProvider.Claude, "run", "claude-sonnet-5-5", AiReasoningLevel.Low);
        Assert.Contains("claude-sonnet-5-5", claude.ArgumentList);
        Assert.Equal("1024", claude.EnvironmentVariables["MAX_THINKING_TOKENS"]);

        // カタログにないIDは各プロバイダーの既定モデルへ正規化する。
        Assert.Equal("gpt-6.1-sol", DocumentAiCatalog.NormalizeModel(DocumentAiProvider.Codex, "unknown-model"));
        Assert.Equal("medium", ApiDocumentAiRunner.CodexReasoningEffort(AiReasoningLevel.Middle));
    }

    [Fact]
    public void GlmUsesZcodeCli_WithNpmScriptAttachedPromptAndIsolatedSettings()
    {
        // GLMはzcode（npm配布のスクリプトをnodeで起動）を使い、自身のZ.aiサインインで実行する。
        var launch = new CliLaunch(@"C:\Program Files\nodejs\node.exe", @"C:\Users\x\AppData\Roaming\npm\node_modules\zcode-app-cli\bin\zcode.js");
        var glm = ApiDocumentAiRunner.CreateStartInfo(launch, DocumentAiProvider.Glm, "run", model: null, reasoning: AiReasoningLevel.Middle);
        var arguments = glm.ArgumentList.ToList();
        Assert.Equal(launch.ScriptPath, arguments[0]);
        Assert.Equal("-p", arguments[1]);
        // zcodeにはスキーマ強制がないため、-p 指示へ最終応答のJSONスキーマを埋め込む。
        Assert.Contains("JSONスキーマ", arguments[2]);
        Assert.Contains("completed", arguments[2]);
        Assert.EndsWith("prompt.md", arguments[arguments.IndexOf("--attach") + 1], StringComparison.Ordinal);
        Assert.Equal("account:zai-individual-coding-plan/GLM-5.3", arguments[arguments.IndexOf("--model") + 1]);
        Assert.Contains("--disallowed-tools", arguments);
        Assert.Contains("--json", arguments);
        Assert.Equal(Path.Combine("run", ApiDocumentAiRunner.ZcodeSettingsFileName), glm.EnvironmentVariables["ZCODE_CLI_SETTINGS_FILE"]);
        Assert.False(glm.EnvironmentVariables.ContainsKey("ANTHROPIC_BASE_URL"));
        Assert.False(glm.EnvironmentVariables.ContainsKey("MAX_THINKING_TOKENS"));

        var flash = ApiDocumentAiRunner.CreateStartInfo(launch, DocumentAiProvider.Glm, "run", "glm-5.3-flash");
        Assert.Equal("account:zai-individual-coding-plan/GLM-5.3-Flash", flash.ArgumentList.ToList()[flash.ArgumentList.ToList().IndexOf("--model") + 1]);
        // ProcessStartInfoは現在プロセスの環境を複製するため、zcode自身が利用者環境へ
        // ZCODE_PERSONAL_PROVIDER_CONFIG_FILEを設定しているマシンでは元の値が見える。
        // 検証したいのは「ScopePilotがこの変数を追加しない」こと。
        var ambientProviderConfig = Environment.GetEnvironmentVariable("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE");
        if (ambientProviderConfig is null)
            Assert.False(flash.EnvironmentVariables.ContainsKey("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"));
        else
            Assert.Equal(ambientProviderConfig, flash.EnvironmentVariables["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]);

        // APIキー登録時は独立プロバイダー設定（Z.ai Coding Planテンプレート）を経由する。
        var keyed = ApiDocumentAiRunner.CreateStartInfo(launch, DocumentAiProvider.Glm, "run", "glm-5.3-flash", zcodeProviderFile: @"C:\tmp\provider_config.json");
        Assert.Equal("scopepilot-zai/GLM-5.3-Flash", keyed.ArgumentList.ToList()[keyed.ArgumentList.ToList().IndexOf("--model") + 1]);
        Assert.Equal(@"C:\tmp\provider_config.json", keyed.EnvironmentVariables["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]);
        using (var config = System.Text.Json.JsonDocument.Parse(ApiDocumentAiRunner.ZcodeApiKeyProviderConfig("id.secret", "glm-5.3")))
        {
            var rule = config.RootElement.GetProperty("config").GetProperty("providerConfigRules").GetProperty("providerRules")[0];
            Assert.Equal("scopepilot-zai", rule.GetProperty("providerId").GetString());
            Assert.Equal("zai-api", rule.GetProperty("templateId").GetString());
            Assert.Equal("zhipu-coding-plan-api-key", rule.GetProperty("config").GetProperty("access").GetProperty("type").GetString());
            Assert.Equal("id.secret", rule.GetProperty("config").GetProperty("access").GetProperty("apiKey").GetString());
            Assert.Equal("GLM-5.3", config.RootElement.GetProperty("config").GetProperty("defaultModelSelection").GetProperty("modelId").GetString());
        }
        // 実行ログには認証方式だけを記録し、キーは含めない。
        Assert.Contains("auth=api-key", ApiDocumentAiRunner.RunLogHeader(DocumentAiProvider.Glm, "glm-5.3", AiReasoningLevel.Middle, apiKey: true));
        Assert.Contains("auth=zcode-login", ApiDocumentAiRunner.RunLogHeader(DocumentAiProvider.Glm, "glm-5.3", AiReasoningLevel.Middle));

        // zcode -p --json の応答から最終応答(response)を取り出し、コードブロックで囲まれたJSONにも対応する。
        const string stdout = "ZCode Built-in skipped (not-due)\n{\n  \"response\": \"```json\\n{\\\"status\\\":\\\"completed\\\"}\\n```\",\n  \"usage\": {}\n}\n";
        Assert.Equal("{\"status\":\"completed\"}", ApiDocumentAiRunner.ExtractZcodeResult(stdout));
        Assert.Equal("{\"a\":1}", ApiDocumentAiRunner.StripCodeFences("```\n{\"a\":1}\n```"));
        Assert.Equal("{\"a\":1}", ApiDocumentAiRunner.StripCodeFences("{\"a\":1}"));
        Assert.Throws<InvalidDataException>(() => ApiDocumentAiRunner.ExtractZcodeResult("JSONがない出力"));
        Assert.Throws<InvalidDataException>(() => ApiDocumentAiRunner.ExtractZcodeResult("{\"other\":1}"));
        Assert.Throws<InvalidDataException>(() => ApiDocumentAiRunner.ExtractZcodeResult("pre{\"response\": }post"));
        // 推論レベルはzcodeへ渡せないため、表示でも付けない。
        Assert.Equal(string.Empty, ApiDocumentAiRunner.ReasoningSuffix(DocumentAiProvider.Glm, AiReasoningLevel.High));
        Assert.Equal("・推論High", ApiDocumentAiRunner.ReasoningSuffix(DocumentAiProvider.Claude, AiReasoningLevel.High));

        var model = new ViewModels.MainViewModel();
        Assert.True(model.ApiReasoningEnabled);
        model.ApiProviderIndex = 2;
        Assert.False(model.ApiReasoningEnabled);
        model.DocProviderIndex = 2;
        Assert.False(model.DocReasoningEnabled);
        model.DocProviderIndex = 0;
        Assert.True(model.DocReasoningEnabled);
    }

    [Fact]
    public void ZcodeFailureSummary_ExplainsUsageLimitAuthAndKeyFormat()
    {
        // 実機ログ（Z.ai Coding Planの5時間上限超過・HTTP 429）の形式。
        const string limit = "ZCode Built-in skipped (not-due)\nProviderBusinessError: [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-13 01:26:35][20261012221006080546d126e44ef8]\n  code: 'PROVIDER_BUSINESS_ERROR',\nError: Turn execution failed (traceId: x)";
        var summary = ApiDocumentAiRunner.ZcodeFailureSummary(limit);
        Assert.NotNull(summary);
        Assert.Contains("利用上限", summary);
        Assert.Contains("2026-10-13 01:26:35", summary);
        Assert.DoesNotContain("20261012221006080546d126e44ef8", summary);
        Assert.Contains("認証に失敗", ApiDocumentAiRunner.ZcodeFailureSummary("responseBody: '{\"error\":{\"message\":\"Authentication Failed\"}}'\nError: Turn execution failed"));
        Assert.Contains("形式", ApiDocumentAiRunner.ZcodeFailureSummary("ClientRequestSigningV4Error: Client signing credential must contain one separator."));
        Assert.Equal("Error: Provider Registry 中不存在 Model: x/y", ApiDocumentAiRunner.ZcodeFailureSummary("Error: Provider Registry 中不存在 Model: x/y"));
        Assert.Null(ApiDocumentAiRunner.ZcodeFailureSummary("Error: Turn execution failed (traceId: x)"));
    }

    [Fact]
    public void GlmApiKey_IsProtectedWithDpapiAndResolvedBeforeEnvironment()
    {
        // 平文はDPAPIで暗号化され、暗号化済みの値は再暗号化しない。
        var protectedKey = AppSettingsService.ProtectSecret(" id.secret ");
        Assert.StartsWith("dpapi:", protectedKey, StringComparison.Ordinal);
        Assert.DoesNotContain("id.secret", protectedKey);
        Assert.Equal(protectedKey, AppSettingsService.ProtectSecret(protectedKey));
        Assert.Equal("id.secret", AppSettingsService.UnprotectSecret(protectedKey));
        // 復号できない値は未登録扱い。
        Assert.Equal(string.Empty, AppSettingsService.UnprotectSecret("dpapi:AAAA"));
        Assert.Equal(string.Empty, AppSettingsService.UnprotectSecret("dpapi:not-base64!"));
        Assert.Equal(string.Empty, AppSettingsService.ProtectSecret("  "));
        // 設定ファイルのキーを環境変数より優先する。
        var settings = AppSettingsService.Normalize(new AppSettings { GlmApiKey = "id.secret" });
        Assert.Equal("id.secret", AppSettingsService.ResolveGlmApiKey(settings));
        Assert.Equal("設定ファイル", AppSettingsService.GlmApiKeySource(settings));
    }

    [Fact]
    public async Task WebHistory_ComparesPreviousWebRun_WhenApiGenerationIsBetweenRuns()
    {
        using var temp = new TempDirectory();
        var project = Project();
        var root = System.IO.Path.Combine(temp.Path, project.Id.ToString("N"));
        var oldWeb = System.IO.Path.Combine(root, "old-web");
        var newWeb = System.IO.Path.Combine(root, "new-web");
        Directory.CreateDirectory(oldWeb);
        Directory.CreateDirectory(newWeb);
        await File.WriteAllTextAsync(System.IO.Path.Combine(oldWeb, "observed-requests.jsonl"), JsonSerializer.Serialize(new { method = "GET", url = "https://api.example.test/pets", statusCode = 200 }));
        await File.WriteAllTextAsync(System.IO.Path.Combine(newWeb, "observed-requests.jsonl"), JsonSerializer.Serialize(new { method = "GET", url = "https://api.example.test/pets", statusCode = 500 }));
        var apiRun = await new ApiDocumentService(temp.Path).BuildAsync(project);
        Directory.SetLastWriteTimeUtc(oldWeb, DateTime.UtcNow.AddMinutes(-3));
        Directory.SetLastWriteTimeUtc(apiRun, DateTime.UtcNow.AddMinutes(-2));
        Directory.SetLastWriteTimeUtc(newWeb, DateTime.UtcNow.AddMinutes(-1));
        var history = await new RunHistoryService(temp.Path).ListAsync(project.Id);
        Assert.Equal("new-web", history[0].RunId);
        Assert.Equal(1, history[0].ChangedPatternCount);
        Assert.Equal(InputMode.ApiDocument, history[1].Mode);
        Assert.Equal(0, history[1].ChangedPatternCount);
    }

    private static EngagementProject Project() => new()
    {
        Mode = InputMode.ApiDocument, AllowedOrigins = "https://api.example.test",
        ApiDocument = new() { FileName = "openapi.yaml", Content = "openapi: 3.1.0\npaths: {}", BaseUrl = "https://api.example.test/v1" }
    };

    private static string ResultJson(string path = "/pets/42?expand=owner", string headerValue = "application/json", int count = 1) => JsonSerializer.Serialize(new
    {
        status = "partial", summary = "Requests generated", limitations = new[] { "Token is unresolved" },
        requests = Enumerable.Range(0, count).Select(_ => new
        {
            method = "POST", path, headers = new[] { new { name = "Content-Type", value = headerValue } }, body = "{\"name\":\"日本語\"}",
            operationId = "updatePet", summary = "Update pet", sourceReference = "#/paths/~1pets~1{id}/post",
            unresolvedValues = new[] { "Authorization: <TOKEN>" }, notes = new[] { "Document example" }
        })
    });

    private sealed class TempDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ScopePilot.Tests", Guid.NewGuid().ToString("N"));
        public TempDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() { if (Directory.Exists(Path)) Directory.Delete(Path, true); }
    }
}
