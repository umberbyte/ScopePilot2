using System.Security.Cryptography;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public static class ProjectPaths
{
    internal static System.Text.Json.Nodes.JsonNode PortableRunObject(EngagementProject project, object value)
    {
        var node = System.Text.Json.JsonSerializer.SerializeToNode(value)!;
        if (!string.IsNullOrWhiteSpace(project.ProjectFilePath) && node["SourceRunDirectory"]?.GetValue<string>() is { Length: > 0 } path)
            node["SourceRunDirectory"] = Relative(project, path);
        return node;
    }
    public static string Root(EngagementProject project) => string.IsNullOrWhiteSpace(project.ProjectFilePath)
        ? throw new InvalidOperationException("プロジェクトファイルを作成または開いてください。")
        : Path.GetDirectoryName(Path.GetFullPath(project.ProjectFilePath))!;

    public static void CheckProjectFile(EngagementProject project)
    {
        var root = Root(project);
        EnsureChild(root, project.ProjectFilePath);
        if (!project.ProjectFilePath.EndsWith(".scopepilot.json", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("プロジェクトファイルの拡張子は.scopepilot.jsonです。");
        if (Directory.Exists(root) && Directory.EnumerateFiles(root, "*.scopepilot.json")
            .Any(x => !Path.GetFullPath(x).Equals(Path.GetFullPath(project.ProjectFilePath), StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException("同じフォルダーに別のプロジェクトファイルがあります。案件ごとにフォルダーを分けてください。");
    }

    public static string Resolve(EngagementProject project, string relative)
    {
        if (Path.IsPathRooted(relative)) throw new InvalidDataException("プロジェクト内の相対パスが必要です。");
        var root = Root(project);
        var target = Path.GetFullPath(Path.Combine(root, relative));
        EnsureChild(root, target);
        return target;
    }

    public static void EnsureChild(string root, string target)
    {
        root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        target = Path.GetFullPath(target);
        if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("対象がプロジェクトフォルダーの範囲外です。");
        for (var path = target; path is not null; path = Path.GetDirectoryName(path))
        {
            if ((File.Exists(path) || Directory.Exists(path)) &&
                (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("リンク先をプロジェクトデータとして使用できません。");
            if (path.Equals(root, StringComparison.OrdinalIgnoreCase)) break;
        }
    }

    public static string Category(EngagementProject project, string category) => Resolve(project, category);
    public static string Relative(EngagementProject project, string path)
    {
        EnsureChild(Root(project), path);
        return Path.GetRelativePath(Root(project), path).Replace('\\', '/');
    }

    public static async Task<EvidenceReference> ImportAsync(EngagementProject project, string source, string kind)
    {
        var directory = Category(project, "inputs");
        Directory.CreateDirectory(directory);
        var target = Resolve(project, $"inputs/{Guid.NewGuid():N}-{Path.GetFileName(source)}");
        await using (var input = File.OpenRead(source))
        await using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write))
            await input.CopyToAsync(output);
        return await EvidenceAsync(project, target, kind);
    }

    public static async Task<EvidenceReference> EvidenceAsync(EngagementProject project, string path, string kind, string pointer = "")
    {
        var relative = Relative(project, path);
        await using var stream = File.OpenRead(path);
        return new(relative, Convert.ToHexString(await SHA256.HashDataAsync(stream)).ToLowerInvariant(), pointer, kind, "local-only");
    }

    public static async Task VerifyAsync(EngagementProject project, EvidenceReference reference)
    {
        var actual = await EvidenceAsync(project, Resolve(project, reference.LocalPath), reference.Kind, reference.Pointer);
        if (!actual.Sha256.Equals(reference.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"証拠ファイルのSHA-256が一致しません: {reference.LocalPath}");
    }
}
