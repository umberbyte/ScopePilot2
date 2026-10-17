using System.Diagnostics;
using System.Text;
using System.Text.Json;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record ZapRunResult(int ExitCode, string Status, string? ReportPath);

public sealed class ZapCliRunner
{
    private readonly Func<DiagnosticToolSettings, ZapPackage, string, string, string, CancellationToken, Action<string>?, Task<int>> _execute;
    private readonly Func<EngagementProject, ZapPackage, CancellationToken, Task<ZapAuthVerification>>? _verifyAuthentication;
    private readonly bool _prepareAddons;
    public ZapCliRunner()
    {
        _execute = ExecuteAsync;
        _verifyAuthentication = new ZapAuthenticationVerifier().VerifyAsync;
        _prepareAddons = true;
    }
    internal ZapCliRunner(Func<DiagnosticToolSettings, ZapPackage, string, string, string, CancellationToken, Action<string>?, Task<int>> execute,
        Func<EngagementProject, ZapPackage, CancellationToken, Task<ZapAuthVerification>>? verifyAuthentication = null) =>
        (_execute, _verifyAuthentication, _prepareAddons) = (execute, verifyAuthentication, false);
    public async Task<ZapRunResult> RunAsync(EngagementProject project, ZapPackage package,
        IProgress<string>? progress, CancellationToken cancellationToken, bool activeScanAcknowledged = false,
        ZapScanTuning? tuning = null)
    {
        if (package.MessageCount == 0 || package.PlanEvidence is null || package.HarEvidence is null)
            throw new InvalidOperationException("観測済み応答を含むHARを取り込んでください。API下書きのみでは診断できません。");
        var settings = new DiagnosticToolSettings { JavaPath = project.DiagnosticTools.JavaPath, ZapJarPath = project.DiagnosticTools.ZapJarPath };
        // 案件側で空欄のときはアプリ設定（%APPDATA%）の既定パスを使う。
        AppSettingsService.ApplyZapToolDefaults(settings);
        var limits = (tuning ?? ZapScanTuning.Defaults).Normalized();
        if (!File.Exists(settings.ZapJarPath) || Path.GetExtension(settings.ZapJarPath) != ".jar" ||
            !File.Exists(settings.JavaPath) || !Path.GetFileName(settings.JavaPath).Equals("java.exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("ZAPのJARとJavaのjava.exeを指定してください。zap.exeはCLI引数に対応していません。");
        ProjectPaths.EnsureChild(ProjectPaths.Root(project), package.Directory);
        await ProjectPaths.VerifyAsync(project, package.PlanEvidence);
        await ProjectPaths.VerifyAsync(project, package.HarEvidence);
        if (package.PlanPath != ProjectPaths.Resolve(project, package.PlanEvidence.LocalPath) ||
            package.HarPath != ProjectPaths.Resolve(project, package.HarEvidence.LocalPath))
            throw new InvalidDataException("計画・HARの証拠参照と実行パスが一致しません。");
        using var harDocument = JsonDocument.Parse(await File.ReadAllTextAsync(package.HarPath, cancellationToken));
        var recordedTargets = harDocument.RootElement.GetProperty("log").GetProperty("entries").EnumerateArray()
            .Select(x => x.GetProperty("request").GetProperty("url").GetString())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x =>
            {
                ApiRequestFormatter.EnsureAllowed(x!, project.AllowedOrigins);
                return ApiRequestFormatter.ValidateUrl(x!).AbsoluteUri;
            })
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (!recordedTargets.ToHashSet(StringComparer.OrdinalIgnoreCase)
                .SetEquals(package.RecordedTargets.Select(x => ApiRequestFormatter.ValidateUrl(x).AbsoluteUri)))
            throw new InvalidDataException("ZAPパッケージの観測済みURLが現在の採用対象と一致しません。新しいパッケージを作成してください。");
        if (package.ActiveScan != project.DiagnosticTools.EnableZapActiveScan)
            throw new InvalidDataException("ZAP診断モードがパッケージ作成時から変更されています。新しいパッケージを作成してください。");
        if (package.UseRecordedAuthentication != (project.DiagnosticTools.EnableZapActiveScan && project.DiagnosticTools.UseRecordedAuthentication))
            throw new InvalidDataException("記録済みCookieによる認証診断の設定がパッケージ作成時から変更されています。新しいパッケージを作成してください。");
        if (package.ActiveScan && !activeScanAcknowledged)
            throw new InvalidOperationException("アクティブ診断は攻撃リクエストを送信します。実行画面でACTIVEと入力して今回の実行を承認してください。");
        var strength = ZapActiveScanProfile.NormalizeStrength(project.DiagnosticTools.ActiveScanStrength);
        var threshold = ZapActiveScanProfile.NormalizeThreshold(project.DiagnosticTools.ActiveScanThreshold);
        var expected = ZapHandoffService.CreatePlan(recordedTargets, Math.Clamp(project.MaxMinutes, 1, 120), package.ActiveScan,
            strength, threshold, package.AuthCookieHeader, package.AuthCookieScopeRegex, limits);
        if (await File.ReadAllTextAsync(package.PlanPath, cancellationToken) != expected)
            throw new InvalidDataException("ScopePilotが生成したパッシブ計画と一致しません。新しいパッケージを作成してください。");
        if (File.Exists(Path.Combine(package.Directory, "zap-run.log")) || File.Exists(Path.Combine(package.Directory, "reports", "zap-report.json")))
            throw new InvalidOperationException("実行済みの証拠を上書きできません。新しいパッケージを作成してください。");
        var home = Path.Combine(package.Directory, "zap-home");
        ProjectPaths.EnsureChild(ProjectPaths.Root(project), home);
        Directory.CreateDirectory(home);
        if (package.ActiveScan)
        {
            var authentication = await VerifyAuthenticationAsync(project, package, progress, cancellationToken);
            await File.WriteAllTextAsync(Path.Combine(package.Directory, "zap-active-authorization.json"), JsonSerializer.Serialize(new
            {
                acknowledgedAt = DateTimeOffset.Now, acknowledgement = "interactive-ACTIVE",
                projectId = project.Id, role = project.ActiveRole, targets = recordedTargets,
                allowedOrigins = project.AllowedOrigins.Split(['\r', '\n', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                authentication,
                settings = new { strength, threshold, maxTargets = ZapActiveScanProfile.NormalizeTargets(project.DiagnosticTools.MaxActiveScanTargets),
                    maxRuleDurationInMins = limits.MaxRuleDurationInMins, maxAlertsPerRule = limits.MaxAlertsPerRule },
                safeguards = new { strength, threshold, delayInMs = limits.DelayInMs, threadPerHost = limits.ThreadPerHost,
                    scanHeadersAllRequests = limits.ScanHeadersAllRequests, addQueryParam = limits.AddQueryParam, handleAntiCSRFTokens = true }
            }, new JsonSerializerOptions { WriteIndented = true }), cancellationToken);
        }
        await ZapHandoffService.WriteStatusAsync(package.Directory, "running", package.MessageCount, null);
        try
        {
            var environment = _prepareAddons
                ? await new ZapAddonService().PrepareAsync(project, package.Directory, home, progress, cancellationToken, package.ActiveScan) : null;
            progress?.Report(package.ActiveScan ? "ZAP: アクティブ診断計画を検証しています。" : "ZAP: パッシブ診断計画を検証しています。");
            var check = await _execute(settings, package, home, "-autocheck", "zap-check.log", cancellationToken, null);
            if (check is not (0 or 2))
                throw new InvalidOperationException($"ZAP計画の検証に失敗しました（終了コード {check}）。zap-check.logを確認してください。");
            await ProjectPaths.VerifyAsync(project, package.PlanEvidence);
            await ProjectPaths.VerifyAsync(project, package.HarEvidence);
            if (environment is not null) await environment.VerifyAsync(cancellationToken);
            progress?.Report(package.ActiveScan
                ? $"ZAP: 保存済み通信を取り込み、承認済みURLへ強度{strength}のアクティブ診断を実行しています。"
                : "ZAP: 保存済み通信のパッシブ解析を実行しています。");
            var summarizer = new ZapOutputSummarizer(package.ActiveScan ? package.RecordedTargets : Array.Empty<string>(), reportJobProgress: true);
            var exit = await _execute(settings, package, home, "-autorun", "zap-run.log", cancellationToken, line =>
            {
                var message = summarizer.Summarize(line);
                if (message is not null) progress?.Report(message);
            });
            if (environment is not null) await environment.VerifyAsync(cancellationToken);
            var report = Path.Combine(package.Directory, "reports", "zap-report.json");
            var status = exit is 0 or 2 && File.Exists(report) ? exit == 2 ? "warnings" : "completed" : "failed";
            await ZapHandoffService.WriteStatusAsync(package.Directory, status, package.MessageCount, exit);
            return new(exit, status, File.Exists(report) ? report : null);
        }
        catch (OperationCanceledException)
        {
            await ZapHandoffService.WriteStatusAsync(package.Directory, "cancelled", package.MessageCount, null);
            throw;
        }
        catch
        {
            await ZapHandoffService.WriteStatusAsync(package.Directory, "failed", package.MessageCount, null);
            throw;
        }
    }

    private async Task<object?> VerifyAuthenticationAsync(EngagementProject project, ZapPackage package,
        IProgress<string>? progress, CancellationToken token)
    {
        if (!package.UseRecordedAuthentication) return new { enabled = false, cookieNames = Array.Empty<string>(), verified = false };
        var names = package.AuthCookieNames ?? [];
        if (names.Count == 0 || package.AuthCookieHeader is null)
            throw new InvalidOperationException("記録済みHARにセッションCookieがありません。ログイン後のHARを取り込むか、認証診断を無効にしてください。");
        if (_verifyAuthentication is null)
            throw new InvalidOperationException("認証の事前確認を構成できませんでした。");
        progress?.Report("ZAP: 記録済みセッションCookieで認証後URLへ到達できるか確認しています。");
        var verification = await _verifyAuthentication(project, package, token);
        if (!verification.Success)
            throw new InvalidOperationException(
                $"認証付き診断の事前確認に失敗しました（{verification.Reason}）。ブラウザーでログインし直してHARを取り込むか、認証診断を無効にしてください。");
        progress?.Report($"ZAP: 認証後URLへの到達を確認しました（HTTP {verification.StatusCode}）。");
        return new
        {
            enabled = true, cookieNames = names, verified = true,
            verifiedUrl = verification.FinalUrl, statusCode = verification.StatusCode, reason = verification.Reason
        };
    }

    private static async Task<int> ExecuteAsync(DiagnosticToolSettings settings, ZapPackage package,
        string home, string action, string logName, CancellationToken token, Action<string>? onLine)
    {
        var start = new ProcessStartInfo(settings.JavaPath)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
            RedirectStandardError = true, WorkingDirectory = package.Directory
        };
        foreach (var argument in new[] { "-jar", Path.GetFullPath(settings.ZapJarPath), "-cmd", "-silent",
            "-loglevel", "DEBUG", "-dir", home, action, package.PlanPath }) start.ArgumentList.Add(argument);
        start.Environment["TEMP"] = home;
        start.Environment["TMP"] = home;
        using var process = Process.Start(start) ?? throw new IOException("ZAPを起動できませんでした。");
        using var registration = token.Register(() =>
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
        });
        // ZAPの出力は終了を待たずにログへ書き込み、停止・異常終了のときもそこまでの内容を残す。
        // ZAPは -cmd 実行中、log4jの詳細を標準出力へ出さないため、-loglevel DEBUG で zap.log に
        // 書かれた詳細（ルール単位の攻撃・警告検出・WARN/ERROR）を逐次読んで同じ進行窓へ流す。
        await using var output = new StreamWriter(Path.Combine(package.Directory, logName), append: false) { AutoFlush = true };
        var gate = new object();
        void WriteLine(string line)
        {
            lock (gate) output.WriteLine(line);
        }
        async Task PumpAsync(StreamReader reader)
        {
            while (await reader.ReadLineAsync() is { } line)
            {
                WriteLine(line);
                onLine?.Invoke(line);
            }
        }
        async Task TailZapLogAsync()
        {
            var zapLogPath = Path.Combine(home, "zap.log");
            long offset = 0;
            while (!process.HasExited)
            {
                await Task.Delay(400, CancellationToken.None);
                offset = await PumpZapLogAsync(zapLogPath, offset, onLine);
            }
            await PumpZapLogAsync(zapLogPath, offset, onLine);
        }
        var pumps = Task.WhenAll(PumpAsync(process.StandardOutput), PumpAsync(process.StandardError), TailZapLogAsync());
        try
        {
            await process.WaitForExitAsync(token);
            await pumps;
            token.ThrowIfCancellationRequested();
            return process.ExitCode;
        }
        catch (OperationCanceledException)
        {
            try { if (!process.HasExited) process.Kill(true); } catch (InvalidOperationException) { }
            await process.WaitForExitAsync(CancellationToken.None);
            try { await pumps.WaitAsync(TimeSpan.FromSeconds(5)); }
            catch (Exception ex) when (ex is TimeoutException or OperationCanceledException) { }
            throw;
        }
    }

    // zap.logは稼働中に追記されるため、前回読んだ位置から末尾までの完全な行だけを流す。
    // zap.logはJVM既定の文字コードで書かれる。転送対象の行はASCII中心のためLatin1でbyte一致読込する。
    private static async Task<long> PumpZapLogAsync(string path, long offset, Action<string>? onLine)
    {
        try
        {
            if (!File.Exists(path)) return offset;
            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (stream.Length < offset) return 0;
            if (stream.Length == offset) return offset;
            stream.Seek(offset, SeekOrigin.Begin);
            using var reader = new StreamReader(stream, Encoding.Latin1);
            var chunk = await reader.ReadToEndAsync();
            var lastNewline = chunk.LastIndexOf('\n');
            if (lastNewline < 0) return offset;
            offset += Encoding.Latin1.GetByteCount(chunk[..(lastNewline + 1)]);
            foreach (var line in chunk[..lastNewline].Split('\n'))
            {
                var trimmed = line.TrimEnd('\r');
                if (trimmed.Length > 0) onLine?.Invoke(trimmed);
            }
            return offset;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return offset;
        }
    }
}
