using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Media.Imaging;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using Markdig.Extensions.Tables;
using Markdig.Extensions.TaskLists;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using W = DocumentFormat.OpenXml.Wordprocessing;
using A = DocumentFormat.OpenXml.Drawing;
using DW = DocumentFormat.OpenXml.Drawing.Wordprocessing;
using PIC = DocumentFormat.OpenXml.Drawing.Pictures;

namespace ScopePilot.Services.WordReports;

internal sealed class MarkdownWordRenderer(IWordReportTemplate template, List<string> warnings, IReadOnlyDictionary<string, string> images)
{
    private MainDocumentPart _part = null!;
    private bool _hasTitle;
    private int _listId = 1;
    private uint _imageId = 1;
    private readonly Dictionary<string, string> _bookmarks = new(StringComparer.Ordinal);
    private readonly HashSet<string> _usedBookmarks = new(StringComparer.Ordinal);
    private int _bookmarkId;
    private sealed record InlineFormat(bool Bold = false, bool Italic = false, bool Strike = false, bool Code = false, bool Header = false, string? Link = null, int? ImageWidthTwips = null);

    public void Write(MarkdownDocument markdown, string path)
    {
        using var doc = WordprocessingDocument.Create(path, WordprocessingDocumentType.Document);
        _part = doc.AddMainDocumentPart();
        _part.Document = new W.Document(new W.Body());
        template.Apply(doc);
        var body = _part.Document.Body!;
        var section = body.Elements<W.SectionProperties>().LastOrDefault();
        section?.Remove();
        foreach (var h in markdown.Descendants<HeadingBlock>())
        {
            var anchor = Anchor(PlainText(h.Inline));
            if (!_bookmarks.ContainsKey(anchor)) _bookmarks[anchor] = "Heading_" + _bookmarks.Count;
        }
        RenderBlocks(markdown, body);
        if (!body.Elements<W.Paragraph>().Any()) body.Append(Paragraph(template.Styles.Body));
        if (section is not null) body.Append(section);
        doc.PackageProperties.Creator = "ScopePilot";
        doc.PackageProperties.Title = markdown.Descendants<HeadingBlock>().Select(h => PlainText(h.Inline)).FirstOrDefault() ?? "レポート";
        _part.Document.Save();
    }

