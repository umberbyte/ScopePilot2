using System.Security.Cryptography;
using System.Text;
using ScopePilot.Domain;

namespace ScopePilot.Services.Reports;

public sealed class ReportDocumentV2Builder
{
    public const string TemplateId = "scopepilot-assurance-ja-v2";
    public const string AutomatedAssessmentAssumption = "ご依頼いただいたものはツールによる自動診断であり、手動での診断は作業範囲外となります。";
    private const string Missing = "未入力";

    public async Task<ReportDocumentV2> BuildAsync(EngagementProject project, DateTimeOffset generatedAt)
    {
        ArgumentNullException.ThrowIfNull(project);
        var settings = project.Report ?? new ReportSettings();
        var evidenceSeeds = EvidenceSeeds(project).GroupBy(x => x.Key, StringComparer.Ordinal)
            .Select(x => new EvidenceSeed(x.Key, x.First().Reference, x.Where(y => y.CapturedAt is not null).Min(y => y.CapturedAt)))
            .OrderBy(x => x.Reference.LocalPath, StringComparer.Ordinal)
            .ThenBy(x => x.Reference.Sha256, StringComparer.Ordinal).ThenBy(x => x.Reference.Pointer, StringComparer.Ordinal).ToArray();
        var evidenceIds = evidenceSeeds.Select((x, index) => (x.Key, Id: $"E-{index + 1:000}"))
            .ToDictionary(x => x.Key, x => x.Id, StringComparer.Ordinal);
        var assets = BuildAssets(project);
        var assetByHost = assets.Where(x => x.Fqdn != Missing).ToDictionary(x => x.Fqdn, x => x.Id, StringComparer.OrdinalIgnoreCase);

        var findings = new List<ReportFindingV2>();
        findings.AddRange(await BuildToolFindingsAsync(project, evidenceIds, assetByHost));
        findings.AddRange(BuildRecordedFindings(project, assetByHost));
        findings.AddRange(await BuildBrunoFindingsAsync(project, evidenceIds, assetByHost));

        var related = findings.SelectMany(x => x.EvidenceIds.Select(id => (EvidenceId: id, FindingId: x.Id)))
            .GroupBy(x => x.EvidenceId, StringComparer.Ordinal).ToDictionary(x => x.Key,
                x => (IReadOnlyList<string>)x.Select(y => y.FindingId).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray(), StringComparer.Ordinal);
        var evidence = evidenceSeeds.Select(x => new ReportEvidenceV2(
            evidenceIds[x.Key], DisplayEvidenceType(x.Reference.Kind), x.Reference.LocalPath,
            x.Reference.Sha256, x.CapturedAt, Value(x.Reference.Sensitivity), "原本・本文非掲載",
            related.GetValueOrDefault(evidenceIds[x.Key], Array.Empty<string>()))).ToArray();

        var severityCounts = SeverityOrder.Select(x => new KeyValuePair<string, int>(x, findings.Count(y => y.Severity == x)))
            .ToDictionary(x => x.Key, x => x.Value, StringComparer.Ordinal);
        var validationCounts = ValidationOrder.Select(x => new KeyValuePair<string, int>(x, findings.Count(y => y.ValidationStatus == x)))
            .ToDictionary(x => x.Key, x => x.Value, StringComparer.Ordinal);
        var highest = SeverityOrder.FirstOrDefault(x => findings.Any(y => y.Severity == x)) ?? "未評価";
        var priorities = Lines(settings.Priorities);
        var limitations = Lines(settings.MajorLimitations).Concat(findings.Select(x => x.Limitations).Where(x => x != Missing))
            .Distinct(StringComparer.Ordinal).ToList();
        if (project.DiagnosticObservations.Count > 0)
            limitations.Add("外部診断ツールの警告は、成立条件と業務影響を担当者が確認するまで推定として扱います。");
        if (limitations.Count == 0) limitations.Add(Missing);

        var metadata = new ReportMetadataV2(
            $"SP-{generatedAt:yyyyMMdd}-{project.Id.ToString("N")[..8].ToUpperInvariant()}", Value(settings.Version),
            Value(settings.DocumentStatus), Value(settings.Classification), generatedAt, Value(settings.Author), Value(settings.Reviewer),
            Value(settings.Approver), DefaultList(Lines(settings.Distribution)),
            [new(Value(settings.Version), generatedAt, "初版生成", Value(settings.Author))]);
        var (assessmentStartedAt, assessmentEndedAt) = EffectiveAssessmentPeriod(project, settings);
        var assessmentRoles = EffectiveRoles(project, findings);
        var assessment = new AssessmentMetadataV2(
            assessmentStartedAt, assessmentEndedAt, Value(settings.AssessmentType), BuildMethods(project),
            DefaultList(Lines(settings.SourceIps)), DefaultList(Lines(project.AllowedOrigins)), DefaultList(Lines(project.SupportingOrigins)),
            assessmentRoles, DefaultList(Lines(project.ForbiddenActions).Append("設定変更")), DefaultList(Lines(settings.Exclusions)),
            DefaultList(Lines(settings.Assumptions).Append(AutomatedAssessmentAssumption)), new(project.MaxRequests, project.MaxMinutes, project.MaxPages), BuildTools(project));
        var summary = new ReportSummaryV2(
            Value(settings.Conclusion, "総合所見は担当者が対象範囲、業務影響、未実施項目を確認して確定してください。"),
            highest, severityCounts, validationCounts, DefaultList(priorities), limitations.Distinct(StringComparer.Ordinal).ToArray());
        var responses = findings.Select(x => new ReportResponseV2(x.Id, Missing, Missing, null, "未着手", null, "未実施", Missing, Array.Empty<string>())).ToArray();
        var notes = new[]
        {
            "本報告書は記載した対象、期間、権限、診断手法および制約の範囲で確認した結果を示します。",
            "未実施または未観測の機能を含むシステム全体の安全性を保証するものではありません。",
            "Cookie、Authorization、セッショントークン、API キー、パスワードは提出用文書へ原文のまま掲載しません。",
            string.IsNullOrWhiteSpace(settings.Contact) ? "問い合わせ先: 未入力" : "問い合わせ先: " + settings.Contact
        };

        return new("2", TemplateId, metadata,
            new(project.Id, ReportName(project.Name, settings.SystemName), Value(settings.SystemName, project.Name), Value(settings.ClientName), Value(settings.ServiceProvider)),
            assessment, summary, assets, BuildCoverage(project, evidenceIds), findings, evidence, responses, notes);
    }

