namespace ScopePilot.Domain;

// 画面探索のAI。Codex CLI（既定）またはGLM（zcode）。Claude Code CLIは画面探索に未対応。
// Modelは GLM のときだけ使う（Codexは従来どおりCodex CLIの既定モデル）。
public sealed class ExplorationAiSettings
{
    public DocumentAiProvider Provider { get; set; } = DocumentAiProvider.Codex;
    public string Model { get; set; } = string.Empty;

    public static bool Supports(DocumentAiProvider provider) => provider is DocumentAiProvider.Codex or DocumentAiProvider.Glm;
}

public sealed class ExplorationDocumentSettings
{
    public string FileName { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public EvidenceReference? Source { get; set; }
    // 補助情報の抽出に使うAI。APIドキュメントモードと同じ選択肢・既定値。
    public DocumentAiProvider AiProvider { get; set; } = DocumentAiProvider.Codex;
    public string Model { get; set; } = string.Empty;
    public AiReasoningLevel ReasoningLevel { get; set; } = AiReasoningLevel.Middle;
    // 文書内容のSHA-256がSourceSha256と一致するとき有効な抽出結果。
    public DocumentHints? Hints { get; set; }
}