    private W.Paragraph Paragraph(string style) => new(new W.ParagraphProperties(new W.ParagraphStyleId { Val = style }));
    private void RenderBlocks(ContainerBlock blocks, OpenXmlCompositeElement parent, int depth = 0, int? number = null, bool quote = false)
    {
        var first = true;
        foreach (var block in blocks)
        {
            switch (block)
            {
                case HeadingBlock h:
                    var title = !_hasTitle && h.Level == 1;
                    if (title) _hasTitle = true;
                    var style = title ? template.Styles.Title : template.Styles.HeadingPrefix + Math.Clamp(h.Level - (_hasTitle ? 1 : 0), 1, 6);
                    var heading = Paragraph(style);
                    var anchor = Anchor(PlainText(h.Inline));
                    var bookmark = _bookmarks.GetValueOrDefault(anchor);
                    if (bookmark is not null && !_usedBookmarks.Add(bookmark)) bookmark = "RepeatedHeading_" + _bookmarkId;
                    if (bookmark is not null)
                    {
                        heading.Append(new W.BookmarkStart { Name = bookmark, Id = _bookmarkId.ToString() });
                        AppendInline(h.Inline, heading, new());
                        heading.Append(new W.BookmarkEnd { Id = (_bookmarkId++).ToString() });
                    }
                    else AppendInline(h.Inline, heading, new());
                    parent.Append(heading); break;
                case ParagraphBlock p:
                    var paragraph = Paragraph(quote ? template.Styles.Quote : template.Styles.Body);
                    if (first && number.HasValue)
                        paragraph.ParagraphProperties!.Append(new W.NumberingProperties(new W.NumberingLevelReference { Val = Math.Clamp(depth, 0, 8) }, new W.NumberingId { Val = number.Value }));
                    else if (number.HasValue) paragraph.ParagraphProperties!.Append(new W.Indentation { Left = ((depth + 1) * 360).ToString() });
                    AppendInline(p.Inline, paragraph, new()); parent.Append(paragraph); break;
                case ListBlock list:
                    var num = AddNumbering(list);
                    foreach (var item in list.OfType<ListItemBlock>()) RenderBlocks(item, parent, depth + (number.HasValue ? 1 : 0), num, quote);
                    break;
                case QuoteBlock q: RenderBlocks(q, parent, depth, number, true); break;
                case CodeBlock code:
                    foreach (var line in code.Lines.ToString().Replace("\r\n", "\n").Split('\n'))
                    {
                        var cp = Paragraph(template.Styles.Code); cp.Append(TextRun(line, new())); parent.Append(cp);
                    }
                    parent.Append(Paragraph(template.Styles.Body)); break;
                case Table table: parent.Append(RenderTable(table)); parent.Append(Paragraph(template.Styles.Body)); break;
                case ThematicBreakBlock:
                    var rule = Paragraph(template.Styles.Body);
                    rule.ParagraphProperties!.Append(new W.ParagraphBorders(new W.BottomBorder { Val = W.BorderValues.Single, Color = "D9D9D9", Size = 4, Space = 4 }));
                    parent.Append(rule); break;
                case HtmlBlock html:
                    var hp = Paragraph(template.Styles.Code); hp.Append(TextRun(html.Lines.ToString(), new(Code: true))); parent.Append(hp);
                    warnings.Add("HTMLブロックは実行せずテキストとして掲載しました。"); break;
                case LinkReferenceDefinitionGroup: break;
                case ContainerBlock container: RenderBlocks(container, parent, depth, number, quote); break;
                case LeafBlock leaf:
                    var other = Paragraph(template.Styles.Body); AppendInline(leaf.Inline, other, new());
                    if (leaf.Inline is null) other.Append(TextRun(leaf.Lines.ToString(), new())); parent.Append(other);
                    warnings.Add($"行{block.Line + 1}の拡張記法はテキストとして掲載しました。"); break;
            }
            first = false;
        }
    }

    private int AddNumbering(ListBlock list)
    {
        var part = _part.NumberingDefinitionsPart ?? _part.AddNewPart<NumberingDefinitionsPart>();
        part.Numbering ??= new W.Numbering();
        var id = _listId++;
        var abstractNum = new W.AbstractNum { AbstractNumberId = id };
        abstractNum.Append(new W.MultiLevelType { Val = W.MultiLevelValues.Multilevel });
        var start = list.IsOrdered && int.TryParse(list.OrderedStart, out var n) ? Math.Max(1, n) : 1;
        for (var i = 0; i < 9; i++)
        {
            var level = new W.Level { LevelIndex = i };
            level.Append(new W.StartNumberingValue { Val = start }, new W.NumberingFormat { Val = list.IsOrdered ? W.NumberFormatValues.Decimal : W.NumberFormatValues.Bullet },
                new W.LevelText { Val = list.IsOrdered ? $"%{i + 1}." : "•" }, new W.LevelJustification { Val = W.LevelJustificationValues.Left },
                new W.PreviousParagraphProperties(new W.Indentation { Left = ((i + 1) * 360).ToString(), Hanging = "240" }));
            abstractNum.Append(level);
        }
        // Abstract numbering definitions precede numbering instances in the OOXML schema.
        var firstInstance = part.Numbering.Elements<W.NumberingInstance>().FirstOrDefault();
        if (firstInstance is null) part.Numbering.Append(abstractNum); else part.Numbering.InsertBefore(abstractNum, firstInstance);
        part.Numbering.Append(new W.NumberingInstance(new W.AbstractNumId { Val = id }) { NumberID = id });
        return id;
    }