    private static async Task<IReadOnlyList<ReportFindingV2>> BuildToolFindingsAsync(EngagementProject project,
        IReadOnlyDictionary<string, string> evidenceIds, IReadOnlyDictionary<string, string> assetByHost)
    {
        var reads = await new ZapAlertDetailsService().ReadManyAsync(project,
            project.DiagnosticObservations.Where(x => x.Tool.Equals("ZAP", StringComparison.OrdinalIgnoreCase)));
        var detailByObservationId = reads.Where(x => x.Details is not null).GroupBy(x => x.Observation.Id, StringComparer.Ordinal)
            .ToDictionary(x => x.Key, x => x.First().Details!, StringComparer.Ordinal);
        return project.DiagnosticObservations.GroupBy(x => new { x.Tool, x.RuleId, x.Title, x.Role })
            .OrderBy(x => x.Key.Tool, StringComparer.Ordinal).ThenBy(x => x.Key.RuleId, StringComparer.Ordinal)
            .ThenBy(x => x.Key.Role, StringComparer.Ordinal).Select(group =>
            {
                var first = group.First();
                var explanation = JapaneseZapAlertCatalog.Find(first.Tool, first.RuleId);
                var id = "W-" + StableId($"{first.Tool}|{first.RuleId}|{first.Title}|{first.Role}");
                var ids = group.Select(x => evidenceIds.GetValueOrDefault(EvidenceKey(x.Evidence))).Where(x => x is not null)
                    .Cast<string>().Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
                var urls = group.Select(x => SafeUrl(x.Url)).Where(x => x != Missing).Distinct(StringComparer.Ordinal).ToArray();
                var detail = group.Select(x => detailByObservationId.GetValueOrDefault(x.Id))
                    .FirstOrDefault(x => x is not null && (x.Request.Length > 0 || DetailValue(x.Description) is not null))
                    ?? group.Select(x => detailByObservationId.GetValueOrDefault(x.Id)).FirstOrDefault(x => x is not null);
                var cweIds = DetailValue(detail?.Cwe) is { } cwe && int.TryParse(cwe, out var cweNumber) && cweNumber > 0
                    ? new[] { $"CWE-{cweNumber}" } : Array.Empty<string>();
                var guidelineReferences = OwaspTop10For(cweIds).ToArray();
                var references = ReferenceLines(detail?.References).Concat(explanation is null ? [] : new[] { explanation.SourceUrl })
                    .Distinct(StringComparer.Ordinal).ToArray();
                var description = explanation?.Description ?? DetailValue(detail?.Description)
                    ?? "外部診断ツールが警告を記録しました。成立条件と実影響は確認されていません。";
                var additional = DetailValue(detail?.ExternalInteraction);
                var technicalEvidence = new ReportTechnicalEvidenceV2(
                    detail?.Request ?? "", detail?.Response ?? "", detail?.AttackInput ?? "", detail?.ObservedEvidence ?? "",
                    additional ?? "", detail is null
                        ? "ZAP原本の詳細を照合できませんでした。証拠索引の原本とSHA-256を確認してください。"
                        : detail.Request.Length == 0 && detail.Response.Length == 0
                            ? "このZAP原本にはHTTP通信詳細がありません。traditional-json-plusで実行した新しい診断から収集されます。"
                            : "ZAP診断時の代表通信です。秘密値・個人情報候補を提出用に伏せ字処理しています。");
                var stackMismatch = HasTechnologyStackMismatch(detail);
                return new ReportFindingV2(id, explanation?.Title ?? Value(first.Title), "ツール警告", NormalizeSeverity(first.Severity),
                    "未評価", stackMismatch ? "判定保留" : "推定", Value(first.ConfidenceDisplay), new(Missing, null, Missing), cweIds,
                    detail?.CveIds ?? Array.Empty<string>(), guidelineReferences, AssetIds(urls, assetByHost), Value(first.Method),
                    urls.Length == 0 ? Missing : string.Join("\n", urls), Value(first.Parameter), Value(first.Role), first.Tool, group.Min(x => x.ImportedAt),
                    description, "担当者による成立条件の確認が必要です。",
                    DetailValue(detail?.Description) ?? Missing, ExpectedImpact(NormalizeSeverity(first.Severity)),
                    new(Missing, Array.Empty<string>(), Missing, DetailValue(detail?.ObservedEvidence)
                        ?? "ツール警告を取り込んだ状態で、手動再現は未実施です。"), technicalEvidence, ids,
                    new(Missing, DetailValue(detail?.Recommendation) ?? explanation?.Recommendation ?? Missing),
                    "同一条件で正常動作と警告の解消を確認します。", references,
                    stackMismatch ? "送信ペイロードと観測された技術スタックが一致しないため、自動判定を保留しました。" : "成立と実影響は未確認です。");
            }).ToArray();
    }

