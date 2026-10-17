namespace ScopePilot.Services;

public static class ProjectWorkspaceService
{
    public const string ProjectFileName = "project.scopepilot.json";

    public static string FindProjectFile(string folder)
    {
        folder = Path.GetFullPath(folder);
        if (!Directory.Exists(folder)) throw new DirectoryNotFoundException("プロジェクトフォルダーが見つかりません。");
        var files = Directory.GetFiles(folder, "*.scopepilot.json", SearchOption.TopDirectoryOnly);
        if (files.Length != 1) throw new InvalidDataException(files.Length == 0
            ? "選択したフォルダーにプロジェクトファイルがありません。" : "選択したフォルダーに複数のプロジェクトファイルがあります。");
        ProjectPaths.EnsureChild(folder, files[0]);
        return files[0];
    }

    public static string CreateFolder(string parent, string name)
    {
        parent = Path.GetFullPath(parent);
        if (!Directory.Exists(parent)) throw new DirectoryNotFoundException("作成先フォルダーが見つかりません。");
        if (string.IsNullOrWhiteSpace(name) || name != name.Trim() || name.EndsWith('.') ||
            name is "." or ".." || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
            System.Text.RegularExpressions.Regex.IsMatch(name, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            throw new InvalidDataException("有効なプロジェクトフォルダー名を入力してください。");
        var folder = Path.GetFullPath(Path.Combine(parent, name));
        ProjectPaths.EnsureChild(parent, folder);
        if (Directory.Exists(folder) || File.Exists(folder)) throw new IOException("同じ名前のフォルダーまたはファイルが既にあります。別の名前を指定してください。");
        Directory.CreateDirectory(folder);
        return Path.Combine(folder, ProjectFileName);
    }
}
