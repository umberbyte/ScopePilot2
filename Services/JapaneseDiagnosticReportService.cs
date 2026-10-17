using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record JapaneseDiagnosticReport(string Markdown, int AlertGroupCount, int UntranslatedGroupCount, int UnavailableEvidenceCount);

public sealed class JapaneseDiagnosticReportService
{
    public const string SampleUrl = "https://www.digicert.com/content/dam/digicert/jp/pdfs/sample/webapp-or-report-sample.pdf";

    public async Task<JapaneseDiagnosticReport> BuildAsync(EngagementProject project, DateTimeOffset generatedAt)
    {
        var originals = await new ZapAlertDetailsService().ReadManyAsync(project,
            project.DiagnosticObservations.Where(x => x.Tool.Equals("ZAP", StringComparison.OrdinalIgnoreCase)));
        var originalByObservation = originals.ToDictionary(x => x.Observation);
        var groups = project.DiagnosticObservations
            .GroupBy(x => new { x.Tool, x.RuleId, x.Title, x.Severity, x.Confidence, x.Role })
            .OrderByDescending(x => RiskOrder(x.Key.Severity)).ThenBy(x => x.Key.Tool, StringComparer.Ordinal)
            .ThenBy(x => x.Key.RuleId, StringComparer.Ordinal).ThenBy(x => x.Key.Title, StringComparer.Ordinal)
            .ThenBy(x => x.Key.Role, StringComparer.Ordinal).ThenBy(x => x.Key.Confidence, StringComparer.Ordinal)
            .Select((x, i) => new AlertGroup($"W-{i + 1:000}", x.OrderBy(y => y.Evidence.LocalPath, StringComparer.Ordinal)
                .ThenBy(y => y.Evidence.Pointer, StringComparer.Ordinal).ToArray(), JapaneseZapAlertCatalog.Find(x.Key.Tool, x.Key.RuleId)))
            .ToArray();
        var untranslated = groups.Count(x => x.Explanation is null);
        var unavailable = originals.Count(x => x.Details is null);
        var bruno = project.BrunoVerifications ?? [];
        var sb = new StringBuilder();
        sb.AppendLine("# Web アプリケーション診断結果報告書").AppendLine();
        Table(sb, ["項目", "内容"],
        [
            ["案件名", project.Name], ["作成日時", generatedAt.ToString("yyyy-MM-dd HH:mm:ss zzz")],
            ["作成元", "ScopePilot"], ["依頼者・担当者", "未記録（提出前に記入）"],
            ["開始 URL", SafeUrl(project.StartUrl)], ["版", "Markdown レポート形式 1 / 日本語解説辞書 " + JapaneseZapAlertCatalog.Version]
        ]);
        sb.AppendLine("## 目次").AppendLine();
        foreach (var section in new[] { "1. 報告の目的と扱い", "2. 実施概要", "3. 結果サマリーと評価基準", "4. 対象・観測 URL 一覧", "5. 指摘事項一覧", "6. 指摘事項詳細", "7. 対応と再確認", "8. 付録・出典" })
            sb.AppendLine("- " + section);
        sb.AppendLine();
        Heading(sb, "1. 報告の目的と扱い");
        sb.AppendLine("本報告書は、プロジェクトで観測した通信、選定した診断対象、探索所見、外部ツールの警告、Brunoで手動確認した通信を整理したものです。記録した範囲に基づき、担当者による調査と対策の検討に使用します。").AppendLine();
        sb.AppendLine("ツールの警告と探索所見は、記録された状態のまま掲載します。ZAP の確度が高くても、実際の被害や脆弱性の成立が確認されたことを意味しません。報告書の内容と出典は案件関係者で管理してください。").AppendLine();

        Heading(sb, "2. 実施概要");
        var observed = project.Requests.Select(x => x.ObservedAt).Concat(project.Findings.Select(x => x.ObservedAt)).ToArray();
        Table(sb, ["項目", "内容"],
        [
            ["対象", project.Name], ["診断実施期間", "未記録（観測・取込日時からは断定しません）"],
            ["記録上の観測期間", observed.Length == 0 ? "記録なし" : $"{observed.Min():yyyy-MM-dd HH:mm:ss zzz} ～ {observed.Max():yyyy-MM-dd HH:mm:ss zzz}"],
            ["診断方法", project.DiagnosticObservations.Count > 0 ? "記録済み通信の整理・探索所見・取り込んだツール警告の確認" : "記録済み通信・探索所見の整理"],
            ["診断元 IP アドレス", "未記録（提出前に記入）"], ["認証ロール", project.Roles],
            ["観測通信数", project.Requests.Count.ToString()], ["診断対象候補数 / 採用数", $"{project.Candidates.Count} / {project.Candidates.Count(x => x.Selected)}"]
        ]);
        List(sb, "許可された対象 Origin", Lines(project.AllowedOrigins).Select(SafeUrl));
        List(sb, "表示・認証用の対象外 Origin", Lines(project.SupportingOrigins).Select(SafeUrl));
        List(sb, "操作上の制約", Lines(project.ForbiddenActions));
        sb.AppendLine("ZAP 警告の取込日時は診断実施日時ではありません。ロールは記録されたラベルであり、認証主体や権限の検証結果ではありません。").AppendLine();

        Heading(sb, "3. 結果サマリーと評価基準");
        Table(sb, ["集計項目", "件数・状態"],
        [
            ["総合評価", "未判定（担当者の確認が必要）"], ["探索所見", project.Findings.Count.ToString()],
            ["Bruno手動確認", bruno.Count.ToString()],
            ["うち成立確認として登録", bruno.Count(x => x.Status == BrunoVerificationStatus.Confirmed).ToString()],
            ["ツール警告の種類・ロール別件数", groups.Length.ToString()], ["ツール警告の発生記録数", project.DiagnosticObservations.Count.ToString()],
            ["日本語解説が未登録の警告", untranslated.ToString()], ["詳細原本を検証できなかった発生記録", unavailable.ToString()]
        ]);
        sb.AppendLine("### ZAP の危険度別内訳").AppendLine();
        Table(sb, ["危険度（ZAP 評価）", "警告種類・ロール別", "発生記録数"],
            new[] { "3", "2", "1", "0" }.Select(risk => new[]
            {
                new DiagnosticObservation { Severity = risk }.SeverityDisplay,
                groups.Count(x => x.First.Tool.Equals("ZAP", StringComparison.OrdinalIgnoreCase) && x.First.Severity == risk).ToString(),
                project.DiagnosticObservations.Count(x => x.Tool.Equals("ZAP", StringComparison.OrdinalIgnoreCase) && x.Severity == risk).ToString()
            }));
        var otherSeverity = project.DiagnosticObservations.Count(x => !x.Tool.Equals("ZAP", StringComparison.OrdinalIgnoreCase) || x.Severity is not ("0" or "1" or "2" or "3"));
        if (otherSeverity > 0) sb.AppendLine($"その他・未評価の発生記録: {otherSeverity} 件。").AppendLine();
        sb.AppendLine("危険度と確度には ZAP の原評価を使用します。探索所見の深刻度・状態は所見に記録された値です。危険度、攻撃難易度、実影響を組み合わせる独自の総合評価は行っていません。").AppendLine();
        sb.AppendLine("警告はツール・ルール・原警告名・危険度・確度・ロールが同じ記録をまとめています。同じ URL に複数の出典がある場合も発生記録として数えます。件数は脆弱性の確定件数ではありません。").AppendLine();
        sb.AppendLine(project.DiagnosticObservations.Count + project.Findings.Count + bruno.Count == 0
            ? "現在の記録に所見・警告はありません。未実施・未観測の機能を含めた安全性は判定できません。"
            : "掲載した警告の適用条件、所見の根拠、対象機能への影響を確認し、対応優先度を決めてください。").AppendLine();

        Heading(sb, "4. 対象・観測 URL 一覧");
        var urls = project.Requests.Select(x => (Url: SafeUrl(x.Url), Name: x.PageTitle, Kind: "観測通信"))
            .Concat(project.Candidates.Where(x => x.Selected).Select(x => (SafeUrl(x.Representative.Url), x.Representative.PageTitle, "採用候補")))
            .Concat(project.DiagnosticObservations.Select(x => (SafeUrl(x.Url), "", "警告発生箇所")))
            .Concat(bruno.Select(x => (SafeUrl(x.Url), "", "Bruno手動確認")))
            .GroupBy(x => x.Item1).OrderBy(x => x.Key, StringComparer.Ordinal).ToArray();
        Table(sb, ["対象番号", "機能・ページ名", "URL", "記録の種類"], urls.Select((x, i) => new[]
        { $"U-{i + 1:000}", x.Select(y => y.Item2).FirstOrDefault(y => !string.IsNullOrWhiteSpace(y)) ?? "未記録", x.Key, string.Join(" / ", x.Select(y => y.Item3).Distinct()) }));
        if (urls.Length == 0) sb.AppendLine("対象 URL の記録はありません。").AppendLine();
        sb.AppendLine("観測 URL の掲載は診断項目の完了を示しません。URL の認証情報、クエリ値、フラグメントは転記していません。").AppendLine();

        Heading(sb, "5. 指摘事項一覧");
        Table(sb, ["指摘番号", "概要", "危険度・深刻度", "状態", "発生記録数"],
            groups.Select(x => new[] { x.Id, x.Title, x.First.SeverityDisplay, "要確認（実影響未確認）", x.Items.Length.ToString() })
                .Concat(project.Findings.Select((x, i) => new[] { $"F-{i + 1:000}", x.Title, Severity(x.Severity), x.Status, "探索所見" }))
                .Concat(bruno.Select((x, i) => new[] { $"B-{i + 1:000}", x.Title, "担当者評価", BrunoStatus(x.Status), "要求・応答1組" })));
        if (groups.Length + project.Findings.Count + bruno.Count == 0) sb.AppendLine("掲載する指摘事項はありません。").AppendLine();

        Heading(sb, "6. 指摘事項詳細");
        foreach (var group in groups)
        {
            var alert = group.First;
            sb.AppendLine($"### {group.Id} {Escape(group.Title)}").AppendLine();
            Table(sb, ["項目", "内容"],
            [
                ["ツール / ルール ID", $"{alert.Tool} / {alert.RuleId}"], ["原警告名", alert.Title],
                ["危険度", alert.SeverityDisplay + "（ツール評価）"], ["確度", alert.ConfidenceDisplay],
                ["状態", "要確認（実影響未確認）"], ["ロール", alert.Role],
                ["危険度の独立評価 / 攻撃難易度", "未評価 / 未評価"], ["発生記録数", group.Items.Length.ToString()]
            ]);
            Block(sb, "概要・想定される影響", group.Explanation?.Description ?? "日本語解説が未登録です。検証済みの原文と出典を確認し、担当者が補足してください。");
            Block(sb, "診断内容・結果", "取り込んだツールが以下の通信について警告を報告しています。パラメータや原本の出典を確認してください。脆弱性の成立や実影響は確認していません。");
            Block(sb, "対応案", group.Explanation?.Recommendation ?? "原文の対策案を確認し、アプリケーションの要件と照合して対応を決めてください。");
            sb.AppendLine("#### 発生箇所と証拠の出典").AppendLine();
            var sources = group.Items.Select(x => (x.Evidence.LocalPath, x.Evidence.Sha256)).Distinct()
                .Select((x, i) => new { x.LocalPath, x.Sha256, Id = $"{group.Id}-E{i + 1:000}" }).ToArray();
            Table(sb, ["メソッド", "URL", "パラメータ", "出典番号", "JSON Pointer", "原本検証"],
                group.Items.Select(x => new[]
                {
                    x.Method, SafeUrl(x.Url), x.Parameter,
                    sources.First(s => s.LocalPath == x.Evidence.LocalPath && s.Sha256 == x.Evidence.Sha256).Id, x.Evidence.Pointer,
                    originalByObservation.TryGetValue(x, out var original) ? original.Details is not null ? "照合済み" : original.Error : "未対応のツール"
                }));
            foreach (var source in sources)
            {
                sb.AppendLine($"- {Escape(source.Id)}: {Escape(source.LocalPath)}");
                sb.AppendLine($"  - SHA-256: {Escape(source.Sha256)}");
            }
            sb.AppendLine();
            sb.AppendLine("証拠本文・入力値・Cookie・Authorization・要求／応答本文は原本で確認します。再現手順と実影響の確認結果は未記録です。").AppendLine();
            var verified = group.Items.Where(originalByObservation.ContainsKey).Select(x => originalByObservation[x].Details)
                .Where(x => x is not null).Cast<ZapAlertDetails>()
                .DistinctBy(x => (x.Title, x.Description, x.Recommendation, x.References, x.Cwe, x.Wasc)).ToArray();
            foreach (var original in verified)
            {
                sb.AppendLine("#### 検証済み原文（翻訳前の参照情報）").AppendLine();
                Table(sb, ["項目", "内容"], [["警告名", original.Title], ["CWE / WASC", original.Cwe + " / " + original.Wasc]]);
                Block(sb, "原文の説明", original.Description);
                Block(sb, "原文の対策", original.Recommendation);
                Block(sb, "原文の参考情報", original.References);
            }
            if (verified.Length == 0) sb.AppendLine("原本詳細は未掲載です。出典の検証状態を確認してください。").AppendLine();
            if (group.Explanation is { } explanation)
            {
                sb.AppendLine($"日本語解説の参照: [ZAP 公式ルール解説]({explanation.SourceUrl})").AppendLine();
                sb.AppendLine("日本語解説はルールの一般的な要約です。警告の個別の種類と条件は検証済み原文で確認してください。").AppendLine();
            }
        }
        foreach (var (finding, index) in project.Findings.Select((x, i) => (x, i)))
        {
            sb.AppendLine($"### F-{index + 1:000} {Escape(finding.Title)}").AppendLine();
            Table(sb, ["項目", "内容"], [["分類", finding.Category], ["深刻度", Severity(finding.Severity)], ["確信度", finding.Confidence], ["状態", finding.Status]]);
            Block(sb, "診断結果・説明", finding.Description);
            Block(sb, "観測根拠", finding.Evidence);
            Block(sb, "発生箇所", string.Join("\n", Lines(finding.AffectedUrls).Select(SafeUrl)));
            Block(sb, "対応案", "所見に対応案が記録されていません。担当者が調査結果に基づき記入してください。");
            Block(sb, "参照基準", finding.GuidelineBasis);
            Block(sb, "備考・制約", finding.Limitations);
        }
        if (bruno.Count > 0) sb.AppendLine("### Brunoでの手動確認と通信記録").AppendLine();
        foreach (var (item, index) in bruno.Select((x, i) => (x, i)))
        {
            sb.AppendLine($"#### B-{index + 1:000} {Escape(item.Title)}").AppendLine();
            Table(sb, ["項目", "内容"],
            [
                ["確認状態", BrunoStatus(item.Status)], ["記録日時", item.RecordedAt.ToString("yyyy-MM-dd HH:mm:ss zzz")],
                ["認証ロール", item.Role], ["要求", item.Method + " " + SafeUrl(item.Url)],
                ["応答ステータス", item.ResponseStatus.ToString()], ["証拠ファイル", item.Exchange.LocalPath],
                ["証拠SHA-256", item.Exchange.Sha256]
            ]);
            Block(sb, "確認結果", item.Result);
            if (item.Status == BrunoVerificationStatus.Blocked)
            {
                Block(sb, "未実施・中断の理由", item.BlockReason);
                Block(sb, "再開に必要な入力・改善", item.RequiredInput);
            }
            var exchange = await BrunoEvidenceReportFormatter.ReadAsync(project, item);
            if (exchange.Error.Length > 0) Block(sb, "証拠の照合", exchange.Error);
            else
            {
                sb.AppendLine("##### HTTPリクエスト（機密値を伏せ字で掲載）").AppendLine();
                Code(sb, exchange.Request);
                sb.AppendLine("##### HTTPレスポンス（機密値を伏せ字で掲載）").AppendLine();
                Code(sb, exchange.Response);
            }
        }
        if (groups.Length + project.Findings.Count + bruno.Count == 0) sb.AppendLine("詳細を出力する所見・警告がありません。").AppendLine();

        Heading(sb, "7. 対応と再確認");
        sb.AppendLine("1. 指摘の根拠と対象機能の要件を担当者が確認する。\n2. 誤検知や適用対象外の理由、対応方針、担当者、期限を追記する。\n3. 対策後、同じ対象・ロール・条件で正常動作と指摘の解消を確認する。\n4. 再確認の日時、方法、根拠、残る制約を記録する。").AppendLine();
        Table(sb, ["指摘番号", "対応方針", "担当者", "期限", "再確認結果"],
            groups.Select(x => x.Id).Concat(project.Findings.Select((_, i) => $"F-{i + 1:000}"))
                .Concat(bruno.Select((_, i) => $"B-{i + 1:000}"))
                .Select(id => new[] { id, "未記入", "未記入", "未記入", "未実施" }));
        Block(sb, "報告書に関する連絡先", "未記録（提出前に記入）");

        Heading(sb, "8. 付録・出典");
        sb.AppendLine($"構成の参考: [デジサート・ジャパンの公開サンプル報告書]({SampleUrl})。章立てと報告項目を参考にし、本文と評価はプロジェクトの記録から作成しています。").AppendLine();
        sb.AppendLine("日本語解説はアプリ内の辞書を使用し、外部サービスへ案件情報を送信しません。未登録の警告は未翻訳と明示し、検証済み原文を掲載します。サンプルの総合評価や診断済み項目を現在の案件に転用していません。").AppendLine();
        sb.AppendLine("同時出力: engagement-report.json（案件データ）、engagement-report.html（既存の案件レポート）、diagnostic-summary.json（警告と出典）、candidate-review.tsv（対象選定の作業表）。").AppendLine();
        return new(sb.ToString(), groups.Length, untranslated, unavailable);
    }