    private static IReadOnlyList<ReportFindingV2> BuildRecordedFindings(EngagementProject project,
        IReadOnlyDictionary<string, string> assetByHost) => project.Findings.Select((finding, index) =>
    {
        var urls = Lines(finding.AffectedUrls).Select(SafeUrl).Where(x => x != Missing).Distinct(StringComparer.Ordinal).ToArray();
        var id = FindingId(finding.FindingId, "F", index);
        return new ReportFindingV2(id, Value(finding.Title), Value(finding.Category), NormalizeSeverity(finding.Severity), "未評価",
            NormalizeValidation(finding.Status), Value(finding.Confidence), new(Missing, null, Missing), Array.Empty<string>(), Array.Empty<string>(),
            DefaultList(Lines(finding.GuidelineBasis)), AssetIds(urls, assetByHost), Missing, urls.Length == 0 ? Missing : string.Join("\n", urls), Missing, Missing,
            "探索所見", finding.ObservedAt, Value(finding.Description), Missing, Missing, "業務影響は未入力です。",
            new(Missing, Array.Empty<string>(), Missing, Value(BrunoEvidenceReportFormatter.RedactForReport(finding.Evidence))),
            new("", "", "", BrunoEvidenceReportFormatter.RedactForReport(finding.Evidence), "", "担当者が記録した証跡です。"),
            Array.Empty<string>(), new(Missing, Missing), "修正確認条件は未入力です。", Array.Empty<string>(), Value(finding.Limitations));
    }).ToArray();

