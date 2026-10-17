using ScopePilot.Domain;

namespace ScopePilot.Services;

public static class ExplorationDocumentService
{
    public const string RunFileName = "reference-document.txt";

    public static async Task<ExplorationDocumentSettings> ImportAsync(EngagementProject project, string path)
    {
        // Validate before copying so unsupported inputs do not leave project artifacts.
        _ = await TextDocumentReader.ReadAsync(path);
        var source = await ProjectPaths.ImportAsync(project, path, "exploration-document");
        var content = await TextDocumentReader.ReadAsync(ProjectPaths.Resolve(project, source.LocalPath));
        return new()
        {
            FileName = Path.GetFileName(path),
            Content = content,
            Source = source with { Role = project.ActiveRole }
        };
    }
}