    private W.Table RenderTable(Table table)
    {
        var rows = table.OfType<TableRow>().ToArray();
        var columns = Math.Max(1, rows.Select(r => r.OfType<TableCell>().Sum(c => Math.Max(1, c.ColumnSpan))).DefaultIfEmpty(1).Max());
        var weights = Enumerable.Repeat(6.0, columns).ToArray();
        foreach (var row in rows)
            foreach (var (cell, position) in Cells(row))
            {
                var index = Math.Clamp(position, 0, columns - 1);
                var text = string.Join(" ", cell.OfType<LeafBlock>().Select(x => PlainText(x.Inline)));
                weights[index] = Math.Max(weights[index], Math.Min(70, text.Sum(c => c > 255 ? 2.0 : 1.0) / Math.Max(1, cell.ColumnSpan)));
            }
        var widths = weights.Select(x => (int)(template.ContentWidthTwips * x / weights.Sum())).ToArray();
        widths[^1] += template.ContentWidthTwips - widths.Sum();
        var result = new W.Table();
        result.Append(new W.TableProperties(new W.TableWidth { Type = W.TableWidthUnitValues.Dxa, Width = template.ContentWidthTwips.ToString() },
            new W.TableBorders(new W.TopBorder { Val = W.BorderValues.Single, Color = "D9D9D9", Size = 4 }, new W.LeftBorder { Val = W.BorderValues.Single, Color = "D9D9D9", Size = 4 },
                new W.BottomBorder { Val = W.BorderValues.Single, Color = "D9D9D9", Size = 4 }, new W.RightBorder { Val = W.BorderValues.Single, Color = "D9D9D9", Size = 4 },
                new W.InsideHorizontalBorder { Val = W.BorderValues.Single, Color = "D9D9D9", Size = 4 }, new W.InsideVerticalBorder { Val = W.BorderValues.Single, Color = "D9D9D9", Size = 4 }),
            new W.TableLayout { Type = W.TableLayoutValues.Fixed },
            new W.TableCellMarginDefault(new W.TopMargin { Width = "100", Type = W.TableWidthUnitValues.Dxa }, new W.TableCellLeftMargin { Width = 120, Type = W.TableWidthValues.Dxa },
                new W.BottomMargin { Width = "100", Type = W.TableWidthUnitValues.Dxa }, new W.TableCellRightMargin { Width = 120, Type = W.TableWidthValues.Dxa })));
        result.Append(new W.TableGrid(widths.Select(x => new W.GridColumn { Width = x.ToString() })));
        for (var r = 0; r < rows.Length; r++)
        {
            var row = new W.TableRow();
            var rowProperties = new W.TableRowProperties();
            // Keep short records intact; long narrative cells can still span pages.
            if (rows[r].OfType<TableCell>().All(c => string.Join(" ", c.OfType<LeafBlock>().Select(x => PlainText(x.Inline))).Length <= 300)) rowProperties.Append(new W.CantSplit());
            if (rows[r].IsHeader) rowProperties.Append(new W.TableHeader());
            if (rowProperties.HasChildren) row.Append(rowProperties);
            foreach (var (cell, position) in Cells(rows[r]))
            {
                var index = Math.Clamp(position, 0, columns - 1);
                var span = Math.Min(Math.Max(1, cell.ColumnSpan), columns - index);
                var cp = new W.TableCellProperties(new W.TableCellWidth { Type = W.TableWidthUnitValues.Dxa, Width = widths.Skip(index).Take(span).Sum().ToString() });
                if (span > 1) cp.Append(new W.GridSpan { Val = span });
                cp.Append(new W.Shading { Val = W.ShadingPatternValues.Clear, Fill = rows[r].IsHeader ? "203864" : r % 2 == 0 ? "F1F5FA" : "FFFFFF" }, new W.TableCellVerticalAlignment { Val = W.TableVerticalAlignmentValues.Center });
                var output = new W.TableCell(cp);
                foreach (var p in cell.OfType<ParagraphBlock>())
                {
                    var paragraph = Paragraph(rows[r].IsHeader ? template.Styles.TableHeader : template.Styles.TableBody);
                    var align = index < table.ColumnDefinitions.Count ? table.ColumnDefinitions[index].Alignment : null;
                    var text = PlainText(p.Inline);
                    if (rows[r].IsHeader || align == TableColumnAlign.Center || Regex.IsMatch(text, @"^[\d,./%]+$")) paragraph.ParagraphProperties!.Append(new W.Justification { Val = W.JustificationValues.Center });
                    else if (align == TableColumnAlign.Right) paragraph.ParagraphProperties!.Append(new W.Justification { Val = W.JustificationValues.Right });
                    AppendInline(p.Inline, paragraph, new(Header: rows[r].IsHeader, ImageWidthTwips: Math.Max(1, widths.Skip(index).Take(span).Sum() - 240))); output.Append(paragraph);
                }
                if (!output.Elements<W.Paragraph>().Any()) output.Append(Paragraph(template.Styles.TableBody));
                row.Append(output);
            }
            result.Append(row);
        }
        return result;
    }

