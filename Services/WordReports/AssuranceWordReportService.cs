using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using ScopePilot.Domain;
using W = DocumentFormat.OpenXml.Wordprocessing;

namespace ScopePilot.Services.WordReports;

public sealed record AssuranceWordReportResult(string WordPath, string TemplateId);

public sealed class AssuranceWordReportService
{
    public const string TemplateId = "scopepilot-assurance-ja-v2";

    public async Task<AssuranceWordReportResult> WriteAsync(ReportDocumentV2 report, string path)
    {
        ArgumentNullException.ThrowIfNull(report);
        if (!report.TemplateId.Equals(TemplateId, StringComparison.Ordinal))
            throw new InvalidDataException($"未対応のレポートテンプレートです: {report.TemplateId}");
        var fullPath = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        var temporary = fullPath + ".tmp";
        try
        {
            await Task.Run(() => new AssuranceWordReportRenderer().Write(report, temporary));
            File.Move(temporary, fullPath, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        return new(fullPath, TemplateId);
    }
}

internal sealed class AssuranceWordReportRenderer
{
    private const int ContentWidth = 9026;
    private const string Navy = "193652";
    private const string PaleBlue = "EEF3F6";
    private const string Border = "D9D9D9";
    private const string Gray = "6B7280";
    private MainDocumentPart _part = null!;
    private W.Body _body = null!;

    public void Write(ReportDocumentV2 report, string path)
    {
        using var document = WordprocessingDocument.Create(path, WordprocessingDocumentType.Document);
        _part = document.AddMainDocumentPart();
        _part.Document = new W.Document();
        _body = _part.Document.AppendChild(new W.Body());
        AddStyles();
        AddNumbering();

        Cover(report);
        AddPageBreak();
        TableOfContents();
        Section("1", "文書管理");
        KeyValues([
            ("文書状態", report.Report.Status), ("作成者", report.Report.Author), ("レビュー担当", report.Report.Reviewer),
            ("承認者", report.Report.Approver), ("配布先", Join(report.Report.Distribution))
        ]);
        Heading("1.1  改訂履歴", 2);
        Table(["版", "日付", "変更内容", "作成者"], report.Report.Revisions.Select(x => new[]
            { x.Version, x.Date.ToString("yyyy-MM-dd"), x.Description, x.Author }), [1100, 1800, 3900, 2200]);

        Section("2", "経営層向け概要");
        Paragraph(report.Summary.Conclusion, "Body");
        Heading("2.1  結果指標", 2);
        Table(["指標", "結果", "判断に必要な補足"],
        [
            ["最高深刻度", report.Summary.HighestSeverity, "確認済みと推定を成立状態で区別してください。"],
            ["確認済み指摘", report.Summary.ValidationCounts.GetValueOrDefault("確認済み").ToString("N0") + "件", "再現確認済みの件数です。"],
            ["推定・判定保留", (report.Summary.ValidationCounts.GetValueOrDefault("推定") + report.Summary.ValidationCounts.GetValueOrDefault("判定保留")).ToString("N0") + "件", "追加確認が必要です。"],
            ["カバレッジ", $"実施済み {report.Coverage.Count(x => x.Status == "実施済み"):N0} / 全 {report.Coverage.Count:N0}", "未実施、対象外、判定保留を含みます。"]
        ], [2200, 2300, 4500]);
        Heading("2.2  深刻度別件数", 2);
        Table(["Critical", "High", "Medium", "Low", "Informational", "未評価"],
            [new[] { "Critical", "High", "Medium", "Low", "Informational", "未評価" }.Select(x => report.Summary.SeverityCounts.GetValueOrDefault(x).ToString("N0")).ToArray()],
            [1500, 1500, 1500, 1500, 1500, 1500]);
        Heading("2.3  優先対応事項", 2); Bullets(report.Summary.Priorities);
        Heading("2.4  重大な制約", 2); Bullets(report.Summary.MajorLimitations);

        Section("3", "診断条件と対象範囲");
        Heading("3.1  実施条件", 2);
        KeyValues([
            ("診断期間", Period(report.Assessment.StartedAt, report.Assessment.EndedAt)), ("診断種別", report.Assessment.Type),
            ("診断方法", Join(report.Assessment.Methods)), ("診断元 IP", Join(report.Assessment.SourceIps)),
            ("対象ロール", Join(report.Assessment.Roles)),
            ("送信上限", $"要求 {report.Assessment.RequestLimits.MaxRequests:N0}件 / {report.Assessment.RequestLimits.MaxMinutes:N0}分 / {report.Assessment.RequestLimits.MaxPages:N0}ページ")
        ]);
        Heading("3.2  診断ツールと設定", 2);
        Table(["ツール", "バージョン", "用途", "主要設定"], report.Assessment.Tools.Select(x => new[] { x.Name, x.Version, x.Purpose, x.Settings }), [1800, 1500, 3000, 2700]);
        Heading("3.3  対象資産", 2);
        Table(["資産 ID", "機能・資産名", "FQDN", "URL", "備考"], report.Assets.Select(x => new[]
            { x.Id, x.Name, x.Fqdn, Join(x.Urls), x.Notes }), [1100, 1900, 1800, 3000, 1200]);
        Heading("3.4  許可範囲と除外", 2, true);
        KeyValues([
            ("許可 Origin", Join(report.Assessment.AllowedOrigins)), ("補助 Origin", Join(report.Assessment.SupportingOrigins)),
            ("対象外", Join(report.Assessment.Exclusions)), ("禁止操作", Join(report.Assessment.ForbiddenActions)),
            ("前提条件", Join(report.Assessment.Assumptions))
        ]);

        Section("4", "診断カバレッジ");
        Paragraph("実施状態は警告の有無ではなく、対象、ロール、検証手段および証拠が記録されたかどうかで区別します。", "Body");
        Table(["項目 ID", "診断観点", "状態", "検証手段", "対象・ロール", "証拠・制約"], report.Coverage.Select(x => new[]
        {
            x.ControlId, x.Title, x.Status, x.Method, Join(x.Targets.Concat(x.Roles)), Join(x.EvidenceIds) + NewLine(x.Limitations)
        }), [1200, 2000, 1100, 1300, 1700, 1700]);
        Heading("4.1  状態の定義", 2);
        Table(["状態", "定義"],
        [
            ["実施済み", "対象と条件を満たす検証を実行し、証拠を記録した状態"], ["一部実施", "対象、ロール、手段の一部だけを実施した状態"],
            ["未実施", "計画対象だが検証を実行していない状態"], ["対象外", "該当機能がないなど、理由を記録して除外した状態"],
            ["判定保留", "証拠または前提条件が不足し、結論を確定できない状態"]
        ], [1800, 7200]);

        Section("5", "評価方法");
        Paragraph("深刻度、成立状態、悪用容易性を別々に記録します。件数だけで総合所見を決めず、業務影響と未実施項目を担当者が確認します。", "Body");
        Heading("5.1  深刻度", 2);
        Table(["深刻度", "定義"],
        [
            ["Critical", "重大な業務停止、広範な情報漏えい、管理権限の取得などにつながる可能性がある"],
            ["High", "重要な情報または機能へ大きな影響を及ぼす可能性がある"],
            ["Medium", "限定された条件で中程度の影響を及ぼす可能性がある"],
            ["Low", "影響が限定的で、悪用に複数の条件を必要とする"],
            ["Informational", "直ちに脆弱性とは判定しないが、改善または把握が望ましい"], ["未評価", "担当者による評価が完了していない"]
        ], [1900, 7100]);
        Heading("5.2  成立状態と対応状態", 2);
        Table(["区分", "値", "意味"],
        [
            ["成立状態", "確認済み", "再現手順と証拠により成立を確認した"], ["成立状態", "推定", "可能性を示す記録はあるが実影響を確認していない"],
            ["成立状態", "未再現", "定めた条件で成立を確認できなかった"], ["成立状態", "誤検知・対象外", "根拠を記録して指摘から除外した"],
            ["対応状態", "未着手・対応中・対応済み・受容・保留", "修正作業の進行状況を示す"]
        ], [1700, 2600, 4700]);

        Section("6", "指摘事項一覧");
        Table(["ID", "指摘名称", "深刻度", "成立状態", "対象", "対応状態", "再診断"], report.Findings.Select(f => new[]
        {
            f.Id, f.Title, f.Severity, f.ValidationStatus, Join(f.AffectedAssetIds),
            report.Responses.FirstOrDefault(x => x.FindingId == f.Id)?.Status ?? "未着手",
            report.Responses.FirstOrDefault(x => x.FindingId == f.Id)?.RetestResult ?? "未実施"
        }), [1100, 2600, 1100, 1200, 1100, 1000, 900]);
        if (report.Findings.Count == 0) Paragraph("指摘事項は記録されていません。未実施項目を含む安全性を保証する表現には使用できません。", "Body");

        Section("7", "指摘事項詳細");
        foreach (var (finding, index) in report.Findings.Select((x, i) => (x, i))) Finding(finding, index > 0);
        if (report.Findings.Count == 0) Paragraph("詳細を表示する指摘事項はありません。", "Body");

        Section("8", "対応計画と再診断");
        Table(["指摘 ID", "対応方針", "担当者", "期限", "状態", "再診断結果"], report.Responses.Select(x => new[]
        {
            x.FindingId, x.Plan, x.Owner, x.DueDate?.ToString("yyyy-MM-dd") ?? "未入力", x.Status, x.RetestResult
        }), [1100, 2700, 1400, 1300, 1200, 1300]);

        Section("9", "証拠索引");
        Paragraph("提出用文書にはマスク済みの内容だけを掲載します。原本は案件フォルダー内の相対パスと SHA-256 で照合します。", "Body");
        if (report.Evidence.Count > 0)
            Table(["証拠 ID", "種類", "保存先", "SHA-256", "マスク", "関連指摘"], report.Evidence.Select(x => new[]
            {
                x.Id, x.Type, x.LocalPath, x.Sha256, x.RedactionStatus, Join(x.RelatedFindingIds)
            }), [1100, 1300, 2300, 1800, 1400, 1100]);
        else Paragraph("証拠ファイルは登録されていません。", "Body");

        Section("10", "特記事項");
        Heading("10.1  診断結果の利用条件", 2); Bullets(report.SpecialNotes);
        Heading("10.2  診断後の後処理", 2);
        Bullets(["診断用アカウントを無効化または削除する", "診断元 IP の許可設定を解除する", "テストデータ、API キー、証明書などを失効または削除する", "不要になった一時ログと共有ファイルを規程に従って処理する"]);
        Heading("10.3  発行主体", 2);
        KeyValues([("組織名", report.Engagement.ServiceProvider), ("提出先", report.Engagement.ClientName), ("レポート ID", report.Report.Id)]);

        var sectionProperties = SectionProperties(report);
        _body.Append(sectionProperties);
        _part.Document.Save();
    }

    private void Cover(ReportDocumentV2 report)
    {
        Paragraph("SCOPEPILOT  SECURITY ASSESSMENT", "Eyebrow", after: 700);
        Paragraph("Web アプリケーション\n脆弱性診断報告書", "Title", after: 260);
        Paragraph(report.Engagement.SystemName, "Subtitle", after: 500);
        KeyValues([
            ("提出先", report.Engagement.ClientName), ("案件名", report.Engagement.Name), ("診断区分", report.Assessment.Type),
            ("レポート ID", report.Report.Id), ("版数", report.Report.Version), ("発行日", report.Report.GeneratedAt.ToString("yyyy年MM月dd日")),
            ("発行者", report.Engagement.ServiceProvider), ("取扱区分", report.Report.Classification)
        ]);
        Paragraph("本報告書は、記載された対象、期間、権限、診断手法および制約の範囲で確認した結果を報告します。", "Small", before: 320);
    }

    private void TableOfContents()
    {
        Heading("目次", 1);
        Table(["章", "内容"], new[]
        {
            ("1", "文書管理"), ("2", "経営層向け概要"), ("3", "診断条件と対象範囲"), ("4", "診断カバレッジ"),
            ("5", "評価方法"), ("6", "指摘事項一覧"), ("7", "指摘事項詳細"), ("8", "対応計画と再診断"),
            ("9", "証拠索引"), ("10", "特記事項")
        }.Select(x => new[] { x.Item1, x.Item2 }), [1200, 7800]);
    }

    private void Finding(ReportFindingV2 finding, bool pageBreak)
    {
        Heading($"7.{finding.Id}  {finding.Title}", 2, pageBreak);
        FindingSummaryTable(finding);
        Labeled("説明", JoinText(finding.Summary, finding.TechnicalCause));
        Heading("診断時に収集したHTTP証跡", 3);
        Paragraph(Value(finding.TechnicalEvidence.CollectionStatus), "Small");
        if (HasValue(finding.TechnicalEvidence.Request)) EvidenceBlock("Request", finding.TechnicalEvidence.Request);
        if (HasValue(finding.TechnicalEvidence.Response)) EvidenceBlock("Response", finding.TechnicalEvidence.Response);
        if (HasValue(finding.TechnicalEvidence.AttackInput) || HasValue(finding.TechnicalEvidence.ObservedEvidence))
            KeyValues([
                ("診断入力・攻撃文字列", Value(finding.TechnicalEvidence.AttackInput)),
                ("観測した根拠", Value(finding.TechnicalEvidence.ObservedEvidence))
            ]);
        if (HasValue(finding.TechnicalEvidence.ExternalInteraction))
            Labeled("外部サービスインタラクション・追加観測", finding.TechnicalEvidence.ExternalInteraction);
        Labeled("成立条件", finding.Conditions);
        Labeled("想定される業務影響", finding.BusinessImpact);
        Heading("再現条件と結果", 3); Labeled("前提条件", finding.Reproduction.Prerequisites); Numbered(finding.Reproduction.Steps);
        KeyValues([("期待される結果", finding.Reproduction.Expected), ("実際の結果", finding.Reproduction.Actual)]);
        Labeled("証拠", Join(finding.EvidenceIds));
        Heading("改善策", 3); KeyValues([("暫定対策", finding.Remediation.Immediate), ("恒久対策", finding.Remediation.Permanent), ("修正確認条件", finding.VerificationCriteria)]);
        Labeled("参考情報", Join(finding.References.Concat(finding.GuidelineReferences)));
        Labeled("制約", finding.Limitations);
    }

    private void FindingSummaryTable(ReportFindingV2 finding)
    {
        int[] widths = [1700, 2813, 1700, 2813];
        var table = new W.Table(new W.TableProperties(
            new W.TableWidth { Width = ContentWidth.ToString(), Type = W.TableWidthUnitValues.Dxa },
            Borders(), new W.TableLayout { Type = W.TableLayoutValues.Fixed }, CellMargins()),
            new W.TableGrid(widths.Select(x => new W.GridColumn { Width = x.ToString() })));
        table.Append(DetailRow(widths, ("脆弱性名称", true, 1), (finding.Title, false, 3)));
        table.Append(DetailRow(widths, ("対象ホスト", true, 1), (finding.Url, false, 3)));
        table.Append(DetailRow(widths, ("危険度", true, 1), (finding.Severity, false, 1),
            ("発生可能性", true, 1), (finding.Exploitability, false, 1)));
        table.Append(DetailRow(widths, ("CVSS v3.1ベーススコア", true, 1), (Cvss(finding.Cvss), false, 3)));
        table.Append(DetailRow(widths, ("CVE/CWE", true, 1), (Join(finding.CveIds.Concat(finding.CweIds)), false, 3)));
        table.Append(DetailRow(widths, ("成立状態", true, 1), (finding.ValidationStatus, false, 1),
            ("検出確度", true, 1), (finding.Confidence, false, 1)));
        table.Append(DetailRow(widths, ("診断条件", true, 1),
            ($"{finding.Method} / ロール: {finding.Role} / パラメータ: {finding.Parameter}", false, 3)));
        table.Append(DetailRow(widths, ("検出元・確認日時", true, 1),
            ($"{finding.Source} / {finding.ObservedAt?.ToString("yyyy-MM-dd HH:mm:ss zzz") ?? "未入力"}", false, 3)));
        _body.Append(table);
        _body.Append(new W.Paragraph(new W.ParagraphProperties(new W.SpacingBetweenLines { After = "120" })));
    }

    private static W.TableRow DetailRow(int[] widths, params (string Text, bool Label, int Span)[] values)
    {
        var row = new W.TableRow();
        var position = 0;
        foreach (var (text, label, span) in values)
        {
            var width = widths.Skip(position).Take(span).Sum();
            position += span;
            var properties = new W.TableCellProperties(
                new W.TableCellWidth { Width = width.ToString(), Type = W.TableWidthUnitValues.Dxa });
            if (span > 1) properties.Append(new W.GridSpan { Val = span });
            if (label) properties.Append(new W.Shading { Fill = "111111", Val = W.ShadingPatternValues.Clear });
            properties.Append(new W.TableCellVerticalAlignment { Val = W.TableVerticalAlignmentValues.Center });
            var runProperties = new W.RunProperties(
                new W.RunFonts { Ascii = "Aptos", HighAnsi = "Aptos", EastAsia = "Yu Gothic" });
            if (label) runProperties.Append(new W.Bold());
            runProperties.Append(new W.Color { Val = label ? "FFFFFF" : "000000" }, new W.FontSize { Val = "19" });
            var paragraph = new W.Paragraph(new W.ParagraphProperties(new W.ParagraphStyleId { Val = "TableText" }),
                new W.Run(runProperties, new W.Text(Value(text)) { Space = SpaceProcessingModeValues.Preserve }));
            row.Append(new W.TableCell(properties, paragraph));
        }
        return row;
    }

    private void EvidenceBlock(string label, string value)
    {
        var table = new W.Table(new W.TableProperties(
            new W.TableWidth { Width = ContentWidth.ToString(), Type = W.TableWidthUnitValues.Dxa },
            Borders(), new W.TableLayout { Type = W.TableLayoutValues.Fixed }, CellMargins()),
            new W.TableGrid(new W.GridColumn { Width = ContentWidth.ToString() }));
        var labelProperties = new W.TableCellProperties(new W.Shading { Fill = Navy, Val = W.ShadingPatternValues.Clear });
        var labelRun = new W.Run(new W.RunProperties(new W.Bold(), new W.Color { Val = "FFFFFF" }, new W.FontSize { Val = "18" }),
            new W.Text(label));
        table.Append(new W.TableRow(new W.TableCell(labelProperties,
            new W.Paragraph(new W.ParagraphProperties(new W.ParagraphStyleId { Val = "TableText" }, new W.KeepNext()), labelRun))));
        var contentProperties = new W.TableCellProperties(new W.Shading { Fill = "F4F4F4", Val = W.ShadingPatternValues.Clear });
        var paragraph = new W.Paragraph(new W.ParagraphProperties(new W.SpacingBetweenLines
            { After = "0", Line = "240", LineRule = W.LineSpacingRuleValues.Auto }));
        var lines = value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (i > 0) paragraph.Append(new W.Run(new W.Break()));
            paragraph.Append(new W.Run(new W.RunProperties(
                    new W.RunFonts { Ascii = "Consolas", HighAnsi = "Consolas", EastAsia = "Yu Gothic" },
                    new W.FontSize { Val = "16" }),
                new W.Text(lines[i]) { Space = SpaceProcessingModeValues.Preserve }));
        }
        var contentRow = new W.TableRow(new W.TableCell(contentProperties, paragraph));
        if (value.Length <= 5000) contentRow.PrependChild(new W.TableRowProperties(new W.CantSplit()));
        table.Append(contentRow);
        _body.Append(table);
        _body.Append(new W.Paragraph(new W.ParagraphProperties(new W.SpacingBetweenLines { After = "120" })));
    }

    private void Section(string number, string title) => Heading($"{number}  {title}", 1, true);
    private void Heading(string text, int level, bool pageBreak = false)
    {
        var paragraph = P(text, "Heading" + level);
        if (pageBreak) paragraph.ParagraphProperties!.Append(new W.PageBreakBefore());
        _body.Append(paragraph);
    }
    private void Labeled(string label, string value)
    {
        Heading(label, 3);
        Paragraph(Value(value), "Body");
    }
    private void Paragraph(string text, string style, int before = 0, int after = 120)
    {
        var paragraph = P(text, style);
        paragraph.ParagraphProperties!.Append(new W.SpacingBetweenLines { Before = before.ToString(), After = after.ToString(), Line = "300", LineRule = W.LineSpacingRuleValues.Auto });
        _body.Append(paragraph);
    }
    private static W.Paragraph P(string text, string style)
    {
        var paragraph = new W.Paragraph(new W.ParagraphProperties(new W.ParagraphStyleId { Val = style }));
        var lines = (text ?? "").Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (i > 0) paragraph.Append(new W.Run(new W.Break()));
            paragraph.Append(new W.Run(new W.Text(lines[i]) { Space = SpaceProcessingModeValues.Preserve }));
        }
        return paragraph;
    }
    private void Bullets(IEnumerable<string> values)
    {
        var items = values.Where(x => !string.IsNullOrWhiteSpace(x)).ToArray();
        if (items.Length == 0) items = ["未入力"];
        foreach (var item in items) _body.Append(NumberedParagraph(item, 1));
    }
    private void Numbered(IEnumerable<string> values)
    {
        var items = values.Where(HasValue).ToArray();
        if (items.Length == 0) return;
        foreach (var item in items) _body.Append(NumberedParagraph(item, 2));
    }
    private static W.Paragraph NumberedParagraph(string text, int numberId) => new(
        new W.ParagraphProperties(new W.ParagraphStyleId { Val = "Body" }, new W.NumberingProperties(new W.NumberingLevelReference { Val = 0 }, new W.NumberingId { Val = numberId })),
        new W.Run(new W.Text(text) { Space = SpaceProcessingModeValues.Preserve }));
    private void AddPageBreak() => _body.Append(new W.Paragraph(new W.Run(new W.Break { Type = W.BreakValues.Page })));

