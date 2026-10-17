using DocumentFormat.OpenXml.Packaging;
using W = DocumentFormat.OpenXml.Wordprocessing;

namespace ScopePilot.Services.WordReports;

/// <summary>Replace this provider to apply a future client DOCX/DOTX layout without changing Markdown parsing.</summary>
public interface IWordReportTemplate
{
    string Id { get; }
    WordReportStyles Styles { get; }
    int ContentWidthTwips { get; }
    void Apply(WordprocessingDocument document);
}

public sealed record WordReportStyles(string Body, string Title, string HeadingPrefix, string Code, string Quote,
    string TableBody, string TableHeader, string Link, string InlineCode);

public sealed class DefaultWordReportTemplate : IWordReportTemplate
{
    public string Id => "scopepilot-a4-ja-v1";
    public WordReportStyles Styles { get; } = new("Normal", "Title", "Heading", "CodeBlock", "Quote", "TableBody", "TableHeader", "Hyperlink", "InlineCode");
    public int ContentWidthTwips => 9026;

    public void Apply(WordprocessingDocument document)
    {
        var part = document.MainDocumentPart!;
        var styles = new W.Styles();
        var stylePart = part.AddNewPart<StyleDefinitionsPart>();
        stylePart.Styles = styles;
        void ParagraphStyle(string id, string name, int size, bool bold, int before, int after, bool keep = false)
        {
            var style = new W.Style { Type = W.StyleValues.Paragraph, StyleId = id, Default = id == "Normal" };
            style.Append(new W.StyleName { Val = name });
            if (id != "Normal") style.Append(new W.BasedOn { Val = "Normal" });
            var pp = new W.StyleParagraphProperties(new W.WidowControl(), new W.SpacingBetweenLines { Before = before.ToString(), After = after.ToString(), Line = "300", LineRule = W.LineSpacingRuleValues.Auto });
            if (keep) pp.PrependChild(new W.KeepNext());
            style.Append(pp);
            var rp = new W.StyleRunProperties(new W.RunFonts { Ascii = "Aptos", HighAnsi = "Aptos", EastAsia = "Yu Gothic", ComplexScript = "Arial" },
                new W.Color { Val = "000000" }, new W.FontSize { Val = size.ToString() }, new W.FontSizeComplexScript { Val = size.ToString() }, new W.Languages { Val = "ja-JP", EastAsia = "ja-JP" });
            if (bold) rp.InsertAfter(new W.Bold(), rp.RunFonts);
            style.Append(rp); styles.Append(style);
        }
        ParagraphStyle("Normal", "本文", 22, false, 0, 120);
        ParagraphStyle("Title", "文書タイトル", 40, true, 0, 300, true);
        for (var i = 1; i <= 6; i++)
        {
            ParagraphStyle("Heading" + i, "見出し " + i, i == 1 ? 30 : i == 2 ? 26 : 22, true, i == 1 ? 300 : 200, 120, true);
            styles.LastChild!.GetFirstChild<W.StyleParagraphProperties>()!.Append(new W.OutlineLevel { Val = i - 1 });
        }
        ParagraphStyle("CodeBlock", "コードブロック", 18, false, 0, 40);
        styles.LastChild!.GetFirstChild<W.StyleRunProperties>()!.RunFonts!.Ascii = "Consolas";
        styles.LastChild!.GetFirstChild<W.StyleRunProperties>()!.RunFonts!.HighAnsi = "Consolas";
        ParagraphStyle("Quote", "引用", 22, false, 0, 120);
        styles.LastChild!.GetFirstChild<W.StyleParagraphProperties>()!.Append(new W.Indentation { Left = "360", Right = "180" });
        ParagraphStyle("TableBody", "表本文", 20, false, 0, 60);
        ParagraphStyle("TableHeader", "表見出し", 20, true, 0, 60);
        styles.LastChild!.GetFirstChild<W.StyleRunProperties>()!.Color!.Val = "FFFFFF";
        styles.Append(new W.Style(new W.StyleName { Val = "リンク" }, new W.StyleRunProperties(new W.Color { Val = "0563C1" }, new W.Underline { Val = W.UnderlineValues.Single })) { Type = W.StyleValues.Character, StyleId = "Hyperlink" });
        styles.Append(new W.Style(new W.StyleName { Val = "インラインコード" }, new W.StyleRunProperties(new W.RunFonts { Ascii = "Consolas", HighAnsi = "Consolas", EastAsia = "Yu Gothic" }, new W.FontSize { Val = "20" })) { Type = W.StyleValues.Character, StyleId = "InlineCode" });
        var footerPart = part.AddNewPart<FooterPart>();
        footerPart.Footer = new W.Footer(new W.Paragraph(new W.ParagraphProperties(new W.Justification { Val = W.JustificationValues.Right }),
            new W.SimpleField(new W.Run(new W.Text("1"))) { Instruction = " PAGE " }, new W.Run(new W.Text(" / ")),
            new W.SimpleField(new W.Run(new W.Text("1"))) { Instruction = " NUMPAGES " }));
        part.Document!.Body!.Append(new W.SectionProperties(new W.FooterReference { Type = W.HeaderFooterValues.Default, Id = part.GetIdOfPart(footerPart) },
            new W.PageSize { Width = 11906, Height = 16838 }, new W.PageMargin { Top = 1440, Bottom = 1440, Left = 1440, Right = 1440, Header = 720, Footer = 720, Gutter = 0 }));
        part.AddNewPart<DocumentSettingsPart>().Settings = new W.Settings(new W.UpdateFieldsOnOpen { Val = true });
    }
}
