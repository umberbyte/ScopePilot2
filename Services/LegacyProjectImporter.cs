using System.Text.Json;
using System.Text.Json.Serialization;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed class LegacyProjectImporter
{
    public async Task<EngagementProject> ImportAsync(string sourceFile, string destinationFile)
    {
        if (File.Exists(destinationFile)) throw new IOException("移行先には新しいプロジェクトファイルを指定してください。");
        var options = new JsonSerializerOptions { Converters = { new JsonStringEnumConverter() } };
        var project = JsonSerializer.Deserialize<EngagementProject>(await File.ReadAllTextAsync(sourceFile), options)
            ?? throw new InvalidDataException("旧案件JSONが空です。");
        project.ProjectFilePath = Path.GetFullPath(destinationFile);
        ProjectPaths.CheckProjectFile(project);
        var sourceDirectory = Path.GetDirectoryName(Path.GetFullPath(sourceFile))!;
        if (!Path.GetFileName(sourceDirectory).Equals("projects", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("旧保存ルートのprojectsフォルダー内の案件JSONを指定してください。");
        var legacyRoot = Path.GetDirectoryName(sourceDirectory)!;
        var newRoot = ProjectPaths.Root(project);
        if (newRoot.Equals(legacyRoot, StringComparison.OrdinalIgnoreCase) ||
            newRoot.StartsWith(legacyRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("移行先は旧保存ルートの外側に指定してください。");
        foreach (var category in new[] { "runs", "exports", "reports" })
        {
            var old = Path.Combine(legacyRoot, category, project.Id.ToString("N"));
            var target = ProjectPaths.Category(project, category);
            if (Directory.Exists(target)) throw new IOException($"移行先の{category}フォルダーが既に存在します。");
            if (Directory.Exists(old)) CopyDirectory(legacyRoot, old, target);
        }
        string ConvertPath(string old)
        {
            if (string.IsNullOrWhiteSpace(old)) return "";
            var prefix = Path.Combine(legacyRoot, "runs", project.Id.ToString("N")) + Path.DirectorySeparatorChar;
            return old.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                ? ProjectPaths.Resolve(project, "runs/" + Path.GetRelativePath(prefix, old).Replace('\\', '/')) : "";
        }
        foreach (var draft in project.ApiRequests) draft.SourceRunDirectory = ConvertPath(draft.SourceRunDirectory);
        foreach (var finding in project.Findings) finding.SourceRunDirectory = ConvertPath(finding.SourceRunDirectory);
        project.Inputs.Clear();
        project.Inputs.Add(await ProjectPaths.ImportAsync(project, sourceFile, "legacy-project"));
        if (!string.IsNullOrEmpty(project.ApiDocument.Content))
        {
            var path = ProjectPaths.Resolve(project, "inputs/api-document.txt");
            await File.WriteAllTextAsync(path, project.ApiDocument.Content);
            project.Inputs.Add(await ProjectPaths.EvidenceAsync(project, path, "api-document"));
        }
        await new ProjectStore().SaveAsync(project);
        return project;
    }
    private static void CopyDirectory(string root, string source, string target)
    {
        ProjectPaths.EnsureChild(root, source);
        Directory.CreateDirectory(target);
        foreach (var file in Directory.EnumerateFiles(source))
        {
            ProjectPaths.EnsureChild(root, file);
            File.Copy(file, Path.Combine(target, Path.GetFileName(file)), overwrite: false);
        }
        foreach (var directory in Directory.EnumerateDirectories(source)) CopyDirectory(root, directory, Path.Combine(target, Path.GetFileName(directory)));
    }
}
