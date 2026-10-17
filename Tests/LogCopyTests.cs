using System.IO;
using System.Runtime.InteropServices;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class LogCopyTests
{
    [Fact]
    public async Task BusyClipboardRetriesAndCopiesExactText()
    {
        const string text = "認証待ち\r\n次の行";
        var attempts = 0;
        var waits = 0;
        string? copied = null;
        var result = await ClipboardService.CopyTextAsync(text, value =>
        {
            if (++attempts < 3) throw new COMException("busy", unchecked((int)0x800401D0));
            copied = value;
        }, () => { waits++; return Task.CompletedTask; });
        Assert.True(result.Success);
        Assert.Equal(text, copied);
        Assert.Equal(3, attempts);
        Assert.Equal(2, waits);
    }

    [Fact]
    public async Task PersistentClipboardFailureIsReportedWithoutThrowing()
    {
        var attempts = 0;
        var result = await ClipboardService.CopyTextAsync("log", _ =>
        {
            attempts++;
            throw new COMException("busy", unchecked((int)0x800401D0));
        }, () => Task.CompletedTask);
        Assert.False(result.Success);
        Assert.Equal(5, attempts);
        Assert.Contains("0x800401D0", result.Message);
        Assert.Contains("TXT保存", result.Message);
    }

    [Fact]
    public async Task EmptyTextDoesNotOverwriteClipboard()
    {
        var result = await ClipboardService.CopyTextAsync("", _ => throw new Exception("Must not touch clipboard"), () => Task.CompletedTask);
        Assert.False(result.Success);
        Assert.Contains("ありません", result.Message);
    }

    [Fact]
    public async Task ExportStaysInsideProjectWithoutSavingProjectFile()
    {
        var root = Path.Combine(Path.GetTempPath(), "ScopePilot-log-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var project = new EngagementProject { ProjectFilePath = Path.Combine(root, "project.scopepilot.json") };
        await File.WriteAllTextAsync(project.ProjectFilePath, "existing project content");
        try
        {
            const string text = "日本語のログ\r\nsecond line";
            var path = await LogExportService.SaveAsync(project, text);
            Assert.StartsWith(Path.Combine(root, "reports", "logs") + Path.DirectorySeparatorChar, path);
            Assert.Equal(text, await File.ReadAllTextAsync(path));
            Assert.Equal("existing project content", await File.ReadAllTextAsync(project.ProjectFilePath));
        }
        finally { Directory.Delete(root, true); }
    }
}
