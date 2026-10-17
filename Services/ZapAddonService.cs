using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record ZapAddonArchive(string Id, string Version, string FileName, string Sha256);
public sealed record ZapEnvironmentSnapshot(string JarSha256, IReadOnlyList<ZapAddonArchive> Addons,
    IReadOnlyDictionary<string, string> RuntimeFiles)
{
    public async Task VerifyAsync(CancellationToken token)
    {
        foreach (var (path, expected) in RuntimeFiles)
            if (await ZapAddonService.HashAsync(path, token) != expected)
                throw new InvalidDataException("ZAP本体またはadd-onが実行中に変更されました。新しい実行を作成してください。");
    }
}

public sealed class ZapAddonService
{
    public static readonly string[] RequiredIds = ["automation", "exim", "network", "pscan", "pscanrules", "reports"];
    public static readonly string[] ActiveScanRequiredIds = [.. RequiredIds, "ascanrules"];
    private readonly Func<DiagnosticToolSettings, string, string[], string, CancellationToken, Task<int>> _execute;
    public ZapAddonService() => _execute = ExecuteAsync;
    internal ZapAddonService(Func<DiagnosticToolSettings, string, string[], string, CancellationToken, Task<int>> execute) => _execute = execute;

    public async Task<ZapEnvironmentSnapshot> PrepareAsync(EngagementProject project, string directory, string home,
        IProgress<string>? progress, CancellationToken token, bool includeActiveScan = false)
    {
        // 案件側で空欄のときはアプリ設定（%APPDATA%）の既定パスを使う。
        AppSettingsService.ApplyZapToolDefaults(project.DiagnosticTools);
        ValidateTools(project.DiagnosticTools);
        ProjectPaths.EnsureChild(ProjectPaths.Root(project), directory);
        ProjectPaths.EnsureChild(directory, home);
        Directory.CreateDirectory(home);
        var cache = ProjectPaths.Resolve(project, "tools/zap-addon-home");
        Directory.CreateDirectory(cache);
        // Serialize use of this project's add-on cache across application instances.
        await using var cacheLock = new FileStream(Path.Combine(cache, "scopepilot.lock"), FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None);
        var install = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(project.DiagnosticTools.ZapJarPath))!, "plugin");
        var available = await ReadArchivesAsync([install, Path.Combine(cache, "plugin")], token);
        var requiredIds = includeActiveScan ? ActiveScanRequiredIds : RequiredIds;
        foreach (var id in requiredIds.Where(id => !available.Any(x => x.Archive.Id == id)))
        {
            progress?.Report($"ZAP Marketplaceから必要add-onを導入しています: {id}");
            var exit = await _execute(project.DiagnosticTools, cache, ["-addoninstall", id],
                Path.Combine(directory, $"zap-addon-install-{id}.log"), token);
            if (exit != 0) throw new IOException($"ZAP add-on {id}の導入に失敗しました。導入ログを確認してください。");
            available = await ReadArchivesAsync([install, Path.Combine(cache, "plugin")], token);
        }
        var missing = requiredIds.Where(id => !available.Any(x => x.Archive.Id == id)).ToArray();
        if (missing.Length > 0) throw new IOException($"必要add-onを確認できません: {string.Join(", ", missing)}");
        // Only downloaded add-ons/dependencies are staged; the installed ZAP remains untouched.
        var pluginHome = Path.Combine(home, "plugin");
        Directory.CreateDirectory(pluginHome);
        foreach (var file in Directory.Exists(Path.Combine(cache, "plugin"))
            ? Directory.GetFiles(Path.Combine(cache, "plugin"), "*.zap") : [])
        {
            ProjectPaths.EnsureChild(cache, file);
            File.Copy(file, Path.Combine(pluginHome, Path.GetFileName(file)), overwrite: true);
        }
        var loadedArchives = await ReadArchivesAsync([install, pluginHome], token);
        var runtime = loadedArchives.ToDictionary(x => x.Path, x => x.Archive.Sha256, StringComparer.OrdinalIgnoreCase);
        var jarPath = Path.GetFullPath(project.DiagnosticTools.ZapJarPath);
        var jarHash = await HashAsync(jarPath, token);
        runtime[jarPath] = jarHash;
        var snapshot = new ZapEnvironmentSnapshot(jarHash, loadedArchives.Select(x => x.Archive).ToArray(), runtime);
        var listExit = await _execute(project.DiagnosticTools, home, ["-addonlist", "-suppinfo"],
            Path.Combine(directory, "zap-addon-list.log"), token);
        if (listExit != 0) throw new IOException("ZAP add-onの起動確認に失敗しました。zap-addon-list.logを確認してください。");
        var inventoryLog = await File.ReadAllTextAsync(Path.Combine(directory, "zap-addon-list.log"), token);
        var loadedLine = Regex.Match(inventoryLog, @"Installed add-ons:\s*(?<addons>[^\r\n]+)", RegexOptions.IgnoreCase).Groups["addons"].Value;
        var runtimeAddons = Regex.Matches(loadedLine, @"\[id=(?<id>[^,\]]+), version=(?<version>[^\]]+)\]")
            .Select(x => new { id = x.Groups["id"].Value, version = x.Groups["version"].Value }).ToArray();
        if (requiredIds.Any(id => !runtimeAddons.Any(x => x.id == id)))
            throw new IOException("必要add-onの読込を確認できません。zap-addon-list.logの対応版・依存関係を確認してください。");
        await snapshot.VerifyAsync(token);
        await File.WriteAllTextAsync(Path.Combine(directory, "zap-environment.json"), JsonSerializer.Serialize(new
        {
            jarSha256 = jarHash, addons = snapshot.Addons, runtimeAddons, requiredIds,
            inventoryKind = "archive-manifests", runtimeInventoryLog = "zap-addon-list.log",
            capturedAt = DateTimeOffset.UtcNow
        }, new JsonSerializerOptions { WriteIndented = true }), token);
        progress?.Report("必要add-onを準備しました。ZAP本体・add-onの版とSHA-256を保存しました。");
        return snapshot;
    }

    public static void ValidateTools(DiagnosticToolSettings tools)
    {
        if (!File.Exists(tools.ZapJarPath) || !Path.GetExtension(tools.ZapJarPath).Equals(".jar", StringComparison.OrdinalIgnoreCase) ||
            !File.Exists(tools.JavaPath) || !Path.GetFileName(tools.JavaPath).Equals("java.exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("ZAPのJARと対応するJavaのjava.exeを指定してください。");
    }

    private static async Task<List<(string Path, ZapAddonArchive Archive)>> ReadArchivesAsync(string[] directories, CancellationToken token)
    {
        var result = new List<(string, ZapAddonArchive)>();
        foreach (var directory in directories.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!Directory.Exists(directory)) continue;
            foreach (var path in Directory.GetFiles(directory, "*.zap").Order())
            {
                ProjectPaths.EnsureChild(directory, path);
                var match = Regex.Match(Path.GetFileName(path), @"^(?<id>.+)-(?:alpha|beta|release)-.+\.zap$");
                if (!match.Success) throw new InvalidDataException("ZAP add-onのファイル名を識別できません。");
                using var archive = ZipFile.OpenRead(path);
                var manifest = archive.GetEntry("ZapAddOn.xml") ?? throw new InvalidDataException("ZAP add-onにmanifestがありません。");
                using var stream = manifest.Open();
                var document = XDocument.Load(stream);
                var version = document.Root?.Element("version")?.Value;
                if (string.IsNullOrWhiteSpace(version)) throw new InvalidDataException("ZAP add-onの版を識別できません。");
                result.Add((path, new(match.Groups["id"].Value, version, Path.GetFileName(path), await HashAsync(path, token))));
            }
        }
        return result;
    }

    internal static async Task<string> HashAsync(string path, CancellationToken token)
    {
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, token)).ToLowerInvariant();
    }

    private static async Task<int> ExecuteAsync(DiagnosticToolSettings tools, string home, string[] arguments,
        string logPath, CancellationToken token)
    {
        var start = new ProcessStartInfo(tools.JavaPath)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
            RedirectStandardError = true, WorkingDirectory = Path.GetDirectoryName(logPath)!
        };
        foreach (var argument in new[] { "-jar", Path.GetFullPath(tools.ZapJarPath), "-cmd", "-silent", "-dir", home }.Concat(arguments))
            start.ArgumentList.Add(argument);
        start.Environment["TEMP"] = home;
        start.Environment["TMP"] = home;
        using var process = Process.Start(start) ?? throw new IOException("ZAP add-on管理を起動できませんでした。");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync(token); }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
            await File.WriteAllTextAsync(logPath, await stdout + await stderr, CancellationToken.None);
        }
        token.ThrowIfCancellationRequested();
        return process.ExitCode;
    }
}