    private static async Task<IReadOnlyList<ReportFindingV2>> BuildBrunoFindingsAsync(EngagementProject project,
        IReadOnlyDictionary<string, string> evidenceIds, IReadOnlyDictionary<string, string> assetByHost)
    {
        var output = new List<ReportFindingV2>();
        foreach (var (item, index) in project.BrunoVerifications.Select((x, i) => (x, i)))
        {
            var exchange = await BrunoEvidenceReportFormatter.ReadAsync(project, item);
            var url = SafeUrl(item.Url);
            var evidenceId = evidenceIds.GetValueOrDefault(EvidenceKey(item.Exchange));
            var actual = exchange.Error.Length > 0 ? exchange.Error : Value(item.Result);
            output.Add(new(FindingId(item.Id, "B", index), Value(item.Title), "手動確認", "未評価", "未評価",
                item.Status switch { BrunoVerificationStatus.Confirmed => "確認済み", BrunoVerificationStatus.NotConfirmed => "未再現", _ => "判定保留" },
                "高", new(Missing, null, Missing), Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>(), AssetIds([url], assetByHost),
                Value(item.Method), url, Missing, Value(item.Role), "Bruno 手動確認", item.RecordedAt, Value(item.Result),
                item.Status == BrunoVerificationStatus.Blocked ? Value(item.RequiredInput) : Missing, Missing, "業務影響は未入力です。",
                new(Value(item.RequiredInput), Array.Empty<string>(), Missing, Value(actual)),
                new(exchange.Request, exchange.Response, "", "", "", exchange.Error.Length > 0
                    ? exchange.Error : "Bruno手動確認時の通信です。秘密値・個人情報候補を提出用に伏せ字処理しています。"),
                evidenceId is null ? Array.Empty<string>() : [evidenceId],
                new(Missing, Missing), "同じ対象、ロール、入力条件で再確認します。", Array.Empty<string>(), Value(item.BlockReason)));
        }
        return output;
    }

