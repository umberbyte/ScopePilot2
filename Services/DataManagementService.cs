using System.IO.Compression;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record ProjectDataSummary(int FileCount, long TotalBytes, int RunCount, int ExportCount, int ReportCount)
{
    public string Display => $"プロジェクト: {FileCount:N0}ファイル / {TotalBytes / 1024d:N1} KB　実行 {RunCount}件　引き渡し {ExportCount}件　レポート {ReportCount}件";
}

public sealed class DataManagementService
{
    public string? FindLatestZapDirectory(EngagementProject project)
    {
        if (string.IsNullOrWhiteSpace(project.ProjectFilePath)) return null;
        var runs = ProjectPaths.Category(project, "runs");
        if (!Directory.Exists(runs)) return null;
        return Directory.EnumerateDirectories(runs).Where(x => File.Exists(Path.Combine(x, "zap-summary.json")))
            .OrderByDescending(Directory.GetLastWriteTimeUtc).FirstOrDefault();
    }
    public string? FindLatestBurpExportDirectory(EngagementProject project, InputMode mode)
    {
        if (string.IsNullOrWhiteSpace(project.ProjectFilePath)) return null;
        var directory = ProjectPaths.Category(project, "exports");
        var marker = mode == InputMode.ApiDocument ? "api-requests.json" : "burp-scope.json";
        return !Directory.Exists(directory) ? null : Directory.EnumerateDirectories(directory)
            .Where(x => File.Exists(Path.Combine(x, marker)))
            .OrderByDescending(Directory.GetLastWriteTimeUtc).FirstOrDefault();
    }

    public Task<ProjectDataSummary> GetSummaryAsync(EngagementProject project)
    {
        if (string.IsNullOrWhiteSpace(project.ProjectFilePath)) return Task.FromResult(new ProjectDataSummary(0, 0, 0, 0, 0));
        var files = Files(ProjectPaths.Root(project)).Select(x => new FileInfo(x)).ToArray();
        int Count(string category) => Directory.Exists(ProjectPaths.Category(project, category))
            ? Directory.EnumerateDirectories(ProjectPaths.Category(project, category)).Count() : 0;
        return Task.FromResult(new ProjectDataSummary(files.Length, files.Sum(x => x.Length), Count("runs"), Count("exports"), Count("reports")));
    }

    public async Task<string> CreateBackupAsync(EngagementProject project)
    {
        var root = ProjectPaths.Root(project);
        var directory = ProjectPaths.Category(project, "backups");
        Directory.CreateDirectory(directory);
        var path = ProjectPaths.Resolve(project, $"backups/project-{DateTimeOffset.Now:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}.zip");
        var files = Files(root).Where(x => !Path.GetRelativePath(root, x).StartsWith("backups" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)).ToArray();
        await using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write);
        using var archive = new ZipArchive(stream, ZipArchiveMode.Create);
        foreach (var file in files)
        {
            var entry = archive.CreateEntry(ProjectPaths.Relative(project, file), CompressionLevel.Optimal);
            await using var input = File.Open(file, FileMode.Open, FileAccess.Read, FileShare.Read);
            await using var output = entry.Open();
            await input.CopyToAsync(output);
        }
        return path;
    }

    public Task DeleteRunAsync(EngagementProject project, string runDirectory)
    {
        ProjectPaths.EnsureChild(ProjectPaths.Category(project, "runs"), runDirectory);
        DeleteChecked(ProjectPaths.Root(project), runDirectory);
        return Task.CompletedTask;
    }
    public Task DeleteGeneratedArtifactsAsync(EngagementProject project)
    {
        foreach (var category in new[] { "exports", "reports" }) DeleteChecked(ProjectPaths.Root(project), ProjectPaths.Category(project, category));
        return Task.CompletedTask;
    }
    private static void DeleteChecked(string root, string path)
    {
        ProjectPaths.EnsureChild(root, path);
        if (!Directory.Exists(path)) return;
        _ = Files(path).ToArray(); // Reject junctions before recursive deletion.
        Directory.Delete(path, true);
    }
    private static IEnumerable<string> Files(string root)
    {
        if (!Directory.Exists(root)) yield break;
        foreach (var path in Directory.EnumerateFileSystemEntries(root))
        {
            ProjectPaths.EnsureChild(root, path);
            if (Directory.Exists(path)) { foreach (var child in Files(path)) yield return child; }
            else yield return path;
        }
    }
}