    private void KeyValues(IEnumerable<(string Label, string Value)> rows) => Table(["項目", "内容"], rows.Select(x => new[] { x.Label, Value(x.Value) }), [2400, 6600], false);

    private void Table(string[] headers, IEnumerable<string[]> rows, int[] widths, bool showHeader = true)
    {
        var table = new W.Table();
        table.Append(new W.TableProperties(new W.TableWidth { Width = ContentWidth.ToString(), Type = W.TableWidthUnitValues.Dxa },
            Borders(), new W.TableLayout { Type = W.TableLayoutValues.Fixed }, CellMargins()));
        table.Append(new W.TableGrid(widths.Select(x => new W.GridColumn { Width = x.ToString() })));
        if (showHeader) table.Append(Row(headers, widths, true, false));
        var materialized = rows.ToArray();
        if (materialized.Length == 0) materialized = [Enumerable.Repeat("未入力", headers.Length).ToArray()];
        for (var i = 0; i < materialized.Length; i++) table.Append(Row(materialized[i], widths, false, i % 2 == 1));
        _body.Append(table);
        _body.Append(new W.Paragraph(new W.ParagraphProperties(new W.SpacingBetweenLines { After = "100" })));
    }
    private static W.TableRow Row(string[] values, int[] widths, bool header, bool alternate)
    {
        var row = new W.TableRow();
        if (header) row.Append(new W.TableRowProperties(new W.TableHeader()));
        for (var i = 0; i < widths.Length; i++)
        {
            var cellProperties = new W.TableCellProperties(new W.TableCellWidth { Width = widths[i].ToString(), Type = W.TableWidthUnitValues.Dxa });
            if (header) cellProperties.Append(new W.Shading { Fill = Navy, Val = W.ShadingPatternValues.Clear });
            else if (alternate) cellProperties.Append(new W.Shading { Fill = PaleBlue, Val = W.ShadingPatternValues.Clear });
            cellProperties.Append(new W.TableCellVerticalAlignment { Val = W.TableVerticalAlignmentValues.Center });
            var runProperties = new W.RunProperties(new W.RunFonts { Ascii = "Aptos", HighAnsi = "Aptos", EastAsia = "Yu Gothic" });
            if (header) runProperties.Append(new W.Bold());
            runProperties.Append(new W.Color { Val = header ? "FFFFFF" : "000000" }, new W.FontSize { Val = "18" });
            var paragraph = new W.Paragraph(new W.ParagraphProperties(new W.ParagraphStyleId { Val = "TableText" }));
            var lines = (i < values.Length ? values[i] : "").Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            for (var line = 0; line < lines.Length; line++)
            {
                if (line > 0) paragraph.Append(new W.Run(new W.Break()));
                paragraph.Append(new W.Run((W.RunProperties)runProperties.CloneNode(true), new W.Text(lines[line]) { Space = SpaceProcessingModeValues.Preserve }));
            }
            row.Append(new W.TableCell(cellProperties, paragraph));
        }
        return row;
    }
    private static W.TableBorders Borders() => new(
        new W.TopBorder { Val = W.BorderValues.Single, Color = Border, Size = 4 }, new W.LeftBorder { Val = W.BorderValues.Single, Color = Border, Size = 4 },
        new W.BottomBorder { Val = W.BorderValues.Single, Color = Border, Size = 4 }, new W.RightBorder { Val = W.BorderValues.Single, Color = Border, Size = 4 },
        new W.InsideHorizontalBorder { Val = W.BorderValues.Single, Color = Border, Size = 4 }, new W.InsideVerticalBorder { Val = W.BorderValues.Single, Color = Border, Size = 4 });
    private static W.TableCellMarginDefault CellMargins() => new(
        new W.TopMargin { Width = "90", Type = W.TableWidthUnitValues.Dxa }, new W.TableCellLeftMargin { Width = 100, Type = W.TableWidthValues.Dxa },
        new W.BottomMargin { Width = "90", Type = W.TableWidthUnitValues.Dxa }, new W.TableCellRightMargin { Width = 100, Type = W.TableWidthValues.Dxa });

