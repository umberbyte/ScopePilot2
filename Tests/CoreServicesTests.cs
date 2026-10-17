using System.IO;
using System.IO.Compression;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class CoreServicesTests
{
    [Theory]
    [InlineData("https://example.test/news110328/", "https://example.test/news120702/")]
    [InlineData("https://example.test/posts/2026-09-26", "https://example.test/posts/2025-01-02")]
    [InlineData("https://example.test/items/12345", "https://example.test/items/98765")]
    public void UrlPatterns_GroupCmsGeneratedPages(string left, string right) =>
        Assert.Equal(UrlPatternNormalizer.NormalizeForSelection(left), UrlPatternNormalizer.NormalizeForSelection(right));

    [Fact]
    public void RequestIdentity_PreservesAuthenticationRole()
    {
        var anonymous = new ObservedRequest { Method = "GET", Url = "https://example.test/account", Role = "未認証" };
        var user = new ObservedRequest { Method = "GET", Url = "https://example.test/account", Role = "一般ユーザー" };
        Assert.NotEqual(ObservedRequestIdentity.Build(anonymous), ObservedRequestIdentity.Build(user));
    }

    [Fact]
    public async Task AiInput_ExcludesStaticAssets_AndKeepsStartUrl()
    {
        using var temp = new TempDirectory();
        await WriteEngagementAsync(temp.Path, "未認証");
        await File.WriteAllLinesAsync(Path.Combine(temp.Path, "fast-observed-requests.jsonl"),
        [
            JsonSerializer.Serialize(new { method = "GET", url = "https://example.test/", statusCode = 200, contentType = "text/html", role = "未認証", pageInspected = true, formCount = 0 }),
            JsonSerializer.Serialize(new { method = "GET", url = "https://example.test/app.css", statusCode = 200, contentType = "text/css", role = "未認証" })
        ]);
        var result = await new AiInputBuilder().BuildAsync(temp.Path);
        Assert.True(result.RequiresAi);
        Assert.Equal(1, result.RequestPatternCount);
        Assert.Equal(1, result.StaticExcluded);
    }

    [Fact]
    public async Task AiInput_RequiresAiForAuthenticatedRole_EvenWithoutRequests()
    {
        using var temp = new TempDirectory();
        await WriteEngagementAsync(temp.Path, "一般ユーザー");
        var result = await new AiInputBuilder().BuildAsync(temp.Path);
        Assert.True(result.RequiresAi);
    }

    [Fact]
    public async Task RunHistory_ComparesNewChangedAndMissingPatterns()
    {
        using var temp = new TempDirectory();
        var projectId = Guid.NewGuid();
        var projectRoot = Path.Combine(temp.Path, projectId.ToString("N"));
        var oldRun = Path.Combine(projectRoot, "old");
        var newRun = Path.Combine(projectRoot, "new");
        Directory.CreateDirectory(oldRun); Directory.CreateDirectory(newRun);
        await WriteRunAsync(oldRun,
            new("GET", "https://example.test/a", 200, "text/html"),
            new("GET", "https://example.test/removed", 200, "text/html"));
        await WriteRunAsync(newRun,
            new("GET", "https://example.test/a", 500, "text/html"),
            new("POST", "https://example.test/new", 200, "application/json"));
        Directory.SetLastWriteTimeUtc(oldRun, DateTime.UtcNow.AddMinutes(-2));
        Directory.SetLastWriteTimeUtc(newRun, DateTime.UtcNow);
        var runs = await new RunHistoryService(temp.Path).ListAsync(projectId);
        Assert.Equal(1, runs[0].NewPatternCount);
        Assert.Equal(1, runs[0].ChangedPatternCount);
        Assert.Equal(1, runs[0].MissingPatternCount);
    }

    [Fact]
    public async Task BurpExport_CombinesCandidatesAndWritesChecklist()
    {
        using var temp = new TempDirectory();
        var project = new EngagementProject { Name = "test", AllowedOrigins = "https://example.test" };
        for (var index = 0; index < 21; index++) project.Candidates.Add(Candidate($"https://example.test/api/{index}"));
        var result = await new BurpScopeExportService(temp.Path).ExportAsync(project);
        Assert.Equal(2, result.CombinedRegexes.Length);
        Assert.True(File.Exists(result.ChecklistPath));
        Assert.Equal(22, File.ReadAllLines(result.ChecklistPath).Length);
    }

    [Fact]
    public async Task Report_ExportsWithoutFindings()
    {
        using var temp = new TempDirectory();
        var project = new EngagementProject { Name = "report", StartUrl = "https://example.test", AllowedOrigins = "https://example.test" };
        project.Candidates.Add(Candidate(project.StartUrl));
        var result = await new FindingReportService(temp.Path).ExportAsync(project);
        Assert.Equal(0, result.FindingCount);
        Assert.Contains("採用した診断対象候補", await File.ReadAllTextAsync(result.HtmlPath));
        Assert.True(File.Exists(result.CandidateChecklistPath));
    }

    [Fact]
    public async Task DataBackup_IncludesProjectAndRunEvidence()
    {
        using var temp = new TempDirectory();
        var id = Guid.NewGuid();
        Directory.CreateDirectory(Path.Combine(temp.Path, "projects"));
        Directory.CreateDirectory(Path.Combine(temp.Path, "runs", id.ToString("N"), "run-1"));
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "projects", $"{id:N}.json"), "{}");
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "runs", id.ToString("N"), "run-1", "evidence.jsonl"), "{}\n");
        var project = new EngagementProject { Id = id, ProjectFilePath = Path.Combine(temp.Path, "project.scopepilot.json") };
        await new ProjectStore().SaveAsync(project);
        var backup = await new DataManagementService().CreateBackupAsync(project);
        using var archive = ZipFile.OpenRead(backup);
        Assert.Contains(archive.Entries, x => x.FullName == "project.scopepilot.json");
        Assert.Contains(archive.Entries, x => x.FullName.EndsWith("evidence.jsonl"));
    }

    private static DiagnosticCandidate Candidate(string url) => new()
    {
        Selected = true,
        Pattern = $"GET {url}",
        Category = "API",
        Reason = "test",
        DiagnosticCaution = "verify",
        Representative = new ObservedRequest { Method = "GET", Url = url, Role = "未認証", StatusCode = 200, ContentType = "application/json" }
    };

    private static async Task WriteEngagementAsync(string directory, string activeRole)
    {
        var payload = new
        {
            StartUrl = "https://example.test/",
            activeRole,
            adoptedCandidatePatterns = Array.Empty<string>(),
            deferredCandidatePatterns = Array.Empty<string>(),
            guidelines = new GuidelineSelectionOptions()
        };
        await File.WriteAllTextAsync(Path.Combine(directory, "engagement.json"), JsonSerializer.Serialize(payload));
    }

    private static async Task WriteRunAsync(string directory, params RequestStub[] requests)
    {
        await File.WriteAllTextAsync(Path.Combine(directory, "engagement.json"), JsonSerializer.Serialize(new { runStartedAt = DateTimeOffset.Now, activeRole = "未認証" }));
        await File.WriteAllLinesAsync(Path.Combine(directory, "fast-observed-requests.jsonl"), requests.Select(x => JsonSerializer.Serialize(new
        {
            method = x.Method, url = x.Url, statusCode = x.Status, contentType = x.ContentType, role = "未認証", formCount = 0
        })));
        await File.WriteAllTextAsync(Path.Combine(directory, "fast-crawl-summary.json"), "{\"status\":\"completed\",\"observedRequestCount\":2}");
    }

    private sealed record RequestStub(string Method, string Url, int Status, string ContentType);

    private sealed class TempDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ScopePilot.Tests", Guid.NewGuid().ToString("N"));
        public TempDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() { try { Directory.Delete(Path, recursive: true); } catch { } }
    }
}
