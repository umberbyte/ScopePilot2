using System.IO;
using System.Text;
using System.Text.Json;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;
using ScopePilot.Domain;
using ScopePilot.Services;
using ScopePilot.Services.WordReports;
using ScopePilot.ViewModels;
using W = DocumentFormat.OpenXml.Wordprocessing;
using Xunit;

namespace ScopePilot.Tests;

public sealed class WordReportTests
{
    private const string Markdown = """
        # 日本語レポート

        変換後も**重要な情報**と *斜体* と ~~取消~~ と `GET /example` を保持します。
        [公式ドキュメント](https://example.test/docs) と [対象一覧](#対象一覧) を参照します。

        ## 対象一覧

        | ID | URL | 状態 |
        | --- | --- | :---: |
        | 1 | https://example.test/home | 要確認 |
        | 2 | リテラル \| 文字<br>次の行 | 未到達 |

        - 許可範囲を確認
          - 対象ページを閲覧
        - [x] 記録を保存

        3. 最初の項目
        4. 次の項目

        > 観測した範囲に基づく記録です。

        ```http
        GET /example HTTP/1.1
        Host: example.test
        ```

        ## 同じ見出し

        本文。

        ## 同じ見出し

        重複する見出しも保持します。
        """;

    private static void AssertValid(WordprocessingDocument doc)
    {
        var errors = new OpenXmlValidator().Validate(doc).ToArray();
        Assert.True(errors.Length == 0, string.Join("\n", errors.Select(x => x.Description + " at " + x.Path?.XPath)));
    }

    [Fact]
    public async Task ConvertsStructuredMarkdownToNativeWordElementsWithoutSavingProject()
    {
        using var temp = new TestFolder();
        var project = temp.Project(); await new ProjectStore().SaveAsync(project);
        var saved = await File.ReadAllTextAsync(project.ProjectFilePath);
        var source = ProjectPaths.Resolve(project, "report.md"); await File.WriteAllTextAsync(source, Markdown);
        var result = await new MarkdownWordReportService().ConvertAsync(project, source);
        Assert.Empty(result.Warnings);
        Assert.Equal(saved, await File.ReadAllTextAsync(project.ProjectFilePath));
        Assert.Equal(Markdown, await File.ReadAllTextAsync(source));
        using var doc = WordprocessingDocument.Open(result.WordPath, false);
        AssertValid(doc);
        var body = doc.MainDocumentPart!.Document!.Body!;
        Assert.Contains(body.Elements<W.Paragraph>(), p => p.ParagraphProperties?.ParagraphStyleId?.Val == "Title");
        Assert.Single(body.Elements<W.Table>());
        Assert.Equal(3, body.Elements<W.Table>().Single().Elements<W.TableRow>().Count());
        var table = body.Elements<W.Table>().Single();
        var widths = table.GetFirstChild<W.TableGrid>()!.Elements<W.GridColumn>().Select(x => x.Width!.Value).ToArray();
        var cellWidths = table.Elements<W.TableRow>().First().Elements<W.TableCell>().Select(x => x.TableCellProperties!.TableCellWidth!.Width!.Value).ToArray();
        Assert.Equal(widths, cellWidths);
        Assert.True(int.Parse(widths[1]!) > int.Parse(widths[0]!));
        Assert.Contains("リテラル | 文字", body.InnerText);
        Assert.Contains("GET /example HTTP/1.1", body.InnerText);
        Assert.True(body.Descendants<W.NumberingProperties>().Count() >= 5);
        Assert.Contains(doc.MainDocumentPart.HyperlinkRelationships, r => r.Uri.AbsoluteUri == "https://example.test/docs");
        Assert.Contains(body.Descendants<W.Hyperlink>(), l => l.Anchor?.Value?.StartsWith("Heading_") == true);
        var bookmarks = body.Descendants<W.BookmarkStart>().Select(x => x.Name!.Value).ToArray(); Assert.Equal(bookmarks.Length, bookmarks.Distinct().Count());
        Assert.All(body.Descendants<W.TableHeader>(), h => Assert.NotNull(h.Parent));
        using var manifest = JsonDocument.Parse(await File.ReadAllTextAsync(result.ManifestPath));
        Assert.Equal("scopepilot-a4-ja-v1", manifest.RootElement.GetProperty("templateId").GetString());
        Assert.StartsWith("reports/word-", manifest.RootElement.GetProperty("word").GetString());
    }

