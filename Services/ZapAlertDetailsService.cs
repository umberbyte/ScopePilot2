using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using ScopePilot.Domain;

namespace ScopePilot.Services;

// Details are read from the verified original on demand, including older imported alerts.
// Raw instance values stay in this transient view, rather than in project/report exports.
public sealed record ZapAlertDetails(string Title, string Summary, string DisplayText, string ReportPath)
{
    public string Description { get; init; } = "";
    public string Recommendation { get; init; } = "";
    public string References { get; init; } = "";
    public string Cwe { get; init; } = "";
    public string Wasc { get; init; } = "";
    public IReadOnlyList<string> CveIds { get; init; } = Array.Empty<string>();
    public string Request { get; init; } = "";
    public string Response { get; init; } = "";
    public string AttackInput { get; init; } = "";
    public string ObservedEvidence { get; init; } = "";
    public string ExternalInteraction { get; init; } = "";
}

public sealed record ZapAlertReadResult(DiagnosticObservation Observation, ZapAlertDetails? Details, string Error);

public sealed partial class ZapAlertDetailsService
{
    public async Task<ZapAlertDetails> ReadAsync(EngagementProject project, DiagnosticObservation observation)
    {
        var path = ProjectPaths.Resolve(project, observation.Evidence.LocalPath);
        var bytes = await ReadBytesAsync(path);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        using var json = JsonDocument.Parse(bytes);
        return ReadVerified(json, hash, path, observation);
    }

