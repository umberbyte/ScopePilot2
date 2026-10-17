using System.Text;
using ScopePilot.Domain;

namespace ScopePilot.Services;

internal static class LogExportService
{
    public static async Task<string> SaveAsync(EngagementProject project, string text)
    {
        if (string.IsNullOrEmpty(text)) throw new InvalidOperationException("保存するログがありません。");
        var directory = ProjectPaths.Category(project, "reports/logs");
        Directory.CreateDirectory(directory);
        var path = ProjectPaths.Resolve(project, $"reports/logs/scopepilot-{DateTime.Now:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}.txt");
        await using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write);
        await using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        await writer.WriteAsync(text);
        return path;
    }
}
