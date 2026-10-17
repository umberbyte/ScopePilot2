using System.IO;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class WorkspacePathOpenerTests
{
    [Fact]
    public void FolderOpening_PassesFullPathWithSpacesAndJapaneseAsOneExplorerArgument()
    {
        using var temp = new TempDirectory();
        var folder = Path.Combine(temp.Path, "API 出力", "api-20261007-143516-739-524e6a853d4140cf9c08d5525dae0530");
        Directory.CreateDirectory(folder);
        var info = WorkspacePathOpener.CreateStartInfo(folder);
        Assert.Equal("explorer.exe", Path.GetFileName(info.FileName));
        Assert.False(info.UseShellExecute);
        Assert.Equal(Path.GetFullPath(folder), Assert.Single(info.ArgumentList));
    }

    [Fact]
    public async Task FilesKeepTheirDefaultApplication_AndMissingFoldersAreReportedBeforeLaunching()
    {
        using var temp = new TempDirectory();
        var file = Path.Combine(temp.Path, "README.txt");
        await File.WriteAllTextAsync(file, "test");
        var info = WorkspacePathOpener.CreateStartInfo(file);
        Assert.True(info.UseShellExecute);
        Assert.Equal(file, info.FileName);
        Assert.Throws<FileNotFoundException>(() => WorkspacePathOpener.CreateStartInfo(Path.Combine(temp.Path, "missing")));
    }

    [Fact]
    public async Task LatestExportRestoration_IgnoresIncompleteExportsAndOtherModes()
    {
        using var temp = new TempDirectory();
        var id = Guid.NewGuid();
        var project = new EngagementProject { Id = id, ProjectFilePath = Path.Combine(temp.Path, "project.scopepilot.json") };
        var root = Path.Combine(temp.Path, "exports");
        var olderApi = Path.Combine(root, "api-old");
        var newerApi = Path.Combine(root, "api-new");
        var web = Path.Combine(root, "web");
        var incomplete = Path.Combine(root, "api-incomplete");
        foreach (var directory in new[] { olderApi, newerApi, web, incomplete }) Directory.CreateDirectory(directory);
        await File.WriteAllTextAsync(Path.Combine(olderApi, "api-requests.json"), "{}");
        await File.WriteAllTextAsync(Path.Combine(newerApi, "api-requests.json"), "{}");
        await File.WriteAllTextAsync(Path.Combine(web, "burp-scope.json"), "{}");
        Directory.SetLastWriteTimeUtc(olderApi, DateTime.UtcNow.AddMinutes(-3));
        Directory.SetLastWriteTimeUtc(newerApi, DateTime.UtcNow.AddMinutes(-2));
        var service = new DataManagementService();
        Assert.Equal(newerApi, service.FindLatestBurpExportDirectory(project, InputMode.ApiDocument));
        Assert.Equal(web, service.FindLatestBurpExportDirectory(project, InputMode.WebExploration));
        Assert.Null(service.FindLatestBurpExportDirectory(new EngagementProject(), InputMode.ApiDocument));
    }

    private sealed class TempDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "ScopePilot.Tests", Guid.NewGuid().ToString("N"));
        public TempDirectory() => Directory.CreateDirectory(Path);
        public void Dispose() { if (Directory.Exists(Path)) Directory.Delete(Path, true); }
    }
}
