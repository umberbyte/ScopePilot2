using System.IO;
using System.Text.Json;
using DocumentFormat.OpenXml.Packaging;
using ScopePilot.Domain;
using ScopePilot.Services;
using ScopePilot.Services.WordReports;
using Xunit;

namespace ScopePilot.Tests;

public sealed class BrunoCaptureTests
{
    private static async Task<string> HarAsync(string folder)
    {
        var path = Path.Combine(folder, "bruno-capture.har");
        var exchange = new
        {
            log = new { version = "1.2", entries = new object[]
            {
                new { request = new { method = "GET", url = "https://example.test/health", headers = Array.Empty<object>() },
                    response = new { status = 200, statusText = "OK", headers = Array.Empty<object>(), content = new { text = "healthy" } } },
                new { request = new { method = "POST", url = "https://example.test/check?case=example&token=QUERY_SECRET",
                    headers = new[] { new { name = "Authorization", value = "Bearer HEADER_SECRET" }, new { name = "Cookie", value = "sid=COOKIE_SECRET" } },
                    postData = new { text = "{\"password\":\"BODY_SECRET\",\"value\":\"test-marker\"}" } },
                    response = new { status = 200, statusText = "OK", headers = new[] { new { name = "Set-Cookie", value = "sid=RESPONSE_SECRET" } },
                    content = new { text = "{\"result\":\"observed-effect\",\"token\":\"RESPONSE_BODY_SECRET\"}" } } }
            } }
        };
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(exchange));
        return path;
    }

    [Fact]
    public async Task SelectedExchangeIsStoredAndAppearsInMarkdownAndWord()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        var store = new ProjectStore();
        await store.SaveAsync(project);
        var before = await File.ReadAllTextAsync(project.ProjectFilePath);
        var har = await HarAsync(temp.Path);
        var service = new BrunoCaptureService();
        Assert.Equal(2, (await service.PreviewAsync(har)).Count);
        var item = await service.ImportAsync(project, har, 1, "手動確認項目", BrunoVerificationStatus.Confirmed,
            "担当者が応答と対象の処理結果を照合した。", "", "", "テスト担当者");
        Assert.Equal(before, await File.ReadAllTextAsync(project.ProjectFilePath));
        Assert.Single(project.BrunoVerifications);
        Assert.Equal("POST", item.Method);
        Assert.StartsWith("inputs/bruno/", item.Exchange.LocalPath);
        using (var source = JsonDocument.Parse(await File.ReadAllTextAsync(ProjectPaths.Resolve(project, item.Exchange.LocalPath))))
            Assert.Equal(1, source.RootElement.GetProperty("log").GetProperty("entries").GetArrayLength());
        await ProjectPaths.VerifyAsync(project, item.Exchange);
        var report = await new FindingReportService().ExportAsync(project);
        var markdown = await File.ReadAllTextAsync(report.MarkdownPath);
        Assert.Contains("B-001 手動確認項目", markdown);
        Assert.Contains("HTTPリクエスト", markdown);
        Assert.Contains("HTTPレスポンス", markdown);
        Assert.Contains("test-marker", markdown);
        Assert.Contains("observed-effect", markdown);
        Assert.Contains(item.Exchange.Sha256, markdown);
        foreach (var secret in new[] { "QUERY_SECRET", "HEADER_SECRET", "COOKIE_SECRET", "BODY_SECRET", "RESPONSE_SECRET", "RESPONSE_BODY_SECRET" })
            Assert.DoesNotContain(secret, markdown);
        var word = await new MarkdownWordReportService().ConvertAsync(project, report.MarkdownPath);
        using var document = WordprocessingDocument.Open(word.WordPath, false);
        var wordText = document.MainDocumentPart!.Document!.InnerText;
        Assert.Contains("手動確認項目", wordText);
        Assert.Contains("observed-effect", wordText);
        Assert.DoesNotContain("HEADER_SECRET", wordText);
        await store.SaveAsync(project);
        var loaded = await store.LoadAsync(project.ProjectFilePath);
        Assert.Equal(item.Exchange.LocalPath, Assert.Single(loaded.BrunoVerifications).Exchange.LocalPath);
    }

    [Fact]
    public async Task BlockedNeedsReasonAndInputAndTamperedEvidenceIsNotQuoted()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        var har = await HarAsync(temp.Path);
        var service = new BrunoCaptureService();
        await Assert.ThrowsAsync<InvalidDataException>(() => service.ImportAsync(project, har, 1, "項目",
            BrunoVerificationStatus.Blocked, "未実施", "", "", ""));
        Assert.Empty(project.BrunoVerifications);
        var item = await service.ImportAsync(project, har, 1, "項目", BrunoVerificationStatus.Blocked,
            "環境のため未実施", "必要サービスが停止", "サービスを起動する", "");
        var report = await new JapaneseDiagnosticReportService().BuildAsync(project, DateTimeOffset.Now);
        Assert.Contains("必要サービスが停止", report.Markdown);
        Assert.Contains("サービスを起動する", report.Markdown);
        var path = ProjectPaths.Resolve(project, item.Exchange.LocalPath);
        await File.AppendAllTextAsync(path, "UNTRUSTED_TEXT");
        report = await new JapaneseDiagnosticReportService().BuildAsync(project, DateTimeOffset.Now);
        Assert.Contains("原本を照合できません", report.Markdown);
        Assert.DoesNotContain("observed-effect", report.Markdown);
        Assert.DoesNotContain("UNTRUSTED_TEXT", report.Markdown);
    }

    [Fact]
    public async Task OtherOriginsAndUnansweredEntriesAreRejected()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        var har = await HarAsync(temp.Path);
        var original = await File.ReadAllTextAsync(har);
        await File.WriteAllTextAsync(har, original.Replace("https://example.test/check", "https://outside.test/check"));
        var service = new BrunoCaptureService();
        await Assert.ThrowsAsync<InvalidDataException>(() => service.ImportAsync(project, har, 1, "項目",
            BrunoVerificationStatus.NotConfirmed, "確認済み", "", "", ""));
        Assert.Empty(project.BrunoVerifications);
        await File.WriteAllTextAsync(har, original.Replace("\"status\":200", "\"status\":0"));
        await Assert.ThrowsAsync<InvalidDataException>(() => service.ImportAsync(project, har, 1, "項目",
            BrunoVerificationStatus.NotConfirmed, "確認済み", "", "", ""));
    }

    [Fact]
    public async Task MalformedHarIsRejectedWithValidationError()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        var path = Path.Combine(temp.Path, "invalid.har");
        await File.WriteAllTextAsync(path, "{\"log\":{\"entries\":[null]}}");
        var service = new BrunoCaptureService();
        await Assert.ThrowsAsync<InvalidDataException>(() => service.PreviewAsync(path));
        await Assert.ThrowsAsync<InvalidDataException>(() => service.ImportAsync(project, path, 0, "項目",
            BrunoVerificationStatus.NotConfirmed, "未確認", "", "", ""));

        await File.WriteAllTextAsync(path,
            "{\"log\":{\"entries\":[{\"request\":{\"method\":\"GET\",\"url\":\"https://example.test/\"},\"response\":{\"status\":\"200\"}}]}}");
        await Assert.ThrowsAsync<InvalidDataException>(() => service.PreviewAsync(path));
        Assert.Empty(project.BrunoVerifications);
    }
}
