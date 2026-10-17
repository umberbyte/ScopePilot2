using System.Text;

namespace ScopePilot.Services;

public static class TextDocumentReader
{
    public const int MaxCharacters = 250_000;
    private static string FormatError => $"UTF-8のテキスト文書（最大{MaxCharacters:N0}文字）を選択してください。PDF・Wordはテキストへ変換してください。";

    public static async Task<string> ReadAsync(string path)
    {
        if (Path.GetExtension(path).ToLowerInvariant() is ".pdf" or ".doc" or ".docx")
            throw new InvalidDataException(FormatError);
        if (new FileInfo(path).Length > MaxCharacters * 4L)
            throw new InvalidDataException("ドキュメントが大きすぎます。必要な部分を分割して読み込んでください。");
        var bytes = await File.ReadAllBytesAsync(path);
        if (bytes.Length > MaxCharacters * 4L) throw new InvalidDataException(FormatError);
        string content;
        try { content = new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF'); }
        catch (DecoderFallbackException ex) { throw new InvalidDataException(FormatError, ex); }
        if (string.IsNullOrWhiteSpace(content) || content.Contains('\0') || content.Length > MaxCharacters)
            throw new InvalidDataException(FormatError);
        return content;
    }
}
