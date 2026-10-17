using System.Text.Json;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed class CodexFindingImporter
{
    private static readonly HashSet<string> AllowedSeverities = new(StringComparer.OrdinalIgnoreCase)
        { "未評価", "情報", "低", "中", "高", "重大", "info", "low", "medium", "high", "critical" };
    private static readonly HashSet<string> AllowedConfidences = new(StringComparer.OrdinalIgnoreCase)
        { "低", "中", "高", "low", "medium", "high" };

    public async Task<IReadOnlyList<DiagnosticFinding>> ImportAsync(string resultPath, string sourceRunDirectory)
    {
        if (!File.Exists(resultPath)) return Array.Empty<DiagnosticFinding>();
        try
        {
            using var document = JsonDocument.Parse(await File.ReadAllTextAsync(resultPath));
            if (!document.RootElement.TryGetProperty("findings", out var findings) || findings.ValueKind != JsonValueKind.Array)
                return Array.Empty<DiagnosticFinding>();

            var imported = new List<DiagnosticFinding>();
            foreach (var item in findings.EnumerateArray())
            {
                var title = ReadString(item, "title");
                if (string.IsNullOrWhiteSpace(title)) continue;
                var severity = NormalizeSeverity(ReadString(item, "severity"));
                var confidence = NormalizeConfidence(ReadString(item, "confidence"));
                imported.Add(new DiagnosticFinding
                {
                    FindingId = ReadString(item, "id") is { Length: > 0 } id ? id : Guid.NewGuid().ToString("N"),
                    Title = title,
                    Severity = severity,
                    Confidence = confidence,
                    Category = ReadString(item, "category") is { Length: > 0 } category ? category : "その他",
                    Status = ReadString(item, "status") is { Length: > 0 } status ? status : "要確認",
                    Description = ReadString(item, "description"),
                    Evidence = ReadString(item, "evidence"),
                    AffectedUrls = string.Join(Environment.NewLine, ReadStrings(item, "affectedUrls")),
                    GuidelineBasis = string.Join("、", ReadStrings(item, "guidelineBasis")),
                    Limitations = string.Join(Environment.NewLine, ReadStrings(item, "limitations")),
                    SourceRunDirectory = sourceRunDirectory,
                    ObservedAt = DateTimeOffset.Now
                });
            }
            return imported;
        }
        catch (JsonException) { return Array.Empty<DiagnosticFinding>(); }
        catch (IOException) { return Array.Empty<DiagnosticFinding>(); }
    }

    public static string Fingerprint(DiagnosticFinding finding) =>
        string.Join("|", finding.Title.Trim(), finding.Category.Trim(), finding.AffectedUrls.Trim())
            .ToUpperInvariant();

    private static string NormalizeSeverity(string value) => AllowedSeverities.Contains(value) switch
    {
        true when value.Equals("critical", StringComparison.OrdinalIgnoreCase) => "重大",
        true when value.Equals("high", StringComparison.OrdinalIgnoreCase) => "高",
        true when value.Equals("medium", StringComparison.OrdinalIgnoreCase) => "中",
        true when value.Equals("low", StringComparison.OrdinalIgnoreCase) => "低",
        true when value.Equals("info", StringComparison.OrdinalIgnoreCase) => "情報",
        true => value,
        _ => "未評価"
    };

    private static string NormalizeConfidence(string value) => AllowedConfidences.Contains(value) switch
    {
        true when value.Equals("high", StringComparison.OrdinalIgnoreCase) => "高",
        true when value.Equals("medium", StringComparison.OrdinalIgnoreCase) => "中",
        true when value.Equals("low", StringComparison.OrdinalIgnoreCase) => "低",
        true => value,
        _ => "中"
    };

    private static string ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()?.Trim() ?? string.Empty
            : string.Empty;

    private static IEnumerable<string> ReadStrings(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array) return [];
        return value.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => item.GetString()?.Trim())
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Select(item => item!);
    }
}