    [Fact]
    public async Task ImportsLocalImagesAndCopiedMarkdownCanBeConvertedAgain()
    {
        using var temp = new TestFolder(); var project = temp.Project(); await new ProjectStore().SaveAsync(project);
        var source = Path.Combine(temp.Path, "original.md");
        var image = Path.Combine(temp.Path, "images", "sample.png"); Directory.CreateDirectory(Path.GetDirectoryName(image)!);
        await File.WriteAllBytesAsync(image, Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII="));
        await File.WriteAllTextAsync(source, "# 画像を含む報告書\n\n![証拠画像](images/sample.png)\n");
        var first = await new MarkdownWordReportService().ConvertAsync(project, source);
        Assert.Empty(first.Warnings);
        Assert.StartsWith(ProjectPaths.Category(project, "inputs"), first.MarkdownPath);
        File.Delete(source); File.Delete(image);
        var second = await new MarkdownWordReportService().ConvertAsync(project, first.MarkdownPath);
        Assert.Empty(second.Warnings);
        using var doc = WordprocessingDocument.Open(second.WordPath, false);
        Assert.Single(doc.MainDocumentPart!.ImageParts); AssertValid(doc);
    }

    [Fact]
    public async Task MissingOrExternalImagesAndHtmlArePreservedWithoutExternalResourceFetch()
    {
        using var temp = new TestFolder(); var project = temp.Project(); await new ProjectStore().SaveAsync(project);
        var source = ProjectPaths.Resolve(project, "unsafe.md");
        await File.WriteAllTextAsync(source, "# 記録\n\n![外部画像](https://example.invalid/image.png)\n\n![範囲外](../../outside.png)\n\n<script>original text</script>\n\n[リンク](javascript:alert(1))");
        var result = await new MarkdownWordReportService().ConvertAsync(project, source);
        Assert.True(result.Warnings.Count >= 3);
        using var doc = WordprocessingDocument.Open(result.WordPath, false); AssertValid(doc);
        Assert.Empty(doc.MainDocumentPart!.ImageParts);
        Assert.Empty(doc.MainDocumentPart.HyperlinkRelationships);
        Assert.Contains("[画像: 外部画像]", doc.MainDocumentPart.Document!.InnerText);
        Assert.Contains("original text", doc.MainDocumentPart.Document.InnerText);
    }

    [Fact]
    public async Task TemplateProviderCanChangeFormattingWithoutChangingMarkdownConversion()
    {
        using var temp = new TestFolder(); var project = temp.Project(); await new ProjectStore().SaveAsync(project);
        var source = ProjectPaths.Resolve(project, "custom.md"); await File.WriteAllTextAsync(source, "# レポート\n\n本文。");
        var result = await new MarkdownWordReportService(new FutureTemplate()).ConvertAsync(project, source);
        Assert.Equal("future-template-fixture", result.TemplateId);
        using var doc = WordprocessingDocument.Open(result.WordPath, false); AssertValid(doc);
        Assert.Equal("32", doc.MainDocumentPart!.StyleDefinitionsPart!.Styles!.Elements<W.Style>().Single(x => x.StyleId == "Title").StyleRunProperties!.FontSize!.Val!.Value);
        Assert.Contains("本文。", doc.MainDocumentPart.Document!.InnerText);
    }

    [Fact]
    public async Task InvalidUtf8IsRejectedAndViewModelRecoversAfterFailure()
    {
        using var temp = new TestFolder(); var project = temp.Project(); await new ProjectStore().SaveAsync(project);
        var vm = new MainViewModel(); Assert.True(await vm.OpenProjectAsync(project.ProjectFilePath));
        var saved = await File.ReadAllTextAsync(project.ProjectFilePath);
        var path = ProjectPaths.Resolve(project, "invalid.md"); await File.WriteAllBytesAsync(path, [0xff, 0xfe, 0xff]);
        Assert.Null(await vm.ConvertMarkdownReportAsync(path));
        Assert.False(vm.IsRunning); Assert.True(vm.CanConvertWordReport);
        Assert.Equal(saved, await File.ReadAllTextAsync(project.ProjectFilePath));
        Assert.Contains("UTF-8", vm.WordReportStatusText);
    }

    [Fact]
    public async Task StandardJapaneseReportConvertsWithValidWordStructure()
    {
        var qa = Environment.GetEnvironmentVariable("SCOPEPILOT_WORD_QA");
        using var temp = new TestFolder();
        var project = qa is null ? temp.Project() : new EngagementProject { ProjectFilePath = Path.Combine(qa, "project.scopepilot.json"), Name = "Word変換確認", StartUrl = "https://example.test", AllowedOrigins = "https://example.test" };
        await new ProjectStore().SaveAsync(project);
        for (var i = 1; i <= 28; i++) project.Requests.Add(new ObservedRequest { Url = $"https://example.test/section/{i}", PageTitle = $"対象ページ {i}", StatusCode = 200, Role = "一般ユーザー" });
        project.Findings.Add(new DiagnosticFinding { Title = "画面と通信の記録", Description = "通常閲覧で確認した内容を整理しました。担当者は対象と記録を確認してください。", Evidence = "GET /section/1 HTTP/1.1\nHost: example.test", AffectedUrls = "https://example.test/section/1", Limitations = "送信操作は未実施です。" });
        var markdown = await new FindingReportService().ExportAsync(project);
        var result = await new MarkdownWordReportService().ConvertAsync(project, markdown.MarkdownPath);
        using var doc = WordprocessingDocument.Open(result.WordPath, false); AssertValid(doc);
        Assert.Contains("Web アプリケーション診断結果報告書", doc.MainDocumentPart!.Document!.InnerText);
        if (qa is not null) await File.WriteAllTextAsync(Path.Combine(qa, "qa-result.json"), JsonSerializer.Serialize(result));
    }

    private sealed class FutureTemplate : IWordReportTemplate
    {
        private readonly DefaultWordReportTemplate _base = new();
        public string Id => "future-template-fixture";
        public WordReportStyles Styles => _base.Styles;
        public int ContentWidthTwips => _base.ContentWidthTwips;
        public void Apply(WordprocessingDocument document)
        {
            _base.Apply(document);
            document.MainDocumentPart!.StyleDefinitionsPart!.Styles!.Elements<W.Style>().Single(x => x.StyleId == "Title").StyleRunProperties!.FontSize!.Val = "32";
        }
    }
}
