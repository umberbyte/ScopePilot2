using System.Text.Json;
using System.Text.Json.Serialization;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed class ProjectStore
{
    private readonly JsonSerializerOptions _options = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() }
    };
    public string Snapshot(EngagementProject project) => JsonSerializer.Serialize(project, _options);

    public async Task SaveAsync(EngagementProject project)
    {
        var directory = ProjectPaths.Root(project);
        ProjectPaths.CheckProjectFile(project);
        Directory.CreateDirectory(directory);
        ProjectPaths.EnsureChild(directory, project.ProjectFilePath);
        project.UpdatedAt = DateTimeOffset.Now;
        var temporary = project.ProjectFilePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            var snapshot = JsonSerializer.SerializeToNode(project, _options)!;
            foreach (var collection in new[] { "ApiRequests", "Findings" })
                foreach (var item in snapshot[collection]!.AsArray())
                    if (item?["SourceRunDirectory"]?.GetValue<string>() is { Length: > 0 } path)
                        item["SourceRunDirectory"] = ProjectPaths.Relative(project, path);
            await File.WriteAllTextAsync(temporary, snapshot.ToJsonString(_options));
            File.Move(temporary, project.ProjectFilePath, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    public async Task<EngagementProject> LoadAsync(string path)
    {
        path = Path.GetFullPath(path);
        ProjectPaths.EnsureChild(Path.GetDirectoryName(path)!, path);
        await using var stream = File.OpenRead(path);
        var project = await JsonSerializer.DeserializeAsync<EngagementProject>(stream, _options)
            ?? throw new InvalidDataException("プロジェクトファイルが空です。");
        if (project.FormatVersion != 1) throw new InvalidDataException("未対応のプロジェクト形式です。");
        project.ProjectFilePath = path;
        ProjectPaths.CheckProjectFile(project);
        project.ApiRequests ??= [];
        project.Findings ??= [];
        project.Inputs ??= [];
        project.BrunoVerifications ??= [];
        project.Report ??= new();
        project.ExplorationDocument ??= new();
        project.ExplorationAi ??= new();
        project.ExplorationProxy ??= new();
        if (project.ExplorationDocument.Source is { } source) _ = ProjectPaths.Resolve(project, source.LocalPath);
        foreach (var reference in project.Inputs) _ = ProjectPaths.Resolve(project, reference.LocalPath);
        foreach (var verification in project.BrunoVerifications) _ = ProjectPaths.Resolve(project, verification.Exchange.LocalPath);
        foreach (var item in project.ApiRequests)
            item.SourceRunDirectory = ResolveStoredPath(project, item.SourceRunDirectory);
        foreach (var item in project.Findings)
            item.SourceRunDirectory = ResolveStoredPath(project, item.SourceRunDirectory);
        return project;
    }

    public static string ResolveStoredPath(EngagementProject project, string path) => string.IsNullOrWhiteSpace(path)
        ? "" : ProjectPaths.Resolve(project, path);
}
