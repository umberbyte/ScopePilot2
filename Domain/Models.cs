using System.Collections.ObjectModel;
using System.ComponentModel;

namespace ScopePilot.Domain;

public enum ProjectStatus
{
    Draft,
    Ready,
    Crawling,
    WaitingForHuman,
    Organizing,
    ReviewReady,
    Partial,
    Paused,
    Failed
}

public sealed class EngagementProject
{
    [System.Text.Json.Serialization.JsonIgnore] public string ProjectFilePath { get; set; } = "";
    public int FormatVersion { get; set; } = 1;
    public DiagnosticToolSettings DiagnosticTools { get; set; } = new();
    public ObservableCollection<EvidenceReference> Inputs { get; set; } = [];
    public ObservableCollection<DiagnosticObservation> DiagnosticObservations { get; set; } = [];
    public ObservableCollection<BrunoVerification> BrunoVerifications { get; set; } = [];
    public InputMode Mode { get; set; } = InputMode.WebExploration;
    public ExplorationDocumentSettings ExplorationDocument { get; set; } = new();
    // 画面探索（Playwright MCPでの機能理解）に使うAI。既定はCodex CLI。
    public ExplorationAiSettings ExplorationAi { get; set; } = new();
    public ExplorationProxySettings ExplorationProxy { get; set; } = new();
    public ApiDocumentSettings ApiDocument { get; set; } = new();
    public ObservableCollection<ApiRequestDraft> ApiRequests { get; set; } = [];
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "新規案件";
    public string StartUrl { get; set; } = string.Empty;
    public string AfterAuthenticationUrl { get; set; } = string.Empty;
    public string AllowedOrigins { get; set; } = string.Empty;
    public string SupportingOrigins { get; set; } = string.Empty;
    public string Roles { get; set; } = "未認証\n一般ユーザー";
    public string ActiveRole { get; set; } = "未認証";
    public string ForbiddenActions { get; set; } = "削除\n購入・決済\n申請・承認\nメール・通知送信\nファイルアップロード\nログアウト";
    public int MaxPages { get; set; } = 500;
    public int MaxMinutes { get; set; } = 30;
    public int MaxRequests { get; set; } = 5000;
    public bool EnableFormSubmissions { get; set; }
    public GuidelineSelectionOptions Guidelines { get; set; } = new();
    public ProjectStatus Status { get; set; } = ProjectStatus.Draft;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.Now;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.Now;
    public ObservableCollection<ObservedRequest> Requests { get; set; } = [];
    public ObservableCollection<DiagnosticCandidate> Candidates { get; set; } = [];
    public ObservableCollection<DiagnosticFinding> Findings { get; set; } = [];
    public ObservableCollection<string> AdoptedCandidatePatterns { get; set; } = [];
    public ObservableCollection<string> DeferredCandidatePatterns { get; set; } = [];
    public ObservableCollection<string> ExplicitlyReviewedCandidatePatterns { get; set; } = [];
}

public sealed class GuidelineSelectionOptions
{
    public bool WebAppPentestGuidelines { get; set; } = true;
    public bool OwaspTop10 { get; set; } = true;
    public bool Asvs { get; set; } = true;
    public bool Wstg { get; set; } = true;
    public bool Aisvs { get; set; } = true;
    public bool CloudNativeTop10 { get; set; } = true;
    public bool Ds221 { get; set; } = true;
}

public sealed class ObservedRequest
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Method { get; set; } = "GET";
    public string Url { get; set; } = string.Empty;
    public int? StatusCode { get; set; }
    public string ContentType { get; set; } = string.Empty;
    public string Source { get; set; } = "Import";
    public string Role { get; set; } = string.Empty;
    public string PageTitle { get; set; } = string.Empty;
    public bool PageInspected { get; set; }
    public int FormCount { get; set; }
    public string[] FormFieldNames { get; set; } = [];
    public DateTimeOffset ObservedAt { get; set; } = DateTimeOffset.Now;
}

public sealed class DiagnosticCandidate : INotifyPropertyChanged
{
    private bool _selected = true;
    private string _decision = "候補";
    public event PropertyChangedEventHandler? PropertyChanged;
    public bool Selected
    {
        get => _selected;
        set
        {
            if (_selected == value) return;
            _selected = value;
            OnPropertyChanged(nameof(Selected));
        }
    }
    public string Confidence { get; set; } = "中";
    public string Category { get; set; } = "その他";
    public string Decision
    {
        get => _decision;
        set
        {
            if (_decision == value) return;
            _decision = value;
            OnPropertyChanged(nameof(Decision));
        }
    }
    public string Reason { get; set; } = string.Empty;
    public string DecisionTrace { get; set; } = string.Empty;
    public string DiagnosticCaution { get; set; } = string.Empty;
    public string GuidelineBasis { get; set; } = string.Empty;
    public string Pattern { get; set; } = string.Empty;
    public int SimilarCount { get; set; }
    public ObservedRequest Representative { get; set; } = new();

    private void OnPropertyChanged(string propertyName) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}

public sealed class DiagnosticFinding
{
    public string FindingId { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = string.Empty;
    public string Severity { get; set; } = "未評価";
    public string Confidence { get; set; } = "中";
    public string Category { get; set; } = "その他";
    public string Status { get; set; } = "要確認";
    public string Description { get; set; } = string.Empty;
    public string Evidence { get; set; } = string.Empty;
    public string AffectedUrls { get; set; } = string.Empty;
    public string GuidelineBasis { get; set; } = string.Empty;
    public string Limitations { get; set; } = string.Empty;
    public string SourceRunDirectory { get; set; } = string.Empty;
    public DateTimeOffset ObservedAt { get; set; } = DateTimeOffset.Now;
}

public sealed record EnvironmentCheck(string Name, bool Available, string Detail);