    private static IEnumerable<(TableCell Cell, int Position)> Cells(TableRow row)
    {
        var position = 0;
        foreach (var cell in row.OfType<TableCell>()) { yield return (cell, position); position += Math.Max(1, cell.ColumnSpan); }
    }

    private void AppendInline(ContainerInline? inline, OpenXmlCompositeElement parent, InlineFormat format)
    {
        if (inline is null) return;
        foreach (var child in inline)
            switch (child)
            {
                case LiteralInline literal: parent.Append(TextRun(literal.Content.ToString(), format)); break;
                case CodeInline code: parent.Append(TextRun(code.Content, format with { Code = true })); break;
                case LineBreakInline line: parent.Append(line.IsHard ? new W.Run(new W.Break()) : TextRun(" ", format)); break;
                case EmphasisInline emphasis:
                    AppendInline(emphasis, parent, format with { Bold = format.Bold || emphasis.DelimiterCount >= 2 && emphasis.DelimiterChar != '~', Italic = format.Italic || emphasis.DelimiterCount == 1, Strike = format.Strike || emphasis.DelimiterChar == '~' && emphasis.DelimiterCount == 2 }); break;
                case LinkInline link when link.IsImage: AppendImage(link, parent, format); break;
                case LinkInline link:
                    var url = link.Url ?? "";
                    if (url.StartsWith('#') && _bookmarks.TryGetValue(Uri.UnescapeDataString(url[1..]), out var bookmark))
                    {
                        var internalLink = new W.Hyperlink { Anchor = bookmark }; AppendInline(link, internalLink, format with { Link = url }); parent.Append(internalLink);
                    }
                    else if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" or "mailto")
                    {
                        var relation = _part.AddHyperlinkRelationship(uri, true);
                        var hyperlink = new W.Hyperlink { Id = relation.Id }; AppendInline(link, hyperlink, format with { Link = url }); parent.Append(hyperlink);
                    }
                    else { AppendInline(link, parent, format); if (url.Length > 0) parent.Append(TextRun($" ({url})", format)); }
                    break;
                case AutolinkInline auto:
                    var href = auto.IsEmail ? "mailto:" + auto.Url : auto.Url;
                    if (Uri.TryCreate(href, UriKind.Absolute, out var autoUri) && autoUri.Scheme is "http" or "https" or "mailto")
                    { var rel = _part.AddHyperlinkRelationship(autoUri, true); parent.Append(new W.Hyperlink(TextRun(auto.Url, format with { Link = href })) { Id = rel.Id }); }
                    else parent.Append(TextRun(auto.Url, format)); break;
                case HtmlInline html when Regex.IsMatch(html.Tag, @"^<br\s*/?>$", RegexOptions.IgnoreCase): parent.Append(new W.Run(new W.Break())); break;
                case HtmlInline html: parent.Append(TextRun(html.Tag, format)); warnings.Add("HTMLの独自書式はテキストとして掲載しました。"); break;
                case TaskList task: parent.Append(TextRun(task.Checked ? "☑ " : "☐ ", format)); break;
                case ContainerInline container: AppendInline(container, parent, format); break;
            }
    }

