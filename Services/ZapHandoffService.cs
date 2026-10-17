using System.Text.Json;
using System.Text.RegularExpressions;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record ZapPackage(string Directory, string PlanPath, string HarPath, int MessageCount,
    EvidenceReference? HarEvidence, EvidenceReference? PlanEvidence, bool ActiveScan,
    IReadOnlyList<string> RecordedTargets,
    bool UseRecordedAuthentication = false, string? AuthCookieHeader = null,
    IReadOnlyList<string>? AuthCookieNames = null, string? AuthCookieScopeRegex = null);

public sealed class ZapHandoffService
{
    public async Task<ZapPackage> BuildAsync(EngagementProject project, ZapScanTuning? tuning = null)
    {
        var scanTuning = (tuning ?? ZapScanTuning.Defaults).Normalized();
        var settings = project.DiagnosticTools;
        var selected = project.Mode == InputMode.ApiDocument
            ? project.ApiRequests.Where(x => x.Selected).Select(x => (x.Method.ToUpperInvariant(), x.Url)).ToArray()
            : project.Candidates.Where(x => x.Selected).Select(x => (x.Representative.Method.ToUpperInvariant(), x.Representative.Url)).ToArray();
        if (selected.Length == 0) throw new InvalidOperationException("診断対象を採用してください。");
        foreach (var (_, url) in selected) ApiRequestFormatter.EnsureAllowed(url, project.AllowedOrigins);
        var activeScan = settings.EnableZapActiveScan;
        var useRecordedAuth = activeScan && settings.UseRecordedAuthentication;
        var maxTargets = ZapActiveScanProfile.NormalizeTargets(settings.MaxActiveScanTargets);
        var patterns = project.Candidates.Where(x => x.Selected).Select(x => x.Pattern).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var entries = new List<JsonElement>();
        var sources = new List<EvidenceReference>();
        foreach (var reference in project.Inputs.Where(x =>
            (x.Kind == "har" || (settings.IncludeReferenceHars && x.Kind == "har-reference")) && x.Role == project.ActiveRole))
        {
            await ProjectPaths.VerifyAsync(project, reference);
            using var document = JsonDocument.Parse(await File.ReadAllTextAsync(ProjectPaths.Resolve(project, reference.LocalPath)));
            var index = 0;
            foreach (var entry in document.RootElement.GetProperty("log").GetProperty("entries").EnumerateArray())
            {
                var pointer = $"/log/entries/{index++}";
                var request = entry.GetProperty("request");
                var url = request.GetProperty("url").GetString() ?? "";
                var method = (request.GetProperty("method").GetString() ?? "GET").ToUpperInvariant();
                var adopted = project.Mode == InputMode.ApiDocument
                    ? selected.Any(x => x.Item1 == method && x.Url == url)
                    : patterns.Contains($"{method} {UrlPatternNormalizer.NormalizeForSelection(url)}");
                if (!adopted || !entry.TryGetProperty("response", out var response) ||
                    !response.TryGetProperty("status", out var status) || !status.TryGetInt32(out var code) || code <= 0) continue;
                ApiRequestFormatter.EnsureAllowed(url, project.AllowedOrigins);
                entries.Add(entry.Clone());
                sources.Add(reference with { Pointer = pointer });
            }
        }
        var recordedTargets = entries.Select(x => x.GetProperty("request").GetProperty("url").GetString() ?? "")
            .Where(x => x.Length > 0).Select(x => ApiRequestFormatter.ValidateUrl(x).AbsoluteUri)
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (activeScan && recordedTargets.Length > maxTargets)
            throw new InvalidOperationException($"アクティブ診断の観測済み対象は{maxTargets}件以下に絞ってください。（診断設定の対象URL上限で変更できます）");
        var auth = useRecordedAuth ? ExtractAuthCookies(entries) : null;
        var directory = ProjectPaths.Resolve(project, $"runs/zap-{DateTimeOffset.Now:yyyyMMdd-HHmmss-fff}-{Guid.NewGuid():N}");
        System.IO.Directory.CreateDirectory(directory);
        System.IO.Directory.CreateDirectory(Path.Combine(directory, "reports"));
        if (project.Mode == InputMode.ApiDocument)
        {
            System.IO.Directory.CreateDirectory(Path.Combine(directory, "requests"));
            var index = 0;
            foreach (var draft in project.ApiRequests.Where(x => x.Selected))
                await File.WriteAllTextAsync(Path.Combine(directory, "requests", $"{++index:D4}.http"), ApiRequestFormatter.Format(draft));
        }
        var harPath = Path.Combine(directory, "selected.har");
        var planPath = Path.Combine(directory, activeScan ? "zap-active.yaml" : "zap-passive.yaml");
        EvidenceReference? harEvidence = null, planEvidence = null;
        var strength = ZapActiveScanProfile.NormalizeStrength(settings.ActiveScanStrength);
        var threshold = ZapActiveScanProfile.NormalizeThreshold(settings.ActiveScanThreshold);
        if (entries.Count > 0)
        {
            await File.WriteAllTextAsync(harPath, JsonSerializer.Serialize(new { log = new { version = "1.2", creator = new { name = "ScopePilot", version = "0.12" }, entries } }));
            await File.WriteAllTextAsync(planPath, CreatePlan(recordedTargets, Math.Clamp(project.MaxMinutes, 1, 120), activeScan, strength, threshold,
                auth?.Header, auth is null ? null : BuildCookieScope(recordedTargets), scanTuning));
            harEvidence = await ProjectPaths.EvidenceAsync(project, harPath, "har");
            planEvidence = await ProjectPaths.EvidenceAsync(project, planPath, "zap-passive-plan");
        }
        await File.WriteAllTextAsync(Path.Combine(directory, "engagement.json"), JsonSerializer.Serialize(new
        {
            mode = activeScan ? "zap-active" : "zap-passive", projectId = project.Id, runStartedAt = DateTimeOffset.Now,
            activeRole = project.ActiveRole, allowedOrigins = project.AllowedOrigins,
            selected = selected.Select(x => new { method = x.Item1, url = x.Url, role = project.ActiveRole }),
            activeScan = activeScan ? new
            {
                enabled = true, targets = recordedTargets, strength, threshold,
                delayInMs = scanTuning.DelayInMs, threadPerHost = scanTuning.ThreadPerHost, maxTargets,
                maxRuleDurationInMins = scanTuning.MaxRuleDurationInMins, maxAlertsPerRule = scanTuning.MaxAlertsPerRule,
                scanHeadersAllRequests = scanTuning.ScanHeadersAllRequests, addQueryParam = scanTuning.AddQueryParam,
                includeReferenceHars = settings.IncludeReferenceHars,
                recordedAuthentication = settings.UseRecordedAuthentication,
                authCookieNames = (IReadOnlyList<string>?)auth?.Names ?? Array.Empty<string>()
            } : null,
            sourceEvidence = sources,
            note = activeScan
                ? "採用対象の保存済み通信を取り込み、明示承認後に対象URLだけをアクティブ診断します。"
                : "採用対象の保存済み通信をZAPへ引き渡します。"
        }, new JsonSerializerOptions { WriteIndented = true }));
        await WriteStatusAsync(directory, "prepared", entries.Count, null);
        await File.WriteAllTextAsync(Path.Combine(directory, "README.txt"),
            "ZAPへの引き渡し\nselected.harは採用対象の保存済み通信です。" +
            (activeScan
                ? $"zap-active.yamlはパッシブ解析後、明示承認された対象URLだけへアクティブ診断を行います（強度{strength}・閾値{threshold}・{scanTuning.ThreadPerHost}スレッド・{scanTuning.DelayInMs}ms間隔・ルールごとの上限{scanTuning.MaxRuleDurationInMins}分）。攻撃リクエストが送信されます。\n" +
                  (auth is not null
                      ? "記録済みセッションCookieを再利用して認証後の状態で診断します。実行前に認証後URLへの到達確認を行います。Cookieの値はselected.harと同じ扱いで保管してください。\n"
                      : "") +
                  (settings.IncludeReferenceHars ? "探索時に記録したZAP通信（HAR参照）も対象抽出に使用しています。\n" : "")
                : "zap-passive.yamlは再送せずパッシブ解析します。\n") +
            "必要なZAPアドオン: Automation Framework / Import/Export / Network / Passive Scanner / Report Generation / パッシブ診断ルール" +
            (activeScan ? " / Active Scanner Rules" + (auth is not null ? " / Replacer" : "") : "") + "。不足分は実行前にプロジェクト専用ホームへ導入し、版・SHAをzap-environment.jsonへ記録します。\n" +
            "［Playwrightで記録］で収集したHAR・trace・Historyの対応は元の記録フォルダーのbrowser-zap-correlation.jsonにあります。ロールはラベルであり、主体・実影響の確認を意味しません。\n" +
            "API下書きのrequests/*.httpはZAPのManual Request Editorへ貼り付けてレビューできます。下書きには観測済み応答がないため、それだけでは診断開始できません。\n" +
            "診断警告は実影響未確認として取り込みます。原本HAR・ログ・ZAPレポートには秘密情報が含まれる可能性があるため、ローカル証拠として保管してください。\n");
        return new(directory, planPath, harPath, entries.Count, harEvidence, planEvidence, activeScan, recordedTargets,
            useRecordedAuth, auth?.Header, auth?.Names, auth is null ? null : BuildCookieScope(recordedTargets));
    }

