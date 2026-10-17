using System.Text.Json;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed class ZapResultImporter
{
    public async Task<int> ImportAsync(EngagementProject project, string path)
    {
        var evidence = await ProjectPaths.EvidenceAsync(project, path, "zap-report");
        using var document = JsonDocument.Parse(await File.ReadAllTextAsync(path));
        if (!document.RootElement.TryGetProperty("site", out var sites) || sites.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("ZAP Traditional JSON形式のsite配列がありません。");
        var incoming = new List<DiagnosticObservation>();
        var siteIndex = 0;
        foreach (var site in sites.EnumerateArray())
        {
            var alertIndex = 0;
            foreach (var alert in site.GetProperty("alerts").EnumerateArray())
            {
                var instanceIndex = 0;
                foreach (var instance in alert.GetProperty("instances").EnumerateArray())
                {
                    var url = String(instance, "uri");
                    var pointer = $"/site/{siteIndex}/alerts/{alertIndex}/instances/{instanceIndex++}";
                    try { ApiRequestFormatter.EnsureAllowed(url, project.AllowedOrigins); }
                    catch (InvalidDataException) { continue; }
                    incoming.Add(new()
                    {
                        RuleId = String(alert, "pluginid"), Title = String(alert, "name"), Severity = String(alert, "riskcode"),
                        Confidence = String(alert, "confidence"), Url = new Uri(url).GetLeftPart(UriPartial.Path),
                        Method = String(instance, "method"), Parameter = String(instance, "param"), Role = project.ActiveRole,
                        Evidence = evidence with { Pointer = pointer }, State = DiagnosisState.TargetAlertEffectUnconfirmed
                    });
                }
                alertIndex++;
            }
            siteIndex++;
        }
        var known = project.DiagnosticObservations.Select(Key).ToHashSet(StringComparer.Ordinal);
        var count = 0;
        foreach (var observation in incoming)
            if (known.Add(Key(observation))) { project.DiagnosticObservations.Add(observation); count++; }
        return count;
    }
    private static string Key(DiagnosticObservation x) => JsonSerializer.Serialize(new
        { x.Tool, x.RuleId, x.Url, x.Method, x.Parameter, x.Role, x.Evidence.Sha256, x.Evidence.Pointer });
    private static string String(JsonElement value, string key) => value.TryGetProperty(key, out var property)
        ? property.ValueKind == JsonValueKind.String ? property.GetString() ?? "" : property.ToString() : "";
}