    private static IReadOnlyList<ReportAssetV2> BuildAssets(EngagementProject project)
    {
        var sources = new List<(string Url, string Name)> { (project.StartUrl, project.Name) };
        sources.AddRange(project.Requests.Select(x => (x.Url, x.PageTitle)));
        sources.AddRange(project.Candidates.Where(x => x.Selected).Select(x => (x.Representative.Url, x.Representative.PageTitle)));
        sources.AddRange(project.DiagnosticObservations.Select(x => (x.Url, x.Title)));
        sources.AddRange(project.BrunoVerifications.Select(x => (x.Url, x.Title)));
        return sources.Select(x => (Url: SafeUrl(x.Url), x.Name)).Where(x => Uri.TryCreate(x.Url, UriKind.Absolute, out _))
            .GroupBy(x => new Uri(x.Url).Host, StringComparer.OrdinalIgnoreCase).OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase)
            .Select((group, index) => new ReportAssetV2($"A-{index + 1:000}",
                Value(group.Select(x => x.Name).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x)), group.Key), group.Key,
                Array.Empty<string>(), group.Select(x => x.Url).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray(), Missing)).ToArray();
    }

    private static IReadOnlyList<CoverageItemV2> BuildCoverage(EngagementProject project, IReadOnlyDictionary<string, string> evidenceIds)
    {
        var rows = new List<CoverageItemV2>();
        var targets = project.Requests.Select(x => $"{x.Method} {SafeUrl(x.Url)} → HTTP {x.StatusCode?.ToString() ?? "未記録"}")
            .Distinct(StringComparer.Ordinal).ToArray();
        rows.Add(new("SCOPE-001", "対象 URL と認証ロールの整理", project.Requests.Count > 0 ? "実施済み" : "未実施",
            "探索記録", DefaultList(Lines(project.Roles)), targets, Array.Empty<string>(), project.Requests.Count > 0 ? "" : "観測通信がありません。"));
        rows.Add(new("TOOL-ZAP", "外部診断ツール警告の取込", project.DiagnosticObservations.Count > 0 ? "一部実施" : "未実施", "ZAP",
            DefaultList(project.DiagnosticObservations.Select(x => Value(x.Role)).Distinct(StringComparer.Ordinal)),
            project.DiagnosticObservations.Select(x => SafeUrl(x.Url)).Distinct(StringComparer.Ordinal).Take(20).ToArray(),
            project.DiagnosticObservations.Select(x => evidenceIds.GetValueOrDefault(EvidenceKey(x.Evidence))).Where(x => x is not null).Cast<string>()
                .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray(), "警告の成立と業務影響は別途確認が必要です。"));
        var excluded = project.Candidates.Where(x => !x.Selected).Select(x =>
            $"{SafeUrl(x.Representative.Url)} — {Value(x.Reason, Value(x.Decision, "対象外理由未記録"))}")
            .Distinct(StringComparer.Ordinal).ToArray();
        rows.Add(new("SCOPE-EXCLUDED", "診断対象外 URL と理由", excluded.Length > 0 ? "対象外" : "該当なし", "対象選定記録",
            DefaultList(Lines(project.Roles)), excluded, Array.Empty<string>(), excluded.Length > 0 ? "各URLの対象外理由を併記しています。" : "対象外URLは記録されていません。"));
        foreach (var (id, title, enabled) in GuidelineRows(project.Guidelines))
            rows.Add(new(id, title, enabled ? "判定保留" : "対象外", "ガイドライン選択", DefaultList(Lines(project.Roles)), targets,
                Array.Empty<string>(), enabled ? "項目単位の実施記録との対応付けが必要です。" : "案件設定で選択されていません。"));
        return rows;
    }

    private static IEnumerable<(string Id, string Title, bool Enabled)> GuidelineRows(GuidelineSelectionOptions options)
    {
        options ??= new();
        yield return ("GUIDE-WAPG", "Web Application Pentest Guidelines", options.WebAppPentestGuidelines);
        yield return ("GUIDE-TOP10", "OWASP Top 10", options.OwaspTop10);
        yield return ("GUIDE-ASVS", "OWASP ASVS", options.Asvs);
        yield return ("GUIDE-WSTG", "OWASP WSTG", options.Wstg);
        yield return ("GUIDE-AISVS", "OWASP AISVS", options.Aisvs);
        yield return ("GUIDE-CLOUD", "OWASP Cloud Native Application Security Top 10", options.CloudNativeTop10);
        yield return ("GUIDE-DS221", "デジタル庁 DS-221", options.Ds221);
    }

    private static IEnumerable<string> OwaspTop10For(IEnumerable<string> cweIds)
    {
        foreach (var cwe in cweIds)
            yield return cwe switch
            {
                "CWE-22" or "CWE-23" or "CWE-35" or "CWE-59" or "CWE-200" or "CWE-284" or "CWE-285" or "CWE-352" or "CWE-639" => "OWASP Top 10 2021 A01: Broken Access Control",
                "CWE-259" or "CWE-261" or "CWE-311" or "CWE-319" or "CWE-326" or "CWE-327" => "OWASP Top 10 2021 A02: Cryptographic Failures",
                "CWE-74" or "CWE-77" or "CWE-78" or "CWE-79" or "CWE-89" or "CWE-91" or "CWE-917" => "OWASP Top 10 2021 A03: Injection",
                "CWE-16" or "CWE-693" or "CWE-1021" => "OWASP Top 10 2021 A05: Security Misconfiguration",
                "CWE-287" or "CWE-384" or "CWE-521" or "CWE-613" => "OWASP Top 10 2021 A07: Identification and Authentication Failures",
                "CWE-502" or "CWE-829" => "OWASP Top 10 2021 A08: Software and Data Integrity Failures",
                _ => "OWASP Top 10 2021: 個別評価が必要"
            };
    }

    private static bool HasTechnologyStackMismatch(ZapAlertDetails? detail)
    {
        if (detail is null) return false;
        var exchange = string.Join("\n", detail.Request, detail.Response, detail.AttackInput, detail.ObservedEvidence);
        var php = exchange.Contains("PHP", StringComparison.OrdinalIgnoreCase)
            || exchange.Contains("PHPSESSID", StringComparison.OrdinalIgnoreCase)
            || exchange.Contains("X-Powered-By: PHP", StringComparison.OrdinalIgnoreCase);
        var windowsPayload = exchange.Contains("cmd.exe", StringComparison.OrdinalIgnoreCase)
            || exchange.Contains("powershell", StringComparison.OrdinalIgnoreCase)
            || exchange.Contains("C:\\Windows", StringComparison.OrdinalIgnoreCase);
        var javaPayload = exchange.Contains("java.lang", StringComparison.OrdinalIgnoreCase)
            || exchange.Contains("${jndi:", StringComparison.OrdinalIgnoreCase);
        return php && (windowsPayload || javaPayload);
    }

    private static IReadOnlyList<ReportToolV2> BuildTools(EngagementProject project)
    {
        var tools = new List<ReportToolV2> { new("ScopePilot", Missing, "対象整理・証拠管理・報告書生成", $"要求上限 {project.MaxRequests:N0}") };
        if (project.DiagnosticObservations.Count > 0)
            tools.Add(new("ZAP", Missing, project.DiagnosticTools.EnableZapActiveScan ? "受動・能動診断結果の取込" : "受動診断結果の取込",
                project.DiagnosticTools.EnableZapActiveScan
                    ? $"Active Scan有効 / 強度 {project.DiagnosticTools.ActiveScanStrength} / 閾値 {project.DiagnosticTools.ActiveScanThreshold}"
                    : "Active Scan無効"));
        if (project.BrunoVerifications.Count > 0) tools.Add(new("Bruno", Missing, "手動 HTTP 確認", Missing));
        return tools;
    }

    private static IReadOnlyList<string> BuildMethods(EngagementProject project)
    {
        var methods = new List<string>();
        if (project.Requests.Count > 0) methods.Add("画面・通信の探索記録");
        if (project.DiagnosticObservations.Count > 0) methods.Add("外部診断ツール結果の取込");
        if (project.BrunoVerifications.Count > 0) methods.Add("手動 HTTP 確認");
        if (project.Findings.Count > 0) methods.Add("担当者所見");
        return DefaultList(methods);
    }

    private static (DateTimeOffset? StartedAt, DateTimeOffset? EndedAt) EffectiveAssessmentPeriod(
        EngagementProject project, ReportSettings settings)
    {
        var observed = project.Requests.Select(x => (DateTimeOffset?)x.ObservedAt)
            .Concat(project.DiagnosticObservations.Select(x => (DateTimeOffset?)x.ImportedAt))
            .Concat(project.Findings.Select(x => (DateTimeOffset?)x.ObservedAt))
            .Concat(project.BrunoVerifications.Select(x => (DateTimeOffset?)x.RecordedAt))
            .Where(x => x is not null).Select(x => x!.Value).ToArray();
        if (observed.Length == 0) return (settings.AssessmentStartedAt, settings.AssessmentEndedAt);
        var first = observed.Min();
        var last = observed.Max();
        return (settings.AssessmentStartedAt is null || settings.AssessmentStartedAt > first ? first : settings.AssessmentStartedAt,
            settings.AssessmentEndedAt is null || settings.AssessmentEndedAt < last ? last : settings.AssessmentEndedAt);
    }

    private static IReadOnlyList<string> EffectiveRoles(EngagementProject project, IEnumerable<ReportFindingV2> findings)
    {
        var roles = Lines(project.Roles).Concat(project.DiagnosticObservations.Select(x => x.Role)).Where(x => !string.IsNullOrWhiteSpace(x)).ToList();
        var hasCookieEvidence = findings.Any(x => x.TechnicalEvidence.Request.Contains("Cookie:", StringComparison.OrdinalIgnoreCase));
        if (hasCookieEvidence && roles.All(x => x.Equals("未認証", StringComparison.OrdinalIgnoreCase)
            || x.Equals("unauthenticated", StringComparison.OrdinalIgnoreCase)))
            roles.Add("認証セッション（Cookie観測）");
        return DefaultList(roles);
    }

    private static IEnumerable<EvidenceSeed> EvidenceSeeds(EngagementProject project)
    {
        foreach (var item in project.Inputs) yield return new(EvidenceKey(item), item, null);
        foreach (var item in project.DiagnosticObservations)
            yield return new(EvidenceKey(item.Evidence), item.Evidence, item.ImportedAt);
        foreach (var item in project.BrunoVerifications)
            yield return new(EvidenceKey(item.Exchange), item.Exchange, item.RecordedAt);
    }

    private static string EvidenceKey(EvidenceReference reference) => string.Join('|', reference.LocalPath, reference.Sha256, reference.Pointer, reference.Kind);
    private static IReadOnlyList<string> AssetIds(IEnumerable<string> urls, IReadOnlyDictionary<string, string> assetByHost) => urls
        .Select(x => Uri.TryCreate(x, UriKind.Absolute, out var uri) ? assetByHost.GetValueOrDefault(uri.Host) : null)
        .Where(x => x is not null).Cast<string>().Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
    private static string SafeUrl(string value) => string.IsNullOrWhiteSpace(value) ? Missing : JapaneseDiagnosticReportService.SafeUrl(value);
    private static string Value(string? value, string fallback = Missing)
    {
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        var normalized = value.Trim();
        return normalized is "ぬるぽ" or "ほげふが" or "ほげふげ" or "テスト発行者" ? fallback : normalized;
    }
    private static string ReportName(string? projectName, string? systemName)
    {
        var name = Value(projectName, "");
        if (name.Length > 0 && !name.All(char.IsDigit)) return name;
        return Value(systemName, "案件名未設定");
    }
    private static string[] Lines(string? value) => (value ?? "").Split(['\r', '\n', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    private static IReadOnlyList<string> DefaultList(IEnumerable<string> values)
    {
        var items = values.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.Ordinal).ToArray();
        return items.Length == 0 ? [Missing] : items;
    }
    private static string NormalizeSeverity(string value) => value.Trim().ToLowerInvariant() switch
    {
        "4" or "critical" or "緊急" => "Critical", "3" or "high" or "高" => "High",
        "2" or "medium" or "中" => "Medium", "1" or "low" or "低" => "Low",
        "0" or "info" or "informational" or "情報" => "Informational", _ => "未評価"
    };
    private static string NormalizeValidation(string value) => value.Trim().ToLowerInvariant() switch
    {
        "confirmed" or "確認済み" or "成立" => "確認済み", "estimated" or "推定" or "要確認" => "推定",
        "notconfirmed" or "未再現" => "未再現", "falsepositive" or "誤検知" => "誤検知",
        "outofscope" or "対象外" => "対象外", _ => "判定保留"
    };
    private static string FindingId(string value, string prefix, int index)
    {
        if (!string.IsNullOrWhiteSpace(value) && value.StartsWith(prefix + "-", StringComparison.OrdinalIgnoreCase)) return value.ToUpperInvariant();
        return string.IsNullOrWhiteSpace(value) ? $"{prefix}-{index + 1:000}" : $"{prefix}-{StableId(value)}";
    }
    private static string StableId(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..8];
    private static string DisplayEvidenceType(string kind) => string.IsNullOrWhiteSpace(kind) ? Missing : kind switch
    {
        "zap-report" => "ZAP JSON", "bruno-http-exchange" => "HTTP 通信", "har" => "HAR", "api-document" => "API 仕様", _ => kind
    };
    private static string? DetailValue(string? value) => string.IsNullOrWhiteSpace(value) || value == "未記載" ? null : value.Trim();
    private static IReadOnlyList<string> ReferenceLines(string? value) => DetailValue(value) is not { } text
        ? Array.Empty<string>() : text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    private static string ExpectedImpact(string severity) => severity switch
    {
        "Critical" => "成立した場合、管理権限の取得、広範な情報漏えい、または重大な業務停止につながる可能性があります。実際の影響範囲は担当者による確認が必要です。",
        "High" => "成立した場合、重要な情報または機能の機密性・完全性・可用性へ大きな影響を及ぼす可能性があります。実際の影響範囲は担当者による確認が必要です。",
        "Medium" => "成立条件を満たす場合、限定された情報または機能に中程度の影響を及ぼす可能性があります。実際の影響範囲は担当者による確認が必要です。",
        "Low" => "成立した場合の影響は限定的と見込まれますが、他の問題と組み合わさる可能性を含めて確認が必要です。",
        "Informational" => "直ちに脆弱性とは判定しませんが、構成や公開情報が攻撃の補助情報となる可能性があります。",
        _ => "業務影響は未評価です。"
    };
    private static readonly string[] SeverityOrder = ["Critical", "High", "Medium", "Low", "Informational", "未評価"];
    private static readonly string[] ValidationOrder = ["確認済み", "推定", "未再現", "誤検知", "対象外", "判定保留"];
    private sealed record EvidenceSeed(string Key, EvidenceReference Reference, DateTimeOffset? CapturedAt);
}
