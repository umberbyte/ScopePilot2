using System.IO;
using System.IO.Compression;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class ProjectWorkflowTests
{
    [Fact]
    public async Task ExistingProjectWithRetiredFieldsOpensWithoutRequiringThem()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.Name = "既存案件";
        project.Requests.Add(new() { Url = "https://example.test/api" });
        var store = new ProjectStore();
        await store.SaveAsync(project);
        var legacy = JsonSerializer.Deserialize<System.Text.Json.Nodes.JsonObject>(await File.ReadAllTextAsync(project.ProjectFilePath))!;
        legacy["SourceDigest"] = "old-source";
        legacy["Seed"] = "42";
        legacy["ConditionSeries"] = "baseline";
        legacy["Assessments"] = new System.Text.Json.Nodes.JsonArray();
        await File.WriteAllTextAsync(project.ProjectFilePath, legacy.ToJsonString());
        var loaded = await store.LoadAsync(project.ProjectFilePath);
        Assert.Equal(project.Name, loaded.Name);
        Assert.Equal("https://example.test/api", Assert.Single(loaded.Requests).Url);
        await store.SaveAsync(loaded);
        using var saved = JsonDocument.Parse(await File.ReadAllTextAsync(loaded.ProjectFilePath));
        foreach (var field in new[] { "SourceDigest", "Seed", "ConditionSeries", "Assessments" })
            Assert.False(saved.RootElement.TryGetProperty(field, out _));
    }
    [Fact]
    public async Task ProjectFolderCanMoveWithInputsRunsAndDraftReferences()
    {
        using var temp = new TestFolder();
        var project = temp.Project("old");
        var run = ProjectPaths.Resolve(project, "runs/one");
        Directory.CreateDirectory(run);
        project.ApiRequests.Add(new() { SourceRunDirectory = run });
        var source = Path.Combine(temp.Path, "document.yaml");
        await File.WriteAllTextAsync(source, "openapi: 3.0.0");
        var evidence = await ProjectPaths.ImportAsync(project, source, "api-document");
        project.Inputs.Add(evidence);
        var store = new ProjectStore();
        await store.SaveAsync(project);
        var serialized = await File.ReadAllTextAsync(project.ProjectFilePath);
        Assert.DoesNotContain(ProjectPaths.Root(project).Replace("\\", "\\\\"), serialized);
        Assert.Contains("runs/one", serialized);
        var moved = Path.Combine(temp.Path, "moved");
        Directory.Move(ProjectPaths.Root(project), moved);
        var loaded = await store.LoadAsync(Path.Combine(moved, "project.scopepilot.json"));
        Assert.Equal(Path.Combine(moved, "runs", "one"), loaded.ApiRequests[0].SourceRunDirectory);
        await ProjectPaths.VerifyAsync(loaded, loaded.Inputs[0]);
    }

    [Fact]
    public async Task SaveRejectsUnownedPathsWithoutReplacingExistingFile()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        var store = new ProjectStore();
        await store.SaveAsync(project);
        var original = await File.ReadAllTextAsync(project.ProjectFilePath);
        project.ApiRequests.Add(new() { SourceRunDirectory = temp.Path });
        await Assert.ThrowsAsync<InvalidDataException>(() => store.SaveAsync(project));
        Assert.Equal(original, await File.ReadAllTextAsync(project.ProjectFilePath));
        Assert.Empty(Directory.GetFiles(ProjectPaths.Root(project), "*.tmp"));
        Assert.Throws<InvalidDataException>(() => ProjectPaths.Resolve(project, "../outside"));
        Assert.Throws<InvalidDataException>(() => ProjectPaths.Resolve(project, temp.Path));
    }

    [Fact]
    public async Task NoImplicitStorageAndOnlyOneProjectPerFolder()
    {
        using var temp = new TestFolder();
        var store = new ProjectStore();
        await Assert.ThrowsAsync<InvalidOperationException>(() => store.SaveAsync(new()));
        var project = temp.Project();
        await store.SaveAsync(project);
        project.ProjectFilePath = Path.Combine(ProjectPaths.Root(project), "other.scopepilot.json");
        await Assert.ThrowsAsync<InvalidDataException>(() => store.SaveAsync(project));
    }

    [Fact]
    public async Task BackupIncludesInputsAndExcludesEarlierBackupsAndDeletionIsConfined()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        await new ProjectStore().SaveAsync(project);
        Directory.CreateDirectory(ProjectPaths.Category(project, "inputs"));
        await File.WriteAllTextAsync(ProjectPaths.Resolve(project, "inputs/sample.txt"), "input");
        var service = new DataManagementService();
        await service.CreateBackupAsync(project);
        var backup = await service.CreateBackupAsync(project);
        using var archive = ZipFile.OpenRead(backup);
        Assert.Contains(archive.Entries, x => x.FullName == "inputs/sample.txt");
        Assert.DoesNotContain(archive.Entries, x => x.FullName.StartsWith("backups/"));
        await Assert.ThrowsAsync<InvalidDataException>(() => service.DeleteRunAsync(project, temp.Path));
        Assert.True(File.Exists(project.ProjectFilePath));
    }

    [Fact]
    public async Task AllDefaultArtifactServicesUseSelectedProjectFolder()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.Mode = InputMode.ApiDocument;
        project.ApiDocument.Content = "openapi: 3.0.0";
        project.ApiDocument.FileName = "spec.yaml";
        project.ApiDocument.BaseUrl = "https://example.test";
        project.ApiRequests.Add(new() { Selected = true, Method = "GET", Url = "https://example.test/api" });
        project.Candidates.Add(new() { Selected = true, Pattern = "GET https://example.test/api", Representative = new() { Url = "https://example.test/api" } });
        var paths = new[]
        {
            await new ApiDocumentService().BuildAsync(project),
            await new ExplorationPackageBuilder().BuildAsync(project),
            (await new ApiRequestExportService().ExportAsync(project)).Directory,
            (await new BurpScopeExportService().ExportAsync(project)).Directory,
            (await new FindingReportService().ExportAsync(project)).Directory
        };
        foreach (var path in paths) ProjectPaths.EnsureChild(ProjectPaths.Root(project), path);
        Assert.Equal(2, (await new RunHistoryService().ListAsync(project)).Count);
    }

    [Fact]
    public async Task LegacyImportCopiesArtifactsAndLeavesOriginalUntouched()
    {
        using var temp = new TestFolder();
        var old = Path.Combine(temp.Path, "legacy");
        Directory.CreateDirectory(Path.Combine(old, "projects"));
        var project = new EngagementProject();
        var run = Path.Combine(old, "runs", project.Id.ToString("N"), "one");
        Directory.CreateDirectory(run);
        await File.WriteAllTextAsync(Path.Combine(run, "engagement.json"), "{}");
        project.ApiRequests.Add(new() { SourceRunDirectory = run });
        var source = Path.Combine(old, "projects", project.Id.ToString("N") + ".json");
        await File.WriteAllTextAsync(source, JsonSerializer.Serialize(project));
        var destination = temp.Project("new").ProjectFilePath;
        var migrated = await new LegacyProjectImporter().ImportAsync(source, destination);
        Assert.True(File.Exists(Path.Combine(ProjectPaths.Root(migrated), "runs", "one", "engagement.json")));
        Assert.True(File.Exists(source));
        var loaded = await new ProjectStore().LoadAsync(destination);
        Assert.Equal(migrated.ApiRequests[0].SourceRunDirectory, loaded.ApiRequests[0].SourceRunDirectory);
    }
}

internal sealed class TestFolder : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ScopePilot.Tests", Guid.NewGuid().ToString("N"));
    public TestFolder() => Directory.CreateDirectory(Path);
    public EngagementProject Project(string name = "project") => new()
    {
        ProjectFilePath = System.IO.Path.Combine(Path, name, "project.scopepilot.json"),
        AllowedOrigins = "https://example.test", StartUrl = "https://example.test"
    };
    public void Dispose() { if (Directory.Exists(Path)) Directory.Delete(Path, true); }
}