    internal static (string Header, IReadOnlyList<string> Names)? ExtractAuthCookies(IEnumerable<JsonElement> entries)
    {
        var values = new List<string>();
        foreach (var entry in entries)
        {
            if (!entry.TryGetProperty("request", out var request) || !request.TryGetProperty("headers", out var headers)) continue;
            foreach (var header in headers.EnumerateArray())
            {
                if (!header.TryGetProperty("name", out var name) || !header.TryGetProperty("value", out var value)) continue;
                if (!name.GetString()?.Equals("cookie", StringComparison.OrdinalIgnoreCase) ?? true) continue;
                var headerValue = value.GetString();
                if (!string.IsNullOrWhiteSpace(headerValue)) values.Add(headerValue);
            }
        }
        var names = new List<string>();
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var headerValue in values)
            foreach (var pair in headerValue.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var index = pair.IndexOf('=');
                if (index <= 0) continue;
                var cookieName = pair[..index].Trim();
                if (cookieName.Length == 0) continue;
                if (!map.ContainsKey(cookieName)) names.Add(cookieName);
                map[cookieName] = pair[(index + 1)..].Trim();
            }
        if (names.Count == 0) return null;
        return (string.Join("; ", names.Select(x => $"{x}={map[x]}")), names.ToArray());
    }

    // ZAP replacer compares the rule URL with matches() (full-string), so the
    // pattern must allow any path, query, or fragment after the origin.
    internal static string BuildCookieScope(IEnumerable<string> targetUrls) =>
        "^(?:" + string.Join("|", targetUrls
            .Select(x => Regex.Escape(new Uri(ApiRequestFormatter.ValidateUrl(x).AbsoluteUri).GetLeftPart(UriPartial.Authority)))
            .Distinct(StringComparer.OrdinalIgnoreCase)) + ")(?:[/:?#].*)?$";

    internal static string CreatePlan(IEnumerable<string> targetUrls, int minutes, bool activeScan = false,
        string strength = ZapActiveScanProfile.DefaultStrength, string threshold = ZapActiveScanProfile.DefaultThreshold,
        string? sessionCookie = null, string? cookieScope = null, ZapScanTuning? tuning = null)
    {
        var limits = (tuning ?? ZapScanTuning.Defaults).Normalized();
        var targets = targetUrls.Select(x => ApiRequestFormatter.ValidateUrl(x).AbsoluteUri)
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var roots = targets.Select(x => new Uri(x).GetLeftPart(UriPartial.Path))
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var plan =
        "env:\n  contexts:\n    - name: scopepilot-recorded\n      urls:\n" +
        string.Concat(roots.Select(x => "        - " + JsonSerializer.Serialize(x) + "\n")) +
        (activeScan ? "      includePaths:\n" + string.Concat(roots.Select(x =>
            "        - '^" + Regex.Escape(x).Replace("'", "''", StringComparison.Ordinal) + "(?:\\?.*)?$'\n")) : "") +
        "  parameters:\n    failOnError: true\n    failOnWarning: false\n    progressToStdout: true\n" +
        "jobs:\n  - type: import\n    parameters:\n      type: har\n      fileName: selected.har\n" +
        $"  - type: passiveScan-wait\n    parameters:\n      maxDuration: {minutes}\n" +
        (!activeScan || sessionCookie is null ? "" :
            "  - type: replacer\n    parameters:\n      deleteAllRules: false\n    rules:\n" +
            "      - description: scopepilot-session-cookie\n" +
            "        url: " + JsonSerializer.Serialize(cookieScope) + "\n" +
            "        matchType: req_header\n" +
            "        matchString: Cookie\n" +
            "        matchRegex: false\n" +
            "        replacementString: " + JsonSerializer.Serialize(sessionCookie) + "\n") +
        (activeScan ? string.Concat(targets.Select(x =>
            "  - type: activeScan\n    parameters:\n      context: scopepilot-recorded\n" +
            "      url: " + JsonSerializer.Serialize(x) + "\n" +
            $"      defaultStrength: {strength}\n      defaultThreshold: {threshold}\n" +
            $"      maxRuleDurationInMins: {limits.MaxRuleDurationInMins}\n" +
            $"      maxScanDurationInMins: {minutes}\n" +
            $"      addQueryParam: {limits.AddQueryParam.ToString().ToLowerInvariant()}\n      delayInMs: {limits.DelayInMs}\n      handleAntiCSRFTokens: true\n" +
            $"      scanHeadersAllRequests: {limits.ScanHeadersAllRequests.ToString().ToLowerInvariant()}\n      threadPerHost: {limits.ThreadPerHost}\n      maxAlertsPerRule: {limits.MaxAlertsPerRule}\n")) : "") +
        "  - type: report\n    parameters:\n      template: traditional-json\n      reportDir: reports\n      reportFile: zap-report\n      displayReport: false\n" +
        "  - type: report\n    parameters:\n      template: traditional-html\n      reportDir: reports\n      reportFile: zap-report\n      displayReport: false\n";
        return plan;
    }

    internal static Task WriteStatusAsync(string directory, string status, int messages, int? exitCode) =>
        File.WriteAllTextAsync(Path.Combine(directory, "zap-summary.json"), JsonSerializer.Serialize(new
        { status, messageCount = messages, exitCode, updatedAt = DateTimeOffset.Now }));
}

