using System.Diagnostics;

namespace ScopePilot.Services;

public static class WorkspacePathOpener
{
    public static void Open(string path) => Process.Start(CreateStartInfo(path));

    internal static ProcessStartInfo CreateStartInfo(string path)
    {
        var fullPath = Path.GetFullPath(path);
        if (Directory.Exists(fullPath))
        {
            // Pass the literal directory as one argument rather than asking its shell
            // association to resolve it. This also handles spaces and Japanese names.
            var info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"))
            {
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(fullPath) ?? fullPath
            };
            info.ArgumentList.Add(fullPath);
            return info;
        }
        if (File.Exists(fullPath))
            return new ProcessStartInfo(fullPath) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(fullPath)! };
        throw new FileNotFoundException($"保存先が見つかりません: {fullPath}", fullPath);
    }
}