    private sealed record AlertGroup(string Id, DiagnosticObservation[] Items, JapaneseZapExplanation? Explanation)
    {
        public DiagnosticObservation First => Items[0];
        public string Title => Explanation?.Title ?? $"{First.Tool} 警告（ルール {First.RuleId}・日本語解説未登録）";
    }
    private static int RiskOrder(string value) => value switch { "critical" or "緊急" => 4, "3" or "high" or "高" => 3, "2" or "medium" or "中" => 2, "1" or "low" or "低" => 1, _ => 0 };
    private static string BrunoStatus(BrunoVerificationStatus status) => status switch
    { BrunoVerificationStatus.Confirmed => "成立確認（担当者記録）", BrunoVerificationStatus.NotConfirmed => "実施済み・成立未確認", _ => "未実施・中断" };
    private static void Code(StringBuilder sb, string value)
    {
        var fence = new string('`', Math.Max(3, Regex.Matches(value, "`+").Cast<Match>().Select(x => x.Length).DefaultIfEmpty().Max() + 1));
        sb.AppendLine(fence + "http").AppendLine(value).AppendLine(fence).AppendLine();
    }
    private static string Severity(string value) => value.ToLowerInvariant() switch
    { "critical" => "緊急", "high" => "高", "medium" => "中", "low" => "低", "info" or "informational" => "情報", _ => value };
    private static string[] Lines(string value) => value.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    internal static string SafeUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")) return value;
        var clean = new UriBuilder(uri) { UserName = "", Password = "", Query = "", Fragment = "" };
        return clean.Uri.GetLeftPart(UriPartial.Path);
    }
    private static void Heading(StringBuilder sb, string value) => sb.AppendLine("## " + value).AppendLine();
    private static string Escape(string? value)
    {
        var encoded = WebUtility.HtmlEncode(value ?? "").Replace("\r\n", "\n").Replace('\r', '\n');
        foreach (var symbol in new[] { "\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "!", "|", ">", "~" })
            encoded = encoded.Replace(symbol, "\\" + symbol);
        encoded = Regex.Replace(encoded, @"(?m)^([ \t]*)([-+])(?=\s)", "$1\\$2");
        encoded = Regex.Replace(encoded, @"(?m)^([ \t]*\d+)\.(?=\s)", "$1\\.");
        return encoded;
    }
    private static void Table(StringBuilder sb, string[] columns, IEnumerable<string[]> rows)
    {
        sb.AppendLine("| " + string.Join(" | ", columns) + " |");
        sb.AppendLine("| " + string.Join(" | ", columns.Select(_ => "---")) + " |");
        foreach (var row in rows) sb.AppendLine("| " + string.Join(" | ", row.Select(x => Escape(string.IsNullOrWhiteSpace(x) ? "未記録" : x).Replace("\n", "<br>"))) + " |");
        sb.AppendLine();
    }
    private static void Block(StringBuilder sb, string title, string value)
    {
        sb.AppendLine("#### " + title).AppendLine();
        sb.AppendLine(Escape(string.IsNullOrWhiteSpace(value) ? "未記録" : value)).AppendLine();
    }
    private static void List(StringBuilder sb, string title, IEnumerable<string> values)
    {
        sb.AppendLine("### " + title).AppendLine();
        var items = values.ToArray();
        foreach (var value in items) sb.AppendLine("- " + Escape(value));
        if (items.Length == 0) sb.AppendLine("未記録");
        sb.AppendLine();
    }
}