    private W.SectionProperties SectionProperties(ReportDocumentV2 report)
    {
        var headerPart = _part.AddNewPart<HeaderPart>();
        headerPart.Header = new W.Header(new W.Paragraph(new W.ParagraphProperties(new W.ParagraphStyleId { Val = "Header" },
            new W.Tabs(new W.TabStop { Val = W.TabStopValues.Right, Position = ContentWidth })),
            new W.Run(new W.Text("Web アプリケーション脆弱性診断報告書")), new W.Run(new W.TabChar()), new W.Run(new W.Text("ScopePilot"))));
        var footerPart = _part.AddNewPart<FooterPart>();
        footerPart.Footer = new W.Footer(new W.Paragraph(new W.ParagraphProperties(new W.ParagraphStyleId { Val = "Footer" },
            new W.Tabs(new W.TabStop { Val = W.TabStopValues.Right, Position = ContentWidth })),
            new W.Run(new W.Text("取扱区分  " + report.Report.Classification)), new W.Run(new W.TabChar()),
            new W.Run(new W.Text("Page ") { Space = SpaceProcessingModeValues.Preserve }),
            new W.SimpleField(new W.Run(new W.Text("1"))) { Instruction = " PAGE " }));
        return new W.SectionProperties(new W.HeaderReference { Type = W.HeaderFooterValues.Default, Id = _part.GetIdOfPart(headerPart) },
            new W.FooterReference { Type = W.HeaderFooterValues.Default, Id = _part.GetIdOfPart(footerPart) },
            new W.PageSize { Width = 11906, Height = 16838 },
            new W.PageMargin { Top = 1020, Bottom = 1020, Left = 1080, Right = 1080, Header = 450, Footer = 450, Gutter = 0 },
            new W.PageNumberType { Start = 0 }, new W.TitlePage());
    }

