using System.Text.Json.Serialization;
using ScopePilot.Infrastructure;
using ScopePilot.Services;

namespace ScopePilot.Domain;

public enum InputMode { WebExploration, ApiDocument }
public enum DocumentAiProvider { Codex, Claude, Glm }
public enum AiReasoningLevel { Highest, High, Middle, Low }

public sealed record DocumentAiModel(string Id, string Label);

// モデルIDは各CLIの命名規約に合わせている。提供IDが変わる場合はここだけ修正する。
public static class DocumentAiCatalog
{
    public static readonly IReadOnlyList<DocumentAiModel> CodexModels =
    [
        new("gpt-6.1-sol", "GPT-6.1-Sol"),
        new("gpt-6-astra", "GPT-6-Astra"),
        new("gpt-6-sol", "GPT-6-Sol"),
        new("gpt-6-luna", "GPT-6-Luna"),
        new("daybreak-blue", "Daybreak Blue")
    ];
    public static readonly IReadOnlyList<DocumentAiModel> ClaudeModels =
    [
        new("claude-opus-5-5", "Opus 5.5"),
        new("claude-sonnet-5-5", "Sonnet 5.5"),
        new("claude-fable-5-1", "Fable 5.1")
    ];
    public static readonly IReadOnlyList<DocumentAiModel> GlmModels =
    [
        new("glm-5.3", "GLM-5.3"),
        new("glm-5.3-flash", "GLM-5.3 flash")
    ];
    public static readonly IReadOnlyList<string> ReasoningLevels = ["Highest", "High", "Middle", "Low"];

    public static IReadOnlyList<DocumentAiModel> Models(DocumentAiProvider provider) => provider switch
    {
        DocumentAiProvider.Claude => ClaudeModels,
        DocumentAiProvider.Glm => GlmModels,
        _ => CodexModels
    };
    public static IReadOnlyList<string> ModelLabels(DocumentAiProvider provider) =>
        Models(provider).Select(x => x.Label).ToArray();
    public static string DisplayName(DocumentAiProvider provider) => provider switch
    {
        DocumentAiProvider.Codex => "Codex CLI",
        DocumentAiProvider.Claude => "Claude Code CLI",
        _ => "GLM（Z.ai・zcode）"
    };
    // GLMはzcode CLIで実行する。zcodeのモデル指定は「provider/model」形式。
    // APIキー未登録時はZ.ai個人プランのアカウントプロバイダー（サインインはzcode自身が管理）、
    // 登録時は実行ごとの独立プロバイダー設定（Z.ai Coding Planテンプレート）を経由する。
    public const string ZcodeProviderPrefix = "account:zai-individual-coding-plan";
    public const string ZcodeApiKeyProviderId = "scopepilot-zai";
    public static string ZcodeModelName(string modelId) => modelId == "glm-5.3-flash" ? "GLM-5.3-Flash" : "GLM-5.3";
    public static string ZcodeModelId(string modelId, bool useApiKey = false) =>
        $"{(useApiKey ? ZcodeApiKeyProviderId : ZcodeProviderPrefix)}/{ZcodeModelName(modelId)}";
    public static string NormalizeModel(DocumentAiProvider provider, string? id) =>
        Models(provider).FirstOrDefault(x => x.Id.Equals(id, StringComparison.OrdinalIgnoreCase))?.Id
            ?? Models(provider)[0].Id;
}

public sealed class ApiDocumentSettings
{
    public DocumentAiProvider Provider { get; set; } = DocumentAiProvider.Codex;
    public string Model { get; set; } = string.Empty;
    public AiReasoningLevel ReasoningLevel { get; set; } = AiReasoningLevel.Middle;
    public string FileName { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public string BaseUrl { get; set; } = string.Empty;
}

// Drafts describe documented requests. They never represent an observed response.
public sealed class ApiRequestDraft : ObservableObject
{
    private bool _selected;
    private string _method = "GET", _url = string.Empty, _headersText = string.Empty, _body = string.Empty;
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public bool Selected { get => _selected; set => SetProperty(ref _selected, value); }
    public string Method { get => _method; set { if (SetProperty(ref _method, value)) RaisePropertyChanged(nameof(RawRequest)); } }
    public string Url { get => _url; set { if (SetProperty(ref _url, value)) RaisePropertyChanged(nameof(RawRequest)); } }
    public string HeadersText { get => _headersText; set { if (SetProperty(ref _headersText, value)) RaisePropertyChanged(nameof(RawRequest)); } }
    public string Body { get => _body; set { if (SetProperty(ref _body, value)) RaisePropertyChanged(nameof(RawRequest)); } }
    public string OperationId { get; set; } = string.Empty;
    public string Summary { get; set; } = string.Empty;
    public string SourceReference { get; set; } = string.Empty;
    public string Role { get; set; } = "未認証";
    public string[] UnresolvedValues { get; set; } = [];
    public string[] Notes { get; set; } = [];
    public string SourceRunDirectory { get; set; } = string.Empty;
    [JsonIgnore] public string ReviewNotes => string.Join(Environment.NewLine,
        new[] { $"出典: {SourceReference}" }.Concat(UnresolvedValues.Select(x => "要補完: " + x)).Concat(Notes));
    [JsonIgnore] public string RawRequest
    {
        get
        {
            try { return ApiRequestFormatter.Format(this); }
            catch (InvalidDataException ex) { return "リクエストを確認してください: " + ex.Message; }
        }
    }
}
