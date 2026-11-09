/** Compatibility facade and composition root for one open case workspace.
 * Command/query ports connect the extracted services; public API signatures remain stable.
 */
import { RuntimeProfileService } from './services/runtime-profile.ts';
import { SessionService } from './services/session-service.ts';
import { ExplorationService } from './services/exploration-service.ts';
import { GuidelineExecutionService } from './services/guideline-execution-service.ts';
import { JobOrchestrator } from './services/job-orchestrator.ts';
import { FindingService } from './services/finding-service.ts';
import { ReportService } from './services/report-service.ts';
import { TrafficService } from './services/traffic-service.ts';
import { ApiImportService } from './services/api-import-service.ts';
import { ExecutionContext } from './services/execution-context.ts';
import { SessionVault } from './services/session-vault.ts';
import { RepeaterService } from './services/repeater-service.ts';
import { FuzzerService } from './services/fuzzer-service.ts';
import { SequencerService } from './services/sequencer-service.ts';
import { OastService } from './services/oast-service.ts';
import { WebSocketService } from './services/web-socket-service.ts';
import type { ToolWorkspacePort } from './services/tool-ports.ts';
import { CaseSessionContext } from './services/case-session-context.ts';
import { CaseService } from './services/case-service.ts';
import { AuthorizationService } from './services/authorization-service.ts';
import { PlanService } from './services/plan-service.ts';
import { requirePermission } from './services/authorization-policy.ts';
import { EventPublisher } from './services/event-publisher.ts';
import { EvidenceService } from './services/evidence-service.ts';
import { RunLifecycleService } from './services/run-lifecycle-service.ts';
import type { BaselineFlowDeps, CreateCaseInput, GrantAuthorizationInput, ExploreRunInput, ExploreRunResult, InteractiveDiagnosticTrack, InteractiveDiagnosticItemInput, InteractiveDiagnosticRunInput, InteractiveDiagnosticItemResult, SequencerTokenSource, SequencerSessionRecord, SequencerSessionResult, ActiveScanRunResult, ActiveScanPayloadVerification, DiagnosticRouteResult, GuidelineRouteResult, ActiveScanExecutionEvent, ActiveScanExecutionControl, ImportNucleiResultsInput, ImportNucleiResultsResult } from './baseline-contracts.ts';
export type { BaselineFlowDeps, CreateCaseInput, GrantAuthorizationInput, ExploreRunInput, ExploreRunResult, InteractiveDiagnosticTrack, InteractiveDiagnosticItemInput, InteractiveDiagnosticRunInput, InteractiveDiagnosticItemResult, ActiveScanRunResult, ActiveScanPayloadVerification, DiagnosticRouteResult, GuidelineRouteResult, ActiveScanExecutionEvent, ActiveScanExecutionControl, ImportNucleiResultsInput, ImportNucleiResultsResult } from './baseline-contracts.ts';
import { domainError, hashStable, type AuthorizationRecord, type BaselineFlowEvent, type CaseRecord, type EngineCapabilitySnapshot, type ExecutionPlan, type Finding, type OperatorProfile, type OperatorPermission, type PageObservation, type PlanConfirmation, type ReportArtifact, type ScanCandidate, type ScopeLimits, type DocumentAuthHint, type DocumentAuthHintEntry, type DocumentPriorityRule, type DocumentParameterHint, type DocumentParameterHintEntry } from '@scopepilot2/contracts';
import { ScopePolicy } from '../domain/scope-policy.ts';
import { BreakQueue, decideIntercept, type BreakItem, type BreakQueueEvent, type InterceptDecision } from '../domain/proxy-intercept.ts';
import { SiteMapProjector } from '../domain/target-logger.ts';
import { type ComparisonOutcome } from '../domain/business-logic.ts';
import { type AuthBypassCheckListItem, type AuthBypassCheckSummary } from '../domain/auth-bypass.ts';
import { type ThemeCheckSummary } from '../domain/zap-unsupported.ts';
import { type LoginFlowStep } from '../domain/authentication-session.ts';
import { type FuzzPosition, type PayloadSetRegistration } from '../domain/fuzzer.ts';
import { applicableSessionCookies, summarizeResponse, type RepeaterDraft, type SendAttemptRecord } from '../domain/repeater.ts';
import { type OastProtocol, type ProviderEvent } from '../domain/oast.ts';
import { checkAuthorityScope, negotiateTransport, transportCapability, transportEvidence, validateHeaderValues, validatePseudoHeaders } from '../domain/advanced-transport.ts';
import { buildDomCandidate, domEvidenceProjection } from '../domain/dom-investigation.ts';
import { checkCompatibility, respondToSecretRead, verifyExtensionManifest, type ExtensionManifest } from '../domain/product-api.ts';
import type { LoginSessionCookie } from '../ports/engines.ts';
export class BaselineFlowService {
    private readonly executionContext: ExecutionContext;
    private readonly sessionVault = new SessionVault();
    private readonly sessionService: SessionService;
    private readonly explorationService: ExplorationService;
    private readonly guidelineExecutionService: GuidelineExecutionService;
    private readonly jobOrchestrator: JobOrchestrator;
    private readonly findingService: FindingService;
    private readonly reportService: ReportService;
    private readonly trafficService: TrafficService;
    private readonly apiImportService: ApiImportService;
    private readonly repeaterService: RepeaterService;
    private readonly fuzzerService: FuzzerService;
    private readonly sequencerService: SequencerService;
    private readonly oastService: OastService;
    private readonly webSocketService: WebSocketService;
    private readonly caseContext = new CaseSessionContext();
    private readonly caseService: CaseService;
    private readonly authorizationService: AuthorizationService;
    private readonly planService: PlanService;
    private readonly eventPublisher = new EventPublisher();
    private readonly evidenceService: EvidenceService;
    private readonly runLifecycle: RunLifecycleService;
    /** proxy の break queue (design/f02)。deadline 経過は既定で drop (暗黙 forward しない)。 */
    private readonly breakQueue = new BreakQueue(100);
    /** CA profile の信頼登録状態 (design/24。既定は未登録)。 */
    private caProfileTrusted = false;
    /** 読み込み済み extension (design/f20)。manifest の署名検証を通過したもののみ。 */
    private readonly loadedExtensions: readonly {
        extensionId: string;
        version: string;
        permissions: readonly string[];
        apiRange: readonly string[];
    }[] = [];
    private readonly deps: BaselineFlowDeps;
    constructor(deps: BaselineFlowDeps) {
        this.deps = deps;
        this.evidenceService = new EvidenceService(deps.evidence);
        this.runLifecycle = new RunLifecycleService(deps.runSink);
        this.executionContext = new ExecutionContext(deps.initialFindings ?? []);
        this.sessionService = new SessionService(deps, {}, this.eventPublisher, this.sessionVault);
        this.explorationService = new ExplorationService(deps, {
            requireMatchingConfirmation: (...args) => this.requireMatchingConfirmation(...args),
            currentCase: (...args) => this.currentCase(...args),
            isPrioritizedUrl: (...args) => this.isPrioritizedUrl(...args),
            recordObservedExchange: (...args) => this.recordObservedExchange(...args),
        }, this.eventPublisher, this.executionContext, this.sessionVault, this.caseContext, this.evidenceService, this.runLifecycle);
        this.guidelineExecutionService = new GuidelineExecutionService(deps, {
            currentCase: (...args) => this.currentCase(...args),
            currentAuthorization: (...args) => this.currentAuthorization(...args),
            runSequencerSession: (...args) => this.runSequencerSession(...args),
            importApiSpec: (...args) => this.importApiSpec(...args),
        }, this.eventPublisher, this.executionContext, this.sessionVault, this.evidenceService);
        this.jobOrchestrator = new JobOrchestrator(deps, {
            requireMatchingConfirmation: (...args) => this.requireMatchingConfirmation(...args),
            currentCase: (...args) => this.currentCase(...args),
            currentAuthorization: (...args) => this.currentAuthorization(...args),
            persistFindings: (...args) => this.persistFindings(...args),
            verifyFindingExecution: (...args) => this.verifyFindingExecution(...args),
            runZapUnsupportedCheck: (...args) => this.runZapUnsupportedCheck(...args),
            importNucleiResults: (...args) => this.importNucleiResults(...args),
        }, this.eventPublisher, this.executionContext, this.sessionVault, this.evidenceService, this.runLifecycle);
        this.findingService = new FindingService(deps, {
            currentCase: (...args) => this.currentCase(...args),
        }, this.eventPublisher, this.executionContext, this.evidenceService);
        this.reportService = new ReportService(deps, {
            currentCase: (...args) => this.currentCase(...args),
        }, this.eventPublisher, this.executionContext, this.caseContext);
        this.trafficService = new TrafficService(deps, {}, this.eventPublisher, this.executionContext);
        this.apiImportService = new ApiImportService(deps, {
            currentCase: (...args) => this.currentCase(...args),
        }, this.eventPublisher, this.executionContext);
        const runtime = new RuntimeProfileService(deps.runtimeProfile);
        const toolPorts: ToolWorkspacePort = {
            currentCase: () => this.caseService.currentCase(),
            sessionForRole: role => this.sessionVault.roleSessionCookies.get(role),
            recordObservedExchange: (summary, at, source) => this.recordObservedExchange(summary, at, source),
        };
        this.repeaterService = new RepeaterService(deps, toolPorts, this.eventPublisher, runtime);
        this.fuzzerService = new FuzzerService(deps, toolPorts, this.eventPublisher, runtime);
        this.sequencerService = new SequencerService(deps, toolPorts, this.eventPublisher, runtime);
        this.oastService = new OastService(deps, toolPorts, this.eventPublisher, runtime);
        this.webSocketService = new WebSocketService(deps, toolPorts, this.eventPublisher, runtime);
        this.caseService = new CaseService(deps, this.caseContext, this.eventPublisher);
        this.authorizationService = new AuthorizationService(deps, this.caseContext, { currentCase: () => this.caseService.currentCase() }, this.evidenceService, this.eventPublisher);
        this.planService = new PlanService(deps, this.caseContext, {
            currentCase: () => this.caseService.currentCase(),
            currentAuthorization: () => this.authorizationService.currentAuthorization(),
            registerConfirmation: confirmation => this.caseService.registerConfirmation(confirmation),
            isConfirmationInvalidated: id => this.caseService.isConfirmationInvalidated(id),
            invalidationReason: id => this.caseService.invalidationReason(id),
        }, this.eventPublisher);
    }
    /**
     * 案件ワークスペースを開くとき、SQLite に保存済みの正本を in-memory aggregate へ戻す。
     * 外部入力用 API ではなく desktop/CLI の構成層だけが使用する。復元時に新しい監査 event は
     * 作らず、以後の更新・実行は通常 command と同じ検証を通す。
     */
    restoreWorkspace(record: CaseRecord, authorization?: AuthorizationRecord): void { return this.caseService.restoreWorkspace(record, authorization); }
    events(): readonly BaselineFlowEvent[] { return this.eventPublisher.events(); }
    /** 現在の全所見 (作成順)。UI/CLI の organizer 表示用。 */
    listFindings(): readonly Finding[] { return this.findingService.listFindings(); }
    private persistFindings(findings: readonly Finding[]): void { return this.findingService.persistFindings(findings); }
    /** site map (観測済み page の一覧・初回観測順)。 */
    listObservations(): readonly PageObservation[] { return this.explorationService.listObservations(); }
    /** 探索で scope 拒否された URL (開示用)。 */
    listDeniedUrls(): readonly {
        url: string;
        reason: string;
    }[] { return this.explorationService.listDeniedUrls(); }
    /**
     * 入力文書由来の document hint の登録 (AGENTS.md 入力ドキュメントの活用)。
     * 文書の記載は観測事実ではないため、hint 単独では観測・所見を作らず、
     * 計画構築時に許可 Origin 内の URL だけ追加開始点として統合する。
     * acceptedUrlCount は現在の案件 scope で許可された URL 数 (監査にも記録)。
     */
    registerDocumentHints(operator: OperatorProfile, input: {
        readonly documentLabel: string;
        readonly urls: readonly string[];
    }): {
        documentLabel: string;
        urlCount: number;
        acceptedUrlCount: number;
    } { return this.caseService.registerDocumentHints(operator, input); }
    /** 登録済み document hints (文書 label と URL の一覧)。 */
    listDocumentHints(): readonly {
        documentLabel: string;
        urls: readonly string[];
    }[] { return this.caseService.listDocumentHints(); }
    /**
     * 入力文書由来の認証情報 hint の登録 (AGENTS.md・design/08 AuthMethod)。
     * ロール・認証方式・文書内の所在のみを扱い、秘密値は受け付けない
     * (「文書の記載」であり観測事実ではないため未確認として表示する)。
     */
    registerDocumentAuthHints(operator: OperatorProfile, input: {
        readonly documentLabel: string;
        readonly entries: readonly DocumentAuthHint[];
    }): {
        documentLabel: string;
        entryCount: number;
    } { return this.caseService.registerDocumentAuthHints(operator, input); }
    /** 登録済みの認証情報 hint (文書 label・所在のみ。値は保持しない)。 */
    listDocumentAuthHints(): readonly DocumentAuthHintEntry[] { return this.caseService.listDocumentAuthHints(); }
    /**
     * 入力文書由来の優先付け規則の登録 (AGENTS.md: クローリング結果の優先付け)。
     * 個人情報に類するもの (pii)・決済に関わるもの (payment) を高優先として探索の
     * 処理順に反映する。規則は URL の部分一致。
     */
    registerDocumentPriorityHints(operator: OperatorProfile, input: {
        readonly documentLabel: string;
        readonly rules: readonly DocumentPriorityRule[];
    }): {
        documentLabel: string;
        ruleCount: number;
    } { return this.caseService.registerDocumentPriorityHints(operator, input); }
    /** 登録済みの優先付け規則の一覧。 */
    listDocumentPriorityRules(): readonly DocumentPriorityRule[] { return this.caseService.listDocumentPriorityRules(); }
    /**
     * 入力文書由来の API parameter バリエーションの登録 (AGENTS.md)。
     * 文書の記載は未確認のため A07 の fuzzer positions の「参照」としてのみ表示し、
     * 自動的には適用しない。
     */
    registerDocumentParameterHints(operator: OperatorProfile, input: {
        readonly documentLabel: string;
        readonly parameters: readonly DocumentParameterHint[];
    }): {
        documentLabel: string;
        parameterCount: number;
    } { return this.caseService.registerDocumentParameterHints(operator, input); }
    /** 登録済みの parameter バリエーション (未確認参照)。 */
    listDocumentParameterHints(): readonly DocumentParameterHintEntry[] { return this.caseService.listDocumentParameterHints(); }
    /** URL が優先付け規則に一致するか (探索の処理順用)。 */
    private isPrioritizedUrl(canonical: string): boolean { return this.caseService.isPrioritizedUrl(canonical); }
    /** 観測通信の記録 (traffic log と endpoint 集約の両方に入れる)。 */
    private recordObservedExchange(summary: {
        url: string;
        method: string;
        status: number;
        contentType: string;
    }, at: string, source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer'): void { return this.trafficService.recordObservedExchange(summary, at, source); }
    /**
     * HTTP 通信一覧 (design/f03)。limit は 1〜500。総数が 100,000 を超えると一覧ではなく
     * 集約 (summary) mode になる (F03-UT-005/006)。list mode は最近の通信から返す。
     */
    listTraffic(limit: number): {
        mode: 'list' | 'summary';
        total: number;
        entries?: readonly {
            exchangeId: string;
            url: string;
            method: string;
            status: number;
            contentType: string;
            at: string;
            source: string;
        }[];
    } { return this.trafficService.listTraffic(limit); }
    /** endpoint 集約 (origin/path/method/content-type/status。query は同一視・F03-UT-004)。 */
    listSiteMapEndpoints(): readonly ReturnType<SiteMapProjector['list']>[number][] { return this.trafficService.listSiteMapEndpoints(); }
    /** break queue の一覧 (deadline 経過を反映してから返す)。 */
    listBreakItems(): readonly BreakItem[] {
        this.breakQueue.expireDeadlines(this.deps.clock.now().getTime());
        return this.breakQueue.list();
    }
    breakQueueEvents(): readonly BreakQueueEvent[] {
        return this.breakQueue.recordedEvents();
    }
    /**
     * break queue への受付。実運用では proxy adapter が呼ぶ経路。fixture/UI 検証では
     * 画面から入れる (messageReference は原本の参照、秘密値は持たない)。
     */
    enqueueBreakItem(operator: OperatorProfile, input: {
        readonly direction: 'request' | 'response';
        readonly messageReference: string;
        readonly holdMs?: number;
    }): BreakItem {
        this.requirePermission(operator, 'run.manage');
        if (input.messageReference.trim() === '') {
            throw domainError('ValidationFailed', 'messageReference must not be empty');
        }
        const nowMs = this.deps.clock.now().getTime();
        return this.breakQueue.enqueue({
            itemId: this.deps.ids.next('break'),
            messageReference: input.messageReference,
            direction: input.direction,
            receivedAtMs: nowMs,
            deadlineMs: nowMs + (input.holdMs ?? 60000),
            originalRequestHash: hashStable('scopepilot2.request', input.messageReference),
        });
    }
    /** 保持中 item の判断。scope 外 URL への編集は forward されず reject される (F02-UT-004)。 */
    decideBreakItem(operator: OperatorProfile, itemId: string, edited: {
        readonly requestHash: string;
        readonly targetUrl: string;
    }): InterceptDecision {
        this.requirePermission(operator, 'run.manage');
        const caseRecord = this.currentCase();
        return decideIntercept(this.breakQueue, itemId, edited, caseRecord.scope);
    }
    /**
     * 業務ロジック (認可・role 差分) 検証の実行 (design/f17)。
     * 認可が CrossRoleTest を許可していること・対象 URL が scope 内であること。
     * 観測は role ごとの session (refresh 済みか) から作り、欠落は inconclusive として
     * 成功/失敗を推測しない (F17-UT-003)。restore 不一致は全体を成功扱いしない (F17-UT-004)。
     */
    async runBusinessLogicCheck(operator: OperatorProfile, input: {
        readonly roles: readonly string[];
        readonly targetUrl: string;
        readonly expectation: {
            readonly expression: string;
            readonly args: readonly unknown[];
        };
    }): Promise<{
        checkId: string;
        roles: readonly string[];
        matrix: {
            readonly evidenceSeparated: boolean;
        };
        observations: readonly {
            role: string;
            observation: string | null;
        }[];
        comparison: {
            readonly outcome: ComparisonOutcome;
        };
        restore: {
            readonly outcome: 'restored' | 'restore-failed';
        };
        status: 'pass' | 'fail' | 'not-run';
        reason?: string;
    }> { return this.guidelineExecutionService.runBusinessLogicCheck(operator, input); }
    listBusinessLogicChecks(): readonly {
        checkId: string;
        roles: readonly string[];
        targetUrl: string;
        status: string;
        comparison: string;
        restore: string;
        executedAt: string;
    }[] { return this.guidelineExecutionService.listBusinessLogicChecks(); }
    /**
     * ZAP非対応テーマ1「認証回避・強制ブラウジング」の代替検証 (作業用 Excel
     * 「ZAP非対応項目と代替検証手段」No.1、IPA手順「認証回避」相当)。
     * runLogin 済み role の session を使い、認証用 cookie の書き換え (空値・削除)・
     * 未認証での直接アクセス・password 書き換え再ログインの応答を観測する。
     * cookie 値・秘密値・応答本文は監査・応答へ出さない (marker は transient に判定)。
     */
    async runAuthBypassCheck(operator: OperatorProfile, input: {
        readonly role: string;
        readonly targetUrls?: readonly string[];
        readonly authCookieNames?: readonly string[];
        readonly includeLoginVariants?: boolean;
        readonly secretValues?: Readonly<Record<string, string>>;
        readonly loginBaseUrl?: string;
    }): Promise<AuthBypassCheckSummary> { return this.guidelineExecutionService.runAuthBypassCheck(operator, input); }
    listAuthBypassChecks(): readonly AuthBypassCheckListItem[] { return this.guidelineExecutionService.listAuthBypassChecks(); }
    /**
     * ZAP非対応テーマ代替検証 (テーマ2以降の Top10 対象分)。テーマごとの handler が
     * 既存 port (browser・login 実行器・repeater transport・fuzz transport・DOM 観測・
     * nuclei) を使い、判定は domain の純関数に任せる。cookie 値・秘密値・応答本文は
     * 監査・応答へ出さない (本文の検査は transient、記録は hash・件数のみ)。
     */
    async runZapUnsupportedCheck(operator: OperatorProfile, input: {
        readonly themeNo: string;
        readonly role?: string;
        readonly targetUrls?: readonly string[];
        readonly params?: Readonly<Record<string, string>>;
        readonly secretValues?: Readonly<Record<string, string>>;
    }): Promise<ThemeCheckSummary> { return this.guidelineExecutionService.runZapUnsupportedCheck(operator, input); }
    listZapUnsupportedChecks(): readonly {
        checkId: string;
        themeNo: string;
        role: string | null;
        status: string;
        totalRequests: number;
        skipped?: readonly string[];
        executedAt: string;
    }[] { return this.guidelineExecutionService.listZapUnsupportedChecks(); }
    /** Execute an AI-proposed plan only after the operator has previewed and confirmed it. */
    async runInteractiveDiagnostics(operator: OperatorProfile, input: InteractiveDiagnosticRunInput): Promise<{
        results: readonly InteractiveDiagnosticItemResult[];
    }> { return this.guidelineExecutionService.runInteractiveDiagnostics(operator, input); }
    /** login flow の登録 (design/f09)。step 構成は domain 検証 (上限 10・allowlist・fill は secret 参照必須)。 */
    registerLoginFlow(operator: OperatorProfile, input: {
        readonly role: string;
        readonly flowVersion: string;
        readonly steps: readonly LoginFlowStep[];
    }): {
        role: string;
        stepCount: number;
        secretReferences: readonly {
            flowVersion: string;
            secretReference: string;
        }[];
    } { return this.sessionService.registerLoginFlow(operator, input); }
    /**
     * 登録済み login flow の実行 (design/f09 §4)。認証済みなら session cookie を
     * role に保存し、以後の探索 (runExploration の role 指定) で使えるようにする。
     * 秘密値は実行中のみ executor へ渡し、監査 event には参照のみ残す (F09-UT-006)。
     */
    async runLogin(operator: OperatorProfile, input: {
        readonly role: string;
        readonly baseUrl: string;
        readonly secretValues: Readonly<Record<string, string>>;
        readonly expectedUrlPrefix: string;
        readonly proxyServer?: string;
    }): Promise<{
        role: string;
        authenticated: boolean;
        finalUrl: string;
        cookieNames: readonly string[];
        sharedCookieNames: boolean;
    }> { return this.sessionService.runLogin(operator, input); }
    /** role ごとの session 状態 (cookie 名・秘密値の参照の一覧のみ。値は保持しない)。 */
    listSessions(): readonly {
        role: string;
        flowVersion: string;
        stepCount: number;
        secretReferences: readonly string[];
        cookieNames: readonly string[];
        sessionRevision: number;
        verificationUrl: string | null;
    }[] { return this.sessionService.listSessions(); }
    /** session の refresh (single-flight・lockout 回避は domain)。 */
    async refreshSession(operator: OperatorProfile, role: string): Promise<{
        outcome: 'refreshed' | 'stopped-lockout-guard';
        sessionRevision: number;
    }> { return this.sessionService.refreshSession(operator, role); }
    /** role への cookie jar 割当。他 role との共有 (同名 cookie) は警告として返す (F09-UT-005)。 */
    assignRoleCookies(operator: OperatorProfile, role: string, cookieNames: readonly string[]): {
        role: string;
        shared: boolean;
    } { return this.sessionService.assignRoleCookies(operator, role, cookieNames); }
    /** payload 集合の登録 (F05-UT-006: 供給元・版・license は必須)。 */
    registerPayloadSet(operator: OperatorProfile, registration: PayloadSetRegistration): {
        name: string;
        valueCount: number;
    } { return this.fuzzerService.registerPayloadSet(operator, registration); }
    listPayloadSets(): readonly {
        name: string;
        source: string;
        version: string;
        license: string;
        sha256: string;
        values: readonly string[];
    }[] { return this.fuzzerService.listPayloadSets(); }
    /**
     * fuzz session の実行 (design/f05)。組合せ総数が上限 (既定は案件上限と 200 の小さい方) を
     * 超えたら送信前に拒否する (F05-UT-001)。fixture adapter は組合せから決定的な応答を作り、
     * rate は仮想時計で進める (実時間を待たない)。応答は cluster 集約して返す (F05-UT-008)。
     * role 指定時はその role の session cookie を適用する (design/08: F05 は Cookie 適用対象)。
     */
    async runFuzzSession(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly positions: readonly FuzzPosition[];
        readonly maxRequests?: number;
        readonly role?: string;
    }): Promise<{
        runId: string;
        targetUrl: string;
        total: number;
        sent: number;
        clusters: readonly {
            key: string;
            members: readonly number[];
            representative: readonly string[];
        }[];
        sessionCookieNames?: readonly string[];
    }> { return this.fuzzerService.runFuzzSession(operator, input); }
    listFuzzRuns(): readonly {
        runId: string;
        targetUrl: string;
        total: number;
        sent: number;
        clusters: readonly {
            key: string;
            members: readonly number[];
            representative: readonly string[];
        }[];
        executedAt: string;
    }[] { return this.fuzzerService.listFuzzRuns(); }
    /**
     * Sequencer session の実行 (design/f07)。sample 数は domain 検証 (30..10000)。
     * fixture adapter は対象 URL から決定的な token 応答を作る (URL に fixed が
     * 含まれる場合は毎回同一 token = 低 entropy・重複の実演、no-token は欠落混入)。
     * token 原文は応答・監査・台帳のいずれにも出さない (F07-UT-006)。
     */
    async runSequencerSession(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly samples: number;
        readonly role?: string;
        readonly tokenSource?: SequencerTokenSource;
        readonly tokenCookieName?: string;
        readonly tokenFieldName?: string;
        readonly tokenStartDelimiter?: string;
        readonly tokenEndDelimiter?: string;
        readonly replayRequest?: {
            readonly method?: string;
            readonly headers?: readonly (readonly [
                string,
                string
            ])[];
            readonly body?: string;
        };
        readonly signal?: AbortSignal;
    }): Promise<SequencerSessionResult> { return this.sequencerService.runSequencerSession(operator, input); }
    listSequencerSessions(): readonly SequencerSessionRecord[] { return this.sequencerService.listSequencerSessions(); }
    /**
     * OpenAPI/Swagger 仕様の取込 (design/f12)。文書内の instruction/script は実行しない。
     * server は許可 Origin 内だけ候補化し (F12-UT-001)、endpoint (method+path+url) を
     * 返す。path template ({id} 等) は警告付きでそのまま返す — 値は利用者が明示する。
     * 生成された要求は呼出側で ExecutionPlan に入れて確認する (A08 の対象へ設定)。
     */
    importApiSpec(operator: OperatorProfile, input: {
        readonly documentLabel: string;
        readonly document: unknown;
    }): {
        documentLabel: string;
        servers: readonly string[];
        excludedServers: readonly string[];
        endpoints: readonly {
            method: string;
            path: string;
            url: string;
        }[];
        warnings: readonly string[];
    } { return this.apiImportService.importApiSpec(operator, input); }
    /**
     * OAST attempt の開始 (design/f13)。protocol 能力は provider (fixture は
     * http/dns) で検証し、非対応は CapabilityUnavailable。token はこの応答で
     * 一度だけ返し、監査・一覧には出さない (F13-UT-007)。
     */
    async startOastAttempt(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly protocol: OastProtocol;
    }): Promise<{
        attemptId: string;
        targetUrl: string;
        protocol: OastProtocol;
        token: string;
        waitMs: number;
    }> { return this.oastService.startOastAttempt(operator, input); }
    /**
     * provider からの callback 記録 (design/f13)。同一 event は dedupe し
     * (F13-UT-002)、未知 token は uncorrelated として隔離する (F13-UT-003)。
     */
    recordOastCallbacks(operator: OperatorProfile, input: {
        readonly events: readonly ProviderEvent[];
    }): {
        kept: number;
        duplicates: number;
        correlated: number;
        uncorrelated: number;
    } { return this.oastService.recordOastCallbacks(operator, input); }
    /** attempt 一覧 (token なし。interactions と曖昧判定のみ)。 */
    listOastAttempts(): readonly {
        attemptId: string;
        targetUrl: string;
        protocol: OastProtocol;
        status: 'waiting' | 'expired';
        interactions: number;
        candidateOnly: boolean;
    }[] { return this.oastService.listOastAttempts(); }
    /**
     * WebSocket frame の取込 (design/f14)。text のみ (binary は対象外)。同一 frame は
     * 呼出内・持越しの両方で dedupe する (F14-UT-001)。表示は raw hash と text を
     * 区別して返す (F14-UT-007)。
     */
    importWsFrames(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly frames: readonly {
            readonly direction: 'sent' | 'received';
            readonly payload: string;
        }[];
    }): {
        imported: number;
        duplicates: number;
    } { return this.webSocketService.importWsFrames(operator, input); }
    /** frame 一覧 (text と raw hash を区別した表示素材)。 */
    listWsFrames(): readonly {
        frameId: string;
        direction: 'sent' | 'received';
        text: string;
        rawHash: string;
    }[] { return this.webSocketService.listWsFrames(); }
    /**
     * WebSocket message の送信 (design/f14)。text のみ (binary は Unsupported・
     * F14-UT-003)。plan hash 付きで確認対象を固定し (F14-UT-002)、rate/size 上限は
     * adapter を呼ばずに拒否する (F14-UT-006)。fixture adapter は送信を frame 台帳へ
     * 'sent' として記録するだけ。
     */
    async sendWsMessages(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly messages: readonly string[];
        readonly role?: string;
        readonly subprotocols?: readonly string[];
    }): Promise<{
        planHash: string;
        sent: number;
        rejected: 'size' | 'rate' | null;
        sessionCookieNames?: readonly string[];
        negotiatedSubprotocol?: string;
    }> { return this.webSocketService.sendWsMessages(operator, input); }
    /**
     * transport の選択 (design/f15)。HTTP/3 は能力表で Unsupported。peer が h2 を
     * offer しない場合、fallback 未許可なら CapabilityUnavailable (F15-UT-004)。
     * 実 port 構成時は bounded request probe を行い、未構成時は URL に h1-only を含む
     * fixture peer だけが h2 を offer しない。結果は ALPN/runtime を保持する (F15-UT-007)。
     */
    async negotiateTransportFor(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly allowFallback: boolean;
        readonly requested?: 'h2' | 'http/1.1' | 'h3';
    }): Promise<{
        protocol: 'h2' | 'http/1.1';
        downgraded: boolean;
        alpn: string;
        runtime: string;
        response?: import('../ports/engines.ts').TransportProbeResponseEvidence;
    }> {
        this.requirePermission(operator, 'run.manage');
        const caseRecord = this.currentCase();
        const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
        const decision = ScopePolicy.decide(caseRecord.scope, canonical);
        if (!decision.allowed) {
            throw domainError('OutOfScope', `transport target is out of scope: ${decision.reason}`);
        }
        const requested = input.requested ?? 'h2';
        if (requested === 'h3' || transportCapability(requested) === 'Unsupported') {
            throw domainError('CapabilityUnavailable', `transport ${requested} is Unsupported`);
        }
        const probe = this.deps.advancedTransport === undefined
            ? requested === 'http/1.1'
                ? {
                    offered: ['http/1.1'] as const,
                    alpn: 'http/1.1 (explicit)',
                    runtime: 'fixture-transport',
                }
                : {
                    offered: canonical.includes('h1-only') ? ['http/1.1'] as const : ['h2'] as const,
                    alpn: canonical.includes('h1-only') ? 'http/1.1' : 'h2',
                    runtime: 'fixture-transport',
                }
            : await this.deps.advancedTransport.probe({ targetUrl: canonical, requested, allowFallback: input.allowFallback });
        const negotiated = requested === 'http/1.1'
            ? { protocol: 'http/1.1' as const, downgraded: false }
            : negotiateTransport({ offered: probe.offered, allowFallback: input.allowFallback });
        const evidence = transportEvidence({ alpn: probe.alpn, runtime: probe.runtime });
        this.record({
            type: 'TransportNegotiated',
            at: this.deps.clock.now().toISOString(),
            targetUrl: canonical,
            protocol: negotiated.protocol,
            downgraded: negotiated.downgraded,
        });
        return {
            protocol: negotiated.protocol,
            downgraded: negotiated.downgraded,
            ...evidence,
            ...(probe.response === undefined ? {} : { response: probe.response }),
        };
    }
    /**
     * HTTP/2 header 検証 (design/f15)。pseudo header の重複・順序 (F15-UT-001)・
     * CRLF 注入になり得る値 (F15-UT-003)・:authority の scope (F15-UT-002) を検証する。
     */
    validateTransportHeaders(operator: OperatorProfile, input: {
        readonly headers: readonly (readonly [
            string,
            string
        ])[];
        readonly scheme: string;
    }): {
        ordered: readonly string[];
        authority: string;
    } {
        this.requirePermission(operator, 'run.manage');
        const caseRecord = this.currentCase();
        const { ordered } = validatePseudoHeaders(input.headers);
        validateHeaderValues(input.headers);
        const scopeDecision = checkAuthorityScope(input.headers, input.scheme, caseRecord.scope);
        if (!scopeDecision.allowed) {
            throw domainError('OutOfScope', `:authority is out of scope: ${scopeDecision.reason}`);
        }
        const authority = input.headers.find(([name]) => name === ':authority')?.[1] ?? '';
        return { ordered, authority };
    }
    /**
     * DOM value-flow 調査 (design/f16)。観測済み API 呼び出し (api + marker) から
     * source→sink 候補を導く。観測なしでは候補を作らない (F16-UT-005)。証跡表示は
     * PII と推定される node を redact する (F16-UT-006)。集計 tool のため監査 event なし
     * (decode/compare と同じ扱い)。
     */
    async analyzeDomFlows(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly observations: readonly {
            readonly api: string;
            readonly marker: string;
        }[];
        readonly nodes?: readonly {
            readonly text: string;
            readonly looksLikePii: boolean;
        }[];
        readonly live?: boolean;
        /** runLogin 済み role。live observation の browser context にだけ適用する。 */
        readonly role?: string;
    }): Promise<{
        candidates: readonly {
            sourceApi: string;
            sinkApi: string;
            confidence: number;
            marker: string;
        }[];
        evidence: readonly string[];
    }> {
        this.requirePermission(operator, 'run.manage');
        const caseRecord = this.currentCase();
        const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
        const decision = ScopePolicy.decide(caseRecord.scope, canonical);
        if (!decision.allowed) {
            throw domainError('OutOfScope', `dom investigation target is out of scope: ${decision.reason}`);
        }
        if (input.role !== undefined && input.live !== true) {
            throw domainError('ValidationFailed', 'DOM observation role is only supported when live is true');
        }
        let observations = input.observations;
        let nodes = input.nodes ?? [];
        if (input.live === true) {
            if (this.deps.domObserver === undefined) {
                throw domainError('CapabilityUnavailable', 'live DOM observation is not configured');
            }
            let appliedCookies: readonly LoginSessionCookie[] | undefined;
            if (input.role !== undefined) {
                const session = this.sessionVault.roleSessionCookies.get(input.role);
                if (session === undefined) {
                    throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
                }
                appliedCookies = applicableSessionCookies([...session.cookies], canonical);
            }
            let observed: Awaited<ReturnType<NonNullable<BaselineFlowDeps['domObserver']>['observe']>>;
            try {
                observed = await this.deps.domObserver.observe({
                    targetUrl: canonical,
                    scope: caseRecord.scope,
                    ...(appliedCookies === undefined ? {} : {
                        sessionCookies: appliedCookies.map((cookie) => ({
                            name: cookie.name,
                            value: cookie.value,
                            domain: cookie.domain,
                            path: cookie.path,
                        })),
                    }),
                });
            }
            catch {
                throw domainError('CapabilityUnavailable', 'live DOM observation failed or instrumentation was unavailable');
            }
            observations = observed.observations;
            nodes = observed.nodes;
        }
        const rawCandidates = buildDomCandidate(observations);
        const candidates = input.live === true
            ? rawCandidates.map((candidate) => ({
                ...candidate,
                marker: `sha256:${hashStable('scopepilot2.dom.marker', candidate.marker)}`,
            }))
            : rawCandidates;
        const evidence = domEvidenceProjection(nodes);
        return { candidates, evidence };
    }
    /**
     * extension の読み込み (design/f20)。署名不一致・非信頼 publisher は load しない
     * (F20-UT-006)。apiRange が現行 API 版を含まない場合は Unsupported (F20-UT-007)。
     * secret 値の read 権限は存在しない (F20-UT-008 — 参照 ID のみ)。fixture の
     * 信頼 root は決定的署名 `trusted-{extensionId}-{version}`。
     */
    installExtension(operator: OperatorProfile, input: {
        readonly extensionId: string;
        readonly version: string;
        readonly signature: string;
        readonly publisherTrusted: boolean;
        readonly permissions: readonly string[];
        readonly apiRange: readonly string[];
    }): {
        loaded: true;
        extension: {
            extensionId: string;
            version: string;
            permissions: readonly string[];
            apiRange: readonly string[];
        };
    } {
        this.requirePermission(operator, 'case.manage');
        if (input.extensionId.trim() === '' || input.version.trim() === '') {
            throw domainError('ValidationFailed', 'extension id and version must not be empty');
        }
        const manifest: ExtensionManifest = {
            extensionId: input.extensionId,
            version: input.version,
            signature: input.signature,
            publisherTrusted: input.publisherTrusted,
            permissions: [...input.permissions],
            apiRange: [...input.apiRange],
        };
        const verification = verifyExtensionManifest(manifest, (hash) => `trusted-${input.extensionId}-${input.version}-${hash.slice(0, 8)}`);
        if (!verification.loaded) {
            throw domainError('ValidationFailed', verification.reason ?? 'extension manifest rejected');
        }
        try {
            checkCompatibility('scopepilot2.api.v1', manifest.apiRange);
        }
        catch {
            throw domainError('Unsupported', `extension ${input.extensionId} does not support the current API version (scopepilot2.api.v1)`);
        }
        // secret read 権限を要求する extension は最初から拒否 (値を返す権限は存在しない)。
        for (const permission of manifest.permissions) {
            respondToSecretRead({ permission });
        }
        const entry = { extensionId: manifest.extensionId, version: manifest.version, permissions: [...manifest.permissions], apiRange: [...manifest.apiRange] };
        (this.loadedExtensions as typeof entry[]).push(entry);
        this.record({ type: 'ExtensionInstalled', at: this.deps.clock.now().toISOString(), extensionId: entry.extensionId, version: entry.version });
        return { loaded: true, extension: entry };
    }
    /** 読み込み済み extension の一覧 (manifest の公開情報のみ・署名は出さない)。 */
    listExtensions(): readonly {
        extensionId: string;
        version: string;
        permissions: readonly string[];
        apiRange: readonly string[];
    }[] {
        return [...this.loadedExtensions];
    }
    /**
     * HTTPS 記録用 CA profile の台帳 (design/24 §2)。鍵生成は実 engine 接続と共に
     * 後続 — ここは fingerprint・生成元・期限・信頼登録状態の表示と信頼状態の
     * 変更 (監査付き) のみ。秘密鍵の export は設計上存在しない。
     */
    listCaProfiles(): readonly {
        profileId: string;
        purpose: string;
        generatedBy: string;
        fingerprint: string;
        createdAt: string;
        expiresAt: string;
        trusted: boolean;
    }[] {
        const fingerprint = hashStable('scopepilot2.ca.profile', { runtime: this.deps.runtimeBundleHash }).slice(0, 32);
        const created = new Date(this.deps.clock.now().getTime() - 24 * 60 * 60 * 1000);
        return [
            {
                profileId: 'scopepilot2-diagnostics',
                purpose: 'HTTPS 記録 (診断用 profile)',
                generatedBy: 'fixture (実鍵は実 engine 接続時に生成)',
                fingerprint,
                createdAt: created.toISOString(),
                expiresAt: new Date(created.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
                trusted: this.caProfileTrusted,
            },
        ];
    }
    /** CA profile の信頼登録状態の変更 (design/24: 信頼登録は明示操作・監査記録)。 */
    setCaProfileTrust(operator: OperatorProfile, profileId: string, trusted: boolean): {
        profileId: string;
        trusted: boolean;
    } {
        this.requirePermission(operator, 'case.manage');
        if (profileId !== 'scopepilot2-diagnostics') {
            throw domainError('ValidationFailed', `unknown CA profile ${profileId}`);
        }
        this.caProfileTrusted = trusted;
        this.record({ type: 'CaProfileTrustChanged', at: this.deps.clock.now().toISOString(), profileId, trusted });
        return { profileId, trusted };
    }
    listApiSpecImports(): readonly {
        documentLabel: string;
        endpointCount: number;
        importedAt: string;
    }[] { return this.apiImportService.listApiSpecImports(); }
    /** draft の表示形 (UI 確認用に plan hash を添える)。 */
    private repeaterDraftView(draft: RepeaterDraft): {
        draftId: string;
        targetUrl: string;
        protocol: RepeaterDraft['protocol'];
        revision: number;
        requestBytes: string;
        planHash: string;
    } { return this.repeaterService.repeaterDraftView(draft); }
    listRepeaterDrafts(): readonly ReturnType<BaselineFlowService['repeaterDraftView']>[] { return this.repeaterService.listRepeaterDrafts(); }
    /** Repeater draft の作成 (design/f04)。対象 URL は案件 scope 内に限る。 */
    createRepeaterDraft(operator: OperatorProfile, input: {
        readonly targetUrl: string;
        readonly protocol: RepeaterDraft['protocol'];
    }): ReturnType<BaselineFlowService['repeaterDraftView']> { return this.repeaterService.createRepeaterDraft(operator, input); }
    /** header/body 編集。改行を含む header は拒否され、revision が進む (F04-UT-002)。 */
    editRepeaterDraft(operator: OperatorProfile, draftId: string, edit: {
        readonly headers: readonly (readonly [
            string,
            string
        ])[];
        readonly body: string;
    }): ReturnType<BaselineFlowService['repeaterDraftView']> { return this.repeaterService.editRepeaterDraft(operator, draftId, edit); }
    /**
     * draft の送信。UI が表示した plan hash と現在の hash が一致する場合だけ adapter へ渡す
     * (F04-UT-003)。応答は summary のみ返し、binary は text 化しない (F04-UT-006)。
     * timeout 相当は応答なし attempt として記録する (F04-UT-007)。
     * role 指定時はその role の session cookie を適用する (design/08: F04 は Cookie 適用対象)。
     * cookie は対象 URL の host/path に一致するものだけ (別 Origin への認証送信はしない)。
     */
    async sendRepeaterDraft(operator: OperatorProfile, draftId: string, confirmedPlanHash: string, role?: string): Promise<{
        sent: boolean;
        reason?: string;
        attempt?: SendAttemptRecord;
        response?: ReturnType<typeof summarizeResponse>;
        sessionCookieNames?: readonly string[];
    }> { return this.repeaterService.sendRepeaterDraft(operator, draftId, confirmedPlanHash, role); }
    repeaterAttemptLog(): readonly SendAttemptRecord[] { return this.repeaterService.repeaterAttemptLog(); }
    dropBreakItem(operator: OperatorProfile, itemId: string): BreakItem {
        this.requirePermission(operator, 'run.manage');
        this.breakQueue.drop(itemId);
        const item = this.breakQueue.get(itemId);
        if (item === undefined) {
            throw domainError('ValidationFailed', `break item ${itemId} does not exist`);
        }
        return item;
    }
    /** 所見の確認状態変更 (6.3)。変更は監査 event に確認者付きで記録する。 */
    updateFindingStatus(operator: OperatorProfile, input: {
        readonly findingId: string;
        readonly next: 'confirmed' | 'rejected';
        readonly reproduction: 'reproduced' | 'not-reproduced';
        readonly notes: string;
        readonly severityRationale: string;
        readonly cvss?: {
            readonly version: '3.1' | '4.0';
            readonly vector: string;
            readonly score: number;
        };
    }): Finding { return this.findingService.updateFindingStatus(operator, input); }
    /** 能力表 (fixture または実測)。API 経由で UI/CLI が版と fixture hash を確認するのに使う。 */
    capabilities(): readonly EngineCapabilitySnapshot[] {
        return [...this.deps.capabilities];
    }
    currentCase(): CaseRecord { return this.caseService.currentCase(); }
    currentAuthorization(): AuthorizationRecord { return this.authorizationService.currentAuthorization(); }
    /** 案件作成。origin は canonicalize 後に保存し、正規化できない URL は拒否する。 */
    createCase(operator: OperatorProfile, input: CreateCaseInput): CaseRecord { return this.caseService.createCase(operator, input); }
    /**
     * scope 更新。expectedRevision 必須 (f01 §4)。狭くなる更新は既存 confirmation を無効化し、
     * 無効化 event を監査記録へ残す。進行中 job への停止要求は run 管理の実装時に接続する。
     */
    updateCaseScope(operator: OperatorProfile, input: {
        expectedRevision: number;
        allowedOrigins: readonly string[];
        deniedOrigins: readonly string[];
        limits: ScopeLimits;
    }): {
        revision: number;
        narrowed: boolean;
        invalidatedConfirmationIds: readonly string[];
    } { return this.caseService.updateCaseScope(operator, input); }
    /** 認可の付与。証跡原本は hash 参照のみ持ち、秘密値は保持しない。 */
    async grantAuthorization(operator: OperatorProfile, input: GrantAuthorizationInput): Promise<AuthorizationRecord> { return this.authorizationService.grantAuthorization(operator, input); }
    /** 探索計画。既定上限と案件上限の狭い方を使う。 */
    buildExplorationPlan(operator: OperatorProfile, seeds: readonly string[], limitsRequest?: {
        readonly maxRequests: number;
        readonly maxPages: number;
        readonly maxDurationMinutes: number;
    }): {
        plan: ExecutionPlan;
        planHash: string;
    } { return this.planService.buildExplorationPlan(operator, seeds, limitsRequest); }
    /**
     * payload 実行検証 (design/f08: 反射の所見と実行確認を区別する)。
     * 検証 URL (payload 付き) を browser で開き、dialog 発火等のコード実行根拠を
     * 観測する。scope 強制はこの入口で行い (Enforced: 送信前拒否)、結果は証跡へ
     * 保存する (信号の文言は先頭のみ・秘密値は出ない)。
     */
    async verifyFindingExecution(operator: OperatorProfile, input: {
        readonly url: string;
        readonly role?: string;
        readonly findingId?: string;
    }): Promise<{
        executed: boolean;
        signals: readonly string[];
        evidenceRef: string;
    }> { return this.explorationService.verifyFindingExecution(operator, input); }
    /** 能動診断計画。対象は採用済み候補の canonical URL の固定 snapshot。 */
    buildActiveScanPlan(operator: OperatorProfile, targets: readonly string[], limitsRequest?: {
        readonly maxRequests: number;
        readonly maxPages: number;
        readonly maxDurationMinutes: number;
    }, options: {
        readonly includeNuclei?: boolean;
        readonly includeWorkflowScan?: boolean;
        readonly guidelines?: readonly string[];
    } = {}): {
        plan: ExecutionPlan;
        planHash: string;
    } { return this.planService.buildActiveScanPlan(operator, targets, limitsRequest, options); }
    /** 計画の検証と認可結び付け。問題があれば最初の問題を domain error へ変換する。 */
    authorizePlan(plan: ExecutionPlan): {
        planHash: string;
    } { return this.planService.authorizePlan(plan); }
    /** 計画確認。確認内容の写しと hash の両方を残し、案件 aggregate へ登録する。 */
    confirmPlan(plan: ExecutionPlan, operator: OperatorProfile): PlanConfirmation { return this.planService.confirmPlan(plan, operator); }
    /**
     * 探索の実行 (Enforced 経路)。各 navigation 前に scope・上限・停止を評価し、
     * scope 外 URL は adapter を呼ばずに拒否記録を残す。
     */
    async runExploration(operator: OperatorProfile, plan: ExecutionPlan, confirmation: PlanConfirmation, input: ExploreRunInput): Promise<ExploreRunResult> { return this.explorationService.runExploration(operator, plan, confirmation, input); }
    /** 候補の採用。基準シナリオでは提示された候補を全採用する。 */
    adoptCandidates(operator: OperatorProfile, candidates: readonly ScanCandidate[]): readonly ScanCandidate[] { return this.explorationService.adoptCandidates(operator, candidates); }
    /**
     * 能動診断の実行 (Delegated 経路)。確認 hash と能力表を検証してから engine へ入力を渡し、
     * 出力から挙動を推測して記録する。個々の送信は傍受・拒否しない。
     */
    async runActiveScan(operator: OperatorProfile, plan: ExecutionPlan, confirmation: PlanConfirmation, adopted: readonly ScanCandidate[], role?: string, control: ActiveScanExecutionControl = {}): Promise<ActiveScanRunResult> { return this.jobOrchestrator.runActiveScan(operator, plan, confirmation, adopted, role, control); }
    /**
     * Nuclei 結果 (JSONL) の取込。engine の起動・送信は行わない観測出力の取込経路であり、
     * 実行 (nuclei-scan step) は能力表が実測を満たすまで公開しない (design/22)。
     * 原本を証拠保存してから所見化し、壊れた行は quarantine して継続する。
     */
    async importNucleiResults(operator: OperatorProfile, input: ImportNucleiResultsInput): Promise<ImportNucleiResultsResult> { return this.findingService.importNucleiResults(operator, input); }
    /** 報告の生成。delegated step の限界開示を必ず含む。 */
    generateReport(operator: OperatorProfile, input: {
        readonly guidelines: readonly string[];
        readonly excludeLowAndInfo?: boolean;
    }): ReportArtifact { return this.reportService.generateReport(operator, input); }
    private requirePermission(operator: OperatorProfile, permission: OperatorPermission): void { requirePermission(operator, permission); }
    private requireMatchingConfirmation(plan: ExecutionPlan, confirmation: PlanConfirmation): void { return this.planService.requireMatchingConfirmation(plan, confirmation); }
    private record(event: BaselineFlowEvent): void { this.eventPublisher.publish(event); }
}
export { isSessionControlUrl } from './services/execution-helpers.ts';
