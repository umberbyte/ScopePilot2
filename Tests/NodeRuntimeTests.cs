using System.Diagnostics;
using System.IO;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class NodeRuntimeTests
{
    private static string FileAt(string root, params string[] parts)
    {
        var path = Path.Combine(new[] { root }.Concat(parts).ToArray());
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "fixture");
        return path;
    }

    private static string? Resolve(string root, string? explicitPath = null, params string?[] paths) =>
        EnvironmentProbe.ResolveNode(explicitPath, Path.Combine(root, "app"), Path.Combine(root, "programs"),
            Path.Combine(root, "local"), Path.Combine(root, "profile"), paths);

    [Fact]
    public void DesktopRuntimeIsDetectedWithoutAnyPathEntry()
    {
        using var temp = new TestFolder();
        var node = FileAt(temp.Path, "profile", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "bin", "node.exe");
        Assert.Equal(node, Resolve(temp.Path));
    }

    [Fact]
    public void ExplicitAndInstalledNodeTakePrecedenceOverDesktopFallback()
    {
        using var temp = new TestFolder();
        FileAt(temp.Path, "profile", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "bin", "node.exe");
        var installed = FileAt(temp.Path, "programs", "nodejs", "node.exe");
        Assert.Equal(installed, Resolve(temp.Path));
        var packaged = FileAt(temp.Path, "app", "tools", "node", "node.exe");
        Assert.Equal(packaged, Resolve(temp.Path));
        var selected = FileAt(temp.Path, "custom", "node.exe");
        Assert.Equal(selected, Resolve(temp.Path, '"' + selected + '"'));
    }

    [Fact]
    public void QuotedPathAndMissingCandidatesAreHandled()
    {
        using var temp = new TestFolder();
        Assert.Null(Resolve(temp.Path, Path.Combine(temp.Path, "missing.exe"), null, ""));
        var node = FileAt(temp.Path, "path with spaces", "node.exe");
        Assert.Equal(node, Resolve(temp.Path, null, "\"" + Path.GetDirectoryName(node) + "\""));
    }

    [Fact]
    public async Task AvailableNodeActuallyStartsWithAnEmptyChildPath()
    {
        var node = EnvironmentProbe.ResolveNode(null, AppContext.BaseDirectory,
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), []);
        if (node is null) return; // Developer machines may intentionally have PATH-only Node.js.
        var info = new ProcessStartInfo(node)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
        };
        info.Environment["PATH"] = "";
        info.ArgumentList.Add("--version");
        using var process = Process.Start(info)!;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await process.WaitForExitAsync(timeout.Token);
        Assert.Equal(0, process.ExitCode);
        Assert.StartsWith("v", (await process.StandardOutput.ReadToEndAsync()).Trim());
    }
}
