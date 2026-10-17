using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Text.RegularExpressions;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Infrastructure;
using ScopePilot.Services;

namespace ScopePilot.ViewModels;

public sealed partial class MainViewModel : ObservableObject
{
    private readonly ProjectStore _store = new();
    private readonly RequestImporter _importer = new();
    private readonly CandidateSelector _selector = new();
    private readonly EnvironmentProbe _environment = new();
    private readonly ExplorationPackageBuilder _packageBuilder = new();
    private readonly McpSetupService _mcpSetup = new();
    private readonly CodexExplorationRunner _runner = new();
    private readonly ZcodeExplorationRunner _zcodeRunner = new();
    private readonly FastCrawlerRunner _fastCrawler = new();
    private readonly AiInputBuilder _aiInputBuilder = new();
    private readonly BurpScopeExportService _burpScopeExport = new();
    private readonly CodexFindingImporter _findingImporter = new();
    private readonly FindingReportService _findingReport = new();
    private readonly RunHistoryService _runHistoryService = new();
    private readonly DataManagementService _dataManagement = new();
    private readonly ApiDocumentService _apiDocuments = new();
    private readonly ApiDocumentAiRunner _apiRunner = new();
    private readonly ApiRequestExportService _apiExport = new();
    private ApiRequestDraft? _selectedApiRequest;
    private EngagementProject _project = new();
    private CancellationTokenSource? _runCancellation;
    private string? _currentRunDirectory;
    private bool _isRunning;
    private string _interventionText = string.Empty;
    private DiagnosticCandidate? _selectedCandidate;
    private DiagnosticFinding? _selectedFinding;
    private ExplorationRunSummary? _selectedRun;
    private string _candidateSearch = string.Empty;
    private string _candidateReviewFilter = "すべて";
    private string _runPhase = "待機中";
    private string _runProgressDetail = "探索を開始すると進捗を表示します。";
    private int _runProgress;
    private string? _lastBurpExportDirectory;
    private string? _selectedBurpScopeRegex;
    private string _burpHandoffStatus = "Burp Scope出力を生成すると、登録用の正規表現をここで案内します。";
    private int _nextBurpRegexIndex;
    private string _dataSummaryText = "保存データを確認しています。";
    private string? _lastBackupPath;

    public MainViewModel()
    {
        InitializeWordReportCommands();
        SaveCommand = new AsyncRelayCommand(SaveAsync, () => !IsRunning);
        NewProjectCommand = new AsyncRelayCommand(NewProjectAsync, () => !IsRunning);
        LoadProjectCommand = new AsyncRelayCommand(LoadProjectAsync, () => !IsRunning);
        OpenRunFolderCommand = new RelayCommand(OpenSelectedRunFolder, () => SelectedRun is not null);
        RetrySelectedRunCommand = new AsyncRelayCommand(RetrySelectedRunAsync, () => !IsRunning && SelectedRun is { Tool: "ScopePilot" });
        CheckEnvironmentCommand = new AsyncRelayCommand(CheckEnvironmentAsync);
        SetupMcpCommand = new AsyncRelayCommand(SetupMcpAsync, () => !IsRunning && !IsApiMode);
        BuildExplorationPackageCommand = new AsyncRelayCommand(BuildExplorationPackageAsync, () => !IsRunning);
        StartExplorationCommand = new AsyncRelayCommand(StartExplorationAsync, () => !IsRunning);
        StopExplorationCommand = new RelayCommand(StopExploration, () => IsRunning && !IsWordConversionRunning);
        ResumeExplorationCommand = new RelayCommand(ResumeExploration, () => IsRunning && Project.Status == ProjectStatus.WaitingForHuman);
        GenerateCandidatesCommand = new RelayCommand(GenerateCandidates);
        ResetCandidateDecisionsCommand = new AsyncRelayCommand(ResetCandidateDecisionsAsync, () => !IsRunning);
        ShowAllCandidatesCommand = new RelayCommand(() => SetCandidateReviewFilter("すべて"));
        ShowSelectedCandidatesCommand = new RelayCommand(() => SetCandidateReviewFilter("採用"));
        ShowExcludedCandidatesCommand = new RelayCommand(() => SetCandidateReviewFilter("除外"));
        AdoptVisibleCandidatesCommand = new AsyncRelayCommand(() => SetVisibleCandidateDecisionAsync(true), () => !IsRunning && FilteredCandidates.Count > 0);
        ExcludeVisibleCandidatesCommand = new AsyncRelayCommand(() => SetVisibleCandidateDecisionAsync(false), () => !IsRunning && FilteredCandidates.Count > 0);
        ExportBurpScopeCommand = new AsyncRelayCommand(ExportBurpScopeAsync, () => !IsRunning);
        OpenBurpExportFolderCommand = new RelayCommand(OpenBurpExportFolder, () => !string.IsNullOrWhiteSpace(LastBurpExportDirectory));
        CopyNextBurpRegexCommand = new RelayCommand(CopyNextBurpRegex, () => BurpScopeRegexes.Count > 0);
        ExportFindingsCommand = new AsyncRelayCommand(ExportFindingsAsync, () => !IsRunning);
        RefreshDataSummaryCommand = new AsyncRelayCommand(RefreshDataSummaryAsync);
        BackupProjectCommand = new AsyncRelayCommand(BackupProjectAsync, () => !IsRunning);
        OpenDataFolderCommand = new RelayCommand(() => OpenProjectFolder());
        CopyApiRequestCommand = new RelayCommand(CopyApiRequest, () => !IsRunning && SelectedApiRequest is not null);
        ClearExplorationDocumentCommand = new RelayCommand(ClearExplorationDocument, () => !IsRunning && HasExplorationDocument);
    }