    // A report can have thousands of instances from one file: read and hash that file once.
    public async Task<IReadOnlyList<ZapAlertReadResult>> ReadManyAsync(EngagementProject project,
        IEnumerable<DiagnosticObservation> observations)
    {
        var results = new List<ZapAlertReadResult>();
        foreach (var group in observations.GroupBy(x => x.Evidence.LocalPath, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var path = ProjectPaths.Resolve(project, group.Key);
                var bytes = await ReadBytesAsync(path);
                var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
                using var json = JsonDocument.Parse(bytes);
                foreach (var observation in group)
                {
                    try { results.Add(new(observation, ReadVerified(json, hash, path, observation, includeInstanceValues: false), "")); }
                    catch (InvalidDataException ex) { results.Add(new(observation, null, ex.Message)); }
                }
            }
            catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException or InvalidOperationException or JsonException)
            {
                // Never substitute an unverified source for the missing/changed original.
                foreach (var observation in group)
                    results.Add(new(observation, null, "原本を読み取れません。プロジェクト内の出典ファイルを確認してください。"));
            }
        }
        return results;
    }

    private static async Task<byte[]> ReadBytesAsync(string path)
    {
        if (new FileInfo(path).Length > 64 * 1024 * 1024) throw new InvalidDataException("原本JSONが詳細表示の上限（64MB）を超えています。");
        var bytes = await File.ReadAllBytesAsync(path);
        if (bytes.Length > 64 * 1024 * 1024) throw new InvalidDataException("原本JSONが詳細表示の上限（64MB）を超えています。");
        return bytes;
    }

    private static ZapAlertDetails ReadVerified(JsonDocument json, string hash, string path, DiagnosticObservation observation, bool includeInstanceValues = true)
    {
        if (!hash.Equals(observation.Evidence.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("ZAP原本のSHA-256が一致しません。詳細は表示できません。");
        var pointer = Regex.Match(observation.Evidence.Pointer, @"^/site/(\d+)/alerts/(\d+)/instances/(\d+)$");
        if (!pointer.Success || !int.TryParse(pointer.Groups[1].Value, out var siteIndex) ||
            !int.TryParse(pointer.Groups[2].Value, out var alertIndex) || !int.TryParse(pointer.Groups[3].Value, out var instanceIndex))
            throw new InvalidDataException("ZAP警告の出典位置を読み取れません。");
        var site = Element(json.RootElement, "site", siteIndex);
        var alert = Element(site, "alerts", alertIndex);
        var instance = Element(alert, "instances", instanceIndex);
        var metadata = new DiagnosticObservation { Severity = Value(alert, "riskcode"), Confidence = Value(alert, "confidence") };
        var title = Value(alert, "name");
        if (title.Length == 0) title = Value(alert, "alert");
        if (title.Length == 0) title = observation.Title;
        var rule = Value(alert, "pluginid");
        if (observation.RuleId.Length > 0 && observation.RuleId != rule)
            throw new InvalidDataException("原本の警告ルールと選択した警告が一致しません。");
        var cwe = Value(alert, "cweid");
        var wasc = Value(alert, "wascid");
        var description = Plain(Value(alert, "desc"));
        var recommendation = Plain(Value(alert, "solution"));
        var references = Plain(Value(alert, "reference"));
        var parameter = Value(instance, "param");
        var attack = Value(instance, "attack");
        var observedEvidence = Value(instance, "evidence");
        var instanceOther = Value(instance, "otherinfo");
        var alertOther = Plain(Value(alert, "otherinfo"));
        var externalInteraction = string.Join("\n", new[] { instanceOther, alertOther }
            .Where(x => !string.IsNullOrWhiteSpace(x) && x != "未記載").Distinct(StringComparer.Ordinal));
        var summary = $"危険度: {metadata.SeverityDisplay}　確度: {metadata.ConfidenceDisplay}　状態: 要確認\n" +
            $"ルールID: {rule}　CWE: {Present(cwe)}　WASC: {Present(wasc)}\nロール: {observation.Role}";
        var display = includeInstanceValues ? $"説明\n{description}\n\n" +
            $"対策\n{recommendation}\n\n" +
            $"参考情報\n{references}\n\n" +
            $"該当通信・証拠（原本の値）\n" +
            $"URL: {Value(instance, "uri")}\nメソッド: {Value(instance, "method")}\nパラメータ: {Present(Value(instance, "param"))}\n" +
            $"証拠: {Present(observedEvidence)}\n入力値: {Present(attack)}\n" +
            $"追加情報: {Present(instanceOther)}\nメッセージID: {Present(Value(instance, "messageId"))}\n\n" +
            $"出典\nファイル: {observation.Evidence.LocalPath}\nJSON Pointer: {observation.Evidence.Pointer}\nSHA-256: {hash}" : "";
        return new(title, summary, display, path)
        {
            Description = description, Recommendation = recommendation,
            References = references, Cwe = Present(cwe), Wasc = Present(wasc),
            CveIds = Cve().Matches(string.Join("\n", new[] { description, references, externalInteraction })).Cast<Match>()
                .Select(x => x.Value.ToUpperInvariant())
                .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray(),
            Request = BrunoEvidenceReportFormatter.RedactHttpForReport(
                Value(instance, "request-header"), Value(instance, "request-body"), request: true),
            Response = BrunoEvidenceReportFormatter.RedactHttpForReport(
                Value(instance, "response-header"), Value(instance, "response-body"), request: false),
            AttackInput = BrunoEvidenceReportFormatter.IsSensitiveFieldForReport(parameter)
                ? "[伏せ字]" : BrunoEvidenceReportFormatter.RedactForReport(attack),
            ObservedEvidence = BrunoEvidenceReportFormatter.IsSensitiveFieldForReport(parameter)
                ? "[伏せ字]" : BrunoEvidenceReportFormatter.RedactForReport(observedEvidence),
            ExternalInteraction = BrunoEvidenceReportFormatter.RedactForReport(externalInteraction)
        };
    }

    private static JsonElement Element(JsonElement parent, string property, int index)
    {
        if (!parent.TryGetProperty(property, out var array) || array.ValueKind != JsonValueKind.Array || index >= array.GetArrayLength())
            throw new InvalidDataException("ZAP原本に対象の警告・通信がありません。");
        return array[index];
    }
    private static string Value(JsonElement element, string property) => element.TryGetProperty(property, out var value)
        ? value.ValueKind == JsonValueKind.String ? Limit(value.GetString() ?? "") : Limit(value.ToString()) : "";
    private static string Present(string value) => value.Length == 0 || value == "0" ? "未記載" : value;
    private static string Limit(string value) => value.Length <= 40000 ? value : value[..40000] + "\n（以下省略。原本を参照してください）";
    private static string Plain(string value)
    {
        var breaks = Regex.Replace(value, @"<br\s*/?>|</(?:p|li|div|h[1-6])>", "\n", RegexOptions.IgnoreCase);
        return Present(WebUtility.HtmlDecode(Regex.Replace(breaks, @"<[^>]+>", "")).Trim());
    }

    [GeneratedRegex(@"(?i)\bCVE-\d{4}-\d{4,7}\b")]
    private static partial Regex Cve();
}
