using System.IO;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class InstalledZapTests
{
    [InstalledZapFact]
    public async Task InstalledZapProcessesOfflineHarAndProducesImportableReports()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        project.AllowedOrigins = "http://scopepilot.invalid";
        project.DiagnosticTools.JavaPath = Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_JAVA")!;
        project.DiagnosticTools.ZapJarPath = Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_ZAP_JAR")!;
        project.MaxMinutes = 1;
        project.Candidates.Add(new() { Selected = true, Pattern = "GET http://scopepilot.invalid/fixture", Representative = new() { Url = "http://scopepilot.invalid/fixture" } });
        var path = Path.Combine(temp.Path, "offline-fixture.har");
        // Synthetic response used only in this offline integration fixture; no server or live target exists.
        await File.WriteAllTextAsync(path, """
        {"log":{"version":"1.2","creator":{"name":"ScopePilot offline test","version":"1"},"entries":[{
          "startedDateTime":"2026-10-10T00:00:00.000Z","time":10,
          "request":{"method":"GET","url":"http://scopepilot.invalid/fixture","httpVersion":"HTTP/1.1","cookies":[],"headers":[{"name":"Host","value":"scopepilot.invalid"}],"queryString":[],"headersSize":-1,"bodySize":0},
          "response":{"status":200,"statusText":"OK","httpVersion":"HTTP/1.1","cookies":[],"headers":[{"name":"Content-Type","value":"text/html"}],"content":{"size":41,"mimeType":"text/html","text":"<html><body>offline fixture</body></html>"},"redirectURL":"","headersSize":-1,"bodySize":41},
          "cache":{},"timings":{"send":1,"wait":8,"receive":1}
        }]}}
        """);
        project.Inputs.Add((await ProjectPaths.ImportAsync(project, path, "har")) with { Role = project.ActiveRole });
        var package = await new ZapHandoffService().BuildAsync(project);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        var result = await new ZapCliRunner().RunAsync(project, package, null, cancellation.Token);
        Assert.True(result.Status is "completed" or "warnings", await File.ReadAllTextAsync(Path.Combine(package.Directory, "zap-run.log")));
        Assert.NotNull(result.ReportPath);
        Assert.True(File.Exists(Path.Combine(package.Directory, "reports", "zap-report.html")));
        await new ZapResultImporter().ImportAsync(project, result.ReportPath!);
        Assert.NotEmpty(project.DiagnosticObservations);
        Assert.All(project.DiagnosticObservations, x => Assert.Equal(DiagnosisState.TargetAlertEffectUnconfirmed, x.State));
        // Optional retained artifacts make installation failures diagnosable without keeping a global project catalog.
        if (Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_ZAP_ARTIFACTS") is { Length: > 0 } output)
        {
            Directory.CreateDirectory(output);
            foreach (var file in new[] { "zap-check.log", "zap-run.log", "zap-summary.json", "zap-passive.yaml" })
                File.Copy(Path.Combine(package.Directory, file), Path.Combine(output, file), overwrite: true);
            var zapLog = Path.Combine(package.Directory, "zap-home", "zap.log");
            if (File.Exists(zapLog)) File.Copy(zapLog, Path.Combine(output, "zap-verbose.log"), overwrite: true);
            File.Copy(result.ReportPath!, Path.Combine(output, "zap-report.json"), overwrite: true);
        }
    }
}

internal sealed class InstalledZapFactAttribute : FactAttribute
{
    public InstalledZapFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_ZAP_JAR")) ||
            string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("SCOPEPILOT_TEST_JAVA")))
            Skip = "Set SCOPEPILOT_TEST_ZAP_JAR and SCOPEPILOT_TEST_JAVA to run the offline ZAP integration test.";
    }
}
