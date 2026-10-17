using System.Diagnostics;
using System.Text;
using System.Text.Json;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record ZapBrowserCaptureResult(string Directory, IReadOnlyList<EvidenceReference> Evidence, int MatchedMessages, string Status);

public sealed class ZapBrowserRecordingService
{
    public async Task<ZapBrowserCaptureResult> RecordAsync(EngagementProject project, string directory,
        IProgress<string>? progress, CancellationToken token, bool fixture = false)
    {
        ProjectPaths.EnsureChild(ProjectPaths.Root(project), directory);
        Directory.CreateDirectory(directory);
        var role = project.ActiveRole;
        var startUrl = project.Mode == InputMode.ApiDocument ? project.StartUrl
            : project.Candidates.FirstOrDefault(x => x.Selected)?.Representative.Url ?? project.StartUrl;
        ApiRequestFormatter.EnsureAllowed(startUrl, project.AllowedOrigins);
        var origins = project.AllowedOrigins.Split(['\r', '\n', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(x => ApiRequestFormatter.ValidateUrl(x).GetLeftPart(UriPartial.Authority)).Distinct().ToArray();
        var evidence = new List<EvidenceReference>();
        var matched = 0;
        var status = "failed";
        await ZapHandoffService.WriteStatusAsync(directory, "running", 0, null);
        try
        {
            var environment = await new ZapAddonService().PrepareAsync(project, directory, Path.Combine(directory, "zap-proxy-home"), progress, token);
            await using var zap = await ManagedZapProxy.StartAsync(project, directory, progress, token, portOverride: 0);
            var installed = await zap.Api.InstalledAddonsAsync(token);
            var loaded = installed.EnumerateArray().Select(x => x.GetProperty("id").GetString()).ToHashSet();
            if (ZapAddonService.RequiredIds.Any(id => !loaded.Contains(id)))
                throw new IOException("必要add-onがZAPに読み込まれていません。zap-loaded-addons.jsonとログを確認してください。");
            await File.WriteAllTextAsync(Path.Combine(directory, "zap-loaded-addons.json"), installed.GetRawText(), token);
            await File.WriteAllTextAsync(Path.Combine(directory, "browser-config.json"), JsonSerializer.Serialize(new
            {
                startUrl, allowedOrigins = origins, proxy = zap.Url, role,
                maxRequests = Math.Clamp(project.MaxRequests, 1, 50000), maxMinutes = Math.Clamp(project.MaxMinutes, 1, 120)
            }), token);
            var exit = await RecordBrowserAsync(directory, progress, token, zap, fixture);
            // User stop is graceful; finish saving originals before the owned ZAP is stopped.
            using var finalize = new CancellationTokenSource(TimeSpan.FromSeconds(90));
            var finishToken = finalize.Token;
            var limitation = "";
            try { await zap.Api.WaitForPassiveDrainAsync(TimeSpan.FromSeconds(30), finishToken); }
            catch (IOException ex) { limitation = ex.Message; }
            await zap.Api.ExportHistoryAsync(Path.Combine(directory, "zap-history.json"), Math.Clamp(project.MaxRequests, 1, 50000), finishToken);
            await zap.Api.ExportHarAsync(Path.Combine(directory, "zap-browser.har"), 0, Math.Clamp(project.MaxRequests, 1, 50000), project.AllowedOrigins, finishToken);
            await environment.VerifyAsync(finishToken);
            var browserHar = Path.Combine(directory, "browser.har");
            if (!File.Exists(browserHar)) throw new IOException("PlaywrightのHARが保存されませんでした。ブラウザー記録ログを確認してください。");
            using var har = JsonDocument.Parse(await File.ReadAllTextAsync(browserHar, finishToken));
            using var history = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(directory, "zap-history.json"), finishToken));
            var matches = ZapCaptureCorrelator.Match(har.RootElement, history.RootElement);
            matched = matches.Count(x => x.MessageId is not null);
            foreach (var (name, kind) in new[]
            {
                ("browser.har", "har"), ("zap-browser.har", "har-reference"), ("zap-history.json", "zap-history"),
                ("browser-trace.zip", "playwright-trace"), ("browser-events.jsonl", "browser-events"),
                ("zap-environment.json", "zap-environment"), ("zap-loaded-addons.json", "zap-addons")
            })
                if (File.Exists(Path.Combine(directory, name)))
                    evidence.Add((await ProjectPaths.EvidenceAsync(project, Path.Combine(directory, name), kind)) with { Role = role });
            status = exit == 0 && matches.Count > 0 && matches.All(x => x.MessageId is not null) && limitation.Length == 0 ? "recorded" : "partial";
            await File.WriteAllTextAsync(Path.Combine(directory, "browser-zap-correlation.json"), JsonSerializer.Serialize(new
            {
                conditionSeriesId = Path.GetFileName(directory), subject = role, identityVerified = false,
                status, matchedMessages = matched, browserMessages = matches.Count, matches, evidence,
                limitation, effectOracle = (string?)null, effectObserved = (bool?)null,
                note = "HTTP・セッション値の一致を確認した通信記録です。主体・必要条件への到達・実影響の判定は未実施です。"
            }, new JsonSerializerOptions { WriteIndented = true }), finishToken);
            evidence.Add(await ProjectPaths.EvidenceAsync(project, Path.Combine(directory, "browser-zap-correlation.json"), "zap-correlation"));
            return new(directory, evidence, matched, status);
        }
        catch (OperationCanceledException) { status = "cancelled"; throw; }
        finally { await ZapHandoffService.WriteStatusAsync(directory, status, matched, null); }
    }