    public EngagementProject Project
    {
        get => _project;
        private set
        {
            PrepareProject(value);
            if (!SetProperty(ref _project, value)) return;
            RefreshSummary();
            RaisePropertyChanged(nameof(ActiveRole));
        }
    }
    public ObservableCollection<string> Logs { get; } = [];
    public ObservableCollection<ExplorationRunSummary> RunHistory { get; } = [];
    public ObservableCollection<string> RoleOptions { get; } = [];
    public ObservableCollection<DiagnosticCandidate> FilteredCandidates { get; } = [];
    public ObservableCollection<string> BurpScopeRegexes { get; } = [];
    public AsyncRelayCommand SaveCommand { get; }
    public AsyncRelayCommand NewProjectCommand { get; }
    public AsyncRelayCommand LoadProjectCommand { get; }
    public RelayCommand OpenRunFolderCommand { get; }
    public AsyncRelayCommand RetrySelectedRunCommand { get; }
    public AsyncRelayCommand CheckEnvironmentCommand { get; }
    public AsyncRelayCommand SetupMcpCommand { get; }
    public AsyncRelayCommand BuildExplorationPackageCommand { get; }
    public AsyncRelayCommand StartExplorationCommand { get; }
    public RelayCommand StopExplorationCommand { get; }
    public RelayCommand ResumeExplorationCommand { get; }
    public RelayCommand GenerateCandidatesCommand { get; }
    public AsyncRelayCommand ResetCandidateDecisionsCommand { get; }
    public RelayCommand ShowAllCandidatesCommand { get; }
    public RelayCommand ShowSelectedCandidatesCommand { get; }
    public RelayCommand ShowExcludedCandidatesCommand { get; }
    public AsyncRelayCommand AdoptVisibleCandidatesCommand { get; }
    public AsyncRelayCommand ExcludeVisibleCandidatesCommand { get; }
    public AsyncRelayCommand ExportBurpScopeCommand { get; }
    public RelayCommand OpenBurpExportFolderCommand { get; }
    public RelayCommand CopyNextBurpRegexCommand { get; }
    public AsyncRelayCommand ExportFindingsCommand { get; }
    public AsyncRelayCommand RefreshDataSummaryCommand { get; }
    public AsyncRelayCommand BackupProjectCommand { get; }
    public RelayCommand OpenDataFolderCommand { get; }
    public RelayCommand CopyApiRequestCommand { get; }
    public RelayCommand ClearExplorationDocumentCommand { get; }
    public bool HasExplorationDocument => !string.IsNullOrWhiteSpace(Project.ExplorationDocument.Content);
    public string ExplorationDocumentName => HasExplorationDocument
        ? $"{Project.ExplorationDocument.FileName}（{Project.ExplorationDocument.Content.Length:N0}文字）" : "ドキュメント未選択";
    public int DocProviderIndex
    {
        get => (int)Project.ExplorationDocument.AiProvider;
        set
        {
            if (IsRunning || value is not (0 or 1 or 2) || (int)Project.ExplorationDocument.AiProvider == value) return;
            Project.ExplorationDocument.AiProvider = (DocumentAiProvider)value;
            // プロバイダーを変えたらモデルもその既定へ戻す。
            Project.ExplorationDocument.Model = DocumentAiCatalog.Models(Project.ExplorationDocument.AiProvider)[0].Id;
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(DocModelOptions));
            RaisePropertyChanged(nameof(DocModelIndex));
            RaiseAfterItemsChanged(nameof(DocModelLabel));
            RaisePropertyChanged(nameof(DocReasoningEnabled));
            RefreshSaveState();
        }
    }
    // 画面探索のAI: 0=Codex CLI、1=GLM（zcode）。
    public int ExplorationAiIndex
    {
        get => Project.ExplorationAi.Provider == DocumentAiProvider.Glm ? 1 : 0;
        set
        {
            if (IsRunning || value is not (0 or 1) || ExplorationAiIndex == value) return;
            Project.ExplorationAi.Provider = value == 1 ? DocumentAiProvider.Glm : DocumentAiProvider.Codex;
            Project.ExplorationAi.Model = value == 1 ? DocumentAiCatalog.Models(DocumentAiProvider.Glm)[0].Id : string.Empty;
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(ExplorationAiModelOptions));
            RaisePropertyChanged(nameof(ExplorationAiModelIndex));
            RaiseAfterItemsChanged(nameof(ExplorationAiModelLabel));
            RaisePropertyChanged(nameof(ExplorationAiModelEnabled));
            RefreshSaveState();
        }
    }
    // Codexの画面探索は従来どおりCodex CLIの既定モデルを使う。
    public IReadOnlyList<string> ExplorationAiModelOptions => Project.ExplorationAi.Provider == DocumentAiProvider.Glm
        ? DocumentAiCatalog.ModelLabels(DocumentAiProvider.Glm) : ["Codex CLIの既定モデル"];
    public bool ExplorationAiModelEnabled => Project.ExplorationAi.Provider == DocumentAiProvider.Glm;
    public int ExplorationAiModelIndex
    {
        get
        {
            if (Project.ExplorationAi.Provider != DocumentAiProvider.Glm) return 0;
            var id = DocumentAiCatalog.NormalizeModel(DocumentAiProvider.Glm, Project.ExplorationAi.Model);
            return Math.Max(0, DocumentAiCatalog.Models(DocumentAiProvider.Glm).ToList().FindIndex(x => x.Id == id));
        }
        set
        {
            if (IsRunning || Project.ExplorationAi.Provider != DocumentAiProvider.Glm) return;
            var models = DocumentAiCatalog.Models(DocumentAiProvider.Glm);
            if (value < 0 || value >= models.Count || Project.ExplorationAi.Model == models[value].Id) return;
            Project.ExplorationAi.Model = models[value].Id;
            RaisePropertyChanged();
            RefreshSaveState();
        }
    }
    public IReadOnlyList<string> DocModelOptions => DocumentAiCatalog.ModelLabels(Project.ExplorationDocument.AiProvider);
    // GLM（zcode）は推論レベルをCLIから指定できないため、選択を無効にする。
    public bool DocReasoningEnabled => Project.ExplorationDocument.AiProvider != DocumentAiProvider.Glm;
    public int DocModelIndex
    {
        get
        {
            var models = DocumentAiCatalog.Models(Project.ExplorationDocument.AiProvider);
            var id = DocumentAiCatalog.NormalizeModel(Project.ExplorationDocument.AiProvider, Project.ExplorationDocument.Model);
            var index = models.ToList().FindIndex(x => x.Id == id);
            return index < 0 ? 0 : index;
        }
        set
        {
            if (IsRunning) return;
            var models = DocumentAiCatalog.Models(Project.ExplorationDocument.AiProvider);
            if (value < 0 || value >= models.Count) return;
            var id = models[value].Id;
            if (Project.ExplorationDocument.Model == id) return;
            Project.ExplorationDocument.Model = id;
            RaisePropertyChanged();
            RefreshSaveState();
        }
    }
    public IReadOnlyList<string> DocReasoningOptions => DocumentAiCatalog.ReasoningLevels;
    public int DocReasoningIndex
    {
        get => (int)Project.ExplorationDocument.ReasoningLevel;
        set
        {
            if (IsRunning || !Enum.IsDefined(typeof(AiReasoningLevel), value) || (int)Project.ExplorationDocument.ReasoningLevel == value) return;
            Project.ExplorationDocument.ReasoningLevel = (AiReasoningLevel)value;
            RaisePropertyChanged();
            RefreshSaveState();
        }
    }
    public bool IsApiMode => Project.Mode == InputMode.ApiDocument;
    public int ProjectModeIndex
    {
        get => (int)Project.Mode;
        set
        {
            if (IsRunning || value is not (0 or 1) || (int)Project.Mode == value) return;
            Project.Mode = (InputMode)value;
            ResetBurpHandoff();
            RefreshModeProperties();
            Log(IsApiMode ? "APIドキュメントモードへ切り替えました。文書とAPIベースURLを設定してください。" : "Web探索モードへ切り替えました。");
        }
    }
    public int ApiProviderIndex
    {
        get => (int)Project.ApiDocument.Provider;
        set
        {
            if (IsRunning || value is not (0 or 1 or 2) || (int)Project.ApiDocument.Provider == value) return;
            Project.ApiDocument.Provider = (DocumentAiProvider)value;
            // プロバイダーを変えたらモデルもその既定へ戻す。
            Project.ApiDocument.Model = DocumentAiCatalog.Models(Project.ApiDocument.Provider)[0].Id;
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(ApiModelOptions));
            RaisePropertyChanged(nameof(ApiModelIndex));
            RaiseAfterItemsChanged(nameof(ApiModelLabel));
            RaisePropertyChanged(nameof(ApiReasoningEnabled));
        }
    }
    public IReadOnlyList<string> ApiModelOptions => DocumentAiCatalog.ModelLabels(Project.ApiDocument.Provider);
    // GLM（zcode）は推論レベルをCLIから指定できないため、選択を無効にする。
    public bool ApiReasoningEnabled => Project.ApiDocument.Provider != DocumentAiProvider.Glm;
    public int ApiModelIndex
    {
        get
        {
            var models = DocumentAiCatalog.Models(Project.ApiDocument.Provider);
            var id = DocumentAiCatalog.NormalizeModel(Project.ApiDocument.Provider, Project.ApiDocument.Model);
            var index = models.ToList().FindIndex(x => x.Id == id);
            return index < 0 ? 0 : index;
        }
        set
        {
            if (IsRunning) return;
            var models = DocumentAiCatalog.Models(Project.ApiDocument.Provider);
            if (value < 0 || value >= models.Count) return;
            var id = models[value].Id;
            if (Project.ApiDocument.Model == id) return;
            Project.ApiDocument.Model = id;
            RaisePropertyChanged();
            RefreshSaveState();
        }
    }
    // モデルのドロップダウンは表示名（SelectedItem）でバインドする。位置（SelectedIndex）でバインドすると、
    // AIを切り替えて候補一覧が置き換わったとき、位置が同じ0のままのため表示が空欄になる。
    // 候補の置き換え中にドロップダウンが一時的に渡すnullは無視する（ここで通知を返すと選択が同期せず空欄になる）。
    // AIの切替後は各プロバイダーの設定でモデルを先頭へ戻し、このプロパティの変更を通知する。
    public string? ApiModelLabel
    {
        get => _blankModelLabel == nameof(ApiModelLabel) ? null : ApiModelOptions[ApiModelIndex];
        set { if (value is not null && ApiModelOptions.ToList().IndexOf(value) is >= 0 and var index) ApiModelIndex = index; }
    }
    public string? DocModelLabel
    {
        get => _blankModelLabel == nameof(DocModelLabel) ? null : DocModelOptions[DocModelIndex];
        set { if (value is not null && DocModelOptions.ToList().IndexOf(value) is >= 0 and var index) DocModelIndex = index; }
    }
    public string? ExplorationAiModelLabel
    {
        get => _blankModelLabel == nameof(ExplorationAiModelLabel) ? null : ExplorationAiModelOptions[ExplorationAiModelIndex];
        set { if (value is not null && ExplorationAiModelOptions.ToList().IndexOf(value) is >= 0 and var index) ExplorationAiModelIndex = index; }
    }
    // ドロップダウンが新しい候補一覧を取り込んだ後に選択を通知する（同期で通知すると一覧の置き換え前に選択され、空欄になる）。
    // 置き換え中にWPFが選択を読み直して書き戻すため、置き換え後に一度空（null）を経由して通知し、選択を同期させる。
    private void RaiseAfterItemsChanged(string propertyName)
    {
        void Raise()
        {
            _blankModelLabel = propertyName;
            RaisePropertyChanged(propertyName);
            _blankModelLabel = null;
            RaisePropertyChanged(propertyName);
        }
        if (System.Windows.Application.Current?.Dispatcher is { } dispatcher)
            dispatcher.BeginInvoke(Raise, System.Windows.Threading.DispatcherPriority.DataBind);
        else Raise();
    }
    private string? _blankModelLabel;
    public IReadOnlyList<string> ApiReasoningOptions => DocumentAiCatalog.ReasoningLevels;
    public int ApiReasoningIndex
    {
        get => (int)Project.ApiDocument.ReasoningLevel;
        set
        {
            if (IsRunning || !Enum.IsDefined(typeof(AiReasoningLevel), value) || (int)Project.ApiDocument.ReasoningLevel == value) return;
            Project.ApiDocument.ReasoningLevel = (AiReasoningLevel)value;
            RaisePropertyChanged();
            RefreshSaveState();
        }
    }
    public string ApiDocumentName => string.IsNullOrWhiteSpace(Project.ApiDocument.FileName) ? "ドキュメント未選択" : $"{Project.ApiDocument.FileName}（{Project.ApiDocument.Content.Length:N0}文字）";
    public string StartActionText => IsApiMode ? "APIリクエストを生成" : "探索を開始";
    public string ExecutionPageHeader => IsApiMode ? "APIリクエスト生成" : "探索";
    public string ExecutionNavigationText => IsApiMode ? "2   API生成" : "2   探索";
    public string ExecutionNextText => IsApiMode ? "API生成へ進む →" : "探索へ進む →";
    public string RequestLimitLabel => IsApiMode ? "最大生成リクエスト数" : "最大通信数";
    public bool CrawlFormSubmissions
    {
        get => Project.EnableFormSubmissions;
        set
        {
            if (Project.EnableFormSubmissions == value) return;
            Project.EnableFormSubmissions = value;
            RaisePropertyChanged();
            RefreshSaveState();
        }
    }
    public string ReviewPageTag => IsApiMode ? "8" : "3";
    public string ReviewNavigationText => IsApiMode ? "3   APIリクエスト" : "3   候補レビュー";
    public string RoleHelpText => IsApiMode ? "選択ロールを生成リクエストへ記録します。認証情報は下書きの置換値を確認して補完してください。"
        : "認証画面を検出すると、ロールに関係なく認証情報の入力を案内します。同じ探索ブラウザでログインし、アプリで再開してください。";
    public string RunModeDescription => IsApiMode
        ? "読み込んだAPIドキュメントをAIで解釈し、未送信のリクエストを作成します。［APIリクエスト］で仮値と本文を確認・編集して採用してください。"
        : "まず高速クローラで収集し、動的な代表パターンをAIで確認します。案件設定で選択した仕様書・操作手順もAIが参照します。ログインなどの手動操作が必要になったら、ここに案内が表示されます。";
    public string BurpExportActionText => IsZapTarget ? "ZAPパッケージを出力" : IsApiMode ? "HTTPリクエストを出力" : "Scope出力を生成";
    public string BurpListHeader => IsApiMode ? "Burp RepeaterへのHTTPリクエスト出力" : "登録用URL正規表現";
    public string BurpPageDescription => IsApiMode ? "採用したAPIリクエストをHTTPテキストとして出力し、Burp Repeaterへ貼り付けます。"
        : "採用した候補を出力し、Burp SuiteのScopeへ登録します。";
    public string BurpModeDescription => IsApiMode ? "APIリクエスト画面で出典と仮値を確認し、採用したリクエストをHTTPファイルへ出力します。URLに合わせてBurp Repeaterの接続先を指定してください。"
        : "Burp Suite Community EditionではScopeを自動変更できないため、採用候補を少数のURL正規表現へ集約して手動登録します。案件の許可Originと一致することを確認してから追加してください。";
    public string ApiRequestSummary => $"API文書から生成: {Project.ApiRequests.Count:N0}件（採用 {Project.ApiRequests.Count(x => x.Selected):N0}件）";
    public ApiRequestDraft? SelectedApiRequest
    {
        get => _selectedApiRequest;
        set { if (SetProperty(ref _selectedApiRequest, value)) CopyApiRequestCommand.RaiseCanExecuteChanged(); }
    }

    public async Task ReadApiDocumentAsync(string path)
    {
        if (IsRunning) return;
        try
        {
            await EnsureProjectAsync();
            var source = await ProjectPaths.ImportAsync(Project, path, "api-document");
            path = ProjectPaths.Resolve(Project, source.LocalPath);
            Project.ApiDocument = await ApiDocumentService.ReadDocumentAsync(path, Project.ApiDocument);
            Project.Inputs.Add(source with { Role = Project.ActiveRole });
            RefreshModeProperties();
            await RecordProjectChangeAsync();
            Log($"APIドキュメントを読み込みました: {ApiDocumentName}");
        }
        catch (Exception ex) { Log($"APIドキュメントの読込に失敗しました: {ex.Message}"); }
    }

    public async Task ReadExplorationDocumentAsync(string path)
    {
        if (IsRunning) return;
        try
        {
            await EnsureProjectAsync();
            var previous = Project.ExplorationDocument;
            var document = await ExplorationDocumentService.ImportAsync(Project, path);
            // 文書を読み替えても補助情報の抽出AI指定は引き継ぐ。
            document.AiProvider = previous.AiProvider;
            document.Model = previous.Model;
            document.ReasoningLevel = previous.ReasoningLevel;
            Project.ExplorationDocument = document;
            Project.Inputs.Add(document.Source!);
            RefreshModeProperties();
            await RecordProjectChangeAsync();
            Log($"探索用ドキュメントを読み込みました: {ExplorationDocumentName}");
        }
        catch (Exception ex)
        {
            Log($"探索用ドキュメントの読込に失敗しました: {ex.Message}");
            ShowProjectError?.Invoke($"探索用ドキュメントを読み込めませんでした。{Environment.NewLine}{ex.Message}");
        }
    }

    private void ClearExplorationDocument()
    {
        Project.ExplorationDocument = new();
        RefreshModeProperties();
        RefreshSaveState();
        Log("探索で参照するドキュメントの指定を解除しました。");
    }

    public async Task SaveApiRequestChangesAsync()
    {
        if (IsRunning) return;
        await SaveAsync();
        RaisePropertyChanged(nameof(ApiRequestSummary));
    }

    private void CopyApiRequest()
    {
        if (SelectedApiRequest is null) return;
        try
        {
            ApiRequestFormatter.EnsureAllowed(SelectedApiRequest.Url, Project.AllowedOrigins);
            System.Windows.Clipboard.SetText(ApiRequestFormatter.Format(SelectedApiRequest));
            Log("HTTPリクエストをコピーしました。Burp Repeaterへ貼り付け、接続先と仮値を確認してください。");
        }
        catch (Exception ex) { Log($"HTTPリクエストをコピーできませんでした: {ex.Message}"); }
    }

    private void RefreshModeProperties()
    {
        foreach (var name in new[] { nameof(IsApiMode), nameof(ProjectModeIndex), nameof(ExplorationProxyModeIndex), nameof(ApiProviderIndex), nameof(ApiModelOptions), nameof(ApiModelIndex), nameof(ApiModelLabel), nameof(ApiReasoningOptions), nameof(ApiReasoningIndex), nameof(ApiReasoningEnabled), nameof(DocProviderIndex), nameof(DocModelOptions), nameof(DocModelIndex), nameof(DocModelLabel), nameof(DocReasoningOptions), nameof(DocReasoningIndex), nameof(DocReasoningEnabled), nameof(ExplorationAiIndex), nameof(ExplorationAiModelOptions), nameof(ExplorationAiModelIndex), nameof(ExplorationAiModelLabel), nameof(ExplorationAiModelEnabled), nameof(ApiDocumentName), nameof(ExplorationDocumentName), nameof(HasExplorationDocument), nameof(StartActionText),
            nameof(RunModeDescription), nameof(BurpExportActionText), nameof(BurpListHeader), nameof(ApiRequestSummary), nameof(SummaryText), nameof(ReviewPageTag), nameof(ReviewNavigationText), nameof(RoleHelpText), nameof(ActiveRole),
            nameof(ExecutionPageHeader), nameof(ExecutionNavigationText), nameof(ExecutionNextText), nameof(RequestLimitLabel), nameof(BurpPageDescription), nameof(BurpModeDescription), nameof(HandoffDescription) }) RaisePropertyChanged(name);
        RaisePropertyChanged(nameof(Project));
        SetupMcpCommand.RaiseCanExecuteChanged();
        ClearExplorationDocumentCommand.RaiseCanExecuteChanged();
    }
    public bool IsRunning
    {
        get => _isRunning;
        private set
        {
            if (!SetProperty(ref _isRunning, value)) return;
            RefreshWordReportCommands();
            RaisePropertyChanged(nameof(CanEditExplorationSettings));
            SaveCommand.RaiseCanExecuteChanged();
            ClearExplorationDocumentCommand.RaiseCanExecuteChanged();
            StartExplorationCommand.RaiseCanExecuteChanged();
            NewProjectCommand.RaiseCanExecuteChanged();
            LoadProjectCommand.RaiseCanExecuteChanged();
            RetrySelectedRunCommand.RaiseCanExecuteChanged();
            StopExplorationCommand.RaiseCanExecuteChanged();
            ResumeExplorationCommand.RaiseCanExecuteChanged();
            ResetCandidateDecisionsCommand.RaiseCanExecuteChanged();
            AdoptVisibleCandidatesCommand.RaiseCanExecuteChanged();
            ExcludeVisibleCandidatesCommand.RaiseCanExecuteChanged();
            ExportBurpScopeCommand.RaiseCanExecuteChanged();
            ExportFindingsCommand.RaiseCanExecuteChanged();
            BackupProjectCommand.RaiseCanExecuteChanged();
            SetupMcpCommand.RaiseCanExecuteChanged();
            BuildExplorationPackageCommand.RaiseCanExecuteChanged();
            CopyApiRequestCommand.RaiseCanExecuteChanged();
            StartZapCommand.RaiseCanExecuteChanged();
            PrepareZapAddonsCommand.RaiseCanExecuteChanged();
            RecordZapBrowserCommand.RaiseCanExecuteChanged();
        }
    }
    public string InterventionText { get => _interventionText; private set => SetProperty(ref _interventionText, value); }
    public ExplorationRunSummary? SelectedRun
    {
        get => _selectedRun;
        set
        {
            if (!SetProperty(ref _selectedRun, value)) return;
            OpenRunFolderCommand.RaiseCanExecuteChanged();
            RetrySelectedRunCommand.RaiseCanExecuteChanged();
        }
    }
    public DiagnosticCandidate? SelectedCandidate { get => _selectedCandidate; set => SetProperty(ref _selectedCandidate, value); }
    public DiagnosticFinding? SelectedFinding { get => _selectedFinding; set => SetProperty(ref _selectedFinding, value); }
    public string StatusText => Project.Status switch { ProjectStatus.Draft => "設定中", ProjectStatus.Ready => "準備完了", ProjectStatus.Crawling => "探索中", ProjectStatus.WaitingForHuman => "手動操作待ち", ProjectStatus.Organizing => "整理中", ProjectStatus.ReviewReady => "確認可能", ProjectStatus.Partial => "部分結果", ProjectStatus.Paused => "一時停止", _ => "失敗" };
    public string SummaryText => IsApiMode ? $"{Project.Name}  |  APIドキュメント  |  生成 {Project.ApiRequests.Count:N0}件  |  採用 {Project.ApiRequests.Count(x => x.Selected):N0}件"
        : $"{Project.Name}  |  観測 {Project.Requests.Count:N0}件  |  候補 {Project.Candidates.Count(x => x.Selected):N0}件";
    public string RequestSummary => $"観測した通信: {Project.Requests.Count:N0}件";
    public string CandidateSummary => $"代表化した候補: {Project.Candidates.Count:N0}件（採用 {Project.Candidates.Count(x => x.Selected):N0}件／除外キャッシュ {Project.DeferredCandidatePatterns.Count:N0}件）";
    public string CandidateFilterSummary => $"表示 {FilteredCandidates.Count:N0}件 / 全{Project.Candidates.Count:N0}件（{CandidateReviewFilter}）";
    public string CandidateSearch
    {
        get => _candidateSearch;
        set { if (SetProperty(ref _candidateSearch, value)) RefreshFilteredCandidates(); }
    }
    public string CandidateReviewFilter { get => _candidateReviewFilter; private set => SetProperty(ref _candidateReviewFilter, value); }
    public string RunPhase { get => _runPhase; private set => SetProperty(ref _runPhase, value); }
    public string RunProgressDetail { get => _runProgressDetail; private set => SetProperty(ref _runProgressDetail, value); }
    public int RunProgress { get => _runProgress; private set => SetProperty(ref _runProgress, value); }
    public string? LastBurpExportDirectory { get => _lastBurpExportDirectory; private set { if (SetProperty(ref _lastBurpExportDirectory, value)) OpenBurpExportFolderCommand.RaiseCanExecuteChanged(); } }
    public string? SelectedBurpScopeRegex { get => _selectedBurpScopeRegex; set => SetProperty(ref _selectedBurpScopeRegex, value); }
    public string BurpHandoffStatus { get => _burpHandoffStatus; private set => SetProperty(ref _burpHandoffStatus, value); }
    public string DataSummaryText { get => _dataSummaryText; private set => SetProperty(ref _dataSummaryText, value); }
    public string? LastBackupPath { get => _lastBackupPath; private set => SetProperty(ref _lastBackupPath, value); }
    public string FindingSummary => $"診断所見: {Project.Findings.Count:N0}件";
    public string RunHistorySummary => $"探索実行履歴: {RunHistory.Count:N0}件";
    public string ConsoleText => string.Join(Environment.NewLine, Logs);
    public string LatestLog => Logs.FirstOrDefault() ?? "案件を設定して探索を開始してください。";

    public Task InitializeAsync()
    {
        UpdateRoleOptions(refreshProject: true);
        Log("プロジェクトファイルを作成または開いてください。");
        RefreshSummary();
        return Task.CompletedTask;
    }
    public async Task<int> ImportAsync(string path)
    {
        try
        {
            await EnsureProjectAsync();
            var source = await ProjectPaths.ImportAsync(Project, path, Path.GetExtension(path).Equals(".har", StringComparison.OrdinalIgnoreCase) ? "har" : "requests");
            path = ProjectPaths.Resolve(Project, source.LocalPath);
            Project.Inputs.Add(source with { Role = Project.ActiveRole });
            Log($"取込開始: {path}");
            var imported = await _importer.ImportAsync(path);
            foreach (var request in Project.Requests) RequestImporter.Normalize(request);
            var known = Project.Requests
                .GroupBy(ObservedRequestIdentity.Build, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
            var added = 0;
            foreach (var request in imported)
            {
                var key = ObservedRequestIdentity.Build(request);
                if (!known.TryGetValue(key, out var existing))
                {
                    Project.Requests.Add(request);
                    known[key] = request;
                    added++;
                }
                else MergeObservation(existing, request);
            }
            Log($"{imported.Count:N0}件を読み取り、{added:N0}件を追加しました。");
            GenerateCandidates();
            await RecordProjectChangeAsync();
            return imported.Count;
        }
        catch (Exception ex) { Log($"取込失敗 ({ex.GetType().Name}): {ex.Message}{Environment.NewLine}{ex.StackTrace}"); return 0; }
    }

    private async Task SaveAsync()
    {
        if (IsRunning) return;
        var valid = IsConfigurationValid();
        if (!valid) Project.Status = ProjectStatus.Draft;
        else if (Project.Status is ProjectStatus.Draft or ProjectStatus.Failed) Project.Status = ProjectStatus.Ready;
        await SaveCurrentProjectAsync();
        RefreshSummary();
    }
    public async Task UpdateCandidateDecisionAsync(DiagnosticCandidate candidate)
    {
        UpdateCandidateDecisionCache(candidate);
        await RecordProjectChangeAsync();
        Log(candidate.Selected
            ? $"候補の採用を変更しました（未保存）: {candidate.Pattern}"
            : $"候補の除外を変更しました（未保存）: {candidate.Pattern}");
        RefreshFilteredCandidates();
    }

    private void SetCandidateReviewFilter(string filter)
    {
        CandidateReviewFilter = filter;
        RefreshFilteredCandidates();
    }

    private void RefreshFilteredCandidates()
    {
        var query = Project.Candidates.AsEnumerable();
        query = CandidateReviewFilter switch
        {
            "採用" => query.Where(x => x.Selected),
            "除外" => query.Where(x => !x.Selected),
            _ => query
        };
        var search = CandidateSearch.Trim();
        if (search.Length > 0)
            query = query.Where(x => new[] { x.Pattern, x.Representative.Url, x.Category, x.Reason, x.DiagnosticCaution, x.Representative.Role }
                .Any(value => value?.Contains(search, StringComparison.OrdinalIgnoreCase) == true));
        FilteredCandidates.Clear();
        foreach (var candidate in query) FilteredCandidates.Add(candidate);
        if (SelectedCandidate is null || !FilteredCandidates.Contains(SelectedCandidate))
            SelectedCandidate = FilteredCandidates.FirstOrDefault();
        RaisePropertyChanged(nameof(CandidateFilterSummary));
        AdoptVisibleCandidatesCommand.RaiseCanExecuteChanged();
        ExcludeVisibleCandidatesCommand.RaiseCanExecuteChanged();
    }

    private async Task SetVisibleCandidateDecisionAsync(bool selected)
    {
        var targets = FilteredCandidates.ToArray();
        foreach (var candidate in targets)
        {
            candidate.Selected = selected;
            UpdateCandidateDecisionCache(candidate);
        }
        await RecordProjectChangeAsync();
        Log($"表示中の候補{targets.Length:N0}件を{(selected ? "一括採用" : "一括除外")}しました。");
        RefreshFilteredCandidates();
        RefreshSummary();
    }

    public async Task ApplyGuidelineSelectionAsync()
    {
        Project.Guidelines ??= new GuidelineSelectionOptions();
        GenerateCandidates();
        await RecordProjectChangeAsync();
        Log("参照ガイドラインの変更を候補選定と案件設定へ反映しました。");
    }

    private async Task ResetCandidateDecisionsAsync()
    {
        var adoptedCount = Project.AdoptedCandidatePatterns.Count;
        var deferredCount = Project.DeferredCandidatePatterns.Count;
        var reviewedCount = Project.ExplicitlyReviewedCandidatePatterns.Count;
        Project.AdoptedCandidatePatterns.Clear();
        Project.DeferredCandidatePatterns.Clear();
        Project.ExplicitlyReviewedCandidatePatterns.Clear();
        Project.Candidates.Clear();
        GenerateCandidates();
        await RecordProjectChangeAsync();
        Log($"候補判定の保存記録を解除しました: 採用{adoptedCount:N0}件、除外{deferredCount:N0}件、確認済み{reviewedCount:N0}件。現在の観測通信から候補を再生成しました。");
        RefreshSummary();
    }

    private async Task RefreshRunHistoryAsync()
    {
        var selectedId = SelectedRun?.RunId;
        var runs = await _runHistoryService.ListAsync(Project);
        RunHistory.Clear();
        foreach (var run in runs) RunHistory.Add(run);
        SelectedRun = RunHistory.FirstOrDefault(x => x.RunId == selectedId) ?? RunHistory.FirstOrDefault();
        RaisePropertyChanged(nameof(RunHistorySummary));
    }

    private async Task RefreshDataSummaryAsync()
    {
        try { DataSummaryText = (await _dataManagement.GetSummaryAsync(Project)).Display; }
        catch (Exception ex) { DataSummaryText = $"保存データを集計できませんでした: {ex.Message}"; }
    }

    private async Task BackupProjectAsync()
    {
        try
        {
            await RecordProjectChangeAsync();
            LastBackupPath = await _dataManagement.CreateBackupAsync(Project);
            Log($"案件バックアップを作成しました: {LastBackupPath}");
            await RefreshDataSummaryAsync();
        }
        catch (Exception ex) { Log($"案件バックアップを作成できませんでした: {ex.Message}"); }
    }

    public async Task DeleteSelectedRunAsync()
    {
        if (SelectedRun is null) return;
        var target = SelectedRun;
        try
        {
            await _dataManagement.DeleteRunAsync(Project, target.Directory);
            var prefix = ProjectPaths.Relative(Project, target.Directory).TrimEnd('/') + "/";
            foreach (var input in Project.Inputs.Where(x => x.LocalPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)).ToArray()) Project.Inputs.Remove(input);
            foreach (var draft in Project.ApiRequests.Where(x => x.SourceRunDirectory == target.Directory)) draft.SourceRunDirectory = "";
            foreach (var finding in Project.Findings.Where(x => x.SourceRunDirectory == target.Directory)) finding.SourceRunDirectory = "";
            await RecordProjectChangeAsync();
            Log($"探索実行データを削除しました: {target.StartedAtDisplay}");
            await RefreshRunHistoryAsync();
            await RefreshDataSummaryAsync();
        }
        catch (Exception ex) { Log($"探索実行データを削除できませんでした: {ex.Message}"); }
    }

    public async Task DeleteGeneratedArtifactsAsync()
    {
        try
        {
            await _dataManagement.DeleteGeneratedArtifactsAsync(Project);
            ResetBurpHandoff();
            Log("現在の案件のBurp出力とレポートを削除しました。案件、観測通信、探索実行履歴は保持しています。");
            await RefreshDataSummaryAsync();
        }
        catch (Exception ex) { Log($"生成物を削除できませんでした: {ex.Message}"); }
    }

    private void OpenSelectedRunFolder()
    {
        if (SelectedRun is null) return;
        OpenRunPath(SelectedRun.Directory, "実行フォルダー");
    }

    public void OpenSelectedRunArtifact(string fileName)
    {
        if (SelectedRun is null) return;
        var path = Path.Combine(SelectedRun.Directory, fileName);
        if (!File.Exists(path))
        {
            Log($"選択した実行には {fileName} がありません。");
            return;
        }
        OpenRunPath(path, fileName);
    }

    private void OpenRunPath(string path, string label)
    {
        try { WorkspacePathOpener.Open(path); }
        catch (Exception ex) { Log($"{label}を開けませんでした: {ex.Message}"); }
    }

    private async Task RetrySelectedRunAsync()
    {
        if (SelectedRun is null) return;
        if (SelectedRun.Mode == InputMode.ApiDocument)
        {
            try
            {
                using var document = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(SelectedRun.Directory, "engagement.json")));
                var root = document.RootElement;
                Project.ApiDocument = new ApiDocumentSettings
                {
                    FileName = root.GetProperty("documentName").GetString() ?? "api-document.txt",
                    Content = await File.ReadAllTextAsync(Path.Combine(SelectedRun.Directory, "api-document.txt")),
                    BaseUrl = root.GetProperty("baseUrl").GetString() ?? string.Empty,
                    Provider = Enum.Parse<DocumentAiProvider>(root.GetProperty("provider").GetString()!),
                    Model = root.TryGetProperty("model", out var modelElement) ? modelElement.GetString() ?? string.Empty : string.Empty,
                    ReasoningLevel = root.TryGetProperty("reasoningLevel", out var reasoningElement)
                        && Enum.TryParse<AiReasoningLevel>(reasoningElement.GetString(), true, out var reasoning)
                        ? reasoning : AiReasoningLevel.Middle
                };
                Project.Mode = InputMode.ApiDocument;
                Project.ActiveRole = root.GetProperty("activeRole").GetString() ?? "未認証";
                // Reuse the snapshot against the project's current authorization scope.
                RefreshModeProperties();
            }
            catch (Exception ex) { Log($"API実行の入力を復元できませんでした: {ex.Message}"); return; }
        }
        else { Project.Mode = InputMode.WebExploration; RefreshModeProperties(); }
        Log($"過去実行 {SelectedRun.StartedAtDisplay} を参考に、現在の許可範囲と上限で新しい実行を開始します。");
        await StartExplorationAsync();
    }

    private static void PrepareProject(EngagementProject project)
    {
        project.ExplorationDocument ??= new ExplorationDocumentSettings();
        project.ExplorationAi ??= new ExplorationAiSettings();
        project.ExplorationProxy ??= new ExplorationProxySettings();
        project.ApiDocument ??= new ApiDocumentSettings();
        project.DiagnosticTools ??= new DiagnosticToolSettings();
        project.Inputs ??= [];
        project.DiagnosticObservations ??= [];
        project.ApiRequests ??= [];
        project.Guidelines ??= new GuidelineSelectionOptions();
        project.Requests ??= [];
        project.Candidates ??= [];
        project.Findings ??= [];
        project.AdoptedCandidatePatterns ??= [];
        project.DeferredCandidatePatterns ??= [];
        project.ExplicitlyReviewedCandidatePatterns ??= [];
        foreach (var request in project.Requests) RequestImporter.Normalize(request);
    }

    // 今回探索するロール（選択欄のバインド先）。候補の更新中に選択欄が一時的に外す null は無視する。
    public string ActiveRole
    {
        get => Project.ActiveRole;
        set
        {
            if (_updatingRoleOptions || string.IsNullOrEmpty(value) || Project.ActiveRole == value) return;
            Project.ActiveRole = value;
            RaisePropertyChanged();
            RaisePropertyChanged(nameof(AuthenticationRoleOptions));
        }
    }
    private bool _updatingRoleOptions;

    // 認証ロールの入力欄の編集ごとに呼ばれる。案件全体（Project）の変更通知は出さない。
    // 出すと入力欄自身が案件の値を読み直し、日本語入力の変換中の文字が消える（空欄からは何も入力できなくなる）。
    public void UpdateRoleOptions() => UpdateRoleOptions(refreshProject: false);

    internal void UpdateRoleOptions(bool refreshProject)
    {
        var roles = Project.Roles.Split(['\r', '\n', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (!roles.Contains("未認証", StringComparer.OrdinalIgnoreCase)) roles.Insert(0, "未認証");
        // 候補は一括で消さずに差分で更新し、選択中のロールが一時的に外れて未認証へ戻らないようにする。
        _updatingRoleOptions = true;
        try
        {
            for (var index = 0; index < roles.Count; index++)
            {
                if (index < RoleOptions.Count && RoleOptions[index] == roles[index]) continue;
                var existing = RoleOptions.IndexOf(roles[index]);
                if (existing > index) RoleOptions.Move(existing, index);
                else RoleOptions.Insert(index, roles[index]);
            }
            while (RoleOptions.Count > roles.Count) RoleOptions.RemoveAt(RoleOptions.Count - 1);
        }
        finally { _updatingRoleOptions = false; }
        var current = roles.FirstOrDefault(role => string.Equals(role, Project.ActiveRole, StringComparison.OrdinalIgnoreCase));
        Project.ActiveRole = current ?? roles[0];
        RaisePropertyChanged(nameof(ActiveRole));
        RaisePropertyChanged(nameof(AuthenticationRoleOptions));
        if (refreshProject) RaisePropertyChanged(nameof(Project));
    }

    private static void MergeObservation(ObservedRequest existing, ObservedRequest incoming)
    {
        existing.PageInspected |= incoming.PageInspected;
        existing.FormCount = Math.Max(existing.FormCount, incoming.FormCount);
        existing.FormFieldNames = existing.FormFieldNames.Concat(incoming.FormFieldNames)
            .Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToArray();
        if (incoming.StatusCode.HasValue) existing.StatusCode = incoming.StatusCode;
        if (!string.IsNullOrWhiteSpace(incoming.ContentType)) existing.ContentType = incoming.ContentType;
        if (!string.IsNullOrWhiteSpace(incoming.PageTitle)) existing.PageTitle = incoming.PageTitle;
        if (!string.IsNullOrWhiteSpace(incoming.Source)) existing.Source = incoming.Source;
        if (!string.IsNullOrWhiteSpace(incoming.Role)) existing.Role = incoming.Role;
        if (incoming.ObservedAt > existing.ObservedAt) existing.ObservedAt = incoming.ObservedAt;
    }

    private async Task CheckEnvironmentAsync()
    {
        if (IsApiMode)
        {
            var provider = Project.ApiDocument.Provider;
            var launch = ApiDocumentAiRunner.FindLaunch(provider);
            var name = DocumentAiCatalog.DisplayName(provider);
            if (provider == DocumentAiProvider.Glm)
                Log(launch is null
                    ? $"[要設定] {name} にはzcode CLI（npmグローバル）とnode.jsが必要です。"
                    : AiConnectionChecker.GlmCredentialAvailable()
                        ? $"[OK] {name}: {launch.DisplayPath}。認証はAPIキーまたはzcode loginのサインインで、生成時に確認します。"
                        : $"[要設定] {name}: アプリ設定でAPIキーを登録するか、zcode login でZ.aiへサインインしてください。");
            else
                Log(launch is null ? $"[要設定] {name}をインストールしてログインしてください。" : $"[OK] {name}: {launch.DisplayPath}。ログイン状態は生成時に確認します。");
            return;
        }
        Log("環境チェックを開始します。");
        foreach (var item in await _environment.CheckAsync(Project)) Log($"[{(item.Available ? "OK" : "要設定")}] {item.Name}: {item.Detail}");
        if (HasExplorationDocument)
        {
            var provider = Project.ExplorationDocument.AiProvider;
            var launch = ApiDocumentAiRunner.FindLaunch(provider);
            var name = DocumentAiCatalog.DisplayName(provider);
            if (launch is null)
                Log($"[参考] 入力ドキュメントの補助情報抽出用 {name} が見つかりません。探索は文書なしで続行します。");
            else if (provider == DocumentAiProvider.Glm && !AiConnectionChecker.GlmCredentialAvailable())
                Log($"[参考] 入力ドキュメントの補助情報抽出用 {name} にはAPIキーの登録またはZ.aiサインイン（zcode login）が必要です。");
            else
                Log($"[参考] 入力ドキュメントの補助情報抽出用 {name}: {launch.DisplayPath}。");
        }
    }

    // 画面探索のAI（案件設定）。Claude Code CLIは画面探索に未対応のためCodexとして扱う。
    private DocumentAiProvider ExplorationAiProvider =>
        ExplorationAiSettings.Supports(Project.ExplorationAi.Provider) ? Project.ExplorationAi.Provider : DocumentAiProvider.Codex;
    private string ExplorationAiName => DocumentAiCatalog.DisplayName(ExplorationAiProvider);

    private Task<ExplorationRunResult> RunExplorationAiAsync(string path, IProgress<string> progress) =>
        ExplorationAiProvider == DocumentAiProvider.Glm
            ? _zcodeRunner.RunAsync(path, Project.ExplorationAi, progress, OnInterventionDetected, _runCancellation!.Token, OnAuthenticationNavigationDetected)
            : _runner.RunAsync(path, progress, OnInterventionDetected, _runCancellation!.Token, OnAuthenticationNavigationDetected);

    private async Task SetupMcpAsync()
    {
        if (!await TryEnsureProjectAsync()) return;
        Log("CodexへのMCP登録を開始します。");
        var result = await _mcpSetup.ConfigureAsync(Project);
        foreach (var message in result.Messages) Log(message);
        Log(result.Success ? "MCPの登録が完了しました。Codexを再起動すると設定が反映されます。" : "MCP登録に失敗しました。上記ログを確認してください。");
    }

    private async Task BuildExplorationPackageAsync()
    {
        if (IsApiMode)
        {
            try { var directory = await _apiDocuments.BuildAsync(Project); await RecordProjectChangeAsync(); await RefreshRunHistoryAsync(); await RefreshDataSummaryAsync(); Log($"API生成パッケージを準備しました: {directory}"); }
            catch (Exception ex) { Log($"API生成パッケージを準備できませんでした: {ex.Message}"); }
            return;
        }
        var path = await BuildPackageAsync();
        if (path is null) return;
        await RefreshRunHistoryAsync();
        await RefreshDataSummaryAsync();
        SetRunProgress("準備済み", 100, "探索パッケージを生成しました。AI探索はまだ開始していません。");
        Log($"探索パッケージを生成しました: {path}");
        Log("パッケージは［AI探索を開始］から実行できます。");
    }

    private async Task StartApiDocumentAsync()
    {
        if (!await TryEnsureProjectAsync()) return;
        IsRunning = true;
        _currentRunDirectory = null;
        _runCancellation = new CancellationTokenSource();
        try
        {
            UpdateRoleOptions(refreshProject: true);
            ApiDocumentService.Validate(Project);
            _runCancellation.CancelAfter(TimeSpan.FromMinutes(Project.MaxMinutes));
            SetRunProgress("API入力準備", 10, "APIドキュメントと生成条件を保存しています。");
            _currentRunDirectory = await _apiDocuments.BuildAsync(Project);
            Project.Status = ProjectStatus.Organizing;
            await RecordProjectChangeAsync();
            RefreshSummary();
            SetRunProgress("APIリクエスト生成", 35, $"{DocumentAiCatalog.DisplayName(Project.ApiDocument.Provider)}（{DocumentAiCatalog.NormalizeModel(Project.ApiDocument.Provider, Project.ApiDocument.Model)}・推論{Project.ApiDocument.ReasoningLevel}）が文書のAPI定義を読み取っています。");
            var result = await _apiRunner.RunAsync(_currentRunDirectory, Project.ApiDocument, new Progress<string>(Log), _runCancellation.Token);
            if (result.Cancelled) throw new OperationCanceledException();
            if (result.ExitCode != 0 || !File.Exists(result.ResultPath))
                throw new InvalidDataException("AIがリクエスト生成を完了できませんでした。実行履歴のAPI実行ログを確認してください。");
            SetRunProgress("生成結果確認", 85, "生成結果のURL、ヘッダー、本文を検証しています。");
            var parsed = ApiDocumentService.ParseResult(await File.ReadAllTextAsync(result.ResultPath), Project, _currentRunDirectory);
            if (parsed.Status == "failed") throw new InvalidDataException(parsed.Summary);
            // Replace only after the complete result passed validation. Every new draft needs review.
            Project.ApiRequests.Clear();
            foreach (var draft in parsed.Requests) Project.ApiRequests.Add(draft);
            ResetBurpHandoff();
            SelectedApiRequest = Project.ApiRequests.FirstOrDefault();
            Project.Status = parsed.Status == "partial" ? ProjectStatus.Partial : ProjectStatus.ReviewReady;
            await File.WriteAllTextAsync(Path.Combine(_currentRunDirectory, "api-document-summary.json"), JsonSerializer.Serialize(new
            {
                status = parsed.Status, summary = parsed.Summary, limitations = parsed.Limitations,
                requestCount = parsed.Requests.Count, finishedAt = DateTimeOffset.Now
            }, new JsonSerializerOptions { WriteIndented = true }));
            SetRunProgress("完了", 100, $"{parsed.Requests.Count:N0}件の未送信リクエストを生成しました。APIリクエスト画面で確認してください。");
            Log(parsed.Summary);
            foreach (var limitation in parsed.Limitations) Log($"API生成の制約: {limitation}");
            Log($"API文書から{parsed.Requests.Count:N0}件を生成しました。［APIリクエスト］で内容を補完して採用してください。");
        }
        catch (OperationCanceledException)
        {
            Project.Status = ProjectStatus.Paused;
            SetRunProgress("停止", RunProgress, "APIリクエストの生成を停止しました。");
            await WriteApiFailureSummaryAsync("paused", "APIリクエストの生成を停止しました。");
        }
        catch (Exception ex)
        {
            Project.Status = ProjectStatus.Failed;
            SetRunProgress("生成失敗", RunProgress, ex.Message);
            Log($"APIリクエストの生成に失敗しました: {ex.Message}");
            await WriteApiFailureSummaryAsync("failed", ex.Message);
        }
        finally
        {
            IsRunning = false;
            _runCancellation.Dispose();
            _runCancellation = null;
            RefreshSummary();
            try { await RecordProjectChangeAsync(); await RefreshRunHistoryAsync(); await RefreshDataSummaryAsync(); }
            catch (Exception ex) { Log($"API実行の保存・履歴更新に失敗しました: {ex.Message}"); }
        }
    }

    private async Task WriteApiFailureSummaryAsync(string status, string summary)
    {
        if (_currentRunDirectory is null) return;
        try
        {
            await File.WriteAllTextAsync(Path.Combine(_currentRunDirectory, "api-document-summary.json"),
                JsonSerializer.Serialize(new { status, summary, limitations = Array.Empty<string>(), requestCount = 0, finishedAt = DateTimeOffset.Now }));
        }
        catch (Exception ex) { Log($"API実行サマリーを保存できませんでした: {ex.Message}"); }
    }

    private async Task StartExplorationAsync()
    {
        if (!await TryEnsureProjectAsync()) return;
        if (IsApiMode) { await StartApiDocumentAsync(); return; }
        UpdateRoleOptions(refreshProject: true);
        SetRunProgress("環境確認", 2, "MCPと実行環境を確認しています。");
        Log($"探索対象ロール: {Project.ActiveRole}");
        _currentRunDirectory = null;
        InterventionText = string.Empty;
        ResetAuthenticationState();
        _runCancellation = new CancellationTokenSource();
        if (Project.MaxMinutes > 0) _runCancellation.CancelAfter(TimeSpan.FromMinutes(Project.MaxMinutes));
        IsRunning = true;
        Project.Status = ProjectStatus.Crawling;
        RefreshSummary();
        await RecordProjectChangeAsync();
        ExplorationProxySession? proxy = null;
        int? aiPhaseStart = null;
        var aiWasStarted = false;
        var proxyDisconnected = false;
        CancellationTokenSource? proxyMonitorCancellation = null;
        Task? proxyMonitor = null;
        try
        {
            var progress = new Progress<string>(message => { Log(message); UpdateProgressFromLog(message); });
            await EnsureDocumentHintsAsync(_runCancellation.Token);
            var path = await BuildPackageAsync();
            if (path is null) { Project.Status = ProjectStatus.Failed; return; }
            _currentRunDirectory = path;
            proxy = await _explorationProxy.OpenAsync(Project, path, progress, _runCancellation.Token);
            proxyMonitorCancellation = CancellationTokenSource.CreateLinkedTokenSource(_runCancellation.Token);
            proxyMonitor = proxy.MonitorAsync(() =>
            {
                proxyDisconnected = true;
                Log("探索用プロキシへの接続が切れたため、探索を停止します。再実行時に接続先を確認してください。");
                _runCancellation?.Cancel();
            }, proxyMonitorCancellation.Token);
            _runCancellation.Token.ThrowIfCancellationRequested();
            SetRunProgress("高速クロール", 10, "開始URLから同一Originのリンクを巡回しています。");
            var crawl = await _fastCrawler.RunAsync(path, progress, _runCancellation.Token, OnInterventionDetected, OnAuthenticationNavigationDetected);
            if (!crawl.Cancelled && !crawl.ProxyUnavailable && crawl.ExitCode != 0)
            {
                Log($"高速クローラが終了コード {crawl.ExitCode} で停止しました。新しいプロセスで1回だけ再試行します。");
                SetRunProgress("クロール再試行", Math.Max(15, RunProgress), "高速クローラを新しいプロセスで再開しています。");
                crawl = await _fastCrawler.RunAsync(path, progress, _runCancellation.Token, OnInterventionDetected, OnAuthenticationNavigationDetected);
            }
            if (crawl.Cancelled)
            {
                Project.Status = proxyDisconnected ? ProjectStatus.Failed : ProjectStatus.Paused;
                SetRunProgress("停止", RunProgress, "高速クロールを停止しました。");
                Log("高速クローラを停止しました。");
                return;
            }
            if (crawl.ProxyUnavailable)
            {
                Project.Status = ProjectStatus.Failed;
                SetRunProgress("接続失敗", 0, "探索用プロキシへ接続できませんでした。");
                Log($"探索用プロキシ {proxy.Endpoint.Provider} ({proxy.Endpoint.Url}) への接続が切れました。通信記録を保存して停止します。再実行時に接続先を確認してください。");
                RefreshSummary();
                return;
            }
            if (crawl.ExitCode != 0)
                Log($"高速クローラが再試行後も終了コード {crawl.ExitCode} で停止しました。取得済みデータを整理し、{ExplorationAiName}の画面探索へフォールバックします。");
            else
                Log(crawl.Status == "completed" ? "通常のリンク巡回が完了しました。AI対象を分類します。" : "リンク巡回は部分結果です。未到達・認証・上限の記録を確認してください。");
            if (crawl.AuthenticationBlocked) { Project.Status = ProjectStatus.Partial; await RecoverPartialObservationsAsync(path); return; }
            if (crawl.ExitCode != 0) { Project.Status = ProjectStatus.Failed; return; }
            var setup = await _mcpSetup.ConfigureAsync(Project, proxy.Endpoint, path);
            foreach (var message in setup.Messages) Log(message);
            if (!setup.Success) throw new InvalidOperationException("MCP設定を準備できませんでした。実行履歴のmcp-setup.logを確認してください。");
            proxy.UseBurpMcp = setup.UseBurpMcp;
            await proxy.WriteRuntimeAsync();
            await ExplorationPackageBuilder.ConfigureProxyPromptAsync(path, setup.UseBurpMcp);
            if (proxy.ZapApi is not null)
            {
                try { aiPhaseStart = await proxy.ZapApi.MessageCountAsync(_runCancellation.Token); }
                catch (Exception ex) when (ex is not OperationCanceledException) { Log($"ZAP通信記録の区切りを取得できませんでした: {ex.Message}"); }
                await CaptureZapHarAsync(proxy, Path.Combine(path, "zap-fast-capture.har"), 0, Project.ActiveRole, "har-reference");
            }
            if (!crawl.ProxyUnavailable)
            {
                SetRunProgress("AI入力整理", 58, "静的通信を除外し、動的な代表パターンを作成しています。");
                var aiInput = await _aiInputBuilder.BuildAsync(path);
                Log($"AI事前分類: 通信{aiInput.TotalRequests:N0}件中、静的アセット・静的画面候補{aiInput.StaticExcluded:N0}件と除外キャッシュ{aiInput.DeferredExcluded:N0}件を対象外とし、採用済み・新規のリクエスト{aiInput.RequestPatternCount:N0}パターン・フォーム{aiInput.FormPatternCount:N0}パターンに集約しました。");
                if (aiInput.TruncatedPatternCount > 0)
                    Log($"AI入力の上限により{aiInput.TruncatedPatternCount:N0}パターンを省略しました。全件の証跡は実行フォルダーに保持しています。");
                if (!aiInput.RequiresAi && crawl.ExitCode == 0)
                {
                    Log($"AIで確認すべき動的パターンがないため、{ExplorationAiName}の画面探索を起動せず完了します。");
                    var fastObservations = Path.Combine(path, "fast-observed-requests.jsonl");
                    if (File.Exists(fastObservations) && new FileInfo(fastObservations).Length > 0)
                        await ImportAsync(fastObservations);
                    else
                        Project.Status = ProjectStatus.Ready;
                    if (crawl.Status != "completed") Project.Status = ProjectStatus.Partial;
                    SetRunProgress("完了", 100, "AI確認が必要な動的パターンはありませんでした。");
                    return;
                }
                Log(crawl.ExitCode == 0
                    ? $"代表パターンと、選択されていれば仕様書・操作手順を{ExplorationAiName}へ渡して機能理解を開始します。"
                    : $"高速クロールの部分データを{ExplorationAiName}へ渡し、代表パターンの確認を継続します。");
                SetRunProgress("AI確認", 65, $"{aiInput.RequestPatternCount:N0}件の要求パターンと{aiInput.FormPatternCount:N0}件のフォームを確認しています。");
            }

            aiWasStarted = true;
            var result = await RunExplorationAiAsync(path, progress);
            if (!result.Cancelled && result.ExitCode == 0 && await IsTransportFailureAsync(result.ResultPath))
            {
                Log("Playwright MCPの切断を検出しました。新しいMCPプロセスで探索を1回だけ自動再開します。");
                SetRunProgress("AI再接続", 70, "Playwright MCPを新しいプロセスで1回だけ再開しています。");
                await File.AppendAllTextAsync(Path.Combine(path, "prompt.md"),
                    Environment.NewLine + "前回のPlaywright MCP接続が切断されたため、新しいMCPセッションでの再開です。ai-input.jsonと既存のexploration-summary.jsonを読み、未確認の代表パターンから続行し、最終結果ファイルを置き換えてください。" + Environment.NewLine,
                    _runCancellation.Token);
                result = await RunExplorationAiAsync(path, progress);
            }
            if (result.Cancelled)
            {
                Project.Status = proxyDisconnected ? ProjectStatus.Failed : ProjectStatus.Paused;
                Log("探索を停止しました。");
            }
            else if (result.HumanInterventionPending)
            {
                Project.Status = ProjectStatus.WaitingForHuman;
                Log("手動操作が完了しないまま探索ジョブが終了しました。");
            }
            else
            {
                if (result.ExitCode != 0)
                    Log($"探索ジョブは終了コード {result.ExitCode} で終了しました。保存済みの観測結果を確認します。");
                var finalStatus = await LogFinalResultAsync(result.ResultPath);
                var observationFiles = new[]
                {
                    Path.Combine(path, "fast-observed-requests.jsonl"),
                    Path.Combine(path, "ai-observed-requests.jsonl"),
                    Path.Combine(path, "observed-requests.jsonl")
                }.Where(file => File.Exists(file) && new FileInfo(file).Length > 0).Distinct().ToArray();
                var importedEvidenceCount = 0;
                if (observationFiles.Length > 0)
                {
                    Log(string.Equals(finalStatus, "failed", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(finalStatus, "partial", StringComparison.OrdinalIgnoreCase)
                        || result.ExitCode != 0
                        ? "探索中に得られた部分的な観測リクエストを取り込みます。"
                        : "探索が完了しました。観測リクエストを取り込みます。");
                    SetRunProgress("結果取込", 90, "観測通信と診断所見を案件へ取り込んでいます。");
                    foreach (var observationFile in observationFiles)
                        importedEvidenceCount += await ImportAsync(observationFile);
                }
                var partialResult = crawl.Status != "completed" || string.IsNullOrWhiteSpace(finalStatus) || result.ExitCode != 0 ||
                    string.Equals(finalStatus, "failed", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(finalStatus, "partial", StringComparison.OrdinalIgnoreCase);
                if (partialResult && (importedEvidenceCount > 0 ||
                    string.Equals(finalStatus, "partial", StringComparison.OrdinalIgnoreCase)))
                {
                    Project.Status = ProjectStatus.Partial;
                    Log("取得済みの結果を部分結果として確認できます。通信記録の未取得など、探索結果の制約を確認してください。");
                }
                else if (partialResult)
                {
                    Project.Status = ProjectStatus.Failed;
                    Log($"{ExplorationAiName}が探索を技術エラーとして終了しました。探索結果の説明を確認してください。");
                }
                else if (observationFiles.Length == 0)
                {
                    Project.Status = ProjectStatus.Ready;
                    Log("探索は完了しましたが、観測リクエストファイルは生成されませんでした。");
                }
            }
        }
        catch (OperationCanceledException)
        {
            Project.Status = proxyDisconnected ? ProjectStatus.Failed : ProjectStatus.Paused;
            if (_currentRunDirectory is not null) await RecoverPartialObservationsAsync(_currentRunDirectory);
            Log("探索を停止しました。取得済みの記録を保存します。");
        }
        catch (Exception ex)
        {
            var recovered = _currentRunDirectory is null ? 0 : await RecoverPartialObservationsAsync(_currentRunDirectory);
            Project.Status = recovered > 0 ? ProjectStatus.Partial : ProjectStatus.Failed;
            SetRunProgress("実行失敗", RunProgress, "探索中に技術エラーが発生しました。実行ログを確認してください。");
            Log($"探索の起動または実行に失敗しました: {ex.Message}");
            if (_currentRunDirectory is not null) await WriteRecoveryRecordAsync(_currentRunDirectory, ex, recovered);
        }
        finally
        {
            try { await _fastCrawler.CloseAsync(); }
            catch (Exception ex) { Log($"探索ブラウザの終了に失敗しました: {ex.Message}"); Project.Status = ProjectStatus.Partial; }
            if (proxyMonitorCancellation is not null)
            {
                proxyMonitorCancellation.Cancel();
                if (proxyMonitor is not null) await proxyMonitor;
                proxyMonitorCancellation.Dispose();
            }
            if (proxy is not null)
            {
                try
                {
                    if (_currentRunDirectory is not null)
                    {
                        if (!aiWasStarted) await CaptureZapHarAsync(proxy, Path.Combine(_currentRunDirectory, "zap-fast-capture.har"), 0, "混在（通信ごとに記録）", "har-reference");
                        else if (aiPhaseStart is int start) await CaptureZapHarAsync(proxy, Path.Combine(_currentRunDirectory, "zap-ai-capture.har"), start, Project.ActiveRole);
                    }
                }
                finally
                {
                    try { await proxy.DisposeAsync(); }
                    catch (Exception ex) { Log($"探索用プロキシの終了処理に失敗しました: {ex.Message}"); }
                }
            }
            IsRunning = false;
            _runCancellation?.Dispose();
            _runCancellation = null;
            ResumeExplorationCommand.RaiseCanExecuteChanged();
            RefreshSummary();
            if (_currentRunDirectory is not null && File.Exists(Path.Combine(_currentRunDirectory, "fast-capture.har")))
            {
                var captured = await ProjectPaths.EvidenceAsync(Project, Path.Combine(_currentRunDirectory, "fast-capture.har"), "har");
                if (!Project.Inputs.Any(x => x.LocalPath == captured.LocalPath)) Project.Inputs.Add(captured with { Role = "混在（通信ごとに記録）" });
            }
            if (_currentRunDirectory is not null)
            {
                try
                {
                    await new RunObservationCollector().CollectAsync(_currentRunDirectory, Project.AllowedOrigins, Project.ActiveRole);
                    var status = Project.Status;
                    await RecoverPartialObservationsAsync(_currentRunDirectory);
                    if (status is ProjectStatus.Partial or ProjectStatus.Failed or ProjectStatus.Paused or ProjectStatus.WaitingForHuman) Project.Status = status;
                }
                catch (Exception ex) { Log($"通信記録の集約に失敗しました: {ex.Message}"); Project.Status = ProjectStatus.Partial; }
            }
            await RecordProjectChangeAsync();
            if (Project.Status is ProjectStatus.Ready or ProjectStatus.ReviewReady or ProjectStatus.Partial)
                SetRunProgress("完了", 100, Project.Status == ProjectStatus.Partial ? "部分結果を保存しました。制約を確認してください。" : "探索結果を保存しました。");
            else if (Project.Status == ProjectStatus.WaitingForHuman)
                SetRunProgress("手動操作待ち", RunProgress, "ブラウザで必要な操作を完了し、［手動操作完了］を押してください。");
            try { await RefreshRunHistoryAsync(); }
            catch (Exception ex) { Log($"探索実行履歴を更新できませんでした: {ex.Message}"); }
            await RefreshDataSummaryAsync();
        }
    }

    // 入力ドキュメントから探索の補助情報を抽出する。文書が変わっていれば再抽出し、
    // 失敗しても探索は継続する（AGENTS.md「入力ドキュメントの活用」）。
    private async Task EnsureDocumentHintsAsync(CancellationToken token)
    {
        var document = Project.ExplorationDocument;
        if (string.IsNullOrWhiteSpace(document.Content)) return;
        var sha = DocumentHintService.Sha256(document.Content);
        if (DocumentHintService.IsUsable(document.Hints, sha)) return;
        var provider = document.AiProvider;
        if (ApiDocumentAiRunner.FindLaunch(provider) is null)
        {
            Log($"[参考] {DocumentAiCatalog.DisplayName(provider)}が見つからないため、入力ドキュメントの補助情報（未到達エンドポイント・認証所在・優先規則）の抽出を省略します。");
            return;
        }
        if (provider == DocumentAiProvider.Glm && !AiConnectionChecker.GlmCredentialAvailable())
        {
            Log("[参考] GLMのAPIキーもZ.aiサインイン（zcode login）も確認できないため、入力ドキュメントの補助情報の抽出を省略します。");
            return;
        }
        SetRunProgress("文書補助情報", 5, "入力ドキュメントから探索の補助情報を抽出しています。");
        var directory = ProjectPaths.Resolve(Project,
            $"document-hints/{DateTimeOffset.Now:yyyyMMdd-HHmmss-fff}-{Guid.NewGuid():N}"[..31]);
        Directory.CreateDirectory(directory);
        await File.WriteAllTextAsync(Path.Combine(directory, "prompt.md"), DocumentHintService.BuildPrompt(Project));
        await File.WriteAllTextAsync(Path.Combine(directory, "hint-schema.json"), DocumentHintService.Schema);
        var (exitCode, cancelled, resultPath, failure) = await new DocumentHintRunner().RunAsync(directory, document,
            new Progress<string>(Log), token);
        if (cancelled) throw new OperationCanceledException(token);
        if (exitCode != 0 || !File.Exists(resultPath))
        {
            document.Hints = null;
            Log($"入力ドキュメントの補助情報の抽出に失敗しました（終了コード {exitCode}{(failure is null ? string.Empty : $"。原因: {failure}")}）。" +
                $"文書なしで探索を続行し、次回の実行で再試行します。詳細: {Path.Combine(directory, "document-hints-run.log")}");
            return;
        }
        document.Hints = await DocumentHintService.ParseAsync(await File.ReadAllTextAsync(resultPath), Project, sha);
        document.Hints.ExtractedBy =
            $"{DocumentAiCatalog.DisplayName(provider)}（{DocumentAiCatalog.NormalizeModel(provider, document.Model)}・推論{document.ReasoningLevel}）";
        var hints = document.Hints;
        Log($"文書補助情報: {hints.Status}。エンドポイント{hints.Endpoints.Length}件（高危先{hints.Endpoints.Count(x => x.Priority == "high")}件）・認証記載{hints.Authentication.Length}件・優先規則{hints.PriorityRules.Length}件・APIパラメーター{hints.ApiVariations.Length}件を抽出しました。");
        foreach (var limitation in hints.Limitations.Take(5)) Log($"文書補助情報の制約: {limitation}");
        await RecordProjectChangeAsync();
    }

    private async Task<string?> BuildPackageAsync()
    {
        if (!await TryEnsureProjectAsync()) return null;
        if (!Uri.TryCreate(Project.StartUrl, UriKind.Absolute, out var start) || start.Scheme is not ("http" or "https"))
        { Log("開始URLをhttpまたはhttpsの完全なURLで入力してください。"); return null; }
        if (string.IsNullOrWhiteSpace(Project.AllowedOrigins))
        { Log("診断を許可されたOriginを1件以上入力してください。"); return null; }
        if (RemoveStartUrlFromDeferredCache())
            Log("開始URLの除外キャッシュを解除し、AI確認対象へ戻しました。");
        await RecordProjectChangeAsync();
        return await _packageBuilder.BuildAsync(Project);
    }

    private void StopExploration()
    {
        Log("処理の停止を要求しました。");
        SetRunProgress("停止要求", RunProgress, "現在の処理を安全に停止しています。");
        _runCancellation?.Cancel();
        _fastCrawler.Stop();
        _runner.Stop();
        _zcodeRunner.Stop();
        _apiRunner.Stop();
    }

    private void ResumeExploration()
    {
        if (_currentRunDirectory is null) return;
        try { CodexExplorationRunner.Resume(_currentRunDirectory, AuthenticationWaiting ? AuthenticationRole : null); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException)
        { ShowProjectError?.Invoke(ex.Message); Log($"再開できませんでした: {ex.Message}"); return; }
        if (AuthenticationWaiting)
        {
            Project.ActiveRole = AuthenticationRole;
            if (!RoleOptions.Contains(AuthenticationRole))
            {
                Project.Roles += Environment.NewLine + AuthenticationRole;
                UpdateRoleOptions(refreshProject: true);
            }
            AuthenticationStatusText = "ユーザーの入力完了を受け付けました。ログイン状態と到達先を確認しています。";
        }
        Project.Status = ProjectStatus.Crawling;
        SetRunProgress("探索再開", Math.Max(65, RunProgress), $"{Project.ActiveRole}として同じブラウザセッションで探索を再開しています。");
        InterventionText = string.Empty;
        AuthenticationWaiting = false;
        RaisePropertyChanged(nameof(ResumeActionText));
        ResumeExplorationCommand.RaiseCanExecuteChanged();
        RefreshSummary();
        Log("手動操作の完了を探索ブラウザへ通知しました。到達先を確認して巡回を再開します。");
    }

    internal void OnInterventionDetected(string detail)
    {
        Project.Status = ProjectStatus.WaitingForHuman;
        SetRunProgress("手動操作待ち", Math.Max(65, RunProgress), "ブラウザで必要な操作を完了してください。");
        InterventionText = FormatIntervention(detail);
        PrepareAuthenticationIntervention(detail);
        ResumeExplorationCommand.RaiseCanExecuteChanged();
        RefreshSummary();
    }

    private async Task<string?> LogFinalResultAsync(string resultPath)
    {
        if (!File.Exists(resultPath)) return null;
        try
        {
            using var result = System.Text.Json.JsonDocument.Parse(await File.ReadAllTextAsync(resultPath));
            if (result.RootElement.TryGetProperty("summary", out var summary)) Log($"探索結果: {summary.GetString()}");
            var imported = await _findingImporter.ImportAsync(resultPath, _currentRunDirectory ?? string.Empty);
            if (imported.Count > 0)
            {
                foreach (var finding in imported)
                {
                    var fingerprint = CodexFindingImporter.Fingerprint(finding);
                    var existing = Project.Findings.FirstOrDefault(item => CodexFindingImporter.Fingerprint(item) == fingerprint);
                    if (existing is not null) Project.Findings.Remove(existing);
                    Project.Findings.Add(finding);
                }
                Log($"{ExplorationAiName}の所見を{imported.Count:N0}件取り込みました。深刻度・根拠・制約を確認してください。");
                RefreshSummary();
            }
            else if (result.RootElement.TryGetProperty("findings", out _))
                Log($"{ExplorationAiName}の結果に取り込み可能な診断所見はありませんでした。");
            return result.RootElement.TryGetProperty("status", out var status) ? status.GetString() : null;
        }
        catch { Log($"画面探索の結果ファイル: {resultPath}"); return null; }
    }

    private static async Task<bool> IsTransportFailureAsync(string resultPath)
    {
        if (!File.Exists(resultPath)) return false;
        try
        {
            using var result = System.Text.Json.JsonDocument.Parse(await File.ReadAllTextAsync(resultPath));
            var root = result.RootElement;
            var status = root.TryGetProperty("status", out var statusValue) ? statusValue.GetString() : null;
            var summary = root.TryGetProperty("summary", out var summaryValue) ? summaryValue.GetString() : null;
            return string.Equals(status, "failed", StringComparison.OrdinalIgnoreCase) &&
                   summary?.Contains("Transport", StringComparison.OrdinalIgnoreCase) == true;
        }
        catch { return false; }
    }

    private async Task<int> RecoverPartialObservationsAsync(string runDirectory)
    {
        var recovered = 0;
        foreach (var fileName in new[] { "fast-observed-requests.jsonl", "ai-observed-requests.jsonl", "observed-requests.jsonl" })
        {
            var path = Path.Combine(runDirectory, fileName);
            if (File.Exists(path) && new FileInfo(path).Length > 0) recovered += await ImportAsync(path);
        }
        if (recovered > 0) Log($"技術エラー前に保存された観測データ{recovered:N0}件を部分結果として復旧しました。");
        return recovered;
    }

    private async Task WriteRecoveryRecordAsync(string runDirectory, Exception error, int recoveredCount)
    {
        try
        {
            var record = new
            {
                recordedAt = DateTimeOffset.Now,
                phase = RunPhase,
                progress = RunProgress,
                errorType = error.GetType().Name,
                error = error.Message,
                recoveredObservationCount = recoveredCount,
                retry = "実行履歴からこの設定で再試行できます。"
            };
            await File.WriteAllTextAsync(Path.Combine(runDirectory, "scopepilot-recovery.json"),
                JsonSerializer.Serialize(record, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception writeError) { Log($"復旧記録を保存できませんでした: {writeError.Message}"); }
    }

    private static string FormatIntervention(string detail)
    {
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(detail);
            var root = document.RootElement;
            var reason = root.TryGetProperty("reason", out var reasonValue) ? reasonValue.GetString() : null;
            var instruction = root.TryGetProperty("instruction", out var instructionValue) ? instructionValue.GetString() : null;
            var page = root.TryGetProperty("page", out var pageValue) ? pageValue.GetString() : null;
            return $"手動操作が必要です\n理由: {reason}\nページ: {page}\n操作: {instruction}";
        }
        catch { return detail; }
    }

    private bool IsConfigurationValid()
    {
        if (IsApiMode)
        {
            try { ApiDocumentService.Validate(Project); return true; }
            catch (InvalidDataException) { return false; }
        }
        try { AuthenticationFlow.ValidateTarget(Project); }
        catch (InvalidDataException) { return false; }
        return Uri.TryCreate(Project.StartUrl, UriKind.Absolute, out var start) && start.Scheme is "http" or "https" &&
            !string.IsNullOrWhiteSpace(Project.AllowedOrigins);
    }

    private void GenerateCandidates()
    {
        Project.Status = ProjectStatus.Organizing;
        var previousDecisions = Project.Candidates
            .GroupBy(x => NormalizeCandidatePattern(x.Pattern), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.Last().Selected, StringComparer.OrdinalIgnoreCase);
        var adopted = Project.AdoptedCandidatePatterns.Select(NormalizeCandidatePattern)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var deferred = Project.DeferredCandidatePatterns.Select(NormalizeCandidatePattern)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var candidates = _selector.Select(Project.Requests, Project.Guidelines ?? new GuidelineSelectionOptions());
        Project.Candidates.Clear();
        foreach (var candidate in candidates)
        {
            var key = NormalizeCandidatePattern(candidate.Pattern);
            var explicitlyDeferred = deferred.Contains(key);
            if (previousDecisions.TryGetValue(key, out var previousSelected)) candidate.Selected = previousSelected;
            else if (adopted.Contains(key)) candidate.Selected = true;
            else if (explicitlyDeferred) candidate.Selected = false;
            candidate.Decision = candidate.Selected ? "候補" : explicitlyDeferred ? "除外キャッシュ" : "除外候補";
            Project.Candidates.Add(candidate);
        }
        RefreshFilteredCandidates();
        Project.Status = candidates.Count > 0 ? ProjectStatus.ReviewReady : ProjectStatus.Ready;
        Log($"{Project.Requests.Count:N0}件から{candidates.Count:N0}個の代表パターンを生成しました。"); RefreshSummary();
    }

    private async Task ExportBurpScopeAsync()
    {
        if (!await TryEnsureProjectAsync()) return;
        if (IsZapTarget) { await ExportZapAsync(); return; }
        if (IsApiMode)
        {
            try
            {
                var export = await _apiExport.ExportAsync(Project);
                await RecordProjectChangeAsync();
                BurpScopeRegexes.Clear();
                CopyNextBurpRegexCommand.RaiseCanExecuteChanged();
                LastBurpExportDirectory = export.Directory;
                BurpHandoffStatus = $"採用{export.RequestCount:N0}件のHTTPリクエストを出力しました。requests内の.httpをBurp Repeaterへ貼り付け、URLに合わせてTLS・Host・Portを設定してください。";
                Log($"APIリクエストを出力しました: {export.Directory}");
                await RefreshDataSummaryAsync();
            }
            catch (Exception ex) { Log($"APIリクエストの出力に失敗しました: {ex.Message}"); }
            return;
        }
        try
        {
            var result = await _burpScopeExport.ExportAsync(Project);
            await RecordProjectChangeAsync();
            BurpScopeRegexes.Clear();
            foreach (var regex in result.CombinedRegexes) BurpScopeRegexes.Add(regex);
            LastBurpExportDirectory = result.Directory;
            _nextBurpRegexIndex = 0;
            SelectedBurpScopeRegex = BurpScopeRegexes.FirstOrDefault();
            BurpHandoffStatus = $"採用{result.SelectedCount:N0}候補を{result.CombinedRegexes.Length:N0}個の登録用正規表現へ集約しました。［次をコピー］からBurpへ順番に登録してください。";
            CopyNextBurpRegexCommand.RaiseCanExecuteChanged();
            Log($"Burp Scope出力を生成しました: 採用{result.SelectedCount:N0}件 / {result.Directory}");
            Log($"Community EditionではBurpのTarget > Scopeへburp-scope-combined-regex.txtの{result.CombinedRegexes.Length:N0}行を手動登録してください。");
            await RefreshDataSummaryAsync();
        }
        catch (Exception ex) { Log($"Burp Scope出力に失敗しました: {ex.Message}"); }
    }

    private void CopyNextBurpRegex()
    {
        if (BurpScopeRegexes.Count == 0) return;
        var index = Math.Clamp(_nextBurpRegexIndex, 0, BurpScopeRegexes.Count - 1);
        var regex = BurpScopeRegexes[index];
        try
        {
            System.Windows.Clipboard.SetText(regex);
            SelectedBurpScopeRegex = regex;
            BurpHandoffStatus = $"{index + 1:N0}/{BurpScopeRegexes.Count:N0} をコピーしました。BurpのTarget > Scope > Include in scopeでURL regexとして追加してください。";
            _nextBurpRegexIndex = (index + 1) % BurpScopeRegexes.Count;
        }
        catch (Exception ex) { Log($"正規表現をクリップボードへコピーできませんでした: {ex.Message}"); }
    }

    private void OpenBurpExportFolder()
    {
        if (!string.IsNullOrWhiteSpace(LastBurpExportDirectory)) OpenRunPath(LastBurpExportDirectory, "Burp連携フォルダー");
    }

    private void ResetBurpHandoff()
    {
        SelectedApiRequest = null;
        BurpScopeRegexes.Clear();
        LastBurpExportDirectory = IsZapTarget ? _dataManagement.FindLatestZapDirectory(Project)
            : _dataManagement.FindLatestBurpExportDirectory(Project, Project.Mode);
        SelectedBurpScopeRegex = null;
        _nextBurpRegexIndex = 0;
        BurpHandoffStatus = IsZapTarget ? "採用対象を確認してZAPパッケージを出力してください。診断開始には選択中のロールのHARが必要です。"
            : IsApiMode ? "APIリクエスト画面で下書きを確認・採用してから［HTTPリクエストを出力］を押してください。" : "Burp Scope出力を生成すると、登録用の正規表現をここで案内します。";
        CopyNextBurpRegexCommand.RaiseCanExecuteChanged();
    }

    private async Task ExportFindingsAsync()
    {
        if (!await TryEnsureProjectAsync()) return;
        try
        {
            var result = await _findingReport.ExportAsync(Project);
            Log($"案件レポートを出力しました: 採用候補{result.CandidateCount:N0}件、所見{result.FindingCount:N0}件 / {result.Directory}");
            Log($"日本語Markdown: {result.MarkdownPath} / ツール警告{result.AlertGroupCount}種類・ロール別");
            RememberMarkdownReport(result.MarkdownPath);
            if (result.UntranslatedGroupCount > 0) Log($"日本語解説が未登録の警告: {result.UntranslatedGroupCount}件。検証済み原文を掲載しています。");
            if (result.UnavailableEvidenceCount > 0) Log($"原本詳細を掲載できない発生記録: {result.UnavailableEvidenceCount}件。Markdownの出典検証欄を確認してください。");
            Log($"JSON: {result.JsonPath}");
            Log($"HTML: {result.HtmlPath}");
            Log($"候補作業表: {result.CandidateChecklistPath}");
            await RefreshDataSummaryAsync();
            OpenRunPath(result.Directory, "レポート出力フォルダー");
        }
        catch (Exception ex) { Log($"案件レポートの出力に失敗しました: {ex.Message}"); }
    }

    private void UpdateCandidateDecisionCache(DiagnosticCandidate candidate)
    {
        var adopted = Project.AdoptedCandidatePatterns.Select(NormalizeCandidatePattern)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var deferred = Project.DeferredCandidatePatterns.Select(NormalizeCandidatePattern)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var key = NormalizeCandidatePattern(candidate.Pattern);
        if (!Project.ExplicitlyReviewedCandidatePatterns.Select(NormalizeCandidatePattern).Contains(key, StringComparer.OrdinalIgnoreCase))
            Project.ExplicitlyReviewedCandidatePatterns.Add(key);
        if (candidate.Selected) { adopted.Add(key); deferred.Remove(key); candidate.Decision = "候補"; }
        else { deferred.Add(key); adopted.Remove(key); candidate.Decision = "除外キャッシュ"; }
        Project.AdoptedCandidatePatterns.Clear();
        foreach (var item in adopted.Order(StringComparer.OrdinalIgnoreCase)) Project.AdoptedCandidatePatterns.Add(item);
        Project.DeferredCandidatePatterns.Clear();
        foreach (var item in deferred.Order(StringComparer.OrdinalIgnoreCase)) Project.DeferredCandidatePatterns.Add(item);
    }

    private bool RemoveStartUrlFromDeferredCache()
    {
        if (!Uri.TryCreate(Project.StartUrl, UriKind.Absolute, out _)) return false;
        var startPattern = NormalizeCandidatePattern($"GET {Project.StartUrl}");
        if (Project.ExplicitlyReviewedCandidatePatterns.Select(NormalizeCandidatePattern)
            .Contains(startPattern, StringComparer.OrdinalIgnoreCase)) return false;
        var removed = false;
        for (var index = Project.DeferredCandidatePatterns.Count - 1; index >= 0; index--)
        {
            if (!NormalizeCandidatePattern(Project.DeferredCandidatePatterns[index]).Equals(startPattern, StringComparison.OrdinalIgnoreCase)) continue;
            Project.DeferredCandidatePatterns.RemoveAt(index);
            removed = true;
        }
        return removed;
    }

    private static string NormalizeCandidatePattern(string value)
    {
        var separator = value.IndexOf(' ');
        if (separator <= 0 || separator == value.Length - 1) return value.Trim();
        var method = value[..separator].ToUpperInvariant();
        var url = value[(separator + 1)..].Trim();
        return Uri.TryCreate(url, UriKind.Absolute, out _)
            ? $"{method} {UrlPatternNormalizer.NormalizeForSelection(url)}"
            : value.Trim();
    }

    private void SetRunProgress(string phase, int percent, string detail)
    {
        RunPhase = phase;
        RunProgress = Math.Clamp(percent, 0, 100);
        RunProgressDetail = detail;
    }

    private void UpdateProgressFromLog(string message)
    {
        var match = Regex.Match(message, @"PAGE\s+(\d+)/(\d+)\s+REQUESTS\s+(\d+)/(\d+)", RegexOptions.IgnoreCase);
        if (!match.Success) return;
        var page = int.Parse(match.Groups[1].Value);
        var maxPages = Math.Max(1, int.Parse(match.Groups[2].Value));
        var requests = int.Parse(match.Groups[3].Value);
        var maxRequests = Math.Max(1, int.Parse(match.Groups[4].Value));
        var ratio = Math.Max((double)page / maxPages, (double)requests / maxRequests);
        SetRunProgress("高速クロール", 10 + (int)Math.Round(Math.Min(1, ratio) * 45),
            $"ページ {page:N0}/{maxPages:N0}、通信 {requests:N0}/{maxRequests:N0}");
    }

    private void Log(string message) { Logs.Insert(0, $"{DateTime.Now:HH:mm:ss}  {message}"); while (Logs.Count > 500) Logs.RemoveAt(Logs.Count - 1); RaisePropertyChanged(nameof(ConsoleText)); RaisePropertyChanged(nameof(LatestLog)); }
    private void RefreshSummary() { RaisePropertyChanged(nameof(StatusText)); RaisePropertyChanged(nameof(SummaryText)); RaisePropertyChanged(nameof(RequestSummary)); RaisePropertyChanged(nameof(CandidateSummary)); RaisePropertyChanged(nameof(FindingSummary)); RaisePropertyChanged(nameof(RunHistorySummary)); RefreshModeProperties(); }
}
