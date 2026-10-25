using System.Text.Json;
using System.Text.Json.Serialization;
using ScopePilot.Domain;

namespace ScopePilot.Services.WorkflowScan;

// 複数回の状態遷移・複数role比較・トークン系列分析・暗号データ解析・API操作を必要とする脆弱性を
// 専用ワークフローで診断するサービス。ZAPの単一リクエスト型診断では届かない
// 「追加入力待ち」になりやすい検出項目を自動実行して所見化する。
public sealed class WorkflowScanService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public async Task<WorkflowScanResult> RunAsync(EngagementProject project, WorkflowScanOptions options, Action<string>? progress = null, CancellationToken token = default)
    {
        progress ??= _ => { };
        var startedAt = DateTimeOffset.Now;
        var baseUri = new Uri(options.BaseUrl.TrimEnd('/') + "/");
        ApiRequestFormatter.EnsureAllowed(baseUri.ToString(), project.AllowedOrigins);
        if (options.MaxRequests > project.MaxRequests)
            throw new InvalidOperationException($"ワークフロー診断のリクエスト上限（{options.MaxRequests}）が案件の上限（{project.MaxRequests}）を超えています。");
        var result = new WorkflowScanResult
        {
            BaseUrl = baseUri.ToString(),
            StartedAt = startedAt
        };
        var marker = "sp" + Guid.NewGuid().ToString("N")[..12];
        using var client = new WorkflowScanClient(options);
        client.SetRedactionValues([options.Password, $"Sp-{marker}"]);
        try
        {
            progress("ログインを試みます。");
            var authenticated = await WorkflowScanChecks.LoginAsync(client, options.Username, options.Password, progress, token);
            result.Authenticated = authenticated;
            result.OriginalSecurityLevel = await WorkflowScanChecks.ReadSecurityLevelAsync(client, token);
            progress($"現在のセキュリティレベル: {(string.IsNullOrEmpty(result.OriginalSecurityLevel) ? "不明" : result.OriginalSecurityLevel)}");
            var levels = options.SecurityLevels;
            result.TestedSecurityLevels = string.Join(", ", levels);
        foreach (var level in levels)
        {
            progress($"セキュリティレベル {level} でチェックを実行します。");
            await WorkflowScanChecks.SetSecurityLevelAsync(client, level, token);
            var context = new ScanCheckContext(client, marker, level, progress, token)
            {
                // パスワード変更系チェックの実効性・復元を別セッションのログインで確認する検証器。
                PasswordVerifier = async password =>
                {
                    using var probe = new WorkflowScanClient(options);
                    probe.SetRedactionValues([options.Password, password, $"Sp-{marker}"]);
                    return await WorkflowScanChecks.LoginAsync(probe, options.Username, password, _ => { }, token);
                }
            };
            await RunLevelScopedChecksAsync(context, options, progress, token);
            Collect(context, result);
        }
            // レベルに依存しないチェックは1回だけ実行する。
            var once = new ScanCheckContext(client, marker, "", progress, token);
            await RunOnceChecksAsync(once, token);
            Collect(once, result);
        }
        finally
        {
            // 対象のセキュリティレベルを元へ戻す。
            try
            {
                if (!string.IsNullOrEmpty(result.OriginalSecurityLevel))
                    await WorkflowScanChecks.SetSecurityLevelAsync(client, result.OriginalSecurityLevel, token);
            }
            catch (Exception)
            {
                // 復元失敗は診断結果には影響しないため記録のみ行う。
            }
        }
        result.EndedAt = DateTimeOffset.Now;
        result.RequestCount = client.RequestCount;
        var runDirectory = await WriteArtifactsAsync(project, result, token);
        result.RunDirectory = runDirectory;
        progress($"ワークフロー診断完了: 検出 {result.Checks.Count}件、リクエスト {result.RequestCount}件。");
        return result;
    }

    // レベル別に実行するチェック。DVWAでは同一URLでもレベルで挙動が変わるため、
    // 各レベルで同じチェックを繰り返し、成立したレベルを記録する。
    private static async Task RunLevelScopedChecksAsync(ScanCheckContext context, WorkflowScanOptions options, Action<string> progress, CancellationToken token)
    {
        await WorkflowScanChecks.RunCsrfAsync(context, options.Password);
        await WorkflowScanChecks.RunFileUploadAsync(context);
        await WorkflowScanChecks.RunCaptchaBypassAsync(context, options.Password);
        await WorkflowScanChecks.RunWeakSessionAsync(context);
        await WorkflowScanChecks.RunXssReflectedAsync(context);
        await WorkflowScanChecks.RunXssStoredAsync(context);
        await WorkflowScanChecks.RunCspBypassAsync(context);
        await WorkflowScanChecks.RunClientSideTokenAsync(context);
        await WorkflowScanChecks.RunXssDomAsync(context);
        await WorkflowScanChecks.RunAuthorizationBypassAsync(context);
        await WorkflowScanChecks.RunBacOpenAccessAsync(context);
        await WorkflowScanCryptoApiChecks.RunCryptoXorAsync(context);
        await WorkflowScanCryptoApiChecks.RunCryptoEcbAsync(context);
        await WorkflowScanCryptoApiChecks.RunCryptoCbcOracleAsync(context);
        await WorkflowScanCryptoApiChecks.RunSqliVerificationAsync(context);
        await WorkflowScanCryptoApiChecks.RunLfiAsync(context);
        if (token.IsCancellationRequested) throw new OperationCanceledException(token);
    }

    private static async Task RunOnceChecksAsync(ScanCheckContext context, CancellationToken token)
    {
        await WorkflowScanChecks.RunBruteForceAsync(context);
        await WorkflowScanChecks.RunXssDomScriptsAsync(context);
        await WorkflowScanChecks.RunOpenRedirectAsync(context);
        await WorkflowScanCryptoApiChecks.RunApiLegacyAsync(context);
        await WorkflowScanCryptoApiChecks.RunApiMassAssignmentAsync(context);
        await WorkflowScanCryptoApiChecks.RunApiCommandInjectionAsync(context);
        if (token.IsCancellationRequested) throw new OperationCanceledException(token);
    }

    private static void Collect(ScanCheckContext context, WorkflowScanResult result)
    {
        result.Checks.AddRange(context.Results.Where(x => x.Detected));
        result.CheckLogs.AddRange(context.Skips);
        var requests = context.Client.TakeRequestLog();
        if (requests.Count > 0)
            result.CheckLogs.Add(new WorkflowScanCheckLog
            {
                CheckId = "requests",
                SecurityLevel = context.Level,
                Detected = false,
                Note = $"{requests.Count}件のリクエストを送信。",
                Requests = requests.ToList()
            });
    }

    private static async Task<string> WriteArtifactsAsync(EngagementProject project, WorkflowScanResult result, CancellationToken token)
    {
        var runDirectory = ProjectPaths.Resolve(project, $"runs/workflow-{DateTimeOffset.Now:yyyyMMdd-HHmmss}-{Guid.NewGuid().ToString("N")[..8]}");
        Directory.CreateDirectory(runDirectory);
        var reportPath = Path.Combine(runDirectory, "workflow-scan.json");
        await File.WriteAllTextAsync(reportPath, JsonSerializer.Serialize(result, JsonOptions), token);
        await File.WriteAllTextAsync(Path.Combine(runDirectory, "workflow-summary.json"), JsonSerializer.Serialize(new
        {
            status = "completed",
            detectedCount = result.Checks.Count,
            requestCount = result.RequestCount,
            securityLevels = result.TestedSecurityLevels,
            limitations = new[]
            {
                "ワークフロー診断の所見は自動検証に基づきます。確定前に対象・影響の確認してください。",
                "パスワード変更・権限変更を伴う検証は実施後に元の値へ復元しています。"
            }
        }, JsonOptions), token);
        var engagement = new Dictionary<string, object>
        {
            ["mode"] = "workflow-scan",
            ["runStartedAt"] = result.StartedAt,
            ["baseUrl"] = result.BaseUrl,
            ["activeRole"] = project.ActiveRole,
            ["detectedCount"] = result.Checks.Count,
            ["requestCount"] = result.RequestCount
        };
        await File.WriteAllTextAsync(Path.Combine(runDirectory, "engagement.json"), JsonSerializer.Serialize(engagement, JsonOptions), token);
        return ProjectPaths.Relative(project, runDirectory);
    }
}
