namespace ScopePilot.Domain;

// 入力ドキュメントからAIが抽出したWeb探索の補助情報。
// すべて「文書の記載」であり観測事実ではない。出典(SourceReference)と合わせて扱う。
public sealed class DocumentHints
{
    public string SourceDocumentName { get; set; } = string.Empty;
    public string SourceSha256 { get; set; } = string.Empty;
    // 抽出に使ったAI（例: 「GLM（Z.ai）（glm-5.3・推論High）」）。追跡可能性のため案件と実行履歴へ記録する。
    public string ExtractedBy { get; set; } = string.Empty;
    public string Status { get; set; } = "failed";
    public string Summary { get; set; } = string.Empty;
    public string[] Limitations { get; set; } = [];
    public DocumentEndpointHint[] Endpoints { get; set; } = [];
    public DocumentAuthHint[] Authentication { get; set; } = [];
    public DocumentPriorityRule[] PriorityRules { get; set; } = [];
    public DocumentApiVariation[] ApiVariations { get; set; } = [];
    public string[] Notes { get; set; } = [];
}

public sealed class DocumentEndpointHint
{
    public string Url { get; set; } = string.Empty;
    public string Kind { get; set; } = "other";
    public string Priority { get; set; } = "normal";
    public string Reason { get; set; } = string.Empty;
    public string SourceReference { get; set; } = string.Empty;
}

// 秘密値(パスワード等)は文書スナップショットにのみ存在し、この派生情報へは複写しない。
public sealed class DocumentAuthHint
{
    public string Role { get; set; } = string.Empty;
    public string Method { get; set; } = string.Empty;
    public string Location { get; set; } = string.Empty;
    public string Note { get; set; } = string.Empty;
    public string SourceReference { get; set; } = string.Empty;
}

public sealed class DocumentPriorityRule
{
    public string Category { get; set; } = string.Empty;
    public string[] Keywords { get; set; } = [];
    public string Priority { get; set; } = "high";
    public string Note { get; set; } = string.Empty;
}

public sealed class DocumentApiVariation
{
    public string Endpoint { get; set; } = string.Empty;
    public DocumentApiParameter[] Parameters { get; set; } = [];
    public string SourceReference { get; set; } = string.Empty;
}

public sealed class DocumentApiParameter
{
    public string Name { get; set; } = string.Empty;
    public string Example { get; set; } = string.Empty;
    public bool Required { get; set; }
}