    private W.Run TextRun(string text, InlineFormat format)
    {
        var properties = new W.RunProperties();
        if (format.Code) properties.Append(new W.RunStyle { Val = template.Styles.InlineCode });
        else if (format.Link is not null) properties.Append(new W.RunStyle { Val = template.Styles.Link });
        if (format.Bold) properties.Append(new W.Bold());
        if (format.Italic) properties.Append(new W.Italic());
        if (format.Strike) properties.Append(new W.Strike());
        if (format.Header) properties.Append(new W.Color { Val = "FFFFFF" });
        var run = new W.Run(properties);
        var pieces = text.Replace("\r\n", "\n").Split('\n');
        for (var i = 0; i < pieces.Length; i++) { if (i > 0) run.Append(new W.Break()); run.Append(new W.Text(pieces[i]) { Space = SpaceProcessingModeValues.Preserve }); }
        return run;
    }

    private void AppendImage(LinkInline image, OpenXmlCompositeElement parent, InlineFormat format)
    {
        var alt = PlainText(image);
        if (!images.TryGetValue(image.Url ?? "", out var path)) { parent.Append(TextRun($"[画像: {alt}]", format)); return; }
        try
        {
            using var source = File.OpenRead(path);
            var bitmap = BitmapDecoder.Create(source, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnDemand).Frames[0];
            if (bitmap.PixelWidth < 1 || bitmap.PixelHeight < 1 || (long)bitmap.PixelWidth * bitmap.PixelHeight > 50_000_000) throw new InvalidDataException("画像サイズが大きすぎます。");
            var width = Math.Min((format.ImageWidthTwips ?? template.ContentWidthTwips) * 635L, bitmap.PixelWidth * 9525L);
            var height = width * bitmap.PixelHeight / bitmap.PixelWidth;
            if (height > 8 * 914400L) { width = width * 8 * 914400L / height; height = 8 * 914400L; }
            var part = _part.AddImagePart(ImagePartType.Png);
            using var data = new MemoryStream(); var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap)); encoder.Save(data); data.Position = 0; part.FeedData(data);
            var id = _imageId++;
            var picture = new PIC.Picture(new PIC.NonVisualPictureProperties(new PIC.NonVisualDrawingProperties { Id = 0U, Name = "Image", Description = alt }, new PIC.NonVisualPictureDrawingProperties()),
                new PIC.BlipFill(new A.Blip { Embed = _part.GetIdOfPart(part) }, new A.Stretch(new A.FillRectangle())),
                new PIC.ShapeProperties(new A.Transform2D(new A.Offset { X = 0, Y = 0 }, new A.Extents { Cx = width, Cy = height }), new A.PresetGeometry(new A.AdjustValueList()) { Preset = A.ShapeTypeValues.Rectangle }));
            var drawing = new W.Drawing(new DW.Inline(new DW.Extent { Cx = width, Cy = height }, new DW.EffectExtent { LeftEdge = 0, TopEdge = 0, RightEdge = 0, BottomEdge = 0 },
                new DW.DocProperties { Id = id, Name = "Image " + id, Description = alt }, new DW.NonVisualGraphicFrameDrawingProperties(new A.GraphicFrameLocks { NoChangeAspect = true }),
                new A.Graphic(new A.GraphicData(picture) { Uri = "http://schemas.openxmlformats.org/drawingml/2006/picture" })) { DistanceFromTop = 0, DistanceFromBottom = 0, DistanceFromLeft = 0, DistanceFromRight = 0 });
            parent.Append(new W.Run(drawing));
        }
        catch (Exception ex) when (ex is IOException or NotSupportedException or InvalidOperationException or ArgumentException)
        { warnings.Add($"画像を描画できません: {image.Url}（{ex.Message}）"); parent.Append(TextRun($"[画像: {alt}]", format)); }
    }

    private static string PlainText(ContainerInline? value)
    {
        if (value is null) return "";
        var sb = new StringBuilder();
        foreach (var item in value)
            switch (item)
            {
                case LiteralInline literal: sb.Append(literal.Content); break;
                case CodeInline code: sb.Append(code.Content); break;
                case LineBreakInline: sb.Append(' '); break;
                case AutolinkInline auto: sb.Append(auto.Url); break;
                case ContainerInline container: sb.Append(PlainText(container)); break;
            }
        return sb.ToString();
    }
    private static string Anchor(string value) => Regex.Replace(value.Trim().ToLowerInvariant(), @"[^\p{L}\p{N}\s_-]", "").Replace(' ', '-');
}
