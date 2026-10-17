using System.Text;
using System.Text.Json;
using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed record ApiRequestExportResult(string Directory, int RequestCount);

public sealed class ApiRequestExportService
{
    private readonly string? _exportsDirectory;
    public ApiRequestExportService(string? exportsDirectory = null) => _exportsDirectory = exportsDirectory;

    public async Task<ApiRequestExportResult> ExportAsync(EngagementProject project)
    {
        var selected = project.ApiRequests.Where(x => x.Selected).ToArray();
        if (selected.Length == 0) throw new InvalidOperationException("APIリクエスト画面で確認したリクエストを採用してください。");
        // Validate the entire selection before producing an export directory.
        var formatted = selected.Select(draft =>
        {
            ApiRequestFormatter.EnsureAllowed(draft.Url, project.AllowedOrigins);
            return ApiRequestFormatter.Format(draft);
        }).ToArray();
        var directory = Path.Combine(_exportsDirectory is null ? ProjectPaths.Category(project, "exports") : Path.Combine(_exportsDirectory, project.Id.ToString("N")), $"api-{DateTimeOffset.Now:yyyyMMdd-HHmmss-fff}-{Guid.NewGuid():N}");
        var requestsDirectory = Path.Combine(directory, "requests");
        System.IO.Directory.CreateDirectory(requestsDirectory);
        for (var i = 0; i < selected.Length; i++)
            await File.WriteAllTextAsync(Path.Combine(requestsDirectory, $"{i + 1:D4}.http"), formatted[i], new UTF8Encoding(false));
        await File.WriteAllTextAsync(Path.Combine(directory, "api-requests.json"), JsonSerializer.Serialize(new
        {
            generatedAt = DateTimeOffset.Now, projectId = project.Id, projectName = project.Name,
            requests = selected.Select((draft, i) => new { file = $"requests/{i + 1:D4}.http", request = ProjectPaths.PortableRunObject(project, draft) })
        }, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
        static string Clean(string? value) => (value ?? string.Empty).Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
        await File.WriteAllLinesAsync(Path.Combine(directory, "api-request-checklist.tsv"),
            new[] { "File\tMethod\tURL\tRole\tOperationId\tSource\tUnresolved\tNotes" }.Concat(selected.Select((x, i) => string.Join('\t',
                $"requests/{i + 1:D4}.http", Clean(x.Method), Clean(x.Url), Clean(x.Role), Clean(x.OperationId),
                Clean(x.SourceReference), Clean(string.Join(" / ", x.UnresolvedValues)), Clean(string.Join(" / ", x.Notes))))), new UTF8Encoding(true));
        await File.WriteAllTextAsync(Path.Combine(directory, "README.txt"),
            "Burp Repeaterへの引き渡し\r\n\r\n1. requestsフォルダーの.httpを開き、HTTPテキスト全体をコピーします。\r\n2. Burp Repeaterの新しいタブへ貼り付けます。\r\n3. api-requests.jsonのURLに合わせ、Repeaterの接続先（TLS、Host、Port）を設定します。\r\n4. 出典、仮値、認証情報、本文、案件の禁止操作を確認・補完してから送信を判断してください。\r\n\r\nこれらはAPI文書から生成した未送信の下書きです。実際の通信・応答を観測した記録ではありません。Scope設定とは別に、各HTTPリクエストをRepeaterへ貼り付けます。\r\n", new UTF8Encoding(false));
        return new(directory, selected.Length);
    }
}