    private void AddStyles()
    {
        var stylesPart = _part.AddNewPart<StyleDefinitionsPart>();
        var styles = new W.Styles();
        styles.Append(ParagraphStyle("Normal", "本文", 21, false, 0, 120, false));
        styles.Append(ParagraphStyle("Body", "本文段落", 21, false, 0, 120, false));
        styles.Append(ParagraphStyle("Title", "表題", 52, true, 0, 240, true));
        styles.Append(ParagraphStyle("Subtitle", "副題", 30, true, 0, 220, true, Gray));
        styles.Append(ParagraphStyle("Eyebrow", "表紙識別子", 18, true, 0, 100, true));
        styles.Append(ParagraphStyle("Small", "注記", 18, false, 0, 80, false, Gray));
        styles.Append(ParagraphStyle("Heading1", "見出し 1", 34, true, 300, 180, true, "000000", 0));
        styles.Append(ParagraphStyle("Heading2", "見出し 2", 25, true, 240, 120, true, "000000", 1));
        styles.Append(ParagraphStyle("Heading3", "見出し 3", 21, true, 180, 80, true, "000000", 2));
        styles.Append(ParagraphStyle("TableText", "表本文", 18, false, 0, 40, false));
        styles.Append(ParagraphStyle("Header", "ヘッダー", 17, false, 0, 0, false, "000000"));
        styles.Append(ParagraphStyle("Footer", "フッター", 16, false, 0, 0, false, Gray));
        stylesPart.Styles = styles;
        _part.AddNewPart<DocumentSettingsPart>().Settings = new W.Settings(new W.UpdateFieldsOnOpen { Val = true });
    }
    private static W.Style ParagraphStyle(string id, string name, int size, bool bold, int before, int after, bool keep,
        string color = "000000", int? outline = null)
    {
        var style = new W.Style { Type = W.StyleValues.Paragraph, StyleId = id, Default = id == "Normal" };
        style.Append(new W.StyleName { Val = name });
        if (id != "Normal") style.Append(new W.BasedOn { Val = "Normal" });
        var pp = new W.StyleParagraphProperties();
        if (keep) pp.Append(new W.KeepNext());
        pp.Append(new W.WidowControl(), new W.SpacingBetweenLines { Before = before.ToString(), After = after.ToString(), Line = "300", LineRule = W.LineSpacingRuleValues.Auto });
        if (outline is not null) pp.Append(new W.OutlineLevel { Val = outline.Value });
        style.Append(pp);
        var rp = new W.StyleRunProperties(new W.RunFonts { Ascii = "Aptos", HighAnsi = "Aptos", EastAsia = "Yu Gothic", ComplexScript = "Arial" });
        if (bold) rp.Append(new W.Bold());
        rp.Append(new W.Color { Val = color }, new W.FontSize { Val = size.ToString() }, new W.FontSizeComplexScript { Val = size.ToString() },
            new W.Languages { Val = "ja-JP", EastAsia = "ja-JP" });
        style.Append(rp);
        return style;
    }
    private void AddNumbering()
    {
        var part = _part.AddNewPart<NumberingDefinitionsPart>();
        var bullet = new W.AbstractNum(new W.Level(new W.NumberingFormat { Val = W.NumberFormatValues.Bullet }, new W.LevelText { Val = "•" },
            new W.LevelJustification { Val = W.LevelJustificationValues.Left }, new W.PreviousParagraphProperties(new W.Indentation { Left = "480", Hanging = "240" })) { LevelIndex = 0 }) { AbstractNumberId = 1 };
        var number = new W.AbstractNum(new W.Level(new W.StartNumberingValue { Val = 1 }, new W.NumberingFormat { Val = W.NumberFormatValues.Decimal },
            new W.LevelText { Val = "%1." }, new W.LevelJustification { Val = W.LevelJustificationValues.Left },
            new W.PreviousParagraphProperties(new W.Indentation { Left = "480", Hanging = "240" })) { LevelIndex = 0 }) { AbstractNumberId = 2 };
        part.Numbering = new W.Numbering(bullet, number,
            new W.NumberingInstance(new W.AbstractNumId { Val = 1 }) { NumberID = 1 },
            new W.NumberingInstance(new W.AbstractNumId { Val = 2 }) { NumberID = 2 });
    }

    private static string Join(IEnumerable<string> values) => string.Join(" / ", values.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.Ordinal).DefaultIfEmpty("未入力"));
    private static bool HasValue(string value) => !string.IsNullOrWhiteSpace(value) && value != "未入力" && value != "未記載";
    private static string JoinText(params string[] values) => string.Join("\n", values.Where(HasValue).DefaultIfEmpty("未入力"));
    private static string Value(string value) => string.IsNullOrWhiteSpace(value) ? "未入力" : value;
    private static string Period(DateTimeOffset? start, DateTimeOffset? end) => start is null && end is null ? "未入力" : $"{start?.ToString("yyyy-MM-dd HH:mm zzz") ?? "未入力"} ～ {end?.ToString("yyyy-MM-dd HH:mm zzz") ?? "未入力"}";
    private static string Cvss(ReportCvssV2 cvss) => cvss.Score is null ? "未入力" : $"{cvss.Version} {cvss.Score:0.0} {cvss.Vector}";
    private static string NewLine(string value) => string.IsNullOrWhiteSpace(value) ? "" : "\n" + value;
}