    private static async Task<int> RecordBrowserAsync(string directory, IProgress<string>? progress, CancellationToken token,
        ManagedZapProxy zap, bool fixture)
    {
        var node = EnvironmentProbe.FindNode() ?? throw new FileNotFoundException(EnvironmentProbe.NodeNotFoundMessage);
        var script = Path.Combine(AppContext.BaseDirectory, "tools", "zap-browser-record.js");
        if (!File.Exists(script)) throw new FileNotFoundException("Playwright記録スクリプトがありません。", script);
        var start = new ProcessStartInfo(node)
        {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        start.ArgumentList.Add(script);
        start.ArgumentList.Add(directory);
        if (fixture) { start.ArgumentList.Add("--headless"); start.ArgumentList.Add("--fixture"); }
        using var process = Process.Start(start) ?? throw new IOException("Playwrightを起動できませんでした。");
        var output = new StringBuilder();
        async Task ReadOutputAsync()
        {
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                output.AppendLine(line);
                if (line == "BROWSER_READY") progress?.Report("Playwright記録中: ブラウザーが準備できました。正常操作を手動で行ってください。");
            }
        }
        var stdout = ReadOutputAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        progress?.Report("Playwrightの別ブラウザーで正常操作を記録しています。終了時は［停止］を押してください。選択ロールはラベルとして保存します。");
        try
        {
            while (!process.HasExited && !token.IsCancellationRequested)
            {
                if (!zap.IsAlive) throw new IOException("ZAPプロキシが停止しました。記録を終了します。");
                await Task.Delay(250);
            }
        }
        finally
        {
            if (!process.HasExited)
            {
                try { await process.StandardInput.WriteLineAsync("close"); await process.StandardInput.FlushAsync(); } catch (IOException) { }
                using var close = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                try { await process.WaitForExitAsync(close.Token); }
                catch (OperationCanceledException) { process.Kill(entireProcessTree: true); }
            }
            await process.WaitForExitAsync(CancellationToken.None);
            await stdout;
            await File.WriteAllTextAsync(Path.Combine(directory, "browser-console.log"), output.ToString() + await stderr);
        }
        return process.ExitCode;
    }
}
