using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using ScopePilot.Domain;

namespace ScopePilot.Services.WordReports;

public sealed record WordReportResult(string WordPath, string MarkdownPath, string ManifestPath, string TemplateId, IReadOnlyList<string> Warnings);

public sealed class MarkdownWordReportService(IWordReportTemplate? template = null)
{
    public const int MaxMarkdownBytes = 10 * 1024 * 1024;
    internal static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder().UsePipeTables().UseAutoLinks().UseEmphasisExtras().UseTaskLists().Build();

    public async Task<WordReportResult> ConvertAsync(EngagementProject project, string markdownPath)
    {
        ProjectPaths.CheckProjectFile(project);
        if (Path.GetExtension(markdownPath).ToLowerInvariant() is not (".md" or ".markdown")) throw new InvalidDataException("Markdownファイル（.md / .markdown）を選択してください。");
        if (new FileInfo(markdownPath).Length > MaxMarkdownBytes) throw new InvalidDataException("Markdownレポートは10MB以下にしてください。");
        var bytes = await File.ReadAllBytesAsync(markdownPath);
        if (bytes.Length > MaxMarkdownBytes) throw new InvalidDataException("Markdownレポートは10MB以下にしてください。");
        string text;
        try { text = new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF'); }
        catch (DecoderFallbackException ex) { throw new InvalidDataException("UTF-8のMarkdownファイルを選択してください。", ex); }
        if (string.IsNullOrWhiteSpace(text) || text.Contains('\0')) throw new InvalidDataException("空ではないMarkdownレポートを選択してください。");
        var document = Markdown.Parse(text, Pipeline);
        var root = ProjectPaths.Root(project);
        var original = Path.GetFullPath(markdownPath);
        var internalSource = original.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        var assetRoot = internalSource ? root : Path.GetDirectoryName(original)!;
        ProjectPaths.EnsureChild(assetRoot, original);
        var source = original;
        if (!internalSource)
        {
            var folder = ProjectPaths.Resolve(project, $"inputs/markdown-report-{Guid.NewGuid():N}");
            Directory.CreateDirectory(folder);
            source = Path.Combine(folder, Path.GetFileName(original));
            await File.WriteAllBytesAsync(source, bytes);
        }
        var warnings = new List<string>();
        var images = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var image in document.Descendants<LinkInline>().Where(x => x.IsImage))
        {
            var value = image.Url ?? "";
            if (images.ContainsKey(value)) continue;
            try
            {
                if (Uri.TryCreate(value, UriKind.Absolute, out _) || value.StartsWith("//")) throw new InvalidDataException("外部画像は取得しません。");
                var imagePath = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(original)!, Uri.UnescapeDataString(value.Split('#')[0])));
                ProjectPaths.EnsureChild(assetRoot, imagePath);
                if (!File.Exists(imagePath) || new FileInfo(imagePath).Length > 10 * 1024 * 1024) throw new InvalidDataException("画像が見つからないか10MBを超えています。");
                if (Path.GetExtension(imagePath).ToLowerInvariant() is not (".png" or ".jpg" or ".jpeg" or ".gif" or ".bmp")) throw new InvalidDataException("PNG/JPEG/GIF/BMP画像に対応しています。");
                if (!internalSource)
                {
                    var copied = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(source)!, Path.GetRelativePath(Path.GetDirectoryName(original)!, imagePath)));
                    ProjectPaths.EnsureChild(Path.GetDirectoryName(source)!, copied);
                    Directory.CreateDirectory(Path.GetDirectoryName(copied)!);
                    if (!File.Exists(copied)) File.Copy(imagePath, copied);
                    imagePath = copied;
                }
                images[value] = imagePath;
            }
            catch (Exception ex) when (ex is IOException or InvalidDataException or UriFormatException or ArgumentException or UnauthorizedAccessException)
            { warnings.Add($"画像を埋め込めません: {value}（{ex.Message}）"); }
        }
        var selectedTemplate = template ?? new DefaultWordReportTemplate();
        var directory = ProjectPaths.Resolve(project, $"reports/word-{DateTimeOffset.Now:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        var name = Path.GetFileNameWithoutExtension(source);
        var word = Path.Combine(directory, name + ".docx");
        var temporary = word + ".tmp";
        try
        {
            await Task.Run(() => new MarkdownWordRenderer(selectedTemplate, warnings, images).Write(document, temporary));
            File.Move(temporary, word);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        var manifest = Path.Combine(directory, "word-conversion.json");
        await File.WriteAllTextAsync(manifest, JsonSerializer.Serialize(new
        {
            formatVersion = 1, generatedAt = DateTimeOffset.Now, templateId = selectedTemplate.Id,
            markdown = ProjectPaths.Relative(project, source), markdownSha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            word = ProjectPaths.Relative(project, word), wordSha256 = (await ProjectPaths.EvidenceAsync(project, word, "word-report")).Sha256,
            images = images.ToDictionary(x => x.Key, x => ProjectPaths.Relative(project, x.Value)), warnings = warnings.Distinct().ToArray()
        }, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
        return new(word, source, manifest, selectedTemplate.Id, warnings.Distinct().ToArray());
    }
}
