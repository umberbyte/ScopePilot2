import { resolveUnsupportedAssessments } from '../domain/unsupported-assessment.ts';
import type { UnsupportedAssessment } from '@scopepilot2/contracts';
import type { GuidelineAutomationDisclosure } from '@scopepilot2/contracts';
import { automaticGuidelineRequestCount, guidelineAutomationPolicy, GUIDELINE_AUTOMATION_POLICY_VERSION } from '../domain/guideline-automation.ts';
import { createHash } from 'node:crypto';
import type { FuzzInput, FuzzRow, FuzzRunView, FuzzPayloadSource } from '@scopepilot2/contracts';
/**
 * 基準シナリオ「案件作成→認可→探索→候補採用→能動診断→取込→所見→報告」の
 * application service。`docs/design/19-cli-automation.md` 5章、`docs/design/22-execution-control.md`。
 *
 * 本体実装より先に simulation fixture で自動完走させる回帰基準となる層で、
 * command pipeline の順序 (権限判定 → 認可 → 確認 → domain 処理 → 証跡 → event) を
 * 最初から踏襲する (SYS-UT-001/005 の土台)。
 */
import type { AdapterKind, RuntimeProfile, RuntimeAdapterCapability, SequencerJobParams, SequencerTokenSource, SequencerSessionRecord, SequencerSessionResult } from '@scopepilot2/contracts';
import { UnavailableCapability } from '../ports/runtime-capability.ts';
import { JobRegistry, jobContext, type JobStore, redactJobText } from './job-registry.ts';
import { bundledGuidelineCoverage } from '../domain/guideline-coverage.ts';
import {
  canonicalJson,
  DomainError,
  domainError,
  hashStable,
  type AuthorizationRecord,
  type BaselineFlowEvent,
  type CaseRecord,
  type CaseScope,
  type EngineCapabilitySnapshot,
  type ExecutionPlan,
  type Finding,
  type OperatorProfile,
  type OperatorPermission,
  type PageObservation,
  type PlanConfirmation,
  type PlanLimits,
  type ReportArtifact,
  type RunRecord,
  type RunState,
  type ScanCandidate,
  type ScopeLimits,
  type StopReason,
  type ActiveScanRequest,
  type DocumentAuthHint,
  type DocumentAuthHintEntry,
  type DocumentPriorityRule,
  type DocumentParameterHint,
  type DocumentParameterHintEntry,
  type DiagnosticTrack,
  type RequestInputPoint,
  DocumentAuthMethods,
  DocumentPriorityCategories,
  type SaveScanPolicyRequest,
  type ScanPolicy,
  type ScanPolicyRouteOverrides,
  AuthenticationMethods,
  type AuthenticationUser,
  type AuthenticationCapabilities,
  type SessionVerification,
} from '@scopepilot2/contracts';
import { ScopePolicy } from '../domain/scope-policy.ts';
import { reviewJwt } from '../domain/client-review.ts';
import { discoverySeeds, DISCOVERY_VERSION, DISCOVERY_WORDLIST, rankCandidates } from '../domain/exploration-discovery.ts';
import { mergeDocumentHintSeeds } from '../domain/exploration.ts';
import { CaseAggregate } from '../domain/case-aggregate.ts';
import { RunStateMachine } from '../domain/run-state-machine.ts';
import { ScanMonitor } from '../domain/scan-monitor.ts';
import { filterAuthorizationEvidenceMetadata } from '../domain/authorization-evidence.ts';
import {
  buildPlan,
  confirmationMatches,
  DEFAULT_ACTIVE_SCAN_LIMITS,
  DEFAULT_EXPLORE_LIMITS,
  firstPlanIssueAsError,
  planHashOf,
  validatePlan,
} from '../domain/plan-service.ts';
import { PASSIVE_RULES, passiveObservationCandidates } from '../domain/passive-observation.ts';
import { dedupeKeyOf, FindingImporter } from '../domain/finding-importer.ts';
import { BreakQueue, decideIntercept, type BreakItem, type BreakQueueEvent, type InterceptDecision } from '../domain/proxy-intercept.ts';
import { SiteMapProjector, planTrafficQuery } from '../domain/target-logger.ts';
import {
  businessTargetInScope,
  evaluateRestore,
  parseExpectation,
  planRoleMatrix,
  resolveOutcome,
  type ComparisonOutcome,
} from '../domain/business-logic.ts';
import {
  derivePasswordVariant,
  judgeLoginVariant,
  judgePageProbe,
  planAuthBypassCheck,
  sessionCookiesForPattern,
  summarizeAuthBypassOutcomes,
  type AuthBypassCheckListItem,
  type AuthBypassCheckRecord,
  type AuthBypassCheckSummary,
  type AuthBypassPagePattern,
  type AuthBypassProbeOutcome,
  type AuthBypassProbeResult,
} from '../domain/auth-bypass.ts';
import {
  DEFAULT_CREDENTIAL_PAIRS_MAX,
  INPUT_ROBUSTNESS_MAX_VALUES,
  INPUT_ROBUSTNESS_PAYLOADS,
  PASSWORD_POLICY_CONTROL,
  RESET_TOKEN_PATTERNS,
  WEAK_PASSWORD_CANDIDATES,
  assertRequestBudget,
  countNucleiMatches,
  findMixedContent,
  findSerializationSignature,
  findSensitiveUrlParamNames,
  forgeResetToken,
  judgeCorsPreflight,
  judgeCorsResponse,
  judgeInputRobustness,
  judgeDirectoryListing,
  judgeIdorAccess,
  judgeLockout,
  judgeMassAssignment,
  judgeNucleiSpot,
  judgeOtpBoundary,
  judgeOtpSubmission,
  judgePasswordEcho,
  judgePiiExposure,
  judgePlainHttp,
  judgeReplay,
  judgeResponseContentType,
  judgeSensitiveCache,
  judgeSamlAssertionReplay,
  judgeUserEnumeration,
  judgeVersionDisclosure,
  mergeJsonFields,
  normalizeEnumerationResponse,
  parseDefaultCredentialPairs,
  parseExtraFieldsJson,
  planIdorProbes,
  planLockoutSequence,
  planOtpExpiryWaitMs,
  planOtpWrongAttempts,
  planReplayCount,
  requireImplementedTheme,
  summarizeThemeOutcomes,
  substituteObjectParam,
  validateSpotTemplateIds,
  OTP_INBOX_TIMEOUT_MS,
  type OtpSubmissionOutcome,
  type ThemeCheckProbeResult,
  type ThemeCheckSummary,
  type ZapUnsupportedThemeNo,
} from '../domain/zap-unsupported.ts';
import {
  RoleSessionRegistry,
  SessionCoordinator,
  checkFlowDeadline,
  detectAuthState,
  validateLoginFlow,
  vaultEvidenceProjection,
  type LoginFlowStep,
} from '../domain/authentication-session.ts';
import {
  PayloadCatalog,
  clusterResponses,
  combinationAt,
  planCombinations,
  runFuzz,
  type FuzzPosition,
  type FuzzResponseOutcome,
  type PayloadSetRegistration,
} from '../domain/fuzzer.ts';
import {
  DraftRegistry,
  applicableSessionCookies,
  runRedirects,
  applyEdit,
  recordSendAttempt,
  renderInitialRequest,
  sendCommand,
  summarizeResponse,
  type RepeaterDraft,
  type SendAttemptRecord,
} from '../domain/repeater.ts';
import { importMatches, parseNucleiJsonl } from '../domain/known-vulnerabilities.ts';
import { assess, createSamplePlan, createSequencerExtractor, createSequencerReplayRequest, extractSequencerToken, reportProjection, SampleCollector, type AlphabetClassCounts, type NumericDeltaSignCounts } from '../domain/sequencer.ts';
import { parseOpenApiDocument, type ParsedOpenApiEndpoint } from '../domain/api-scanning.ts';
import { TokenIssuer, correlate, linkFinding, normalizeCallbacks, OAST_DEFAULT_WAIT_MS, pollDeadline, providerCapability, type OastProtocol, type ProviderEvent } from '../domain/oast.ts';
import { buildWsSendPlan, importFrames, sendWithPolicy, validateWsSubprotocols, wsEvidence, type WsFrame } from '../domain/websocket.ts';
import { checkAuthorityScope, negotiateTransport, transportCapability, transportEvidence, validateHeaderValues, validatePseudoHeaders } from '../domain/advanced-transport.ts';
import { buildDomCandidate, domEvidenceProjection } from '../domain/dom-investigation.ts';
import {
  resolveWorkflowScanCheckIds,
  runWorkflowScan,
  WORKFLOW_SCAN_DEFAULT_MAX_REQUESTS,
  WORKFLOW_SCAN_PAYLOAD_SET,
  type WorkflowScanHttpResponse,
  type WorkflowScanRequestSpec,
  type WorkflowScanTransport,
  type WorkflowScanCheckId,
} from '../domain/workflow-scan.ts';
import { ScanPolicyRegistry } from '../domain/scan-policy.ts';
import { resolveGuidelineThemeRoutes } from '../domain/guideline-execution.ts';
import { checkCompatibility, respondToSecretRead, verifyExtensionManifest, type ExtensionManifest } from '../domain/product-api.ts';
import { buildReportModel, renderMarkdown } from '../domain/report-builder.ts';
import { projectEvidence } from '../domain/evidence-view.ts';
import type { Clock, EvidenceStorePort, IdGenerator } from '../ports/infra.ts';
import type { ActiveScanEnginePort, BrowserSessionState, ExplorationPort, InteractiveBrowserFile, InteractiveBrowserPort, InteractiveBrowserStep, LoginExecutorPort, LoginSessionCookie, NucleiScanPort, OastProviderEvent } from '../ports/engines.ts';

/** 計画の並列度・rate が超えられない安全上天井 (UI 指定でも引き上げ不可)。 */
const PLAN_SAFETY_CEILING = { maxConcurrency: 2, requestsPerSecond: 2 } as const;

/**
 * 動的ルート具体化の上限。テンプレートも識別子も対象自身の観測事実だが、
 * 組合せで frontier が膨らまないよう探索 1 回あたりの上限を切る。
 */
const ROUTE_INSTANTIATION_LIMITS = {
  maxTemplates: 64,
  maxResourceIds: 128,
  maxPerTemplate: 8,
  maxTotalInstantiations: 64,
} as const;

/** payload 実行検証の対象選択と上限 (design/30 30.1)。 */
const PAYLOAD_EXECUTION_FINDING_PATTERN = /xss|cross[\s-]?site[\s-]?scripting/i;
const PAYLOAD_URL_MARKER_PATTERN = /(?:%3C|<script|javascript:|onerror\s*=|onload\s*=|alert\s*\(|<img|<svg|<iframe)/i;
const PAYLOAD_VERIFICATION_MAX = 5;

const TOOL_PORTS = ['repeaterTransport', 'fuzzTransport', 'sequencerTransport', 'oastProvider', 'webSocketTransport', 'advancedTransport'] as const;
type ToolPortName = typeof TOOL_PORTS[number];
type ToolTransport = 'real' | 'fixture' | 'unavailable';

function oastCallbackMetadata(payload: string, fallbackProtocol: OastProtocol): {
  readonly protocol: OastProtocol;
  readonly remoteAddress?: string;
} {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { protocol: fallbackProtocol };
    const record = parsed as Record<string, unknown>;
    const rawProtocol = record.protocol;
    const protocol = rawProtocol === 'https' ? 'http' : rawProtocol;
    const normalized = protocol === 'http' || protocol === 'dns' || protocol === 'smtp' || protocol === 'icmp'
      ? protocol
      : fallbackProtocol;
    const remote = record['remote-address'] ?? record.remote_address ?? record.remote;
    return {
      protocol: normalized,
      ...(typeof remote === 'string' && remote.trim() !== '' ? { remoteAddress: remote.trim() } : {}),
    };
  } catch {
    return { protocol: fallbackProtocol };
  }
}

export interface BaselineFlowDeps {
  readonly runtimeProfile?: RuntimeProfile;
  readonly jobStore?: JobStore;
  readonly jobTransport?: 'live' | 'fixture';
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly evidence: EvidenceStorePort;
  readonly explorer: ExplorationPort;
  readonly scanEngine: ActiveScanEnginePort;
  /** Creates an origin-bound, secret-redacting transport for generic HTTP diagnostics. */
  readonly workflowScanTransportFactory?: (options: {
    readonly baseUrl: string;
    readonly maxRequests: number;
    readonly redactionValues: readonly string[];
    readonly sessionCookies?: readonly { readonly name: string; readonly value: string }[];
    readonly sessionHeaders?: readonly { readonly name: 'Authorization'; readonly value: string }[];
    readonly signal?: AbortSignal;
  }) => WorkflowScanTransport;
  /** 設定済みの実Nuclei CLI。未設定時はscan planにNuclei stepを含めない。 */
  readonly nucleiRunner?: NucleiScanPort;
  readonly capabilities: readonly EngineCapabilitySnapshot[];
  readonly runtimeBundleHash: string;
  /** Login traffic proxy. When present, authenticated browser actions populate the scan engine's session jar. */
  readonly loginProxyServer?: string;
  /** run 記録の永続化 (任意)。開始時 (Running) と終了時の両方へ保存する。 */
  readonly runSink?: import('../ports/infra.ts').RunSinkPort;
  /** 案件記録の永続化 (任意)。作成・scope 更新時に保存する (runs FK の参照先)。 */
  readonly caseSink?: { save(record: CaseRecord): void };
  /** 認可記録の永続化 (任意)。案件再オープン時に最新の認可を復元する。 */
  readonly authorizationSink?: { save(record: AuthorizationRecord): void };
  readonly findingSink?: import('../ports/infra.ts').FindingSinkPort;
  readonly initialFindings?: readonly Finding[];
  /** 実 engine 診断の完了後、alert 生成の遅れを待つ時間 (ms)。fixture では 0。 */
  readonly scanAlertSettleMs?: number;
  /** Repeater の実 transport (design/f04)。未構成なら CapabilityUnavailable。 */
  readonly repeaterTransport?: import('../ports/engines.ts').RepeaterTransportPort;
  /** Fuzz の実 transport (design/f05)。未構成なら CapabilityUnavailable。 */
  readonly fuzzTransport?: import('../ports/engines.ts').FuzzTransportPort;
  /** Sequencer の実収集 transport (design/f07)。未構成なら CapabilityUnavailable。 */
  readonly sequencerTransport?: import('../ports/engines.ts').SequencerTransportPort;
  /** OAST の実 provider session (design/f13)。未構成なら CapabilityUnavailable。 */
  readonly oastProvider?: import('../ports/engines.ts').OastProviderPort | UnavailableCapability;
  /** WebSocket の実 text transport (design/f14)。未構成なら CapabilityUnavailable。 */
  readonly webSocketTransport?: import('../ports/engines.ts').WebSocketTransportPort;
  /** HTTP/2 negotiation/request probe (design/f15). Unavailable when omitted. */
  readonly advancedTransport?: import('../ports/engines.ts').AdvancedTransportPort;
  /** Playwright-backed live DOM observation (design/f16). */
  readonly domObserver?: import('../ports/engines.ts').DomObservationPort;
  /** Operator-confirmed browser workflows for stateful, upload, authorization, and review routes. */
  readonly interactiveBrowser?: InteractiveBrowserPort;

  /** login 実行器 (design/f09)。未構成の service では runLogin が ValidationFailed。 */
  readonly loginExecutor?: LoginExecutorPort;

  /** 許可済み fixture の OTP inbox (テーマ6 OTP sub-check)。未構成なら該当 sub-check を skip する。 */
  readonly otpInbox?: import('../ports/engines.ts').OtpInboxPort;
  /** 隔離された試験 IdP/SP による SAML assertion replay (テーマ6 sub-check)。未構成なら skip する。 */
  readonly samlFixture?: import('../ports/engines.ts').SamlFixturePort;
  /** 期限切れ確認などの実待機。既定は実 setTimeout。fixture では即時解決の fake に差し替える。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CreateCaseInput {
  readonly name: string;
  readonly allowedOrigins: readonly string[];
  readonly deniedOrigins: readonly string[];
  readonly limits: ScopeLimits;
}

export interface GrantAuthorizationInput {
  readonly allowedOperationClasses: AuthorizationRecord['allowedOperationClasses'];
  readonly targetRoles: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string;
  readonly evidence: { readonly label: string; readonly content: string; readonly metadata?: Readonly<Record<string, string>> };
}

export interface ExploreRunInput {
  readonly signal?: AbortSignal;
  readonly maxDepth: number;
  /** runLogin 済みの role。指定時はその role の session cookie で観測する (design/f09)。 */
  readonly role?: string;
}

export interface ExploreRunResult {
  readonly runRecord: RunRecord;
  readonly planHash: string;
  readonly observations: readonly PageObservation[];
  readonly deniedUrls: readonly { readonly url: string; readonly reason: string }[];
  readonly candidates: readonly ScanCandidate[];
  readonly authenticationReview?: readonly import('@scopepilot2/contracts').ClientReviewSignal[];
  readonly engineVersion: string;
}

export type InteractiveDiagnosticTrack =
  | 'workflow-state'
  | 'session-analysis'
  | 'authorization-differential'
  | 'upload-workflow'
  | 'api-schema'
  | 'cryptography-review';

export interface InteractiveDiagnosticItemInput {
  readonly itemId: string;
  readonly track: InteractiveDiagnosticTrack;
  readonly targetUrl: string;
  readonly role: string;
  readonly roles: readonly string[];
  readonly summary: string;
  readonly steps: readonly InteractiveBrowserStep[];
  readonly samples: number;
  readonly tokenSource: SequencerTokenSource;
  readonly tokenName: string;
  readonly expectation: 'same' | 'different';
  readonly requiredInputs: readonly ('upload-file' | 'api-spec' | 'additional-role-session')[];
}

export interface InteractiveDiagnosticRunInput {
  readonly confirmed: boolean;
  readonly items: readonly InteractiveDiagnosticItemInput[];
  readonly files: readonly InteractiveBrowserFile[];
  readonly apiDocuments: readonly { readonly inputRef: string; readonly name: string; readonly document: unknown }[];
}

export interface InteractiveDiagnosticItemResult {
  readonly itemId: string;
  readonly track: InteractiveDiagnosticTrack;
  readonly targetUrl: string;
  readonly status: 'completed' | 'passed' | 'failed' | 'inconclusive';
  readonly detail: string;
  readonly evidenceId?: string;
}

export interface ActiveScanRunResult {
  readonly runRecord: RunRecord;
  readonly planHash: string;
  readonly scanRequest: ActiveScanRequest;
  readonly findings: readonly Finding[];
  readonly overshootReservation: number;
  readonly engineVersion: string;
  readonly requestCorpusEvidenceRef: string;
  readonly diagnosticRoutes: readonly DiagnosticRouteResult[];
  readonly guidelineRoutes: readonly GuidelineRouteResult[];
  readonly unsupportedAssessments: readonly UnsupportedAssessment[];
  readonly workflow?: {
    readonly status: 'completed' | 'failed';
    readonly payloadSet: string;
    readonly baseUrls: readonly string[];
    readonly requestCount: number;
    readonly checkKindCount: number;
    readonly checkCount: number;
    readonly skipCount: number;
    readonly importedCount: number;
    readonly duplicateCount: number;
    readonly evidenceRefs: readonly string[];
    readonly error?: string;
  };
  readonly nuclei?: {
    readonly status: 'completed' | 'failed';
    readonly engineVersion: string;
    readonly templateBundleHash?: string;
    readonly importedCount: number;
    readonly duplicateCount: number;
    readonly quarantinedCount: number;
    readonly excludedOutOfScope: number;
    readonly error?: string;
  };
  /** 取込所見のうち反射系 XSS について browser で実行確認した結果 (design/30 30.1)。 */
  readonly payloadVerifications?: readonly ActiveScanPayloadVerification[];
}

export interface ActiveScanPayloadVerification {
  readonly findingId: string;
  readonly title: string;
  readonly url: string;
  /** dialog 発火等、payload が実行された根拠が得られたか。 */
  readonly executed: boolean;
  readonly signals: readonly string[];
  readonly evidenceRef?: string;
  readonly error?: string;
}

export interface DiagnosticRouteResult {
  readonly track: DiagnosticTrack;
  readonly targetUrl: string;
  readonly candidateCount: number;
  readonly status: 'delegated' | 'executed' | 'needs-input' | 'unavailable';
  readonly detail: string;
  readonly findingCount?: number;
}

export interface GuidelineRouteResult extends GuidelineAutomationDisclosure {
  readonly routeId: string;
  readonly themeNo: string;
  readonly guidelineIds: readonly string[];
  readonly status: 'delegated' | 'executed' | 'needs-input' | 'unavailable';
  readonly detail: string;
  readonly checkId?: string;
  readonly checkStatus?: 'pass' | 'fail' | 'inconclusive';
}

export interface ActiveScanExecutionEvent {
  readonly at: string;
  readonly phase: 'starting' | 'running' | 'collecting' | 'completed' | 'stopping' | 'stopped';
  readonly engine: 'zap' | 'nuclei' | 'scopepilot';
  readonly message: string;
  readonly command?: string;
  readonly progress?: number;
  readonly requestsReportedByEngine?: number;
}

export interface ActiveScanExecutionControl {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ActiveScanExecutionEvent) => void;
}

export interface ImportNucleiResultsInput {
  /** 観測された Nuclei JSONL 出力 (原本)。engine 実行はこの経路では行わない。 */
  readonly lines: readonly string[];
  readonly engineVersion: string;
}

export interface ImportNucleiResultsResult {
  /** 取込後の全所見 (ZAP 由来を含む)。 */
  readonly findings: readonly Finding[];
  readonly importedCount: number;
  readonly duplicateCount: number;
  /** malformed 行数。quarantine しても処理は継続する (f18 §6)。 */
  readonly quarantinedCount: number;
  /** 案件 scope 外の matched-at は案件の所見に含めない。 */
  readonly excludedOutOfScope: number;
  readonly evidenceRef: string;
}

const MAX_POLL_ITERATIONS = 1000;

export class BaselineFlowService {
  readonly jobs: JobRegistry;
  private readonly auditListeners = new Set<(event: BaselineFlowEvent, seq: number) => void>();
  subscribeAudit(listener: (event: BaselineFlowEvent, seq: number) => void): () => void { this.auditListeners.add(listener); return () => { this.auditListeners.delete(listener); }; }
  readonly guidelineCoverage = bundledGuidelineCoverage();
  private latestCoverageRunId: string | undefined;

  private aggregate: CaseAggregate | null = null;
  private authorization: AuthorizationRecord | null = null;
  private readonly eventsLog: BaselineFlowEvent[] = [];
  private readonly importer: FindingImporter;
  private readonly scanPolicies = new ScanPolicyRegistry();
  private passiveQueued = 0;
  private passiveProcessed = 0;
  private passiveFailed = 0;
  /** proxy の break queue (design/f02)。deadline 経過は既定で drop (暗黙 forward しない)。 */
  private readonly breakQueue = new BreakQueue(100);

  /** HTTP 通信 log と endpoint 集約 (design/f03)。探索・Repeater・Fuzzer の観測通信を記録する。 */
  private readonly trafficLog: readonly { exchangeId: string; url: string; method: string; status: number; contentType: string; at: string; source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer' | 'workflow-scan'; jobId?: string }[] = [];
  private readonly siteMapProjector = new SiteMapProjector();

  /** 業務ロジック検証の実行履歴 (design/f17)。 */
  private readonly businessChecks: readonly { checkId: string; roles: readonly string[]; targetUrl: string; status: string; comparison: string; restore: string; executedAt: string }[] = [];

  /** ZAP非対応テーマ代替検証の実行履歴 (Excel「ZAP非対応項目と代替検証手段」)。 */
  private readonly authBypassChecks: readonly AuthBypassCheckRecord[] = [];

  /** テーマ2以降の代替検証実行履歴 (テーマ1は authBypassChecks)。 */
  private readonly zapUnsupportedChecks: readonly { checkId: string; themeNo: string; role: string | null; status: 'pass' | 'fail' | 'inconclusive'; totalRequests: number; skipped?: readonly string[]; executedAt: string }[] = [];

  /** 認証・session 管理 (design/f09)。secret 値は参照のみ保持し、値は受け付けない。 */
  private readonly loginFlows = new Map<string, { flowVersion: string; steps: readonly LoginFlowStep[]; secretReferences: readonly string[] }>();
  private readonly authenticationUsers = new Map<string, AuthenticationUser>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly sessionVerifications = new Map<string, SessionVerification>();
  private readonly verificationFlights = new Map<string, Promise<SessionVerification>>();
  private readonly roleRegistry = new RoleSessionRegistry();
  private readonly sessionRevisions = new Map<string, number>();
  private readonly sessionCoordinator = new SessionCoordinator({
    refresh: async (role: string) => {
      // fixture adapter: 新 session を発行する (token 値は返り値で使うだけで保存しない)。
      return `session-${role}-${this.deps.ids.next('token')}`;
    },
  });

  /** Fuzzer の payload catalog (design/f05)。供給元・版・license 登録を必須とする。 */
  private readonly payloadCatalog = new PayloadCatalog();
  private readonly payloadSetNames: string[] = [];
  private readonly payloadRegistrations = new Map<string, PayloadSetRegistration>();
  private readonly fuzzJobs = new Map<string, { view: FuzzRunView; cancelled: boolean }>();
  fuzzerStatus(): { transport: 'fixture' | 'http' } {
    const kind = this.deps.fuzzTransport?.adapterKind;
    return { transport: this.deps.fuzzTransport === undefined || kind === 'fixture' ? 'fixture' : 'http' };
  }
  getFuzzJob(runId: string): FuzzRunView {
    const job = this.fuzzJobs.get(runId);
    if (!job) throw domainError('ValidationFailed', 'unknown fuzz run');
    return { ...job.view, rows: [...job.view.rows] };
  }
  stopFuzzJob(operator: OperatorProfile, runId: string): FuzzRunView {
    this.requirePermission(operator, 'run.manage');
    const job = this.fuzzJobs.get(runId);
    if (!job) throw domainError('ValidationFailed', 'unknown fuzz run');
    job.cancelled = true;
    return this.getFuzzJob(runId);
  }
  startFuzzJob(operator: OperatorProfile, input: FuzzInput): FuzzRunView {
    this.requirePermission(operator, 'run.manage');
    if ([...this.fuzzJobs.values()].some(job => job.view.state === 'Running')) throw domainError('Conflict', 'a fuzzer run is already running');
    const runId = this.deps.ids.next('fuzz-job');
    const job = { view: { runId, targetUrl: input.targetUrl, transport: this.fuzzerStatus().transport, state: 'Running', total: 0, sent: 0, rows: [] } as FuzzRunView, cancelled: false };
    this.fuzzJobs.set(runId, job);
    if (this.fuzzJobs.size > 20) this.fuzzJobs.delete(this.fuzzJobs.keys().next().value!);
    void this.runFuzzSession(operator, input, {
      isCancelled: () => job.cancelled,
      progress: (total, rows, payloadSources) => { job.view = { ...job.view, total, sent: rows.length, rows: [...rows], payloadSources }; },
    }).then(result => { job.view = { ...job.view, payloadSources: result.payloadSources, state: job.cancelled ? 'Stopped' : 'Completed' }; }, (cause: unknown) => {
      job.view = { ...job.view, state: 'Failed', error: cause instanceof Error ? cause.message : 'Fuzzer failed' };
    });
    return this.getFuzzJob(runId);
  }

  private readonly fuzzRuns: readonly { adapterKind: AdapterKind; runId: string; targetUrl: string; total: number; sent: number; clusters: readonly { key: string; members: readonly number[]; representative: readonly string[] }[]; executedAt: string }[] = [];

  /** OAST の attempt・観測 (design/f13)。token は発行時に一度だけ応答し、一覧には出さない。 */
  private readonly oastIssuer = new TokenIssuer();
  private readonly oastAttempts: { attemptId: string; targetUrl: string; protocol: OastProtocol; token: string; issuedAtMs: number; transport: ToolTransport }[] = [];
  private readonly oastSeenEventIds = new Set<string>();
  private readonly oastInteractions: { token: string; payload: string; recordedAt: string }[] = [];
  private readonly oastUncorrelated: { token: string; reason: string; recordedAt: string }[] = [];
  private readonly oastCallbacks: {
    eventId: string;
    attemptId: string | null;
    protocol: OastProtocol;
    remoteAddress?: string;
    recordedAt: string;
    rawHash: string;
    correlation: 'correlated' | 'uncorrelated';
    transport: ToolTransport;
  }[] = [];

  /** WebSocket connection/frame 台帳 (design/f14)。text のみ・frame は connection 単位で表示する。 */
  private readonly wsConnections: {
    connectionId: string;
    logicalSessionId: string;
    targetUrl: string;
    transport: ToolTransport;
    state: 'closed' | 'failed' | 'imported';
    openedAt: string;
    sentFrames: number;
    receivedFrames: number;
    negotiatedSubprotocol?: string;
  }[] = [];
  private readonly wsFrames: (WsFrame & {
    connectionId: string;
    targetUrl: string;
    transport: ToolTransport;
  })[] = [];
  private readonly wsSeenFingerprints = new Set<string>();
  private wsSessionRevision = 1;

  /** CA profile の信頼登録状態 (design/24。既定は未登録)。 */
  private caProfileTrusted = false;

  /** 読み込み済み extension (design/f20)。manifest の署名検証を通過したもののみ。 */
  private readonly loadedExtensions: readonly { extensionId: string; version: string; permissions: readonly string[]; apiRange: readonly string[] }[] = [];

  /** 取り込んだ API 仕様の記録 (design/f12)。endpoint の一覧は都度応答する。 */
  private readonly apiSpecImports: readonly { documentLabel: string; servers: readonly string[]; excludedServers: readonly string[]; endpoints: readonly (ParsedOpenApiEndpoint & { readonly url: string })[]; importedAt: string }[] = [];

  /** Sequencer session の台帳 (design/f07)。token 原文は保存しない (統計のみ)。 */
  private readonly sequencerSessions: readonly SequencerSessionRecord[] = [];

  /** Repeater の draft 台帳 (design/f04)。tab 上限は domain (20)。 */
  private readonly repeaterDrafts = new DraftRegistry();
  private readonly repeaterDraftOrder: string[] = [];
  private readonly repeaterAttempts: SendAttemptRecord[] = [];
  /** fixture adapter が受け取った送信 command (実 adapter 接続までの記録)。 */
  private readonly repeaterSentCommands: import('../domain/repeater.ts').SendCommand[] = [];

  /** site map 用の観測台帳 (URL 単位・再観測は上書き、初回観測順を維持)。 */
  private readonly observationsByUrl = new Map<string, PageObservation>();
  /** scope により拒否された URL の記録 (design/02 A04 の開示用)。 */
  private readonly deniedUrlLog: readonly { url: string; reason: string }[] = [];
  /**
   * 入力文書由来の document hints (AGENTS.md 入力ドキュメントの活用)。
   * URL は計画構築時に許可 Origin 内だけ追加開始点へ統合され、単独では観測を作らない。
   */
  private readonly documentHintDocuments: { documentLabel: string; urls: readonly string[] }[] = [];
  /** 入力文書由来の認証情報 hint (AGENTS.md・design/08)。所在のみで秘密値は持たない。 */
  private readonly documentAuthHintDocuments: DocumentAuthHintEntry[] = [];
  /** 入力文書由来の優先付け規則 (AGENTS.md: pii・payment を高優先)。探索の処理順に効く。 */
  private readonly documentPriorityRules: readonly DocumentPriorityRule[] = [];
  /** 入力文書由来の parameter バリエーション (AGENTS.md: fuzzer positions の未確認参照)。 */
  private readonly documentParameterHintDocuments: DocumentParameterHintEntry[] = [];
  /** 計画ごとの hint 由来開始点 (canonical)。観測の由来 (document-hint) 判定に使う。 */
  private readonly explorationHintSeeds = new Map<string, ReadonlySet<string>>();
  /** runLogin で得た role session (cookie 値は service 内部のみ。API・監査へ出さない)。 */
  private readonly roleSessionCookies = new Map<string, {
    readonly cookies: readonly LoginSessionCookie[];
    readonly browserState: BrowserSessionState;
    readonly createdAt: string;
    readonly expectedUrlPrefix?: string;
    readonly verificationUrl?: string;
    readonly verificationMarkers?: readonly string[];
  }>();
  /**
   * login 実行時の観測 (role ごと・最新 1 件)。SPA の XHR 裏付け認証 API は
   * 探索では観測できないため、ここから診断候補を補完する (design/f09)。
   */
  private readonly workflowObservations = new Map<string, PageObservation>();
  private readonly loginObservations = new Map<string, PageObservation>();
  private exploredUrlCount = 0;
  private scannedUrlCount = 0;
  private latestCandidates: readonly ScanCandidate[] = [];
  private adoptedCandidateUrls = new Set<string>();
  private scannedUrls = new Set<string>();
  private assessmentStartedAt: string | undefined;
  private assessmentEndedAt: string | undefined;
  private authenticationRole: string | null = null;
  private latestDiagnosticRoutes: readonly DiagnosticRouteResult[] = [];
  private latestUnsupportedAssessments: readonly UnsupportedAssessment[] | undefined;
  private latestGuidelineRoutes: readonly GuidelineRouteResult[] = [];
  private delegatedSteps: {
    readonly stepId: string;
    readonly engineKind: 'zap' | 'nuclei' | 'node-http';
    readonly engineVersion: string;
  }[] = [];

  private readonly deps: BaselineFlowDeps;

  constructor(deps: BaselineFlowDeps) {
    this.deps = { ...deps };
    this.runtimeProfile = deps.runtimeProfile ?? 'production';
    this.configuredAt = deps.clock.now().toISOString();
    this.adapterSnapshot = this.describeToolAdapters();
    this.jobs = new JobRegistry(deps.jobStore);
    this.eventsLog.push(...(deps.jobStore?.loadAudit() ?? []));
    this.importer = new FindingImporter(deps.initialFindings ?? []);
  }

  /**
   * 案件ワークスペースを開くとき、SQLite に保存済みの正本を in-memory aggregate へ戻す。
   * 外部入力用 API ではなく desktop/CLI の構成層だけが使用する。復元時に新しい監査 event は
   * 作らず、以後の更新・実行は通常 command と同じ検証を通す。
   */
  restoreWorkspace(record: CaseRecord, authorization?: AuthorizationRecord): void {
    this.requirePositiveLimits(record.scope.limits, 'case');
    if (record.name.trim() === '' || record.caseId.trim() === '') {
      throw domainError('ValidationFailed', 'stored case is invalid');
    }
    const allowed = record.scope.allowedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
    const denied = record.scope.deniedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
    if (allowed.length === 0) {
      throw domainError('ValidationFailed', 'stored case must have at least one allowed origin');
    }
    if (authorization !== undefined && authorization.caseId !== record.caseId) {
      throw domainError('ValidationFailed', 'stored authorization belongs to another case');
    }
    this.latestCoverageRunId = undefined;
    this.aggregate = CaseAggregate.open({
      ...record,
      scope: {
        allowedOrigins: [...new Set(allowed)],
        deniedOrigins: [...new Set(denied)],
        limits: record.scope.limits,
      },
    });
    this.authorization = authorization ?? null;
  }

  events(): readonly BaselineFlowEvent[] {
    return [...this.eventsLog];
  }

  /** 現在の全所見 (作成順)。UI/CLI の organizer 表示用。 */
  listFindings(): readonly Finding[] {
    return this.importer.list();
  }

  listPassiveRules(operator: OperatorProfile): readonly import('@scopepilot2/contracts').PassiveRule[] {
    this.requirePermission(operator, 'case.read');
    return PASSIVE_RULES.map((rule) => ({ ...rule }));
  }

  listPassiveAlerts(operator: OperatorProfile): readonly Finding[] {
    this.requirePermission(operator, 'case.read');
    return this.importer.list().filter((finding) => finding.passive !== undefined);
  }

  passiveStatus(operator: OperatorProfile): import('@scopepilot2/contracts').PassiveStatus {
    this.requirePermission(operator, 'case.read');
    return { source: 'scopepilot-observation', queued: this.passiveQueued, processed: this.passiveProcessed,
      failed: this.passiveFailed, alerts: this.listPassiveAlerts(operator).length,
      limitations: ['件数はこのセッションの探索観測単位です。ZAP pscan のキューではありません。',
        '観測したフォームのメタデータのみを検査します。HTTP ヘッダー・本文全体や未観測ページは対象外です。ルールは現在参照のみです。'] };
  }

  private async processPassiveObservation(observation: PageObservation): Promise<void> {
    this.passiveQueued += 1;
    try {
      const candidates = passiveObservationCandidates(observation);
      if (candidates.length > 0) {
        const evidence = await this.deps.evidence.saveText('passive-observation', canonicalJson({
          url: observation.finalUrl ?? observation.url, status: observation.status,
          candidates: candidates.map((candidate) => candidate.passive),
        }));
        const result = this.importer.importObservationCandidates(candidates, {
          now: this.deps.clock.now().toISOString(), engineVersion: 'scopepilot-passive-1',
          makeFindingId: () => this.deps.ids.next('finding'), evidenceRef: evidence.evidenceId,
        });
        this.persistFindings([...result.created, ...result.reobserved]);
      }
      this.passiveProcessed += 1;
    } catch {
      // Failed evidence storage must not manufacture candidates or stop exploration.
      this.passiveFailed += 1;
    } finally {
      this.passiveQueued -= 1;
    }
  }

  mergeFindings(operator: OperatorProfile, findingId: string, intoFindingId: string, reason: string): readonly Finding[] {
    this.requirePermission(operator, 'finding.confirm');
    const before = this.listFindings().find(f => f.findingId === findingId);
    const at = this.deps.clock.now().toISOString();
    const updated = this.importer.merge(findingId, intoFindingId, reason, operator.operatorId, at);
    this.persistFindings(updated);
    this.record({ type: 'FindingStatusChanged', at, findingId, from: before!.status, to: 'merged', changedBy: operator.operatorId });
    return updated;
  }

  async listEvidence(operator: OperatorProfile, evidenceId?: string): Promise<readonly import('@scopepilot2/contracts').EvidenceView[]> {
    this.requirePermission(operator, 'case.read');
    this.currentCase();
    if (this.deps.evidence.list === undefined) throw domainError('CapabilityUnavailable', 'evidence listing is unavailable');
    const records = this.deps.evidence.list().filter(r => evidenceId === undefined || r.evidenceId === evidenceId);
    if (evidenceId !== undefined && records.length === 0) throw domainError('ValidationFailed', 'evidence does not exist');
    return Promise.all(records.map(async record => projectEvidence(record, this.listFindings(),
      evidenceId === undefined ? null : await this.deps.evidence.readText?.(record.evidenceId) ?? null)));
  }

  private persistFindings(findings: readonly Finding[]): void {
    const caseId = this.currentCase().caseId;
    for (const finding of findings) {
      const key = finding.source.kind === 'nuclei-match'
        ? `nuclei|${finding.enginePluginId ?? ''}|${finding.url}`
        : dedupeKeyOf({
          engineAlertId: finding.findingId,
          pluginId: finding.enginePluginId ?? '',
          name: finding.title,
          risk: finding.severity === 'info' || finding.severity === 'unknown'
            ? 'Informational'
            : finding.severity === 'low' ? 'Low' : finding.severity === 'medium' ? 'Medium' : 'High',
          url: finding.url,
          method: finding.method ?? 'GET',
          ...(finding.param === undefined ? {} : { param: finding.param }),
          evidenceSummary: '',
        });
      this.deps.findingSink?.save(caseId, key, finding);
    }
  }

  /** site map (観測済み page の一覧・初回観測順)。 */
  listObservations(): readonly PageObservation[] {
    return [...this.observationsByUrl.values()];
  }

  /** A40 の候補表。文書 hint だけでは候補を作らず、探索/API観測で得た候補だけを返す。 */
  listScanCandidates(operator: OperatorProfile): readonly ScanCandidate[] {
    this.requirePermission(operator, 'run.manage');
    this.currentCase();
    return [...this.latestCandidates];
  }

  /** A43: 案件単位の名前付き診断ポリシー。 */
  listScanPolicies(operator: OperatorProfile): readonly ScanPolicy[] {
    this.requirePermission(operator, 'case.read');
    const caseRecord = this.currentCase();
    return this.scanPolicies.list(caseRecord.caseId, this.deps.clock.now().toISOString());
  }

  /**
   * A43: revision guard 付き保存。内容 hash が変わったときだけ plan confirmation を失効する。
   * ZAP 個別 rule ID は契約に存在せず、Core でも受け付けない。
   */
  saveScanPolicy(operator: OperatorProfile, input: SaveScanPolicyRequest): {
    readonly policy: ScanPolicy;
    readonly changed: boolean;
    readonly invalidatedConfirmationIds: readonly string[];
  } {
    this.requirePermission(operator, 'case.manage');
    const caseRecord = this.currentCase();
    const policyId = input.policyId?.trim() || this.deps.ids.next('scan-policy');
    const saved = this.scanPolicies.save(caseRecord.caseId, input, policyId, this.deps.clock.now().toISOString());
    const invalidatedConfirmationIds = saved.changed
      ? this.currentAggregate().invalidateActiveConfirmations('scan policy changed')
      : [];
    if (invalidatedConfirmationIds.length > 0) {
      this.record({
        type: 'ConfirmationsInvalidated',
        at: this.deps.clock.now().toISOString(),
        caseId: caseRecord.caseId,
        confirmationIds: invalidatedConfirmationIds,
        reason: 'scan policy changed',
      });
    }
    return { ...saved, invalidatedConfirmationIds };
  }

  /** 探索で scope 拒否された URL (開示用)。 */
  private recordWorkflowObservation(result: Awaited<ReturnType<InteractiveBrowserPort['execute']>>): void {
    const scope = this.currentCase().scope;
    if (!ScopePolicy.decide(scope, result.finalUrl).allowed) return;
    const observation: PageObservation = {
      url: result.finalUrl, status: result.status ?? 0, contentType: 'text/html', discoveredFrom: null,
      depth: 0, originType: 'crawl', links: [], forms: [],
      requests: (result.observedRequests ?? []).filter((request) => ScopePolicy.decide(scope, request.url).allowed),
      clientRoutes: (result.clientRoutes ?? []).filter((route) => ScopePolicy.decide(scope, route.url).allowed),
    };
    this.observationsByUrl.set(observation.url, observation);
    this.workflowObservations.set(observation.url, observation);
    const extra = candidatesFromObservation(observation, this.deps.ids).map((candidate) => ({ ...candidate, provenance: [{ source: 'reviewed-workflow', url: observation.url }] }));
    const keys = new Set(this.latestCandidates.map((candidate) => `${candidate.method}|${candidate.url}`));
    this.latestCandidates = rankCandidates([...this.latestCandidates, ...extra.filter((candidate) => !keys.has(`${candidate.method}|${candidate.url}`) && !isSessionControlUrl(candidate.url))]);
  }

  listAssetObservations(): readonly import('@scopepilot2/contracts').AssetObservation[] {
    const assets = this.listObservations().flatMap((observation) => observation.assets ?? []);
    return [...new Map(assets.map((asset) => [asset.url, asset])).values()];
  }

  listDeniedUrls(): readonly { url: string; reason: string }[] {
    return [...this.deniedUrlLog];
  }

  /**
   * 入力文書由来の document hint の登録 (AGENTS.md 入力ドキュメントの活用)。
   * 文書の記載は観測事実ではないため、hint 単独では観測・所見を作らず、
   * 計画構築時に許可 Origin 内の URL だけ追加開始点として統合する。
   * acceptedUrlCount は現在の案件 scope で許可された URL 数 (監査にも記録)。
   */
  registerDocumentHints(
    operator: OperatorProfile,
    input: { readonly documentLabel: string; readonly urls: readonly string[] },
  ): { documentLabel: string; urlCount: number; acceptedUrlCount: number } {
    this.requirePermission(operator, 'case.manage');
    if (input.documentLabel.trim() === '') {
      throw domainError('ValidationFailed', 'documentLabel must not be empty');
    }
    if (input.urls.length === 0) {
      throw domainError('ValidationFailed', 'document hints need at least one URL');
    }
    const caseRecord = this.currentCase();
    const acceptedUrlCount = mergeDocumentHintSeeds([], input.urls, caseRecord.scope).hintTargets.length;
    this.documentHintDocuments.push({ documentLabel: input.documentLabel, urls: [...input.urls] });
    this.record({
      type: 'DocumentHintsRegistered',
      at: this.deps.clock.now().toISOString(),
      documentLabel: input.documentLabel,
      urlCount: input.urls.length,
      acceptedUrlCount,
    });
    return { documentLabel: input.documentLabel, urlCount: input.urls.length, acceptedUrlCount };
  }

  /** 登録済み document hints (文書 label と URL の一覧)。 */
  listDocumentHints(): readonly { documentLabel: string; urls: readonly string[] }[] {
    return [...this.documentHintDocuments];
  }

  /**
   * 入力文書由来の認証情報 hint の登録 (AGENTS.md・design/08 AuthMethod)。
   * ロール・認証方式・文書内の所在のみを扱い、秘密値は受け付けない
   * (「文書の記載」であり観測事実ではないため未確認として表示する)。
   */
  registerDocumentAuthHints(
    operator: OperatorProfile,
    input: { readonly documentLabel: string; readonly entries: readonly DocumentAuthHint[] },
  ): { documentLabel: string; entryCount: number } {
    this.requirePermission(operator, 'case.manage');
    if (input.documentLabel.trim() === '') {
      throw domainError('ValidationFailed', 'documentLabel must not be empty');
    }
    if (input.entries.length === 0) {
      throw domainError('ValidationFailed', 'auth hints need at least one entry');
    }
    for (const [index, entry] of input.entries.entries()) {
      if (entry.role.trim() === '') {
        throw domainError('ValidationFailed', `auth hints[${index}]: role must not be empty`);
      }
      if (!DocumentAuthMethods.includes(entry.authMethod)) {
        throw domainError('ValidationFailed', `auth hints[${index}]: authMethod not allowed: ${String(entry.authMethod)}`);
      }
      if (entry.documentLocation.trim() === '') {
        throw domainError('ValidationFailed', `auth hints[${index}]: documentLocation must not be empty`);
      }
    }
    this.documentAuthHintDocuments.push({ documentLabel: input.documentLabel, entries: [...input.entries] });
    this.record({
      type: 'DocumentAuthHintsRegistered',
      at: this.deps.clock.now().toISOString(),
      documentLabel: input.documentLabel,
      entryCount: input.entries.length,
    });
    return { documentLabel: input.documentLabel, entryCount: input.entries.length };
  }

  /** 登録済みの認証情報 hint (文書 label・所在のみ。値は保持しない)。 */
  listDocumentAuthHints(): readonly DocumentAuthHintEntry[] {
    return [...this.documentAuthHintDocuments];
  }

  /**
   * 入力文書由来の優先付け規則の登録 (AGENTS.md: クローリング結果の優先付け)。
   * 個人情報に類するもの (pii)・決済に関わるもの (payment) を高優先として探索の
   * 処理順に反映する。規則は URL の部分一致。
   */
  registerDocumentPriorityHints(
    operator: OperatorProfile,
    input: { readonly documentLabel: string; readonly rules: readonly DocumentPriorityRule[] },
  ): { documentLabel: string; ruleCount: number } {
    this.requirePermission(operator, 'case.manage');
    if (input.documentLabel.trim() === '') {
      throw domainError('ValidationFailed', 'documentLabel must not be empty');
    }
    if (input.rules.length === 0) {
      throw domainError('ValidationFailed', 'priority hints need at least one rule');
    }
    for (const [index, rule] of input.rules.entries()) {
      if (rule.urlIncludes.trim() === '') {
        throw domainError('ValidationFailed', `rules[${index}]: urlIncludes must not be empty`);
      }
      if (!DocumentPriorityCategories.includes(rule.category)) {
        throw domainError('ValidationFailed', `rules[${index}]: category not allowed: ${String(rule.category)}`);
      }
    }
    (this.documentPriorityRules as DocumentPriorityRule[]).push(...input.rules);
    this.record({
      type: 'DocumentPriorityHintsRegistered',
      at: this.deps.clock.now().toISOString(),
      documentLabel: input.documentLabel,
      ruleCount: input.rules.length,
    });
    return { documentLabel: input.documentLabel, ruleCount: input.rules.length };
  }

  /** 登録済みの優先付け規則の一覧。 */
  listDocumentPriorityRules(): readonly DocumentPriorityRule[] {
    return [...this.documentPriorityRules];
  }

  /**
   * 入力文書由来の API parameter バリエーションの登録 (AGENTS.md)。
   * 文書の記載は未確認のため A07 の fuzzer positions の「参照」としてのみ表示し、
   * 自動的には適用しない。
   */
  registerDocumentParameterHints(
    operator: OperatorProfile,
    input: { readonly documentLabel: string; readonly parameters: readonly DocumentParameterHint[] },
  ): { documentLabel: string; parameterCount: number } {
    this.requirePermission(operator, 'case.manage');
    if (input.documentLabel.trim() === '') {
      throw domainError('ValidationFailed', 'documentLabel must not be empty');
    }
    if (input.parameters.length === 0) {
      throw domainError('ValidationFailed', 'parameter hints need at least one parameter');
    }
    for (const [index, parameter] of input.parameters.entries()) {
      if (parameter.name.trim() === '') {
        throw domainError('ValidationFailed', `parameters[${index}]: name must not be empty`);
      }
      if (parameter.values.length === 0) {
        throw domainError('ValidationFailed', `parameters[${index}]: values need at least one entry`);
      }
    }
    this.documentParameterHintDocuments.push({ documentLabel: input.documentLabel, parameters: [...input.parameters] });
    this.record({
      type: 'DocumentParameterHintsRegistered',
      at: this.deps.clock.now().toISOString(),
      documentLabel: input.documentLabel,
      parameterCount: input.parameters.length,
    });
    return { documentLabel: input.documentLabel, parameterCount: input.parameters.length };
  }

  /** 登録済みの parameter バリエーション (未確認参照)。 */
  listDocumentParameterHints(): readonly DocumentParameterHintEntry[] {
    return [...this.documentParameterHintDocuments];
  }

  /** URL が優先付け規則に一致するか (探索の処理順用)。 */
  private isPrioritizedUrl(canonical: string): boolean {
    return this.documentPriorityRules.some((rule) => canonical.includes(rule.urlIncludes));
  }

  /** 観測通信の記録 (traffic log と endpoint 集約の両方に入れる)。 */
  private recordObservedExchange(summary: { url: string; method: string; status: number; contentType: string }, at: string, source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer' | 'workflow-scan', requestAlreadyCounted = false): void {
    const context = jobContext.getStore();
    const exchangeId = this.deps.ids.next('exchange');
    if (context) {
      const counters = context.registry.get(context.jobId)!.summary.counters;
      context.registry.emit(context.jobId, { category: 'request', messageKey: 'job.request.sent', message: 'HTTP request observed', params: { method: summary.method, status: summary.status }, refs: { url: summary.url, exchangeId }, counters: { budget: { ...counters.budget, used: counters.budget.used + (requestAlreadyCounted ? 0 : 1) }, requestsSent: counters.requestsSent + (requestAlreadyCounted ? 0 : 1), ...(summary.status >= 500 ? { errors: counters.errors + 1 } : {}) } });
    }
    (this.trafficLog as { exchangeId: string; url: string; method: string; status: number; contentType: string; at: string; source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer' | 'workflow-scan'; jobId?: string }[]).push({
      exchangeId,
      ...summary,
      ...(context === undefined ? {} : { jobId: context.jobId }),
      at,
      source,
    });
    this.siteMapProjector.add(summary);
  }

  /**
   * HTTP 通信一覧 (design/f03)。limit は 1〜500。総数が 100,000 を超えると一覧ではなく
   * 集約 (summary) mode になる (F03-UT-005/006)。list mode は最近の通信から返す。
   */
  listTraffic(limit: number): {
    mode: 'list' | 'summary';
    total: number;
    entries?: readonly { exchangeId: string; url: string; method: string; status: number; contentType: string; at: string; source: string }[];
  } {
    const plan = planTrafficQuery(this.trafficLog.length, limit);
    if (plan.mode === 'summary') {
      return { mode: 'summary', total: this.trafficLog.length };
    }
    const entries = [...this.trafficLog].slice(-plan.limit).reverse();
    return { mode: 'list', total: this.trafficLog.length, entries };
  }

  /** endpoint 集約 (origin/path/method/content-type/status。query は同一視・F03-UT-004)。 */
  listSiteMapEndpoints(): readonly ReturnType<SiteMapProjector['list']>[number][] {
    return this.siteMapProjector.list();
  }

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
  enqueueBreakItem(
    operator: OperatorProfile,
    input: { readonly direction: 'request' | 'response'; readonly messageReference: string; readonly holdMs?: number },
  ): BreakItem {
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
      deadlineMs: nowMs + (input.holdMs ?? 60_000),
      originalRequestHash: hashStable('scopepilot2.request', input.messageReference),
    });
  }

  /** 保持中 item の判断。scope 外 URL への編集は forward されず reject される (F02-UT-004)。 */
  decideBreakItem(
    operator: OperatorProfile,
    itemId: string,
    edited: { readonly requestHash: string; readonly targetUrl: string },
  ): InterceptDecision {
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
  async runBusinessLogicCheck(
    operator: OperatorProfile,
    input: { readonly roles: readonly string[]; readonly targetUrl: string; readonly expectation: { readonly expression: string; readonly args: readonly unknown[] } },
  ): Promise<{
    checkId: string;
    roles: readonly string[];
    matrix: { readonly evidenceSeparated: boolean };
    observations: readonly { role: string; observation: string | null }[];
    comparison: { readonly outcome: ComparisonOutcome };
    restore: { readonly outcome: 'restored' | 'restore-failed' };
    status: 'pass' | 'fail' | 'not-run';
    reason?: string;
  }> {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    const authorization = this.currentAuthorization();
    if (!authorization.allowedOperationClasses.includes('CrossRoleTest')) {
      throw domainError('OutOfScope', 'authorization does not allow CrossRoleTest for this case');
    }
    if (input.roles.length < 2 || new Set(input.roles).size !== input.roles.length) {
      throw domainError('ValidationFailed', 'business logic check needs 2 or more distinct roles');
    }
    for (const role of input.roles) {
      if (!this.loginFlows.has(role)) {
        throw domainError('ValidationFailed', `login flow for ${role} is not registered`);
      }
    }
    if (!businessTargetInScope(input.targetUrl, caseRecord.scope)) {
      throw domainError('OutOfScope', `business target is out of scope: ${input.targetUrl}`);
    }
    const expectation = parseExpectation(input.expectation);
    const matrix = planRoleMatrix(input.roles);
    // fixture 観測: session を refresh 済みの role だけが認証付き観測を持つ (未 refresh は null)。
    if (this.deps.interactiveBrowser === undefined) throw domainError('CapabilityUnavailable', 'business logic browser is not configured');
    const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
    const measured: { role: string; response: Awaited<ReturnType<InteractiveBrowserPort['execute']>> | null }[] = [];
    for (const role of input.roles) {
      const session = this.roleSessionCookies.get(role);
      if (session === undefined) {
        measured.push({ role, response: null });
        continue;
      }
      measured.push({
        role,
        response: await this.deps.interactiveBrowser.execute({
          targetUrl: canonical,
          scope: caseRecord.scope,
          steps: [{ kind: 'navigate', target: canonical }],
          sessionCookies: applicableSessionCookies(session.cookies, canonical),
        }),
      });
    }
    const observations = measured.map(({ role, response }) => ({
      role,
      observation: response === null ? null : `status=${response.status ?? 'unknown'};bodyHash=${response.bodyHash}`,
    }));
    const primary = measured[0]?.response ?? null;
    // どれかの role でも観測が欠けたら inconclusive (成功/失敗を推測しない)。
    let comparison: { outcome: ComparisonOutcome };
    if (measured.some((entry) => entry.response === null) || primary === null) {
      comparison = { outcome: 'inconclusive' };
    } else {
      const first = input.expectation.args[0];
      const second = input.expectation.args[1];
      let matched: boolean | null = null;
      if (expectation.expression === 'status.equals') matched = typeof first === 'number' && primary.status === first;
      else if (expectation.expression === 'status.in') matched = input.expectation.args.some((value) => typeof value === 'number' && value === primary.status);
      else if (expectation.expression === 'body.contains') matched = typeof first === 'string' && primary.bodyText.includes(first);
      else if (expectation.expression === 'body.notContains') matched = typeof first === 'string' && !primary.bodyText.includes(first);
      else if (expectation.expression === 'header.equals') matched = typeof first === 'string' && typeof second === 'string'
        && primary.headers.some(([name, value]) => name.toLocaleLowerCase() === first.toLocaleLowerCase() && value === second);
      else if (expectation.expression === 'elapsedMs.lessThan') matched = typeof first === 'number' && primary.elapsedMs < first;
      else if (expectation.expression === 'elapsedMs.greaterThan') matched = typeof first === 'number' && primary.elapsedMs > first;
      comparison = matched === null ? { outcome: 'inconclusive' } : { outcome: matched ? 'pass' : 'fail' };
    }
    const restore = evaluateRestore([
      { name: 'verify-state', passed: comparison.outcome !== 'fail' },
      { name: 'restore-navigate', passed: true },
    ]);
    const outcome = resolveOutcome({ setupBlocked: false, assertionPassed: comparison.outcome === 'pass' && restore.outcome === 'restored' });
    const checkId = this.deps.ids.next('bizcheck');
    const record = {
      checkId,
      roles: [...input.roles],
      targetUrl: input.targetUrl,
      status: outcome.status,
      comparison: comparison.outcome,
      restore: restore.outcome,
      executedAt: this.deps.clock.now().toISOString(),
    };
    (this.businessChecks as { checkId: string; roles: readonly string[]; targetUrl: string; status: string; comparison: string; restore: string; executedAt: string }[]).push(record);
    await this.deps.evidence.saveText(`business-logic:${checkId}`, canonicalJson({
      checkId,
      targetUrl: canonical,
      roles: measured.map(({ role, response }) => response === null ? { role, observation: null } : {
        role,
        status: response.status,
        finalUrl: response.finalUrl,
        bodyHash: response.bodyHash,
        elapsedMs: response.elapsedMs,
        headerNames: response.headers.map(([name]) => name),
      }),
      expectation: { expression: input.expectation.expression, argTypes: input.expectation.args.map((value) => typeof value) },
      comparison: comparison.outcome,
    }), { targetUrl: canonical, kind: 'business-logic' });
    this.record({ type: 'BusinessLogicCheckCompleted', at: record.executedAt, checkId, roles: [...input.roles], status: outcome.status });
    return {
      checkId,
      roles: [...input.roles],
      matrix: { evidenceSeparated: matrix.evidenceSeparated },
      observations,
      comparison,
      restore,
      status: outcome.status,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    };
  }

  listBusinessLogicChecks(): readonly { checkId: string; roles: readonly string[]; targetUrl: string; status: string; comparison: string; restore: string; executedAt: string }[] {
    return [...this.businessChecks];
  }

  /**
   * ZAP非対応テーマ1「認証回避・強制ブラウジング」の代替検証 (作業用 Excel
   * 「ZAP非対応項目と代替検証手段」No.1、IPA手順「認証回避」相当)。
   * runLogin 済み role の session を使い、認証用 cookie の書き換え (空値・削除)・
   * 未認証での直接アクセス・password 書き換え再ログインの応答を観測する。
   * cookie 値・秘密値・応答本文は監査・応答へ出さない (marker は transient に判定)。
   */
  async runAuthBypassCheck(
    operator: OperatorProfile,
    input: {
      readonly role: string;
      readonly targetUrls?: readonly string[];
      readonly authCookieNames?: readonly string[];
      readonly includeLoginVariants?: boolean;
      readonly secretValues?: Readonly<Record<string, string>>;
      readonly loginBaseUrl?: string;
    },
  ): Promise<AuthBypassCheckSummary> {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    const authorization = this.currentAuthorization();
    if (!authorization.allowedOperationClasses.includes('ActiveScan')) {
      throw domainError('OutOfScope', 'authorization does not allow ActiveScan for this case');
    }
    const session = this.roleSessionCookies.get(input.role);
    if (session === undefined) {
      throw domainError('ValidationFailed', `no authenticated session for role '${input.role}'; run login first`);
    }
    const targetUrls = input.targetUrls === undefined || input.targetUrls.length === 0
      ? (session.verificationUrl === undefined ? [] : [session.verificationUrl])
      : input.targetUrls;
    for (const target of targetUrls) {
      if (!businessTargetInScope(target, caseRecord.scope)) {
        throw domainError('OutOfScope', `auth bypass target is out of scope: ${target}`);
      }
    }
    const includeLoginVariants = input.includeLoginVariants === true;
    const plan = planAuthBypassCheck({ targetUrls, includeLoginVariants });
    if (plan.totalRequests > caseRecord.scope.limits.maxRequests) {
      throw domainError('ValidationFailed', `auth bypass check needs ${plan.totalRequests} requests which exceeds the case limit ${caseRecord.scope.limits.maxRequests}`);
    }
    if (this.deps.interactiveBrowser === undefined) {
      throw domainError('CapabilityUnavailable', 'interactive browser is not configured for this service');
    }
    // Excel 注意欄どおり、書き換え対象は利用者が事前に特定した認証用 cookie に限る。
    // 全 cookie を暗黙に対象にすると、認証回避ではなくセッション破壊を観測してしまう。
    const requestedCookieNames = (input.authCookieNames ?? []).map((name) => name.trim()).filter((name) => name !== '');
    if (requestedCookieNames.length === 0) {
      throw domainError('NeedsInput', 'theme 1 requires explicitly identified authentication cookie names');
    }
    const sessionCookieNames = new Set(session.cookies.map((cookie) => cookie.name));
    const unknownCookieNames = requestedCookieNames.filter((name) => !sessionCookieNames.has(name));
    if (unknownCookieNames.length > 0) {
      throw domainError('ValidationFailed', `authentication cookie names are not present in the selected session: ${unknownCookieNames.join(', ')}`);
    }
    const authCookieNames = new Set(requestedCookieNames);
    const markers = session.verificationMarkers ?? [];
    const containsMarker = (bodyText: string): boolean => markers.some((marker) => bodyText.includes(marker));

    // 観測 → 判定の 2 段階で使うため、判定結果だけ mutable に持つ。
    const probes: (Omit<AuthBypassProbeResult, 'outcome'> & { outcome: AuthBypassProbeOutcome | null })[] = [];
    const runPageProbe = async (targetUrl: string, pattern: AuthBypassPagePattern): Promise<void> => {
      const canonical = ScopePolicy.canonicalUrl(targetUrl);
      const cookies = sessionCookiesForPattern(applicableSessionCookies([...session.cookies], canonical), pattern, authCookieNames);
      const response = await this.deps.interactiveBrowser!.execute({
        targetUrl: canonical,
        scope: caseRecord.scope,
        steps: [{ kind: 'navigate', target: canonical }],
        ...(cookies === undefined ? {} : { sessionCookies: cookies }),
      });
      probes.push({
        kind: 'page',
        pattern,
        targetUrl: canonical,
        status: response.status,
        finalUrl: response.finalUrl,
        bodyHash: response.bodyHash,
        outcome: null,
        markersFound: markers.length === 0 ? null : containsMarker(response.bodyText),
      });
    };
    for (const targetUrl of plan.targetUrls) {
      await runPageProbe(targetUrl, 'session-baseline');
    }
    // baseline で認証後コンテンツを確認できた target だけ変種を送る (未確認 target は無駄打ちしない)。
    const baselineByTarget = new Map(plan.targetUrls.map((targetUrl) => {
      const canonical = ScopePolicy.canonicalUrl(targetUrl);
      return [canonical, probes.find((probe) => probe.pattern === 'session-baseline' && probe.targetUrl === canonical)];
    }));
    for (const targetUrl of plan.targetUrls) {
      const canonical = ScopePolicy.canonicalUrl(targetUrl);
      const baseline = baselineByTarget.get(canonical);
      if (baseline === undefined || baseline.markersFound === false) {
        continue;
      }
      for (const pattern of ['auth-cookie-emptied', 'auth-cookie-removed', 'no-session'] as const) {
        await runPageProbe(targetUrl, pattern);
      }
    }
    // 判定は観測の後で一括して行う (baseline と変種の hash・marker を比較するため)。
    for (const probe of probes) {
      if (probe.pattern === 'session-baseline') {
        // baseline は判定対象ではなく参照観測。認証後コンテンツ未確認の場合だけ記録する。
        probe.outcome = probe.markersFound === false ? 'inconclusive' : null;
        continue;
      }
      const baseline = baselineByTarget.get(probe.targetUrl);
      if (baseline === undefined) {
        probe.outcome = 'inconclusive';
        continue;
      }
      probe.outcome = judgePageProbe({
        markers,
        baseline: { status: baseline.status, bodyHash: baseline.bodyHash, markersFound: baseline.markersFound === true },
        variant: { status: probe.status, finalUrl: probe.finalUrl, targetUrl: probe.targetUrl, bodyHash: probe.bodyHash, markersFound: probe.markersFound === true },
      });
    }

    // IPA手順 ③: ログイン要求の password 書き換え。秘密値はこの実行の間だけ使う。
    const loginVariantsNotRun: string[] = [];
    if (includeLoginVariants) {
      const flow = this.loginFlows.get(input.role);
      const executor = this.deps.loginExecutor;
      if (flow === undefined || executor === undefined || input.secretValues === undefined) {
        loginVariantsNotRun.push(...plan.loginPatterns);
      } else {
        const passwordReference = input.secretValues.password !== undefined && flow.secretReferences.includes('password')
          ? 'password'
          : flow.secretReferences.find((reference) => flow.steps.some((step) => step.kind === 'fill' && step.secretReference === reference));
        if (passwordReference === undefined || input.secretValues[passwordReference] === undefined) {
          throw domainError('NeedsInput', `secret value for reference '${String(passwordReference)}' was not provided for login variants`);
        }
        const loginBaseUrl = input.loginBaseUrl ?? session.expectedUrlPrefix ?? new URL(plan.targetUrls[0]!).origin;
        for (const pattern of plan.loginPatterns) {
          const variantSecrets: Record<string, string> = { ...input.secretValues };
          let steps = flow.steps;
          if (pattern === 'password-omitted') {
            steps = steps.filter((step) => !(step.kind === 'fill' && step.secretReference === passwordReference));
          } else {
            variantSecrets[passwordReference] = derivePasswordVariant(pattern, input.secretValues[passwordReference]!);
          }
          const result = await executor.execute({
            baseUrl: loginBaseUrl,
            steps,
            secretValues: variantSecrets,
            expectedUrlPrefix: session.expectedUrlPrefix ?? loginBaseUrl,
          });
          probes.push({
            kind: 'login',
            pattern,
            targetUrl: loginBaseUrl,
            status: null,
            finalUrl: result.finalUrl,
            bodyHash: '',
            outcome: judgeLoginVariant(result.authenticated),
            markersFound: null,
          });
        }
      }
    }

    const judged = probes.filter((probe) => probe.outcome !== null);
    const summary = summarizeAuthBypassOutcomes(judged.map((probe) => probe.outcome!));
    const checkId = this.deps.ids.next('authbypass');
    const record: AuthBypassCheckRecord = {
      checkId,
      themeNo: '1',
      role: input.role,
      status: summary.status,
      totalRequests: probes.length,
      loginVariantsNotRun,
      executedAt: this.deps.clock.now().toISOString(),
    };
    (this.authBypassChecks as AuthBypassCheckRecord[]).push(record);
    // 監査記録: cookie 名・marker 名・応答の status/hash のみ。値も本文も含めない。
    await this.deps.evidence.saveText(`auth-bypass:${checkId}`, canonicalJson({
      checkId,
      themeNo: record.themeNo,
      role: input.role,
      authCookieNames: [...authCookieNames],
      markers,
      results: probes.map((probe) => ({
        kind: probe.kind,
        pattern: probe.pattern,
        targetUrl: probe.targetUrl,
        status: probe.status,
        finalUrl: probe.finalUrl,
        bodyHash: probe.bodyHash,
        outcome: probe.outcome,
      })),
      status: summary.status,
    }), { targetUrl: plan.targetUrls[0] ?? '', kind: 'auth-bypass' });
    this.record({ type: 'AuthBypassCheckCompleted', at: record.executedAt, checkId, role: input.role, status: summary.status });
    return { ...record, results: probes };
  }

  listAuthBypassChecks(): readonly AuthBypassCheckListItem[] {
    return [...this.authBypassChecks];
  }

  /**
   * ZAP非対応テーマ代替検証 (テーマ2以降の Top10 対象分)。テーマごとの handler が
   * 既存 port (browser・login 実行器・repeater transport・fuzz transport・DOM 観測・
   * nuclei) を使い、判定は domain の純関数に任せる。cookie 値・秘密値・応答本文は
   * 監査・応答へ出さない (本文の検査は transient、記録は hash・件数のみ)。
   */
  async runZapUnsupportedCheck(
    operator: OperatorProfile,
    input: {
      readonly themeNo: string;
      readonly role?: string;
      readonly targetUrls?: readonly string[];
      readonly params?: Readonly<Record<string, string>>;
      readonly secretValues?: Readonly<Record<string, string>>;
    },
  ): Promise<ThemeCheckSummary> {
    this.requirePermission(operator, 'run.manage');
    const themeNo = requireImplementedTheme(input.themeNo);
    if (themeNo === '1') {
      // テーマ1は専用 route (POST /api/auth-bypass/checks) を使う。
      throw domainError('ValidationFailed', 'theme 1 uses POST /api/auth-bypass/checks');
    }
    const caseRecord = this.currentCase();
    const authorization = this.currentAuthorization();
    if (!authorization.allowedOperationClasses.includes('ActiveScan')) {
      throw domainError('OutOfScope', 'authorization does not allow ActiveScan for this case');
    }
    const targets = (input.targetUrls ?? []).map((url) => url.trim()).filter((url) => url !== '');
    for (const target of targets) {
      if (!businessTargetInScope(target, caseRecord.scope)) {
        throw domainError('OutOfScope', `theme ${themeNo} target is out of scope: ${target}`);
      }
    }
    const params = input.params ?? {};
    const secrets = input.secretValues ?? {};
    const requireSession = (): { role: string; cookies: readonly LoginSessionCookie[]; browserState: BrowserSessionState; markers: readonly string[] } => {
      const role = input.role ?? '';
      const session = this.roleSessionCookies.get(role);
      if (session === undefined) {
        throw domainError('ValidationFailed', `no authenticated session for role '${role}'; run login first`);
      }
      return { role, cookies: session.cookies, browserState: session.browserState, markers: session.verificationMarkers ?? [] };
    };
    const requireFlow = (role: string | undefined): { steps: readonly LoginFlowStep[]; markers: readonly string[] } => {
      const flow = this.loginFlows.get(role ?? '');
      if (flow === undefined) {
        throw domainError('ValidationFailed', `login flow for '${role ?? ''}' is not registered`);
      }
      return { steps: flow.steps, markers: flow.steps.flatMap((step) => step.kind === 'assert' && step.target !== undefined ? [step.target] : []) };
    };
    const browser = () => {
      if (this.deps.interactiveBrowser === undefined) throw domainError('CapabilityUnavailable', 'interactive browser is not configured for this service');
      return this.deps.interactiveBrowser;
    };
    const repeater = () => {
      return this.requireToolAdapter('repeaterTransport');
    };
    const probes: (Omit<ThemeCheckProbeResult, 'outcome'> & { outcome: AuthBypassProbeOutcome | null })[] = [];
    let skipped: string[] = [];
    const requestBudget = (planned: number): void => assertRequestBudget(planned, caseRecord.scope.limits.maxRequests, themeNo);

    /** f09 の flow DSL を browser DSL へ解決する (fill の値はこの呼出の間だけ使う)。 */
    const translateFlow = (steps: readonly LoginFlowStep[], secretValues: Readonly<Record<string, string>>, baseUrl: string): InteractiveBrowserStep[] => {
      const resolveTarget = (target: string): string => target.startsWith('http://') || target.startsWith('https://') ? target : `${new URL(baseUrl).origin}/${target.replace(/^\/+/, '')}`;
      return steps.map((step): InteractiveBrowserStep => {
        if (step.kind === 'navigate') return { kind: 'navigate', target: resolveTarget(step.target ?? baseUrl) };
        if (step.kind === 'fill') {
          const value = secretValues[step.secretReference ?? ''];
          if (value === undefined) {
            throw domainError('NeedsInput', `secret value for reference '${step.secretReference ?? ''}' was not provided`);
          }
          return { kind: 'fill', target: step.target ?? '', value };
        }
        if (step.kind === 'select' || step.kind === 'assertValue') return { kind: step.kind, target: step.target ?? '', value: step.value ?? '' };
        if (step.kind === 'extract') {
          throw domainError('ValidationFailed', 'extract step is not supported by the interactive browser DSL');
        }
        return { kind: step.kind, target: step.target ?? '' };
      });
    };
    const runFlow = async (pattern: string, targetUrl: string, steps: readonly LoginFlowStep[], secretValues: Readonly<Record<string, string>>): Promise<{ status: number | null; finalUrl: string; bodyHash: string; comparisonHash: string; elapsedMs: number; assertionsPassed: boolean; echoedSecretReferences: readonly string[] }> => {
      const response = await browser().execute({ targetUrl: ScopePolicy.canonicalUrl(targetUrl), scope: caseRecord.scope, steps: translateFlow(steps, secretValues, targetUrl) });
      const assertionsPassed = response.assertions.every((assertion) => assertion.passed);
      // 応答への値の露出は「この実行で渡した値」だけで判定する。'password' は画面に
      // 出る語であり誤検知になるため除外する (Excel: パスワードが応答に含まれる)。
      const echoedSecretReferences = Object.entries(secretValues)
        .filter(([, value]) => value !== '' && value !== 'password' && response.bodyText.includes(value))
        .map(([reference]) => reference);
      const comparisonHash = hashStable('scopepilot2.theme.response-comparison', { body: normalizeEnumerationResponse(response.bodyText) });
      return { status: response.status, finalUrl: response.finalUrl, bodyHash: response.bodyHash, comparisonHash, elapsedMs: response.elapsedMs, assertionsPassed, echoedSecretReferences };
    };
    const rawRequest = (method: string, targetUrl: string, headers: readonly (readonly [string, string])[], body: string): string => {
      const parsed = new URL(targetUrl);
      return `${method.toUpperCase()} ${parsed.pathname}${parsed.search} HTTP/1.1\nHost: ${parsed.host}\n${headers.map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${body}`;
    };
    const headerValue = (headers: readonly (readonly [string, string])[], name: string): string | null => {
      const found = headers.find(([headerName]) => headerName.toLocaleLowerCase() === name.toLocaleLowerCase());
      return found === undefined ? null : found[1];
    };

    switch (themeNo) {
      case '2': {
        // 既定アカウント・既定資格: 文書由来の少数組を login 形式で試行 (辞書攻撃ではない)。
        const role = input.role ?? '';
        const flow = requireFlow(role);
        const session = this.roleSessionCookies.get(role);
        const expectedUrlPrefix = params.expectedUrlPrefix ?? session?.expectedUrlPrefix ?? new URL(targets[0] ?? 'http://fixture.invalid/').origin;
        const pairs = parseDefaultCredentialPairs((params.defaultPairs ?? '').split('\n'));
        requestBudget(pairs.length);
        const usernameRef = params.usernameReference ?? 'username';
        const passwordRef = params.passwordReference ?? 'password';
        for (const pair of pairs) {
          const run = await runFlow(`default-credential:${pair.username}`, expectedUrlPrefix, flow.steps, { [usernameRef]: pair.username, [passwordRef]: pair.password });
          const authenticated = detectAuthState({ expectedUrlPrefix, finalUrl: run.finalUrl, assertResult: run.assertionsPassed });
          probes.push({ kind: 'flow', pattern: `default-credential:${pair.username}`, targetUrl: expectedUrlPrefix, status: run.status, finalUrl: run.finalUrl, bodyHash: run.bodyHash, outcome: authenticated === 'authenticated' ? 'exposed' : 'denied' });
        }
        break;
      }
      case '3': {
        // パスワードポリシー: IPA検出パターンの弱い値の受理と、応答への露出 (表示)。
        const steps = JSON.parse(params.steps ?? '[]') as LoginFlowStep[];
        validateLoginFlow(steps);
        const fieldReference = params.fieldReference ?? '';
        if (fieldReference.trim() === '') {
          throw domainError('ValidationFailed', 'theme 3 requires fieldReference (the secret reference of the new password field)');
        }
        const baseUrl = targets[0];
        if (baseUrl === undefined) throw domainError('ValidationFailed', 'theme 3 requires a target URL (flow base)');
        const usernameReference = params.usernameReference ?? 'username';
        const usernameCandidate = secrets[usernameReference];
        const candidates: readonly { label: string; value: string; expected: 'reject' | 'accept-control' }[] = [
          ...WEAK_PASSWORD_CANDIDATES.map((value) => ({ label: value === '' ? '(empty)' : value, value, expected: 'reject' as const })),
          ...(usernameCandidate === undefined ? [] : [{ label: '(same-as-username)', value: usernameCandidate, expected: 'reject' as const }]),
          { label: '(IPA-acceptance-control)', value: PASSWORD_POLICY_CONTROL, expected: 'accept-control' as const },
        ];
        requestBudget(candidates.length);
        let echoOutcome: AuthBypassProbeOutcome | null = null;
        for (const candidate of candidates) {
          const run = await runFlow(`password-policy:${candidate.label}`, baseUrl, steps, { ...secrets, [fieldReference]: candidate.value });
          const outcome: AuthBypassProbeOutcome | null = candidate.expected === 'reject'
            ? (run.assertionsPassed ? 'exposed' : 'denied')
            : (run.assertionsPassed ? null : 'inconclusive');
          probes.push({ kind: 'flow', pattern: `password-policy:${candidate.label}`, targetUrl: ScopePolicy.canonicalUrl(baseUrl), status: run.status, finalUrl: run.finalUrl, bodyHash: run.bodyHash, outcome });
          if (run.echoedSecretReferences.includes(fieldReference)) {
            echoOutcome = judgePasswordEcho(true);
          }
        }
        if (echoOutcome !== null) {
          probes.push({ kind: 'browser', pattern: 'password-echo-in-response', targetUrl: ScopePolicy.canonicalUrl(baseUrl), status: null, finalUrl: '', bodyHash: '', outcome: echoOutcome });
        }
        skipped = ['reversible-storage verification (requires storage/configuration review)', 'password-change side-effect restoration must be confirmed for the diagnostic account'];
        break;
      }
      case '4': {
        // パスワードリセット: 無効 token (空・forge・省略) で再設定が成立しないこと。
        const steps = JSON.parse(params.steps ?? '[]') as LoginFlowStep[];
        validateLoginFlow(steps);
        const fieldReference = params.fieldReference ?? '';
        if (fieldReference.trim() === '') {
          throw domainError('ValidationFailed', 'theme 4 requires fieldReference (the secret reference of the reset token field)');
        }
        const baseUrl = targets[0];
        if (baseUrl === undefined) throw domainError('ValidationFailed', 'theme 4 requires a target URL (flow base)');
        requestBudget(RESET_TOKEN_PATTERNS.length);
        for (const pattern of RESET_TOKEN_PATTERNS) {
          const variantSteps = pattern === 'token-omitted'
            ? steps.filter((step) => !(step.kind === 'fill' && step.secretReference === fieldReference))
            : steps;
          const variantSecrets = pattern === 'token-emptied' ? { ...secrets, [fieldReference]: '' } : pattern === 'token-forged' ? { ...secrets, [fieldReference]: forgeResetToken() } : secrets;
          const run = await runFlow(pattern, baseUrl, variantSteps, variantSecrets);
          probes.push({ kind: 'flow', pattern, targetUrl: ScopePolicy.canonicalUrl(baseUrl), status: run.status, finalUrl: run.finalUrl, bodyHash: run.bodyHash, outcome: run.assertionsPassed ? 'exposed' : 'denied' });
        }
        skipped = ['email receipt verification (requires mailbox integration)', 'token randomness analysis (use A10 Sequencer)'];
        break;
      }
      case '5': {
        // ロックアウト: 合意した少数の連続失敗後、正当資格で認証できるかの観察のみ。
        const role = input.role ?? '';
        const flow = requireFlow(role);
        const executor = this.deps.loginExecutor;
        if (executor === undefined) throw domainError('CapabilityUnavailable', 'login executor is not configured for this service');
        for (const reference of flow.steps.flatMap((step) => step.kind === 'fill' && step.secretReference !== undefined ? [step.secretReference] : [])) {
          if (secrets[reference] === undefined) {
            throw domainError('NeedsInput', `secret value for reference '${reference}' was not provided`);
          }
        }
        const session = this.roleSessionCookies.get(role);
        const baseUrl = params.baseUrl ?? session?.expectedUrlPrefix ?? new URL(targets[0] ?? 'http://fixture.invalid/').origin;
        const failureCount = Number.parseInt(params.failureCount ?? '5', 10);
        const sequence = planLockoutSequence(failureCount);
        requestBudget(sequence.length + 1);
        const fillRefs = flow.steps.flatMap((step) => step.kind === 'fill' && step.secretReference !== undefined ? [step.secretReference] : []);
        const passwordRef = fillRefs.includes('password') ? 'password' : fillRefs.at(-1) ?? 'password';
        const wrongSecrets = { ...secrets, [passwordRef]: `${secrets[passwordRef] ?? ''}A` };
        for (const pattern of sequence) {
          await executor.execute({ baseUrl, steps: flow.steps, secretValues: wrongSecrets, expectedUrlPrefix: baseUrl });
          probes.push({ kind: 'login', pattern, targetUrl: baseUrl, status: null, finalUrl: '', bodyHash: '', outcome: null });
        }
        let afterFailures: 'authenticated' | 'rejected' | 'errored';
        try {
          const final = await executor.execute({ baseUrl, steps: flow.steps, secretValues: secrets, expectedUrlPrefix: baseUrl });
          afterFailures = final.authenticated ? 'authenticated' : 'rejected';
        } catch {
          afterFailures = 'errored';
        }
        probes.push({ kind: 'login', pattern: 'correct-after-failures', targetUrl: baseUrl, status: null, finalUrl: '', bodyHash: '', outcome: judgeLockout(afterFailures) });
        skipped = ['high-volume / high-rate testing (JMeter scope, needs prior agreement)', 'precise rate-limit measurement'];
        break;
      }
      case '6': {
        // MFAの段階スキップを、一次認証直後のsessionで保護APIへ到達できるかに限定して確認する。
        // OTP値の取得・再利用やSAML assertion replayは、対象固有fixtureを別途レビューして行う。
        const signInTarget = targets[0];
        const protectedTarget = targets[1];
        if (signInTarget === undefined || protectedTarget === undefined) {
          throw domainError('ValidationFailed', 'theme 6 requires sign-in and protected target URLs');
        }
        const usernameReference = params.usernameReference ?? 'username';
        const passwordReference = params.passwordReference ?? 'password';
        const username = secrets[usernameReference];
        const password = secrets[passwordReference];
        if (username === undefined || password === undefined) {
          throw domainError('NeedsInput', `theme 6 requires secret values for '${usernameReference}' and '${passwordReference}'`);
        }
        // OTP sub-check (handoff 2026-10-31 P1): 必要入力と許可済み fixture inbox が
        // 揃った sub-check だけ実行し、残りは理由を付けて skip する (全体を pass にしない)。
        const otpInbox = this.deps.otpInbox;
        const otpIssueUrl = (params.otpIssueUrl ?? '').trim();
        const otpVerifyUrl = (params.otpVerifyUrl ?? '').trim();
        const otpVerifyField = (params.otpVerifyField ?? '').trim() || 'code';
        const otpSuccessMarker = params.otpSuccessMarker ?? '';
        const otpMailboxRef = (params.otpMailboxRef ?? '').trim();
        const otpBaseReady = otpIssueUrl !== '' && otpVerifyUrl !== '' && otpSuccessMarker !== '' && otpMailboxRef !== '' && otpInbox !== undefined;
        const otpWrongAttempts = (params.otpWrongAttempts ?? '').trim() === '' ? null : planOtpWrongAttempts(Number.parseInt(params.otpWrongAttempts ?? '0', 10));
        const otpExpiryWaitMs = (params.otpExpirySeconds ?? '').trim() === '' ? null : planOtpExpiryWaitMs(Number.parseInt(params.otpExpirySeconds ?? '0', 10));
        const otpDestinationChangeUrl = (params.otpDestinationChangeUrl ?? '').trim();
        const otpDestinationChangeMarker = params.otpDestinationChangeMarker ?? '';
        const otpDestinationReady = otpDestinationChangeUrl !== '' && otpDestinationChangeMarker !== '' && input.role !== undefined && this.roleSessionCookies.has(input.role);
        // SAML assertion replay は隔離された試験 IdP/SP fixture adapter が全体を駆動する
        // (Core は直接送信しない。IdP/SP が審査済み fixture であることは adapter 側で保証)。
        const samlFixture = this.deps.samlFixture;
        const samlIdpStartUrl = (params.samlIdpStartUrl ?? '').trim();
        const samlAcsUrl = (params.samlAcsUrl ?? '').trim();
        const samlReady = samlFixture !== undefined && samlIdpStartUrl !== '' && samlAcsUrl !== '';
        for (const otpEndpoint of [otpIssueUrl, otpVerifyUrl, otpDestinationChangeUrl]) {
          if (otpEndpoint !== '' && !businessTargetInScope(otpEndpoint, caseRecord.scope)) {
            throw domainError('OutOfScope', `theme 6 OTP endpoint is out of scope: ${otpEndpoint}`);
          }
        }
        requestBudget(2
          + (otpBaseReady ? 3 : 0)
          + (otpBaseReady && otpExpiryWaitMs !== null ? 2 : 0)
          + (otpBaseReady && otpWrongAttempts !== null ? 2 + otpWrongAttempts : 0)
          + (otpDestinationReady ? 1 : 0)
          + (samlReady ? 2 : 0));
        const form = new URLSearchParams({ username, password }).toString();
        const signIn = await repeater().send({
          targetUrl: signInTarget,
          requestBytes: rawRequest('POST', signInTarget, [['Content-Type', 'application/x-www-form-urlencoded']], form),
        });
        const cookies: LoginSessionCookie[] = signIn.headers
          .filter(([name]) => name.toLocaleLowerCase() === 'set-cookie')
          .flatMap(([, value]) => {
            const pair = /^([^=;\s]+)=([^;]*)/u.exec(value);
            if (pair === null || pair[1] === undefined || pair[2] === undefined || pair[2] === '') return [];
            const path = /;\s*Path=([^;]+)/iu.exec(value)?.[1] ?? '/';
            return [{ name: pair[1], value: pair[2], domain: new URL(signInTarget).hostname, path }];
          });
        // MFA entry points commonly issue a pending-session cookie with a 302.
        // Treat a non-error redirect as a valid control only when that cookie exists.
        const signInAccepted = signIn.status >= 200 && signIn.status < 400 && cookies.length > 0;
        probes.push({ kind: 'http', pattern: 'mfa-primary-control', targetUrl: signInTarget, status: signIn.status, finalUrl: signIn.redirectLocations.at(-1) ?? signInTarget, bodyHash: hashStable('scopepilot2.theme', { body: signIn.body.toString('utf8') }), outcome: signInAccepted ? null : 'inconclusive', detail: `sessionIssued=${String(cookies.length > 0)}` });
        let outcome: AuthBypassProbeOutcome = 'inconclusive';
        let protectedStatus: number | null = null;
        let protectedHash = '';
        if (signInAccepted) {
          const protectedResponse = await repeater().send({ targetUrl: protectedTarget, requestBytes: rawRequest('GET', protectedTarget, [], ''), sessionCookies: cookies });
          protectedStatus = protectedResponse.status;
          protectedHash = hashStable('scopepilot2.theme', { body: protectedResponse.body.toString('utf8') });
          outcome = protectedResponse.status >= 200 && protectedResponse.status < 300
            ? 'exposed'
            : protectedResponse.status === 401 || protectedResponse.status === 403
              ? 'denied'
              : 'inconclusive';
        }
        probes.push({ kind: 'http', pattern: 'mfa-stage-skip', targetUrl: protectedTarget, status: protectedStatus, finalUrl: protectedTarget, bodyHash: protectedHash, outcome });
        // ---- OTP sub-check。OTP値はこの呼び出しの間だけ保持し、probe結果・証跡へ出さない。 ----
        const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
        const sendOtpJson = async (targetUrl: string, body: string, marker: string, useCookies: readonly LoginSessionCookie[]): Promise<{ status: number; bodyHash: string; finalUrl: string; outcome: OtpSubmissionOutcome }> => {
          const response = await repeater().send({ targetUrl, requestBytes: rawRequest('POST', targetUrl, [['Content-Type', 'application/json']], body), ...(useCookies.length === 0 ? {} : { sessionCookies: useCookies }) });
          const text = response.body.toString('utf8');
          return {
            status: response.status,
            bodyHash: hashStable('scopepilot2.theme', { body: text }),
            finalUrl: response.redirectLocations.at(-1) ?? targetUrl,
            outcome: judgeOtpSubmission({ status: response.status, markerFound: text.includes(marker) }),
          };
        };
        const issueOtp = async (label: string): Promise<string | null> => {
          const issuedAfter = this.deps.clock.now().toISOString();
          const issue = await repeater().send({ targetUrl: otpIssueUrl, requestBytes: rawRequest('POST', otpIssueUrl, [['Content-Type', 'application/json']], '{}'), sessionCookies: cookies });
          probes.push({ kind: 'http', pattern: `otp-issue:${label}`, targetUrl: otpIssueUrl, status: issue.status, finalUrl: issue.redirectLocations.at(-1) ?? otpIssueUrl, bodyHash: hashStable('scopepilot2.theme', { body: issue.body.toString('utf8') }), outcome: null });
          const received = await otpInbox!.waitForOtp({ mailboxRef: otpMailboxRef, issuedAfter, timeoutMs: OTP_INBOX_TIMEOUT_MS });
          return received === null ? null : received.otp;
        };
        if (otpBaseReady) {
          // 正常対照: 新規OTPを期限内に1回だけ提出して受理を確認する (以後の sub-check の前提)。
          const controlOtp = await issueOtp('control');
          let control: OtpSubmissionOutcome = 'unknown';
          if (controlOtp === null) {
            probes.push({ kind: 'http', pattern: 'otp-reuse:control', targetUrl: otpVerifyUrl, status: null, finalUrl: '', bodyHash: '', outcome: 'inconclusive', detail: 'otp was not received from the authorized fixture inbox' });
          } else {
            const controlRun = await sendOtpJson(otpVerifyUrl, JSON.stringify({ [otpVerifyField]: controlOtp }), otpSuccessMarker, cookies);
            control = controlRun.outcome;
            probes.push({ kind: 'http', pattern: 'otp-reuse:control', targetUrl: otpVerifyUrl, status: controlRun.status, finalUrl: controlRun.finalUrl, bodyHash: controlRun.bodyHash, outcome: control === 'accepted' ? null : 'inconclusive' });
            // 再利用: 同一の使用済みOTPを同一sessionで再送する。
            const reuseRun = await sendOtpJson(otpVerifyUrl, JSON.stringify({ [otpVerifyField]: controlOtp }), otpSuccessMarker, cookies);
            probes.push({ kind: 'http', pattern: 'otp-reuse:resubmit', targetUrl: otpVerifyUrl, status: reuseRun.status, finalUrl: reuseRun.finalUrl, bodyHash: reuseRun.bodyHash, outcome: judgeOtpBoundary({ control, action: reuseRun.outcome }) });
          }
          if (otpExpiryWaitMs !== null) {
            // 寿命: 未使用の新規OTPを期限経過後に1回だけ提出する (実待機は上限内のみ)。
            const expiryOtp = await issueOtp('expiry');
            if (expiryOtp === null) {
              probes.push({ kind: 'http', pattern: 'otp-expiry:expired-submit', targetUrl: otpVerifyUrl, status: null, finalUrl: '', bodyHash: '', outcome: 'inconclusive', detail: 'otp was not received from the authorized fixture inbox' });
            } else {
              await sleep(otpExpiryWaitMs);
              const expiredRun = await sendOtpJson(otpVerifyUrl, JSON.stringify({ [otpVerifyField]: expiryOtp }), otpSuccessMarker, cookies);
              probes.push({ kind: 'http', pattern: 'otp-expiry:expired-submit', targetUrl: otpVerifyUrl, status: expiredRun.status, finalUrl: expiredRun.finalUrl, bodyHash: expiredRun.bodyHash, outcome: judgeOtpBoundary({ control, action: expiredRun.outcome }) });
            }
          } else {
            skipped.push('otp-expiry skipped: otpExpirySeconds (fixture-declared validity; wait capped at 120s) was not provided');
          }
          if (otpWrongAttempts !== null) {
            // 試行制限: 事前合意した少数の誤OTPの後、正規OTPが受理されるかだけを観察する。
            const attemptOtp = await issueOtp('attempt-limit');
            if (attemptOtp === null) {
              probes.push({ kind: 'http', pattern: 'otp-attempt-limit:correct-after-wrong', targetUrl: otpVerifyUrl, status: null, finalUrl: '', bodyHash: '', outcome: 'inconclusive', detail: 'otp was not received from the authorized fixture inbox' });
            } else {
              for (let index = 1; index <= otpWrongAttempts; index += 1) {
                const otpWidth = /^\d{4,10}$/u.test(attemptOtp) ? attemptOtp.length : 6;
                const candidate = String(index).padStart(otpWidth, '0').slice(-otpWidth);
                const wrongOtp = candidate === attemptOtp ? '9'.repeat(otpWidth) : candidate;
                const wrongRun = await sendOtpJson(otpVerifyUrl, JSON.stringify({ [otpVerifyField]: wrongOtp }), otpSuccessMarker, cookies);
                probes.push({ kind: 'http', pattern: `otp-attempt-limit:wrong-${index}`, targetUrl: otpVerifyUrl, status: wrongRun.status, finalUrl: wrongRun.finalUrl, bodyHash: wrongRun.bodyHash, outcome: null });
              }
              const correctRun = await sendOtpJson(otpVerifyUrl, JSON.stringify({ [otpVerifyField]: attemptOtp }), otpSuccessMarker, cookies);
              probes.push({ kind: 'http', pattern: 'otp-attempt-limit:correct-after-wrong', targetUrl: otpVerifyUrl, status: correctRun.status, finalUrl: correctRun.finalUrl, bodyHash: correctRun.bodyHash, outcome: judgeOtpBoundary({ control, action: correctRun.outcome }) });
            }
          } else {
            skipped.push('otp-attempt-limit skipped: otpWrongAttempts (agreed 1..5) was not provided');
          }
        } else {
          skipped.push(`otp-reuse/otp-expiry/otp-attempt-limit skipped: requires otpIssueUrl, otpVerifyUrl, otpSuccessMarker and otpMailboxRef${otpInbox === undefined ? ' plus a configured OTP inbox fixture adapter' : ''}`);
        }
        if (otpDestinationReady) {
          // 宛先変更: 認証済みsessionで再認証なしの宛先変更が受理されるか。変更通知の送信だけでは安全とみなさない。
          const destinationCookies = applicableSessionCookies([...this.roleSessionCookies.get(input.role!)!.cookies], otpDestinationChangeUrl) ?? [];
          const changeRun = await sendOtpJson(otpDestinationChangeUrl, params.otpDestinationChangeBodyJson ?? '{}', otpDestinationChangeMarker, destinationCookies);
          probes.push({ kind: 'http', pattern: 'otp-destination-change:without-reauth', targetUrl: otpDestinationChangeUrl, status: changeRun.status, finalUrl: changeRun.finalUrl, bodyHash: changeRun.bodyHash, outcome: changeRun.outcome === 'accepted' ? 'exposed' : changeRun.outcome === 'rejected' ? 'denied' : 'inconclusive', detail: 'reauth=not-performed (the supplied change body must not contain re-authentication)' });
        } else {
          skipped.push('otp-destination-change skipped: requires otpDestinationChangeUrl, otpDestinationChangeMarker and an authenticated role session');
        }
        if (samlReady) {
          // SAML assertion replay: 試験 IdP が正規発行した同一 assertion を、session reset 後に
          // 同一条件で再送する (生成・改ざんはしない)。assertion 本文は hash だけ記録する。
          const replay = await samlFixture!.issueAndReplay({ idpStartUrl: samlIdpStartUrl, acsUrl: samlAcsUrl, role: input.role ?? 'diag-user' });
          probes.push({
            kind: 'http',
            pattern: 'saml-assertion-replay',
            targetUrl: samlAcsUrl,
            status: replay.replayStatus,
            finalUrl: samlAcsUrl,
            bodyHash: replay.assertionHash,
            outcome: judgeSamlAssertionReplay({ controlAccepted: replay.controlAccepted, replayAccepted: replay.replayAccepted }),
            detail: `controlStatus=${replay.controlStatus === null ? '(none)' : String(replay.controlStatus)}; replayNewSession=${replay.replayAccepted === null ? 'unknown' : String(replay.replayAccepted)}`,
          });
        } else {
          skipped.push('SAML assertion replay skipped: requires samlIdpStartUrl, samlAcsUrl and a configured isolated test IdP/SP fixture adapter');
        }
        break;
      }
      case '7': {
        // ユーザ列挙: 正常系を確認した上で、既存/不在の誤資格応答を複数回比較する。
        const role = input.role ?? '';
        const flow = requireFlow(role);
        const nonexistentUsername = params.nonexistentUsername ?? '';
        if (nonexistentUsername.trim() === '') {
          throw domainError('ValidationFailed', 'theme 7 requires nonexistentUsername (an account that must not exist)');
        }
        const usernameRef = params.usernameReference ?? 'username';
        const passwordRef = params.passwordReference ?? 'password';
        if (secrets[usernameRef] === undefined || secrets[passwordRef] === undefined) {
          throw domainError('NeedsInput', `theme 7 requires secret values for '${usernameRef}' and '${passwordRef}'`);
        }
        if (secrets[usernameRef] === nonexistentUsername) {
          throw domainError('ValidationFailed', 'nonexistentUsername must differ from the existing username');
        }
        const baseUrl = params.baseUrl ?? new URL(targets[0] ?? 'http://fixture.invalid/').origin;
        const sampleCount = Number.parseInt(params.sampleCount ?? '3', 10);
        if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > 5) {
          throw domainError('ValidationFailed', 'theme 7 sampleCount must be 2..5');
        }
        const timingThresholdMs = Number.parseInt(params.timingThresholdMs ?? '250', 10);
        if (!Number.isInteger(timingThresholdMs) || timingThresholdMs < 50 || timingThresholdMs > 5_000) {
          throw domainError('ValidationFailed', 'theme 7 timingThresholdMs must be 50..5000');
        }
        requestBudget(sampleCount * 2 + 1);
        const control = await runFlow('existing-user-correct-password', baseUrl, flow.steps, secrets);
        probes.push({ kind: 'flow', pattern: 'existing-user-correct-password', targetUrl: baseUrl, status: control.status, finalUrl: control.finalUrl, bodyHash: control.bodyHash, outcome: control.assertionsPassed ? null : 'inconclusive', detail: `elapsedMs=${control.elapsedMs.toFixed(1)}` });
        const wrongPassword = `${secrets[passwordRef]!}A`;
        const existingRuns = [];
        const nonexistentRuns = [];
        for (let index = 0; index < sampleCount; index += 1) {
          const existingRun = await runFlow(`existing-user-wrong-password:${index + 1}`, baseUrl, flow.steps, { ...secrets, [passwordRef]: wrongPassword });
          existingRuns.push(existingRun);
          probes.push({ kind: 'flow', pattern: `existing-user-wrong-password:${index + 1}`, targetUrl: baseUrl, status: existingRun.status, finalUrl: existingRun.finalUrl, bodyHash: existingRun.bodyHash, outcome: null, detail: `elapsedMs=${existingRun.elapsedMs.toFixed(1)}` });
          const nonexistentRun = await runFlow(`nonexistent-user-wrong-password:${index + 1}`, baseUrl, flow.steps, { ...secrets, [usernameRef]: nonexistentUsername, [passwordRef]: wrongPassword });
          nonexistentRuns.push(nonexistentRun);
          probes.push({ kind: 'flow', pattern: `nonexistent-user-wrong-password:${index + 1}`, targetUrl: baseUrl, status: nonexistentRun.status, finalUrl: nonexistentRun.finalUrl, bodyHash: nonexistentRun.bodyHash, outcome: null, detail: `elapsedMs=${nonexistentRun.elapsedMs.toFixed(1)}` });
        }
        const existingRun = existingRuns[0]!;
        const nonexistentRun = nonexistentRuns[0]!;
        const average = (runs: readonly { elapsedMs: number }[]): number => runs.reduce((sum, run) => sum + run.elapsedMs, 0) / runs.length;
        const enumeration = judgeUserEnumeration(
          { status: existingRun.status, finalUrl: existingRun.finalUrl, bodyHash: existingRun.comparisonHash, averageElapsedMs: average(existingRuns) },
          { status: nonexistentRun.status, finalUrl: nonexistentRun.finalUrl, bodyHash: nonexistentRun.comparisonHash, averageElapsedMs: average(nonexistentRuns) },
          timingThresholdMs,
        );
        probes.push({ kind: 'browser', pattern: 'response-comparison', targetUrl: baseUrl, status: null, finalUrl: '', bodyHash: '', outcome: control.assertionsPassed ? enumeration : 'inconclusive', detail: `samples=${sampleCount}; existingAvgMs=${average(existingRuns).toFixed(1)}; nonexistentAvgMs=${average(nonexistentRuns).toFixed(1)}` });
        break;
      }
      case '9': {
        // JWT署名検証の最低限確認。正規tokenを対照にalg=none変種を再送する。
        const target = targets[0];
        if (target === undefined) throw domainError('ValidationFailed', 'theme 9 requires a JWT-protected target URL');
        // Renderer sends bearer credentials through secretValues. Keep params as a
        // compatibility fallback for older API clients.
        const token = secrets.validToken ?? params.validToken ?? '';
        if (token.trim() === '') throw domainError('NeedsInput', 'theme 9 requires validToken captured from the authorized test account');
        const parts = token.split('.');
        if (parts.length !== 3) throw domainError('ValidationFailed', 'theme 9 validToken is not a compact JWT');
        let header: Record<string, unknown>;
        let claims: Record<string, unknown>;
        try {
          header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
          claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
        } catch {
          throw domainError('ValidationFailed', 'theme 9 JWT header or claims are not valid JSON');
        }
        requestBudget(2);
        const unsignedHeader = Buffer.from(JSON.stringify({ ...header, alg: 'none' }), 'utf8').toString('base64url');
        const unsigned = `${unsignedHeader}.${parts[1]!}.`;
        const send = async (value: string) => repeater().send({ targetUrl: target, requestBytes: rawRequest('GET', target, [['Authorization', `Bearer ${value}`]], '') });
        const baseline = await send(token);
        const mutated = await send(unsigned);
        const baselineAccepted = baseline.status >= 200 && baseline.status < 300;
        const unsignedAccepted = mutated.status >= 200 && mutated.status < 300;
        probes.push({ kind: 'http', pattern: 'jwt-valid-control', targetUrl: target, status: baseline.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: baseline.body.toString('utf8') }), outcome: baselineAccepted ? null : 'inconclusive' });
        probes.push({ kind: 'http', pattern: 'jwt-alg-none', targetUrl: target, status: mutated.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: mutated.body.toString('utf8') }), outcome: !baselineAccepted ? 'inconclusive' : unsignedAccepted ? 'exposed' : 'denied' });
        const nowSeconds = Math.floor(this.deps.clock.now().getTime() / 1000);
        const exp = typeof claims.exp === 'number' ? claims.exp : null;
        probes.push({ kind: 'http', pattern: 'jwt-exp-claim', targetUrl: target, status: null, finalUrl: target, bodyHash: '', outcome: exp === null || exp > nowSeconds + 86_400 ? 'exposed' : 'denied', detail: `exp=${exp === null ? '(missing)' : String(exp)}` });
        skipped = ['OAuth/OIDC redirect, state, nonce, PKCE and issuer discovery require a registered authorization flow'];
        break;
      }
      case '10': {
        // IDOR: 候補ロールと、そのオブジェクトを正当に参照できる比較ロールの2セッションで比較。
        const candidateSession = requireSession();
        const otherRole = params.otherRole ?? '';
        if (otherRole === '' || otherRole === candidateSession.role) throw domainError('ValidationFailed', 'theme 10 requires a different otherRole with an authenticated session');
        const authorizedSession = this.roleSessionCookies.get(otherRole);
        if (authorizedSession === undefined) throw domainError('ValidationFailed', `no authenticated session for comparison role '${otherRole}'; run login first`);
        const template = targets[0];
        if (template === undefined) throw domainError('ValidationFailed', 'theme 10 requires a target URL with the object parameter');
        const objectParam = params.objectParam ?? '';
        const ownValue = params.ownValue ?? '';
        const otherValues = (params.otherValues ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '');
        const planned = planIdorProbes({ targetUrl: template, objectParam, ownValue, otherValues });
        requestBudget(planned.length);
        const runPage = async (url: string, browserSession: BrowserSessionState) => {
          const canonical = ScopePolicy.canonicalUrl(url);
          return await browser().execute({
            targetUrl: canonical,
            scope: caseRecord.scope,
            steps: [{ kind: 'navigate', target: canonical }],
            browserSession,
          });
        };
        const own = await runPage(planned[0]!.url, candidateSession.browserState);
        probes.push({ kind: 'browser', pattern: 'own-object-baseline', targetUrl: ScopePolicy.canonicalUrl(planned[0]!.url), status: own.status, finalUrl: own.finalUrl, bodyHash: own.bodyHash, outcome: own.status !== null && own.status < 400 ? null : 'inconclusive' });
        for (let index = 1; index < planned.length; index += 2) {
          const authorizedPlan = planned[index]!;
          const candidatePlan = planned[index + 1]!;
          const authorized = await runPage(authorizedPlan.url, authorizedSession.browserState);
          probes.push({ kind: 'browser', pattern: authorizedPlan.pattern, targetUrl: ScopePolicy.canonicalUrl(authorizedPlan.url), status: authorized.status, finalUrl: authorized.finalUrl, bodyHash: authorized.bodyHash, outcome: null });
          const candidate = await runPage(candidatePlan.url, candidateSession.browserState);
          const outcome = judgeIdorAccess({
            authorized: { status: authorized.status, finalUrl: authorized.finalUrl, bodyHash: authorized.bodyHash },
            candidate: { status: candidate.status, finalUrl: candidate.finalUrl, bodyHash: candidate.bodyHash },
          });
          probes.push({ kind: 'browser', pattern: candidatePlan.pattern, targetUrl: ScopePolicy.canonicalUrl(candidatePlan.url), status: candidate.status, finalUrl: candidate.finalUrl, bodyHash: candidate.bodyHash, outcome });
        }
        break;
      }
      case '11': {
        // マスアサインメント: base JSON に特権 field を merge した要求が受理されるか。
        const target = targets[0];
        if (target === undefined) throw domainError('ValidationFailed', 'theme 11 requires a target URL');
        const method = params.method ?? 'POST';
        const baseBody = params.jsonBody ?? '';
        if (baseBody.trim() === '') throw domainError('ValidationFailed', 'theme 11 requires jsonBody (the normal request body)');
        const extraFields = parseExtraFieldsJson(params.extraFieldsJson ?? '{}');
        const variantBody = mergeJsonFields(baseBody, extraFields);
        const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
        requestBudget(2);
        const headers: readonly (readonly [string, string])[] = [['Content-Type', 'application/json']];
        const baseline = await repeater().send({ targetUrl: target, requestBytes: rawRequest(method, target, headers, baseBody), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
        probes.push({ kind: 'http', pattern: 'baseline', targetUrl: target, status: baseline.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: baseline.body.toString('utf8') }), outcome: null });
        const variant = await repeater().send({ targetUrl: target, requestBytes: rawRequest(method, target, headers, variantBody), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
        const variantText = variant.body.toString('utf8');
        const successMarker = params.successMarker;
        const markerFound = successMarker === undefined ? null : variantText.includes(successMarker);
        probes.push({ kind: 'http', pattern: 'mass-assignment', targetUrl: target, status: variant.status, finalUrl: variant.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: variantText }), outcome: judgeMassAssignment({ variantStatus: variant.status, ...(successMarker === undefined ? {} : { successMarker, markerFound }) }), ...(markerFound === null ? {} : { markersFound: markerFound }) });
        skipped = successMarker === undefined && variant.status < 400 ? ['field reflection / persisted side-effect was not confirmed; HTTP success alone is not evidence'] : [];
        break;
      }
      case '13': {
        // CORS: Origin 書き換え再送と プリフライト確認。
        const target = targets[0];
        if (target === undefined) throw domainError('ValidationFailed', 'theme 13 requires a target URL');
        const origins = (params.evilOrigins ?? 'https://scopepilot.invalid').split(',').map((origin) => origin.trim()).filter((origin) => origin !== '');
        if (origins.length === 0 || origins.length > 3) throw domainError('ValidationFailed', 'theme 13 accepts 1..3 evil origins');
        const requestMethod = (params.requestMethod ?? 'GET').toUpperCase();
        const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
        const testOrigins = [...new Set([new URL(target).origin, ...origins, 'null'])];
        requestBudget(testOrigins.length * 2);
        for (const origin of testOrigins) {
          const getResponse = await repeater().send({ targetUrl: target, requestBytes: rawRequest(requestMethod, target, [['Origin', origin]], ''), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
          const outcome = origin === new URL(target).origin ? null : judgeCorsResponse({ requestOrigin: origin, acao: headerValue(getResponse.headers, 'Access-Control-Allow-Origin'), acac: headerValue(getResponse.headers, 'Access-Control-Allow-Credentials'), credentialsSent: (sessionCookies?.length ?? 0) > 0 });
          probes.push({ kind: 'http', pattern: `origin-reflect:${origin}`, targetUrl: target, status: getResponse.status, finalUrl: getResponse.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: getResponse.body.toString('utf8') }), outcome, ...(headerValue(getResponse.headers, 'Access-Control-Allow-Origin') === null ? {} : { detail: `acao=${headerValue(getResponse.headers, 'Access-Control-Allow-Origin') ?? ''}` }) });
          const optionsResponse = await repeater().send({ targetUrl: target, requestBytes: rawRequest('OPTIONS', target, [['Origin', origin], ['Access-Control-Request-Method', requestMethod]], '') });
          const preflight = origin === new URL(target).origin ? null : judgeCorsPreflight({ requestOrigin: origin, requestMethod, acao: headerValue(optionsResponse.headers, 'Access-Control-Allow-Origin'), acaom: headerValue(optionsResponse.headers, 'Access-Control-Allow-Methods') });
          probes.push({ kind: 'http', pattern: `preflight:${origin}`, targetUrl: target, status: optionsResponse.status, finalUrl: target, bodyHash: '', outcome: preflight, ...(headerValue(optionsResponse.headers, 'Access-Control-Allow-Methods') === null ? {} : { detail: `acaom=${headerValue(optionsResponse.headers, 'Access-Control-Allow-Methods') ?? ''}` }) });
        }
        break;
      }
      case '14': {
        // mail subject等へCRLFを入れ、正規値を対照に拒否されるか確認する。外部メールは送らない。
        const target = targets[0];
        if (target === undefined) throw domainError('ValidationFailed', 'theme 14 requires a mail submission target URL');
        const fieldName = params.fieldName ?? 'subject';
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(fieldName)) throw domainError('ValidationFailed', 'theme 14 fieldName is invalid');
        const baselineValue = params.baselineValue ?? 'ScopePilot local notice';
        const injectedValue = params.injectedValue ?? `${baselineValue}\r\nBcc: scopepilot-invalid@example.invalid`;
        const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
        requestBudget(2);
        const send = async (value: string) => repeater().send({
          targetUrl: target,
          requestBytes: rawRequest('POST', target, [['Content-Type', 'application/json']], JSON.stringify({ [fieldName]: value })),
          ...(sessionCookies === undefined ? {} : { sessionCookies }),
        });
        const baseline = await send(baselineValue);
        const injected = await send(injectedValue);
        const baselineAccepted = baseline.status >= 200 && baseline.status < 300;
        const injectionAccepted = injected.status >= 200 && injected.status < 300;
        probes.push({ kind: 'http', pattern: 'mail-header-baseline', targetUrl: target, status: baseline.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: baseline.body.toString('utf8') }), outcome: baselineAccepted ? null : 'inconclusive' });
        probes.push({ kind: 'http', pattern: 'mail-header-crlf', targetUrl: target, status: injected.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: injected.body.toString('utf8') }), outcome: !baselineAccepted ? 'inconclusive' : injectionAccepted ? 'exposed' : 'denied' });
        skipped = ['no external mail is sent; delivery-header proof requires a local inbox/oracle supplied by the target fixture'];
        break;
      }
      case '15': {
        // LDAP/CSV/ReDoS/Host 等の対象固有注入を、正常要求と利用者レビュー済み変異要求の差分で確認する。
        // 任意文字列をこちらで「成功」と推測せず、成立 marker または時間差を明示入力として要求する。
        const target = targets[0];
        if (target === undefined) throw domainError('ValidationFailed', 'theme 15 requires an injection target URL');
        const baselineJson = params.baselineJson ?? '';
        const variantJson = params.variantJson ?? '';
        if (baselineJson.trim() === '' || variantJson.trim() === '') {
          throw domainError('NeedsInput', 'theme 15 requires baselineJson and a reviewed variantJson');
        }
        const parseBody = (name: string, value: string): string => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(value) as unknown;
          } catch {
            throw domainError('ValidationFailed', `theme 15 ${name} must be valid JSON`);
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw domainError('ValidationFailed', `theme 15 ${name} must be a JSON object`);
          }
          if (Buffer.byteLength(value, 'utf8') > 65_536) throw domainError('ValidationFailed', `theme 15 ${name} exceeds 65536 bytes`);
          return JSON.stringify(parsed);
        };
        const baselineBody = parseBody('baselineJson', baselineJson);
        const variantBody = parseBody('variantJson', variantJson);
        const method = (params.method ?? 'POST').toUpperCase();
        if (!['POST', 'PUT', 'PATCH'].includes(method)) throw domainError('ValidationFailed', 'theme 15 method must be POST, PUT, or PATCH');
        const pattern = (params.pattern ?? 'reviewed-injection').trim();
        if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/iu.test(pattern)) throw domainError('ValidationFailed', 'theme 15 pattern is invalid');
        const successMarker = params.successMarker;
        const elapsedThresholdMs = params.elapsedThresholdMs === undefined ? null : Number.parseInt(params.elapsedThresholdMs, 10);
        if (successMarker === undefined && elapsedThresholdMs === null) {
          throw domainError('NeedsInput', 'theme 15 requires successMarker or elapsedThresholdMs so HTTP success is not misreported as injection');
        }
        if (elapsedThresholdMs !== null && (!Number.isInteger(elapsedThresholdMs) || elapsedThresholdMs < 100 || elapsedThresholdMs > 10_000)) {
          throw domainError('ValidationFailed', 'theme 15 elapsedThresholdMs must be 100..10000');
        }
        const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
        requestBudget(2);
        const send = async (body: string): Promise<{ response: Awaited<ReturnType<ReturnType<typeof repeater>['send']>>; elapsedMs: number }> => {
          const startedAt = performance.now();
          const response = await repeater().send({
            targetUrl: target,
            requestBytes: rawRequest(method, target, [['Content-Type', 'application/json']], body),
            ...(sessionCookies === undefined ? {} : { sessionCookies }),
          });
          return { response, elapsedMs: Math.max(0, performance.now() - startedAt) };
        };
        const baseline = await send(baselineBody);
        const variant = await send(variantBody);
        const baselineText = baseline.response.body.toString('utf8');
        const variantText = variant.response.body.toString('utf8');
        const baselineAccepted = baseline.response.status >= 200 && baseline.response.status < 300;
        const markerFound = successMarker === undefined ? null : variantText.includes(successMarker);
        const timingExposed = elapsedThresholdMs !== null
          && variant.elapsedMs >= elapsedThresholdMs
          && variant.elapsedMs >= Math.max(baseline.elapsedMs * 3, baseline.elapsedMs + 75);
        const rejected = variant.response.status === 400 || variant.response.status === 401 || variant.response.status === 403 || variant.response.status === 422;
        const outcome: AuthBypassProbeOutcome = !baselineAccepted
          ? 'inconclusive'
          : markerFound === true || timingExposed
            ? 'exposed'
            : rejected || markerFound === false || elapsedThresholdMs !== null
              ? 'denied'
              : 'inconclusive';
        probes.push({ kind: 'http', pattern: 'injection-baseline', targetUrl: target, status: baseline.response.status, finalUrl: baseline.response.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: baselineText }), outcome: baselineAccepted ? null : 'inconclusive', detail: `elapsedMs=${String(Math.round(baseline.elapsedMs))}` });
        probes.push({ kind: 'http', pattern: `injection:${pattern}`, targetUrl: target, status: variant.response.status, finalUrl: variant.response.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: variantText }), outcome, ...(markerFound === null ? {} : { markersFound: markerFound }), detail: `elapsedMs=${String(Math.round(variant.elapsedMs))}; marker=${markerFound === null ? 'unused' : String(markerFound)}` });
        skipped = ['only the supplied, reviewed injection variant was exercised; other interpreters in theme 15 remain separate checks'];
        break;
      }
      case '16': {
        // SSRF: 正常な公開URLを対照に、許可済みfixture/OAST URLへのサーバ側到達を marker で確認する。
        const target = targets[0];
        if (target === undefined) throw domainError('ValidationFailed', 'theme 16 requires an SSRF input endpoint URL');
        const baselineJson = params.baselineJson ?? '';
        const fieldName = (params.fieldName ?? 'url').trim();
        const probeUrl = params.probeUrl ?? '';
        const successMarker = params.successMarker;
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(fieldName)) throw domainError('ValidationFailed', 'theme 16 fieldName is invalid');
        if (baselineJson.trim() === '' || probeUrl.trim() === '') throw domainError('NeedsInput', 'theme 16 requires baselineJson and probeUrl');
        let baselineObject: unknown;
        try {
          baselineObject = JSON.parse(baselineJson) as unknown;
        } catch {
          throw domainError('ValidationFailed', 'theme 16 baselineJson must be valid JSON');
        }
        if (typeof baselineObject !== 'object' || baselineObject === null || Array.isArray(baselineObject)) {
          throw domainError('ValidationFailed', 'theme 16 baselineJson must be a JSON object');
        }
        if (Buffer.byteLength(baselineJson, 'utf8') > 65_536) throw domainError('ValidationFailed', 'theme 16 baselineJson exceeds 65536 bytes');
        let parsedProbe: URL;
        try {
          parsedProbe = new URL(probeUrl);
        } catch {
          throw domainError('ValidationFailed', 'theme 16 probeUrl must be an absolute URL');
        }
        if (!['http:', 'https:'].includes(parsedProbe.protocol)) throw domainError('ValidationFailed', 'theme 16 probeUrl must use http or https');
        const variantBody = JSON.stringify({ ...(baselineObject as Readonly<Record<string, unknown>>), [fieldName]: probeUrl });
        const baselineBody = JSON.stringify(baselineObject);
        const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
        requestBudget(2);
        const send = async (body: string) => repeater().send({
          targetUrl: target,
          requestBytes: rawRequest('POST', target, [['Content-Type', 'application/json']], body),
          ...(sessionCookies === undefined ? {} : { sessionCookies }),
        });
        const baseline = await send(baselineBody);
        const variant = await send(variantBody);
        const baselineText = baseline.body.toString('utf8');
        const variantText = variant.body.toString('utf8');
        const baselineAccepted = baseline.status >= 200 && baseline.status < 300;
        const markerFound = successMarker === undefined ? null : variantText.includes(successMarker);
        const rejected = variant.status === 400 || variant.status === 401 || variant.status === 403 || variant.status === 422;
        const outcome: AuthBypassProbeOutcome = !baselineAccepted
          ? 'inconclusive'
          : markerFound === true
            ? 'exposed'
            : rejected || markerFound === false
              ? 'denied'
              : 'inconclusive';
        probes.push({ kind: 'http', pattern: 'ssrf-public-control', targetUrl: target, status: baseline.status, finalUrl: baseline.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: baselineText }), outcome: baselineAccepted ? null : 'inconclusive' });
        probes.push({ kind: 'http', pattern: 'ssrf-reviewed-probe', targetUrl: target, status: variant.status, finalUrl: variant.redirectLocations.at(-1) ?? target, bodyHash: hashStable('scopepilot2.theme', { body: variantText }), outcome, ...(markerFound === null ? {} : { markersFound: markerFound }), detail: `probeProtocol=${parsedProbe.protocol}; marker=${markerFound === null ? 'unused' : String(markerFound)}` });
        skipped = successMarker === undefined
          ? ['HTTP acceptance alone is not SSRF evidence; configure successMarker or use the OAST attempt/callback flow']
          : ['the supplied probe URL was checked; alternate encodings, redirects, DNS rebinding and other address families require separate reviewed probes'];
        break;
      }
      case '18': {
        // Excel は「リクエスト中の直列化パターン」を観察する手順。応答本文の存在を
        // 脆弱性として扱わず、履歴から採取した要求サンプルを一時的に分類する。
        const requestSamples = params.requestSamples ?? '';
        if (requestSamples.trim() === '') throw domainError('NeedsInput', 'theme 18 requires requestSamples copied from captured request history');
        const signature = findSerializationSignature(requestSamples);
        probes.push({ kind: 'http', pattern: 'serialized-request-observation', targetUrl: targets[0] ?? '', status: null, finalUrl: '', bodyHash: hashStable('scopepilot2.theme18.sample', { sample: requestSamples }), outcome: signature === null ? 'denied' : 'inconclusive', ...(signature === null ? {} : { detail: `candidate-signature=${signature.name}` }) });
        skipped = ['integrity verification / acceptance was not exercised', 'exploitation with target-specific gadgets is excluded as unsafe'];
        break;
      }
      case '20': {
        // 業務ロジック・競合: 同一要求の順次再送による観察のみ (同期レースは除外)。
        const target = targets[0];
        if (target === undefined) throw domainError('ValidationFailed', 'theme 20 requires a target URL');
        const method = params.method ?? 'GET';
        const body = params.body ?? '';
        const count = planReplayCount(Number.parseInt(params.repeatCount ?? '2', 10));
        const successMarker = params.successMarker;
        const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
        requestBudget(count);
        const replayResponses: { status: number; bodyHash: string; markerFound: boolean | null }[] = [];
        for (let index = 0; index < count; index += 1) {
          const response = await repeater().send({ targetUrl: target, requestBytes: rawRequest(method, target, body === '' ? [] : [['Content-Type', 'application/json']], body), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
          const text = response.body.toString('utf8');
          const bodyHash = hashStable('scopepilot2.theme', { body: text });
          const markerFound = successMarker === undefined ? null : text.includes(successMarker);
          replayResponses.push({ status: response.status, bodyHash, markerFound });
          probes.push({ kind: 'http', pattern: `replay-${index + 1}`, targetUrl: target, status: response.status, finalUrl: response.redirectLocations.at(-1) ?? target, bodyHash, outcome: null, ...(markerFound === null ? {} : { markersFound: markerFound }) });
        }
        probes.push({ kind: 'http', pattern: 'replay-comparison', targetUrl: target, status: null, finalUrl: '', bodyHash: '', outcome: judgeReplay({ responses: replayResponses, ...(successMarker === undefined ? {} : { successMarker }) }) });
        skipped = ['millisecond-synchronized race detection (excluded as infeasible)'];
        break;
      }
      case '21': {
        // 入力検証の堃牢性: 境界値・型・長大文字列を query に適用し 5xx を見る。
        const target = targets[0];
        if (target === undefined) throw domainError('ValidationFailed', 'theme 21 requires a target URL');
        const paramName = params.paramName ?? '';
        if (paramName.trim() === '') throw domainError('ValidationFailed', 'theme 21 requires paramName (query parameter to fuzz)');
        const extraValues = (params.extraValues ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '');
        const values = [...INPUT_ROBUSTNESS_PAYLOADS, ...extraValues].slice(0, INPUT_ROBUSTNESS_MAX_VALUES);
        requestBudget(values.length);
        const fuzzAdapter = this.requireToolAdapter('fuzzTransport');
        const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
        for (const value of values) {
          const response = await fuzzAdapter.send({
            targetUrl: target,
            combination: [value],
            positions: [{ name: paramName, values: [value] }],
            ...(sessionCookies === undefined ? {} : { sessionCookies: sessionCookies.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path })) }),
          });
          const label = value === '' ? '(empty)' : value.length > 24 ? `${value.slice(0, 12)}…(${String(value.length)})` : value;
          probes.push({ kind: 'fuzz', pattern: `robustness:${label}`, targetUrl: response.requestUrl, status: response.status, finalUrl: response.requestUrl, bodyHash: response.bodyHash, outcome: judgeInputRobustness(response.status) });
        }
        skipped = ['required-parameter omission, HPP, double-decoding and trusted-header variants are not covered by this query-value run'];
        break;
      }
      case '22': {
        // TLS・証明書・暗号スイート: 審査済み nuclei template のスポット実行のみ。
        if (targets.length === 0 || targets.length > 3) throw domainError('ValidationFailed', 'theme 22 accepts 1..3 target origins');
        const templateIds = validateSpotTemplateIds((params.templateIds ?? '').split(','));
        if (this.deps.nucleiRunner === undefined) throw domainError('CapabilityUnavailable', 'nuclei runner is not configured for this service');
        const result = await this.deps.nucleiRunner.run({
          targets,
          limits: {
            maxRequests: caseRecord.scope.limits.maxRequests,
            maxDurationMinutes: Math.max(1, Math.min(caseRecord.scope.limits.maxDurationMinutes, 10)),
            maxConcurrency: 2,
            requestsPerSecond: 5,
          },
          templateIds,
        });
        const matchCount = countNucleiMatches(result.lines);
        for (const target of targets) {
          probes.push({ kind: 'nuclei', pattern: 'tls-spot-templates', targetUrl: target, status: null, finalUrl: '', bodyHash: '', outcome: judgeNucleiSpot(matchCount), detail: `matches=${String(matchCount)}; templates=${templateIds.join(',')}` });
        }
        skipped = ['full testssl.sh/OpenSSL-equivalent coverage (spot execution of reviewed templates only)'];
        break;
      }
      case '23': {
        // 平文送信・混在: http:// 到達性と https ページ内の http:// 参照。
        const target = targets[0];
        if (target === undefined || !target.startsWith('https://')) throw domainError('ValidationFailed', 'theme 23 requires an https:// target URL');
        requestBudget(3);
        const session = input.role === undefined ? undefined : requireSession();
        const httpsResponse = await browser().execute({
          targetUrl: ScopePolicy.canonicalUrl(target),
          scope: caseRecord.scope,
          steps: [{ kind: 'navigate', target: ScopePolicy.canonicalUrl(target) }],
          ...(session === undefined ? {} : { browserSession: session.browserState }),
        });
        probes.push({ kind: 'browser', pattern: 'https-baseline', targetUrl: ScopePolicy.canonicalUrl(target), status: httpsResponse.status, finalUrl: httpsResponse.finalUrl, bodyHash: httpsResponse.bodyHash, outcome: null });
        const mixed = findMixedContent(httpsResponse.bodyText);
        probes.push({ kind: 'browser', pattern: 'mixed-content', targetUrl: ScopePolicy.canonicalUrl(target), status: httpsResponse.status, finalUrl: httpsResponse.finalUrl, bodyHash: '', outcome: mixed ? 'exposed' : 'denied' });
        const plainTarget = target.replace(/^https:\/\//, 'http://');
        if (!businessTargetInScope(plainTarget, caseRecord.scope)) {
          throw domainError('OutOfScope', `plain http variant is out of scope: ${plainTarget}`);
        }
        const plainResponse = await repeater().send({ targetUrl: plainTarget, requestBytes: rawRequest('GET', plainTarget, [], '') });
        probes.push({ kind: 'http', pattern: 'plain-http', targetUrl: plainTarget, status: plainResponse.status, finalUrl: plainResponse.redirectLocations.at(-1) ?? plainTarget, bodyHash: hashStable('scopepilot2.theme', { body: plainResponse.body.toString('utf8') }), outcome: judgePlainHttp({ status: plainResponse.status, finalUrl: plainResponse.redirectLocations.at(-1) ?? plainTarget, targetUrl: plainTarget }) });
        break;
      }
      case '24': {
        // ZAP受動ルール外のブラウザ保護ヘッダー。欠落は対象ページの機微性が不明なら保留にする。
        if (targets.length === 0 || targets.length > 5) throw domainError('ValidationFailed', 'theme 24 accepts 1..5 target URLs');
        const strict = params.sensitivePage === 'true';
        requestBudget(targets.length * 2);
        const session = input.role === undefined ? undefined : requireSession();
        for (const target of targets) {
          const sessionCookies = session === undefined ? undefined : applicableSessionCookies([...session.cookies], target);
          const baseline = await repeater().send({ targetUrl: target, requestBytes: rawRequest('GET', target, [], ''), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
          const missing = (): AuthBypassProbeOutcome => strict ? 'exposed' : 'inconclusive';
          const policyChecks: readonly { name: string; safe: (value: string) => boolean }[] = [
            { name: 'Referrer-Policy', safe: (value) => /^(?:no-referrer|same-origin|strict-origin|strict-origin-when-cross-origin)$/iu.test(value.trim()) },
            { name: 'Cross-Origin-Opener-Policy', safe: (value) => value.trim().toLocaleLowerCase() === 'same-origin' },
            { name: 'Cross-Origin-Resource-Policy', safe: (value) => /^(?:same-origin|same-site)$/iu.test(value.trim()) },
            { name: 'Permissions-Policy', safe: (value) => value.trim() !== '' && !/=\s*\*/u.test(value) },
          ];
          for (const policy of policyChecks) {
            const value = headerValue(baseline.headers, policy.name);
            probes.push({
              kind: 'http',
              pattern: `header:${policy.name.toLocaleLowerCase()}`,
              targetUrl: target,
              status: baseline.status,
              finalUrl: baseline.redirectLocations.at(-1) ?? target,
              bodyHash: '',
              outcome: value === null ? missing() : policy.safe(value) ? 'denied' : 'exposed',
              detail: `${policy.name}=${value ?? '(missing)'}`,
            });
          }
          const hostCookies = baseline.headers.filter(([name, value]) => name.toLocaleLowerCase() === 'set-cookie' && /^__Host-/u.test(value));
          for (const [, cookie] of hostCookies) {
            const valid = /;\s*Secure(?:;|$)/iu.test(cookie) && /;\s*Path=\/(?:;|$)/iu.test(cookie) && !/;\s*Domain=/iu.test(cookie);
            probes.push({ kind: 'http', pattern: 'cookie:__host-prefix', targetUrl: target, status: baseline.status, finalUrl: target, bodyHash: '', outcome: valid ? 'denied' : 'exposed', detail: valid ? '__Host- attributes valid' : '__Host- attributes invalid' });
          }
          const crossSite = await repeater().send({
            targetUrl: target,
            requestBytes: rawRequest('GET', target, [['Sec-Fetch-Site', 'cross-site'], ['Sec-Fetch-Mode', 'navigate'], ['Sec-Fetch-Dest', 'document']], ''),
            ...(sessionCookies === undefined ? {} : { sessionCookies }),
          });
          const crossSiteBlocked = crossSite.status === 401 || crossSite.status === 403;
          probes.push({ kind: 'http', pattern: 'sec-fetch-cross-site', targetUrl: target, status: crossSite.status, finalUrl: crossSite.redirectLocations.at(-1) ?? target, bodyHash: '', outcome: crossSiteBlocked ? 'denied' : strict ? 'exposed' : 'inconclusive', detail: `status=${String(crossSite.status)}` });
        }
        skipped = ['__Host- prefix is assessed only when such a Set-Cookie header is observed', ...(strict ? [] : ['missing headers are inconclusive unless sensitivePage=true'])];
        break;
      }
      case '25': {
        // TRACE/TRACK と Allow を確認する。PUT/DELETE は副作用を避け、明示指定なしでは送信しない。
        const target = targets[0];
        if (target === undefined) throw domainError('ValidationFailed', 'theme 25 requires a target URL');
        const requestedMethods = (params.methods ?? 'TRACE,TRACK').split(',').map((method) => method.trim().toUpperCase()).filter((method) => method !== '');
        if (requestedMethods.length === 0 || requestedMethods.length > 6) throw domainError('ValidationFailed', 'theme 25 accepts 1..6 methods');
        const stateChanging = requestedMethods.filter((method) => method === 'PUT' || method === 'DELETE' || method === 'PATCH');
        if (stateChanging.length > 0 && params.allowStateChangingMethods !== 'true') {
          throw domainError('NeedsInput', 'theme 25 requires allowStateChangingMethods=true before PUT/DELETE/PATCH probes');
        }
        const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
        requestBudget(requestedMethods.length + 1);
        const marker = 'scopepilot-method-probe';
        const optionsResponse = await repeater().send({ targetUrl: target, requestBytes: rawRequest('OPTIONS', target, [], ''), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
        const allow = (headerValue(optionsResponse.headers, 'Allow') ?? '').split(',').map((method) => method.trim().toUpperCase()).filter((method) => method !== '');
        const dangerousAdvertised = allow.filter((method) => requestedMethods.includes(method));
        probes.push({ kind: 'http', pattern: 'options-allow', targetUrl: target, status: optionsResponse.status, finalUrl: target, bodyHash: '', outcome: dangerousAdvertised.length > 0 ? 'exposed' : allow.length > 0 ? 'denied' : 'inconclusive', detail: `allow=${allow.join(',') || '(missing)'}` });
        for (const method of requestedMethods) {
          const response = await repeater().send({ targetUrl: target, requestBytes: rawRequest(method, target, [['Content-Type', 'text/plain']], marker), ...(sessionCookies === undefined ? {} : { sessionCookies }) });
          const body = response.body.toString('utf8');
          const rejected = response.status === 401 || response.status === 403 || response.status === 405 || response.status === 501;
          const echoed = body.includes(marker);
          probes.push({
            kind: 'http',
            pattern: `method:${method.toLocaleLowerCase()}`,
            targetUrl: target,
            status: response.status,
            finalUrl: response.redirectLocations.at(-1) ?? target,
            bodyHash: hashStable('scopepilot2.theme', { body }),
            outcome: rejected ? 'denied' : echoed || dangerousAdvertised.includes(method) ? 'exposed' : 'inconclusive',
            detail: `status=${String(response.status)}; echoed=${String(echoed)}`,
          });
        }
        skipped = stateChanging.length === 0 ? ['PUT/DELETE/PATCH were not sent without explicit side-effect authorization'] : [];
        break;
      }
      case '26': {
        // GraphQL introspection と、利用者指定のschema-validな深さ/コストqueryを確認する。
        const target = targets[0];
        if (target === undefined) throw domainError('ValidationFailed', 'theme 26 requires a GraphQL endpoint URL');
        const deepQuery = params.deepQuery ?? '';
        if (deepQuery.trim() === '') throw domainError('NeedsInput', 'theme 26 requires a schema-valid deepQuery');
        if (deepQuery.length > 20_000) throw domainError('ValidationFailed', 'theme 26 deepQuery exceeds 20000 characters');
        const baselineQuery = params.baselineQuery ?? '{__typename}';
        const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
        requestBudget(3);
        const sendQuery = async (query: string) => repeater().send({
          targetUrl: target,
          requestBytes: rawRequest('POST', target, [['Content-Type', 'application/json']], JSON.stringify({ query })),
          ...(sessionCookies === undefined ? {} : { sessionCookies }),
        });
        const baseline = await sendQuery(baselineQuery);
        const baselineText = baseline.body.toString('utf8');
        const baselineWorks = baseline.status >= 200 && baseline.status < 300 && /"data"\s*:/u.test(baselineText) && !/"errors"\s*:/u.test(baselineText);
        probes.push({ kind: 'http', pattern: 'graphql-baseline', targetUrl: target, status: baseline.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: baselineText }), outcome: baselineWorks ? null : 'inconclusive' });
        const introspection = await sendQuery('{__schema{queryType{name}}}');
        const introspectionText = introspection.body.toString('utf8');
        const introspectionEnabled = introspection.status >= 200 && introspection.status < 300 && /"__schema"\s*:/u.test(introspectionText) && !/"errors"\s*:/u.test(introspectionText);
        probes.push({ kind: 'http', pattern: 'graphql-introspection', targetUrl: target, status: introspection.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: introspectionText }), outcome: baselineWorks ? (introspectionEnabled ? 'exposed' : 'denied') : 'inconclusive' });
        const deep = await sendQuery(deepQuery);
        const deepText = deep.body.toString('utf8');
        const explicitlyLimited = deep.status === 400 || deep.status === 413 || deep.status === 429 || /(?:depth|complexity|cost|limit).{0,80}(?:exceed|maximum|too|reject)/iu.test(deepText);
        const deepExecuted = deep.status >= 200 && deep.status < 300 && /"data"\s*:/u.test(deepText) && !/"errors"\s*:/u.test(deepText);
        probes.push({ kind: 'http', pattern: 'graphql-depth-cost', targetUrl: target, status: deep.status, finalUrl: target, bodyHash: hashStable('scopepilot2.theme', { body: deepText }), outcome: !baselineWorks ? 'inconclusive' : explicitlyLimited ? 'denied' : deepExecuted ? 'exposed' : 'inconclusive' });
        skipped = ['query cost requires a schema-valid deepQuery supplied for the target; generic invalid queries are not evidence'];
        break;
      }
      case '27': {
        // Cookie認証WebSocketをsame-originとcross-originのOriginで比較し、CSWSHを確認する。
        const target = targets[0];
        if (target === undefined) throw domainError('ValidationFailed', 'theme 27 requires a WebSocket target URL');
        const wsAdapter = this.requireToolAdapter('webSocketTransport');
        const origins = (params.evilOrigins ?? 'https://scopepilot.invalid').split(',').map((origin) => origin.trim()).filter((origin) => origin !== '');
        if (origins.length === 0 || origins.length > 3) throw domainError('ValidationFailed', 'theme 27 accepts 1..3 evil origins');
        const message = params.message ?? '{"action":"report"}';
        if (Buffer.byteLength(message, 'utf8') > 16_384) throw domainError('ValidationFailed', 'theme 27 message exceeds 16384 bytes');
        const sessionCookies = input.role === undefined ? undefined : applicableSessionCookies([...requireSession().cookies], target);
        requestBudget(origins.length + 1);
        const exchange = async (origin: string): Promise<boolean> => {
          try {
            const result = await wsAdapter.exchange({
              targetUrl: target,
              messages: [message],
              origin,
              ...(sessionCookies === undefined ? {} : { sessionCookies }),
              onSentFrame: () => undefined,
              onTextFrame: () => undefined,
            });
            return result.sent === 1;
          } catch {
            return false;
          }
        };
        const sameOrigin = new URL(target).origin;
        const controlConnected = await exchange(sameOrigin);
        probes.push({ kind: 'websocket', pattern: 'websocket-same-origin-control', targetUrl: target, status: null, finalUrl: target, bodyHash: '', outcome: controlConnected ? null : 'inconclusive' });
        for (const origin of origins) {
          const connected = await exchange(origin);
          probes.push({ kind: 'websocket', pattern: `websocket-cross-origin:${origin}`, targetUrl: target, status: null, finalUrl: target, bodyHash: '', outcome: !controlConnected ? 'inconclusive' : connected ? 'exposed' : 'denied' });
        }
        if (new URL(target).protocol === 'http:') {
          probes.push({ kind: 'websocket', pattern: 'websocket-plaintext-transport', targetUrl: target, status: null, finalUrl: target, bodyHash: '', outcome: params.requireWss === 'true' ? 'exposed' : 'inconclusive' });
        }
        skipped = ['message-level authorization and token replay require target-specific messages and expected results'];
        break;
      }
      case '29': {
        // データ保護・機微露出: 認証後ページの DOM 観測で PII 疑い node を数える。
        if (targets.length === 0 || targets.length > 5) throw domainError('ValidationFailed', 'theme 29 accepts 1..5 target URLs');
        if (this.deps.domObserver === undefined) throw domainError('CapabilityUnavailable', 'DOM observer is not configured for this service');
        requestBudget(targets.length * 2);
        const session = input.role === undefined ? undefined : requireSession();
        for (const target of targets) {
          const canonical = ScopePolicy.canonicalUrl(target);
          const page = await browser().execute({
            targetUrl: canonical,
            scope: caseRecord.scope,
            steps: [{ kind: 'navigate', target: canonical }],
            ...(session === undefined ? {} : { browserSession: session.browserState }),
          });
          const sensitiveParams = findSensitiveUrlParamNames(canonical);
          probes.push({ kind: 'browser', pattern: 'sensitive-url-parameters', targetUrl: canonical, status: page.status, finalUrl: page.finalUrl, bodyHash: page.bodyHash, outcome: sensitiveParams.length > 0 ? 'exposed' : 'denied', detail: `parameterNames=${sensitiveParams.length === 0 ? '(none)' : sensitiveParams.join(',')}` });
          const cacheControl = headerValue(page.headers, 'Cache-Control');
          probes.push({ kind: 'browser', pattern: 'sensitive-cache-control', targetUrl: canonical, status: page.status, finalUrl: page.finalUrl, bodyHash: '', outcome: judgeSensitiveCache(cacheControl), detail: `cacheControl=${cacheControl ?? '(missing)'}` });
          const observation = await this.deps.domObserver.observe({
            targetUrl: canonical,
            scope: caseRecord.scope,
            ...(session === undefined ? {} : { browserSession: session.browserState }),
          });
          const piiCount = observation.nodes.filter((node) => node.looksLikePii).length;
          const confirmedUnmaskedCount = observation.nodes.filter((node) => node.looksLikePii && /(?:payment-card|my-number|pin)-unmasked/u.test(node.text)).length;
          // 実 adapter は生のDOM本文ではなくカテゴリ化済みnodeだけを返す。nodeが空なら
          // 古い/代替adapter等で分類自体が未実施なので、問題なしにせず inconclusive とする。
          const outcome = observation.nodes.length === 0 ? 'inconclusive' : judgePiiExposure(piiCount, confirmedUnmaskedCount);
          probes.push({ kind: 'dom', pattern: 'pii-exposure', targetUrl: canonical, status: null, finalUrl: canonical, bodyHash: '', outcome, detail: `piiCandidates=${String(piiCount)}; confirmedUnmasked=${String(confirmedUnmaskedCount)}; nodes=${String(observation.nodes.length)}` });
        }
        skipped = ['API over-fetching/ownership and third-party transmission require traffic context', 'file metadata (ExifTool) verification'];
        break;
      }
      case '30': {
        // 公開情報・設定面: 既に選択されたHTTP対象の応答だけを観測する。共通パスの
        // 推測列挙はここでは行わず、Server等の版、Content-Type、directory listing、
        // source map参照を本文を保存せずに判定する。
        if (targets.length === 0 || targets.length > 5) throw domainError('ValidationFailed', 'theme 30 accepts 1..5 target URLs');
        requestBudget(targets.length);
        const session = input.role === undefined ? undefined : requireSession();
        const disclosureHeaders = ['Server', 'X-Powered-By', 'X-AspNet-Version', 'X-AspNetMvc-Version'] as const;
        for (const target of targets) {
          const canonical = ScopePolicy.canonicalUrl(target);
          const sessionCookies = session === undefined ? undefined : applicableSessionCookies([...session.cookies], canonical);
          const response = await repeater().send({
            targetUrl: canonical,
            requestBytes: rawRequest('GET', canonical, [['Accept', 'text/html,application/json;q=0.9,*/*;q=0.1']], ''),
            ...(sessionCookies === undefined ? {} : { sessionCookies }),
          });
          const bodyText = response.body.toString('utf8');
          const finalUrl = response.redirectLocations.at(-1) ?? canonical;
          for (const name of disclosureHeaders) {
            const value = headerValue(response.headers, name);
            probes.push({
              kind: 'http',
              pattern: `version-header:${name.toLocaleLowerCase()}`,
              targetUrl: canonical,
              status: response.status,
              finalUrl,
              bodyHash: '',
              outcome: judgeVersionDisclosure(value),
              detail: `${name}=${value ?? '(missing)'}`,
            });
          }
          const contentType = headerValue(response.headers, 'Content-Type');
          probes.push({
            kind: 'http',
            pattern: 'response-content-type',
            targetUrl: canonical,
            status: response.status,
            finalUrl,
            bodyHash: '',
            outcome: judgeResponseContentType({ status: response.status, bodyByteLength: response.body.byteLength, contentType }),
            detail: `contentType=${contentType ?? '(missing)'}`,
          });
          probes.push({
            kind: 'http',
            pattern: 'directory-listing',
            targetUrl: canonical,
            status: response.status,
            finalUrl,
            bodyHash: hashStable('scopepilot2.theme', { body: bodyText }),
            outcome: judgeDirectoryListing(bodyText),
          });
          const sourceMapReference = /(?:\/\/[#@]\s*sourceMappingURL=|\/\*[#@]\s*sourceMappingURL=)/u.test(bodyText);
          probes.push({
            kind: 'http',
            pattern: 'source-map-reference',
            targetUrl: canonical,
            status: response.status,
            finalUrl,
            bodyHash: '',
            outcome: sourceMapReference ? 'exposed' : 'denied',
            detail: `referenceFound=${String(sourceMapReference)}`,
          });
          const parsedTarget = new URL(canonical);
          const callbackName = parsedTarget.searchParams.get('callback') ?? parsedTarget.searchParams.get('jsonp');
          const jsonpReturned = callbackName !== null
            && /^[A-Za-z_$][A-Za-z0-9_$.[\]]{0,127}$/u.test(callbackName)
            && bodyText.trimStart().startsWith(`${callbackName}(`);
          probes.push({
            kind: 'http',
            pattern: 'jsonp-response',
            targetUrl: canonical,
            status: response.status,
            finalUrl,
            bodyHash: '',
            outcome: jsonpReturned ? 'exposed' : 'denied',
            detail: `callbackObserved=${String(jsonpReturned)}`,
          });
          const metadataLikePath = /(?:\/(?:\.git|\.svn)(?:\/|$)|\/(?:\.env|server-status|phpinfo\.php)$|\.(?:bak|old|orig|save|swp|zip|tar|gz)$)/iu.test(parsedTarget.pathname);
          const metadataSignature = /(?:^ref:\s+refs\/heads\/|<title>phpinfo\(\)|\[(?:core|remote\s+"origin")\]|(?:APP_KEY|DATABASE_URL|DB_PASSWORD)\s*=)/imu.test(bodyText);
          const publishedMetadata = response.status >= 200 && response.status < 300 && metadataLikePath && metadataSignature;
          probes.push({
            kind: 'http',
            pattern: 'published-metadata',
            targetUrl: canonical,
            status: response.status,
            finalUrl,
            bodyHash: '',
            outcome: publishedMetadata ? 'exposed' : 'denied',
            detail: `sensitivePath=${String(metadataLikePath)}; signatureFound=${String(metadataSignature)}`,
          });
        }
        skipped = ['common-path guessing and authenticated administrative-surface discovery require reviewed target URLs'];
        break;
      }
      default:
        throw domainError('ValidationFailed', `zap-unsupported theme ${themeNo} has no handler`);
    }

    const judged = probes.filter((probe) => probe.outcome !== null).map((probe) => probe.outcome!);
    const summary = summarizeThemeOutcomes(judged, skipped);
    const checkId = this.deps.ids.next('themecheck');
    const executedAt = this.deps.clock.now().toISOString();
    const record = {
      checkId,
      themeNo,
      role: input.role ?? null,
      status: summary.status,
      totalRequests: probes.length,
      ...(skipped.length === 0 ? {} : { skipped: [...skipped] }),
      executedAt,
    };
    (this.zapUnsupportedChecks as typeof record[]).push(record);
    await this.deps.evidence.saveText(`zap-unsupported:${checkId}`, canonicalJson({
      checkId,
      themeNo,
      role: input.role ?? null,
      results: probes.map((probe) => ({ kind: probe.kind, pattern: probe.pattern, targetUrl: probe.targetUrl, status: probe.status, finalUrl: probe.finalUrl, bodyHash: probe.bodyHash, outcome: probe.outcome, ...(probe.detail === undefined ? {} : { detail: probe.detail }) })),
      ...(skipped.length === 0 ? {} : { skipped }),
      status: summary.status,
    }), { targetUrl: targets[0] ?? '', kind: 'zap-unsupported' });
    this.record({ type: 'ZapUnsupportedCheckCompleted', at: executedAt, checkId, themeNo, role: input.role ?? '', status: summary.status });
    return { ...record, results: probes };
  }

  listZapUnsupportedChecks(): readonly { checkId: string; themeNo: string; role: string | null; status: string; totalRequests: number; skipped?: readonly string[]; executedAt: string }[] {
    return [...this.zapUnsupportedChecks];
  }

  /** Execute an AI-proposed plan only after the operator has previewed and confirmed it. */
  async runInteractiveDiagnostics(
    operator: OperatorProfile,
    input: InteractiveDiagnosticRunInput,
  ): Promise<{ results: readonly InteractiveDiagnosticItemResult[] }> {
    this.requirePermission(operator, 'run.manage');
    if (!input.confirmed) throw domainError('ValidationFailed', 'interactive diagnostic plan requires operator confirmation');
    if (input.items.length === 0 || input.items.length > 20) {
      throw domainError('ValidationFailed', 'interactive diagnostic plan must contain between 1 and 20 items');
    }
    const caseRecord = this.currentCase();
    const authorization = this.currentAuthorization();
    if (!authorization.allowedOperationClasses.includes('ActiveScan')) {
      throw domainError('OutOfScope', 'authorization does not allow ActiveScan for this case');
    }
    const files = new Map(input.files.map((file) => [file.inputRef, file]));
    const apiDocuments = new Map(input.apiDocuments.map((document) => [document.inputRef, document]));
    const forbiddenClickTerms = ['logout', 'log-out', 'delete', 'remove', '退会', '削除'];
    const results: InteractiveDiagnosticItemResult[] = [];

    const roleBrowserSession = (role: string): BrowserSessionState | undefined => {
      if (role === '' || role === 'unauthenticated') return undefined;
      const session = this.roleSessionCookies.get(role);
      if (session === undefined) throw domainError('ValidationFailed', `no authenticated session for role ${role}`);
      return session.browserState;
    };

    const validateSteps = (steps: readonly InteractiveBrowserStep[]): void => {
      if (steps.length === 0 || steps.length > 20) throw domainError('ValidationFailed', 'browser diagnostic needs 1 to 20 steps');
      for (const step of steps) {
        if (step.target.trim() === '' || step.target.length > 1_000) throw domainError('ValidationFailed', 'browser diagnostic step target is invalid');
        if (step.kind === 'navigate' && !ScopePolicy.decide(caseRecord.scope, step.target).allowed) {
          throw domainError('OutOfScope', `interactive navigation is out of scope: ${step.target}`);
        }
        if (step.kind === 'click' && forbiddenClickTerms.some((term) => step.target.toLocaleLowerCase().includes(term))) {
          throw domainError('ValidationFailed', `interactive plan contains a forbidden click target: ${step.target}`);
        }
        if ((step.kind === 'fill' || step.kind === 'select' || step.kind === 'assertValue') && step.value.length > 2_000) {
          throw domainError('ValidationFailed', 'interactive browser value exceeds 2000 characters');
        }
        if (step.kind === 'upload' && !files.has(step.inputRef)) {
          throw domainError('ValidationFailed', `required upload input is missing: ${step.inputRef}`);
        }
      }
    };

    for (const item of input.items) {
      const canonical = ScopePolicy.canonicalUrl(item.targetUrl);
      if (!ScopePolicy.decide(caseRecord.scope, canonical).allowed) {
        throw domainError('OutOfScope', `interactive diagnostic target is out of scope: ${canonical}`);
      }
      if (item.track === 'session-analysis') {
        const result = await this.runSequencerSession(operator, {
          targetUrl: canonical,
          samples: item.samples,
          ...(item.role === '' || item.role === 'unauthenticated' ? {} : { role: item.role }),
          tokenSource: item.tokenSource,
          ...(item.tokenSource === 'cookie' ? { tokenCookieName: item.tokenName } : {}),
          ...(item.tokenSource === 'hidden' ? { tokenFieldName: item.tokenName } : {}),
        });
        const evidence = await this.deps.evidence.saveText(
          `interactive-diagnostic:${item.itemId}`,
          canonicalJson({ itemId: item.itemId, track: item.track, targetUrl: canonical, result }),
          { track: item.track, targetUrl: canonical },
        );
        results.push({ itemId: item.itemId, track: item.track, targetUrl: canonical, status: result.verdict === 'assessed' ? 'completed' : 'inconclusive', detail: `${result.sampleCount} samples; ${result.duplicates} duplicates; ${result.missing} missing`, evidenceId: evidence.evidenceId });
        continue;
      }
      if (item.track === 'api-schema') {
        const document = apiDocuments.get('api-spec');
        if (document === undefined) throw domainError('ValidationFailed', 'API specification input is missing');
        const imported = this.importApiSpec(operator, { documentLabel: document.name, document: document.document });
        const evidence = await this.deps.evidence.saveText(
          `interactive-diagnostic:${item.itemId}`,
          canonicalJson({ itemId: item.itemId, track: item.track, targetUrl: canonical, endpoints: imported.endpoints, warnings: imported.warnings }),
          { track: item.track, targetUrl: canonical },
        );
        results.push({ itemId: item.itemId, track: item.track, targetUrl: canonical, status: imported.endpoints.length > 0 ? 'completed' : 'inconclusive', detail: `${imported.endpoints.length} API endpoints imported`, evidenceId: evidence.evidenceId });
        continue;
      }
      if (this.deps.interactiveBrowser === undefined) throw domainError('CapabilityUnavailable', 'interactive browser is not configured');
      validateSteps(item.steps);
      if (item.track === 'authorization-differential') {
        if (!authorization.allowedOperationClasses.includes('CrossRoleTest')) {
          throw domainError('OutOfScope', 'authorization does not allow CrossRoleTest for this case');
        }
        if (item.roles.length < 2 || new Set(item.roles).size !== item.roles.length) {
          throw domainError('ValidationFailed', 'authorization differential needs at least two distinct roles');
        }
        const observations = [] as { role: string; finalUrl: string; status: number | null; bodyHash: string; assertionsPassed: boolean }[];
        for (const role of item.roles) {
          const browserSession = roleBrowserSession(role);
          const observation = await this.deps.interactiveBrowser.execute({
            targetUrl: canonical,
            scope: caseRecord.scope,
            steps: item.steps,
            maxRequests: Math.min(10000, caseRecord.scope.limits.maxRequests),
            maxDurationMs: Math.min(300000, caseRecord.scope.limits.maxDurationMinutes * 60000),
            ...(browserSession === undefined ? {} : { browserSession }),
          });
          this.recordWorkflowObservation(observation);
          observations.push({ role, finalUrl: observation.finalUrl, status: observation.status, bodyHash: observation.bodyHash, assertionsPassed: observation.assertions.every((entry) => entry.passed) });
        }
        const fingerprints = new Set(observations.map((entry) => `${entry.status}:${entry.finalUrl}:${entry.bodyHash}`));
        const actual = fingerprints.size === 1 ? 'same' : 'different';
        const passed = actual === item.expectation;
        const evidence = await this.deps.evidence.saveText(
          `interactive-diagnostic:${item.itemId}`,
          canonicalJson({ itemId: item.itemId, track: item.track, targetUrl: canonical, expectation: item.expectation, actual, observations }),
          { track: item.track, targetUrl: canonical },
        );
        results.push({ itemId: item.itemId, track: item.track, targetUrl: canonical, status: passed ? 'passed' : 'failed', detail: `role responses were ${actual}; expected ${item.expectation}`, evidenceId: evidence.evidenceId });
        continue;
      }
      const selectedFiles = item.steps.flatMap((step) => step.kind === 'upload' ? [files.get(step.inputRef)] : []).filter((file): file is InteractiveBrowserFile => file !== undefined);
      const browserSession = roleBrowserSession(item.role);
      const observation = await this.deps.interactiveBrowser.execute({
        targetUrl: canonical,
        scope: caseRecord.scope,
        steps: item.steps,
        maxRequests: Math.min(10000, caseRecord.scope.limits.maxRequests),
        maxDurationMs: Math.min(300000, caseRecord.scope.limits.maxDurationMinutes * 60000),
        ...(browserSession === undefined ? {} : { browserSession }),
        ...(selectedFiles.length === 0 ? {} : { files: selectedFiles }),
      });
      this.recordWorkflowObservation(observation);
      const assertionsPassed = observation.assertions.every((entry) => entry.passed);
      const evidenceObservation = {
        observedRequests: observation.observedRequests ?? [],
        clientRoutes: observation.clientRoutes ?? [],
        finalUrl: observation.finalUrl,
        status: observation.status,
        bodyHash: observation.bodyHash,
        elapsedMs: observation.elapsedMs,
        headerNames: observation.headers.map(([name]) => name),
        assertions: observation.assertions,
      };
      const evidence = await this.deps.evidence.saveText(
        `interactive-diagnostic:${item.itemId}`,
        canonicalJson({ itemId: item.itemId, track: item.track, targetUrl: canonical, observation: evidenceObservation }),
        { track: item.track, targetUrl: canonical },
      );
      results.push({
        itemId: item.itemId,
        track: item.track,
        targetUrl: canonical,
        status: observation.assertions.length === 0 ? 'completed' : assertionsPassed ? 'passed' : 'failed',
        detail: `${observation.assertions.filter((entry) => entry.passed).length}/${observation.assertions.length} assertions passed; final status ${observation.status ?? 'unknown'}`,
        evidenceId: evidence.evidenceId,
      });
    }
    this.latestDiagnosticRoutes = this.latestDiagnosticRoutes.map((route) => {
      const result = results.find((candidate) => candidate.track === route.track && ScopePolicy.canonicalUrl(candidate.targetUrl) === route.targetUrl);
      return result === undefined ? route : { ...route, status: 'executed' as const, detail: result.detail };
    });
    return { results };
  }

  authenticationCapabilities(): AuthenticationCapabilities {
    return {
      login: this.deps.loginExecutor === undefined ? 'unavailable' : 'adapter',
      loginEngineVersion: this.deps.loginExecutor?.engineVersion ?? null,
      verification: this.deps.interactiveBrowser === undefined ? 'unavailable' : 'adapter',
      verificationEngineVersion: this.deps.interactiveBrowser?.engineVersion ?? null,
      refresh: 'fixture',
      executableMethods: this.deps.loginExecutor === undefined ? [] : ['Form'],
      configurationStorage: 'memory',
    };
  }

  listAuthenticationUsers(): readonly AuthenticationUser[] {
    return [...this.authenticationUsers.values()].map((user) => ({ ...user }));
  }

  authenticationConfiguration(): { capabilities: AuthenticationCapabilities; users: readonly AuthenticationUser[]; verifications: readonly SessionVerification[]; flows: readonly { role: string; flowVersion: string; steps: readonly LoginFlowStep[] }[] } {
    return { capabilities: this.authenticationCapabilities(), users: this.listAuthenticationUsers(), verifications: [...this.sessionVerifications.values()].map((entry) => ({ ...entry })),
      flows: [...this.loginFlows].map(([role, flow]) => ({ role, flowVersion: flow.flowVersion, steps: flow.steps.map((step) => ({ ...step })) })) };
  }

  saveAuthenticationUser(operator: OperatorProfile, user: AuthenticationUser): AuthenticationUser {
    this.requirePermission(operator, 'case.manage');
    this.currentCase();
    if ([user.role, user.displayName, user.authorizationRole].some((value) => typeof value !== 'string' || value.trim() === '')
      || !AuthenticationMethods.includes(user.method) || typeof user.enabled !== 'boolean') {
      throw domainError('ValidationFailed', 'user needs a session identity, display name, authorization role, authentication method and enabled flag');
    }
    // Explicit projection prevents arbitrary request fields (including secrets) from being stored.
    const saved: AuthenticationUser = { role: user.role.trim(), displayName: user.displayName.trim(), authorizationRole: user.authorizationRole.trim(), method: user.method, enabled: user.enabled };
    this.authenticationUsers.set(saved.role, saved);
    this.invalidateRoleSession(saved.role);
    return { ...saved };
  }

  private invalidateRoleSession(role: string): void {
    this.sessionGenerations.set(role, (this.sessionGenerations.get(role) ?? 0) + 1);
    this.roleSessionCookies.delete(role);
    this.roleRegistry.removeJar(role);
    this.loginObservations.delete(role);
    this.sessionVerifications.delete(role);
  }

  private clearAuthentication(): void {
    for (const role of this.loginFlows.keys()) this.invalidateRoleSession(role);
    this.authenticationUsers.clear();
    this.loginFlows.clear();
    this.sessionRevisions.clear();
  }

  /** Reuses the role's browser state; never returns response bodies, cookies or tokens. */
  async verifySession(operator: OperatorProfile, role: string): Promise<SessionVerification> {
    this.requirePermission(operator, 'run.manage');
    if (this.authenticationUsers.get(role)?.enabled === false) throw domainError('NeedsInput', 'user is disabled');
    const flight = this.verificationFlights.get(role);
    if (flight !== undefined) return flight;
    const verify = this.performSessionVerification(role);
    this.verificationFlights.set(role, verify);
    try { return await verify; } finally { this.verificationFlights.delete(role); }
  }

  private async performSessionVerification(role: string): Promise<SessionVerification> {
    const session = this.roleSessionCookies.get(role);
    if (session === undefined) throw domainError('NeedsInput', 'run login before verifying the session');
    const browser = this.deps.interactiveBrowser;
    const markers = (session.verificationMarkers ?? []).filter((marker) => marker.trim() !== '');
    let state: SessionVerification['state'] = 'unverified';
    let reason = 'verification requires a browser adapter, an expected URL and a non-empty login assertion';
    let source: SessionVerification['source'] = 'unavailable';
    if (browser !== undefined && session.verificationUrl !== undefined && session.expectedUrlPrefix !== undefined && markers.length > 0) {
      const scope = this.currentCase().scope;
      if (!ScopePolicy.decide(scope, session.verificationUrl).allowed) throw domainError('OutOfScope', 'session verification URL is outside the case context');
      if (isSessionControlUrl(session.verificationUrl)) throw domainError('ValidationFailed', 'session verification cannot navigate to a session control URL');
      source = 'adapter';
      try {
        const result = await browser.execute({ targetUrl: session.verificationUrl, scope, browserSession: session.browserState,
          steps: [{ kind: 'navigate', target: session.verificationUrl }, ...markers.map((target) => ({ kind: 'assert' as const, target }))] });
        const valid = ScopePolicy.decide(scope, result.finalUrl).allowed
          && detectAuthState({ finalUrl: result.finalUrl, expectedUrlPrefix: session.expectedUrlPrefix, assertResult: true }) === 'authenticated'
          && result.status !== null && result.status >= 200 && result.status < 400
          && markers.every((marker) => result.assertions.some((assertion) => assertion.target === marker && assertion.passed));
        state = valid ? 'valid' : 'expired';
        reason = valid ? 'expected URL and all login assertions matched' : 'authentication URL, status or login assertion did not match; log in again';
      } catch {
        // Adapter errors can contain request material. Keep only a fixed diagnostic.
        reason = 'browser verification failed; authentication was not established';
      }
    }
    if (this.roleSessionCookies.get(role) !== session) throw domainError('Conflict', 'session changed during verification; verify again');
    const verification: SessionVerification = { role, state, checkedAt: this.deps.clock.now().toISOString(), source, reason };
    this.sessionVerifications.set(role, verification);
    if (state !== 'valid') { this.roleSessionCookies.delete(role); this.roleRegistry.removeJar(role); }
    await this.deps.evidence.saveText(`session-verification:${role}`, canonicalJson({ ...verification, flowVersion: this.loginFlows.get(role)?.flowVersion ?? null, engineVersion: browser?.engineVersion ?? null }));
    return verification;
  }

  /** login flow の登録 (design/f09)。step 構成は domain 検証 (上限 10・allowlist・fill は secret 参照必須)。 */
  registerLoginFlow(
    operator: OperatorProfile,
    input: { readonly role: string; readonly flowVersion: string; readonly steps: readonly LoginFlowStep[] },
  ): { role: string; stepCount: number; secretReferences: readonly { flowVersion: string; secretReference: string }[] } {
    this.requirePermission(operator, 'run.manage');
    if (input.role.trim() === '' || input.flowVersion.trim() === '') {
      throw domainError('ValidationFailed', 'role must not be empty');
    }
    if (input.steps.some((step) => (step as { secretValue?: unknown }).secretValue !== undefined)) {
      // secret 値の持ち込みは最初から拒否 (F09-UT-006: 参照のみ)。
      throw domainError('ValidationFailed', 'inline secret values are not accepted; use secretReference');
    }
    const { stepCount } = validateLoginFlow(input.steps);
    const previous = this.loginFlows.get(input.role);
    if (previous?.flowVersion === input.flowVersion && canonicalJson(previous.steps) !== canonicalJson(input.steps)) {
      throw domainError('Conflict', 'flow steps changed; save with a new flow version');
    }
    const secretReferences = input.steps
      .filter((step) => step.secretReference !== undefined)
      .map((step) => vaultEvidenceProjection({ flowVersion: input.flowVersion, secretReference: step.secretReference ?? '' }));
    this.loginFlows.set(input.role, { flowVersion: input.flowVersion, steps: input.steps.map((step) => ({ ...step })), secretReferences: [...new Set(secretReferences.map((entry) => entry.secretReference))] });
    this.invalidateRoleSession(input.role);
    return { role: input.role, stepCount, secretReferences };
  }

  /**
   * 登録済み login flow の実行 (design/f09 §4)。認証済みなら session cookie を
   * role に保存し、以後の探索 (runExploration の role 指定) で使えるようにする。
   * 秘密値は実行中のみ executor へ渡し、監査 event には参照のみ残す (F09-UT-006)。
   */
  async runLogin(
    operator: OperatorProfile,
    input: {
      readonly role: string;
      readonly baseUrl: string;
      readonly secretValues: Readonly<Record<string, string>>;
      readonly expectedUrlPrefix: string;
      readonly proxyServer?: string;
    },
  ): Promise<{ role: string; authenticated: boolean; finalUrl: string; cookieNames: readonly string[]; sharedCookieNames: boolean }> {
    this.requirePermission(operator, 'run.manage');
    const user = this.authenticationUsers.get(input.role);
    if (user?.enabled === false) throw domainError('NeedsInput', 'user is disabled');
    if (user !== undefined && user.method !== 'Form') throw domainError('CapabilityUnavailable', `${user.method} login is configuration-only; use a Form login flow`);
    const flow = this.loginFlows.get(input.role);
    if (flow === undefined) {
      throw domainError('ValidationFailed', `login flow for ${input.role} is not registered`);
    }
    const executor = this.deps.loginExecutor;
    if (executor === undefined) {
      throw domainError('ValidationFailed', 'login executor is not configured for this service');
    }
    for (const reference of flow.secretReferences) {
      if (input.secretValues[reference] === undefined || input.secretValues[reference] === '') {
        throw domainError('NeedsInput', `secret value for reference '${reference}' was not provided`);
      }
    }
    const scope = this.currentCase().scope;
    let targets: readonly string[];
    try {
      targets = [input.baseUrl, input.expectedUrlPrefix, ...flow.steps.filter((step) => step.kind === 'navigate').map((step) => new URL(step.target ?? '', `${input.baseUrl.replace(/\/$/, '')}/`).href)];
      for (const target of targets) {
        const url = new URL(target);
        if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') throw new Error('invalid login URL');
      }
    } catch { throw domainError('ValidationFailed', 'login URLs must be absolute HTTP(S) URLs without embedded credentials'); }
    for (const target of targets) {
      if (!ScopePolicy.decide(scope, target).allowed) throw domainError('OutOfScope', 'login URL is outside the case context');
    }
    // A failed re-login must never leave a stale authenticated session available.
    this.invalidateRoleSession(input.role);
    const generation = this.sessionGenerations.get(input.role);
    const startedAtMs = this.deps.clock.now().getTime();
    const result = await executor.execute({
      scope,
      baseUrl: input.baseUrl,
      steps: flow.steps,
      secretValues: input.secretValues,
      expectedUrlPrefix: input.expectedUrlPrefix,
      ...((input.proxyServer ?? this.deps.loginProxyServer) === undefined
        ? {}
        : { proxyServer: input.proxyServer ?? this.deps.loginProxyServer }),
    }).catch(() => { throw domainError('EngineFailure', 'login browser execution failed; check the flow and retry manually'); });
    checkFlowDeadline(this.deps.clock.now().getTime() - startedAtMs);
    if (this.sessionGenerations.get(input.role) !== generation) throw domainError('Conflict', 'session changed during login; run login again');
    if (this.loginFlows.get(input.role) !== flow || this.authenticationUsers.get(input.role) !== user || this.currentCase().scope !== scope) {
      throw domainError('Conflict', 'authentication configuration changed during login; run login again');
    }
    if (!ScopePolicy.decide(scope, result.finalUrl).allowed) throw domainError('OutOfScope', 'login final URL is outside the case context');
    if (result.authenticated) {
      this.sessionRevisions.set(input.role, (this.sessionRevisions.get(input.role) ?? 0) + 1);
      this.roleSessionCookies.set(input.role, {
        cookies: result.cookies,
        browserState: result.browserState ?? { cookies: result.cookies, origins: [] },
        createdAt: this.deps.clock.now().toISOString(),
        expectedUrlPrefix: input.expectedUrlPrefix,
        verificationUrl: result.finalUrl,
        verificationMarkers: flow.steps.flatMap((step) => step.kind === 'assert' && step.target !== undefined ? [step.target] : []),
      });
    }
    // login 実行時の観測を候補の根拠として保持する (探索結果へ合成する)。
    // 観測には値が含まれず、scope は探索の合成時に改めて判定する。
    if (result.authenticated || (result.observedRequests?.length ?? 0) > 0) {
      const jwtValues = [...result.cookies.map((cookie) => cookie.value), ...(result.browserState?.origins ?? []).flatMap((origin) => [...origin.localStorage, ...origin.sessionStorage].map((entry) => entry.value)), ...(result.browserState?.headers ?? []).map((header) => header.value.replace(/^Bearer /i, ''))];
      const authenticationReview = jwtValues.slice(0, 128).flatMap((value) => reviewJwt(value));
      if (authenticationReview.length) {
        const evidence = await this.deps.evidence.saveText(`jwt-review:${input.role}`, canonicalJson({ analyzerVersion: 'client-review-1', signals: authenticationReview }));
        const imported = this.importer.importObservationCandidates(authenticationReview.map((signal) => ({ key: `jwt-review:${signal.ruleId}`, title: `JWT: ${signal.ruleId} (passive review; acceptance untested)`, url: result.finalUrl, method: 'GET', param: signal.ruleId, severity: 'info' as const })), { now: this.deps.clock.now().toISOString(), engineVersion: 'client-review-1', makeFindingId: () => this.deps.ids.next('finding'), evidenceRef: evidence.evidenceId });
        this.persistFindings([...imported.created, ...imported.reobserved]);
      }
      this.loginObservations.set(input.role, {
        authenticationReview,
        url: result.finalUrl,
        status: result.authenticated ? 200 : 401,
        contentType: 'text/html',
        discoveredFrom: null,
        depth: 0,
        originType: 'crawl',
        links: [],
        forms: [],
        requests: result.observedRequests ?? [],
      });
    }
    const cookieNames = result.cookies.map((cookie) => cookie.name);
    const jar = this.roleRegistry.assignJar(input.role, cookieNames);
    this.record({
      type: 'LoginCompleted',
      at: this.deps.clock.now().toISOString(),
      role: input.role,
      authenticated: result.authenticated,
      secretReferences: flow.secretReferences,
    });
    return { role: input.role, authenticated: result.authenticated, finalUrl: result.finalUrl, cookieNames, sharedCookieNames: jar.shared };
  }

  /** role ごとの session 状態 (cookie 名・秘密値の参照の一覧のみ。値は保持しない)。 */
  listSessions(): readonly { role: string; flowVersion: string; stepCount: number; secretReferences: readonly string[]; cookieNames: readonly string[]; sessionRevision: number; verificationUrl: string | null }[] {
    return [...this.loginFlows.keys()].map((role) => {
      const flow = this.loginFlows.get(role);
      if (flow === undefined) {
        throw domainError('ValidationFailed', `login flow for ${role} is not registered`);
      }
      const jar = this.roleRegistry.jarOf(role);
      return {
        role,
        flowVersion: flow.flowVersion,
        stepCount: flow.steps.length,
        secretReferences: flow.secretReferences,
        cookieNames: jar?.cookieNames ?? [],
        sessionRevision: this.sessionRevisions.get(role) ?? 0,
        verificationUrl: this.roleSessionCookies.get(role)?.verificationUrl ?? null,
      };
    });
  }

  /** session の refresh (single-flight・lockout 回避は domain)。 */
  async refreshSession(operator: OperatorProfile, role: string): Promise<{ outcome: 'refreshed' | 'stopped-lockout-guard'; sessionRevision: number }> {
    this.requirePermission(operator, 'run.manage');
    if (this.deps.loginExecutor !== undefined) throw domainError('CapabilityUnavailable', 'automatic refresh is fixture-only; run login again with transient credentials');
    if (!this.loginFlows.has(role)) {
      throw domainError('ValidationFailed', `login flow for ${role} is not registered`);
    }
    const result = await this.sessionCoordinator.refresh(role);
    if (result.outcome === 'refreshed') {
      this.sessionRevisions.set(role, result.sessionRevision);
    }
    return result;
  }

  /** role への cookie jar 割当。他 role との共有 (同名 cookie) は警告として返す (F09-UT-005)。 */
  assignRoleCookies(operator: OperatorProfile, role: string, cookieNames: readonly string[]): { role: string; shared: boolean } {
    this.requirePermission(operator, 'run.manage');
    if (!this.loginFlows.has(role)) {
      throw domainError('ValidationFailed', `login flow for ${role} is not registered`);
    }
    return this.roleRegistry.assignJar(role, cookieNames);
  }

  /** payload 集合の登録 (F05-UT-006: 供給元・版・license は必須)。 */
  registerPayloadSet(operator: OperatorProfile, registration: PayloadSetRegistration): { name: string; valueCount: number } {
    this.requirePermission(operator, 'run.manage');
    this.payloadCatalog.register(registration);
    this.payloadRegistrations.set(registration.name, registration);
    if (!this.payloadSetNames.includes(registration.name)) {
      this.payloadSetNames.push(registration.name);
    }
    return { name: registration.name, valueCount: registration.values.length };
  }

  listPayloadSets(): readonly { name: string; source: string; version: string; license: string; sha256: string; values: readonly string[] }[] {
    return this.payloadSetNames.map((name) => {
      const values = this.payloadCatalog.get(name);
      // get は values しか返さないため、登録情報は台帳から返す。
      const registration = this.payloadRegistrations.get(name);
      if (registration === undefined) {
        throw domainError('ValidationFailed', `payload set ${name} is not registered`);
      }
      return { ...registration, values };
    });
  }

  /**
   * fuzz session の実行 (design/f05)。組合せ総数が上限 (既定は案件上限と 200 の小さい方) を
   * 超えたら送信前に拒否する (F05-UT-001)。fixture adapter は組合せから決定的な応答を作り、
   * rate は仮想時計で進める (実時間を待たない)。応答は cluster 集約して返す (F05-UT-008)。
   * role 指定時はその role の session cookie を適用する (design/08: F05 は Cookie 適用対象)。
   */
  async runFuzzSession(
    operator: OperatorProfile,
    input: FuzzInput,
    control?: { isCancelled: () => boolean; progress: (total: number, rows: readonly FuzzRow[], sources: readonly FuzzPayloadSource[]) => void },
  ): Promise<{ adapterKind: AdapterKind; payloadSources: readonly FuzzPayloadSource[]; transport: 'fixture' | 'http'; rows: readonly FuzzRow[]; runId: string; targetUrl: string; total: number; sent: number; clusters: readonly { key: string; members: readonly number[]; representative: readonly string[] }[]; sessionCookieNames?: readonly string[] }> {
    this.requirePermission(operator, 'run.manage');
    const adapter = this.requireToolAdapter('fuzzTransport');
    const adapterKind = adapter.adapterKind ?? 'real';
    const caseRecord = this.currentCase();
    const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
    const decision = ScopePolicy.decide(caseRecord.scope, canonical);
    if (!decision.allowed) {
      throw domainError('OutOfScope', `fuzz target is out of scope: ${decision.reason}`);
    }
    if (input.positions.length === 0) {
      throw domainError('ValidationFailed', 'fuzz needs at least one position');
    }
    // role session の適用 cookie (対象 URL の host/path 一致のみ。別 Origin へは送らない)。
    let appliedCookies: readonly LoginSessionCookie[] | undefined;
    if (input.role !== undefined) {
      const session = this.roleSessionCookies.get(input.role);
      if (session === undefined) {
        throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
      }
      appliedCookies = applicableSessionCookies([...session.cookies], canonical);
    }
    const cap = Math.min(input.maxRequests ?? 200, caseRecord.scope.limits.maxRequests, 10000);
    const rps = input.requestsPerSecond ?? 2;
    if (!Number.isInteger(rps) || rps < 1 || rps > 2) throw domainError('ValidationFailed', 'fuzz rate must be 1..2 RPS');
    const positions = input.positions.map(p => ({ ...p, values: p.payloadSet === undefined ? p.values : this.payloadCatalog.get(p.payloadSet) }));
    const payloadSources = positions.map(p => {
      const registration = p.payloadSet === undefined ? undefined : this.payloadRegistrations.get(p.payloadSet);
      return { position: p.name, name: registration?.name ?? 'direct input', source: registration?.source ?? 'operator input',
        version: registration?.version ?? 'content-addressed', sha256: createHash('sha256').update(JSON.stringify(p.values)).digest('hex') };
    });
    const { total } = planCombinations(positions, cap, input.attack);
    const originals = positions.map(p => new URL(canonical).searchParams.get(p.name) ?? '');
    const template = input.request?.bodyTemplate ?? '';
    const markers = [...template.matchAll(/§([^§]*)§/g)];
    if ((template.match(/§/g)?.length ?? 0) !== markers.length * 2) throw domainError('ValidationFailed', 'unpaired body marker');
    if (input.request && (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.request.method) || /[\r\n]/.test(input.request.contentType))) throw domainError('ValidationFailed', 'invalid base request');
    for (const p of positions) {
      if (p.name.startsWith('body:') && !markers[Number(p.name.slice(5)) - 1]) throw domainError('ValidationFailed', 'invalid body position');
    }
    positions.forEach((p, i) => { if (p.name.startsWith('body:')) originals[i] = markers[Number(p.name.slice(5)) - 1]?.[1] ?? ''; });
    const queryPositions = positions.filter(p => !p.name.startsWith('body:'));
    const startedAtMs = Date.now();
    const rows: FuzzRow[] = [];
    control?.progress(total, rows, payloadSources);
    const realTransport = this.deps.fuzzTransport;
    let virtualNowMs = 0;
    const outcomes: FuzzResponseOutcome[] = [];
    const result = await runFuzz(
      {
        send: async (index, combination) => {
          const started = Date.now();
          const addRow = (outcome: FuzzResponseOutcome) => {
            const baseline = rows[0];
            rows.push({ ...outcome, index, payload: combination, elapsedMs: realTransport === undefined ? 0 : Date.now() - started,
              lengthDiff: outcome.contentLength - (baseline?.contentLength ?? outcome.contentLength),
              changed: baseline !== undefined && (baseline.status !== outcome.status || baseline.bodyHash !== outcome.bodyHash) });
            control?.progress(total, rows, payloadSources);
          };
          const requestUrl = new URL(canonical);
          positions.forEach((p, i) => { if (!p.name.startsWith('body:')) requestUrl.searchParams.set(p.name.trim(), combination[i] ?? ''); });
          const latest = this.currentCase();
          if (latest.caseId !== caseRecord.caseId) throw domainError('Conflict', 'case changed during fuzz run');
          if (Date.now() - startedAtMs >= latest.scope.limits.maxDurationMinutes * 60000) throw domainError('ValidationFailed', 'fuzz exceeded case time limit');
          if (!ScopePolicy.decide(latest.scope, requestUrl.toString()).allowed) throw domainError('OutOfScope', 'fuzz request is outside current scope');
          if (index >= latest.scope.limits.maxRequests) throw domainError('ValidationFailed', 'fuzz exceeds current case request limit');
          if (realTransport !== undefined) {
            const response = await realTransport.send({
              targetUrl: canonical,
              combination: positions.flatMap((p, i) => p.name.startsWith('body:') ? [] : [combination[i] ?? '']),
              positions: queryPositions,
              ...(input.request === undefined ? {} : { request: {
                method: input.request.method, contentType: input.request.contentType,
                body: template.replace(/§([^§]*)§/g, (() => {
                  let marker = 0;
                  return (_match: string, original: string) => {
                    marker++;
                    const position = positions.findIndex(p => p.name === `body:${marker}`);
                    return position < 0 ? original : combination[position] ?? '';
                  };
                })()),
              } }),
              ...(appliedCookies === undefined
                ? {}
                : {
                    sessionCookies: appliedCookies.map((cookie) => ({
                      name: cookie.name,
                      value: cookie.value,
                      domain: cookie.domain,
                      path: cookie.path,
                    })),
                  }),
            });
            outcomes.push({ status: response.status, contentLength: response.contentLength, bodyHash: response.bodyHash });
            addRow(outcomes[outcomes.length - 1]!);
            this.recordObservedExchange(
              { url: response.requestUrl, method: input.request?.method ?? 'GET', status: response.status, contentType: response.contentType },
              this.deps.clock.now().toISOString(),
              'fuzzer',
            );
            return;
          }
          // fixture adapter: 応答は先頭 position の値だけで決まる (cluster 集約の実演)。
          const body = `resp:${combination[0] ?? ''}`;
          outcomes.push({ status: 200, contentLength: Buffer.byteLength(body), bodyHash: hashStable('scopepilot2.fuzz.body', body) });
          addRow(outcomes[outcomes.length - 1]!);
        },
      },
      positions,
      total,
      {
        isCancelled: () => control?.isCancelled() ?? false,
        attack: input.attack ?? 'cluster-bomb', originals, requestsPerSecond: rps,
        now: () => (adapterKind === 'fixture' ? virtualNowMs : Date.now()),
        sleep: async (ms) => {
          if (adapterKind === 'fixture') {
            virtualNowMs += ms;
            await new Promise<void>(resolve => setImmediate(resolve));
          } else {
            await new Promise((resolve) => {
              setTimeout(resolve, ms);
            });
          }
        },
      },
    );
    const clusters = clusterResponses(outcomes).map((cluster) => ({
      ...cluster,
      representative: combinationAt(positions, cluster.members[0] ?? 0, input.attack, originals),
    }));
    const runId = this.deps.ids.next('fuzz');
    const record = { adapterKind, runId, targetUrl: canonical, total, sent: result.sent, clusters, executedAt: this.deps.clock.now().toISOString() };
    (this.fuzzRuns as { adapterKind: AdapterKind; runId: string; targetUrl: string; total: number; sent: number; clusters: readonly { key: string; members: readonly number[]; representative: readonly string[] }[]; executedAt: string }[]).push(record);
    this.record({ type: 'FuzzRunCompleted', at: record.executedAt, runId, targetUrl: canonical, total, sent: result.sent });
    return {
      adapterKind, payloadSources, transport: adapterKind === 'fixture' ? 'fixture' : 'http', rows,
      runId,
      targetUrl: canonical,
      total,
      sent: result.sent,
      clusters,
      // 適用した cookie は名前のみ (値は出さない — Repeater と同一規則)。
      ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
    };
  }

  listFuzzRuns(): readonly { adapterKind: AdapterKind; runId: string; targetUrl: string; total: number; sent: number; clusters: readonly { key: string; members: readonly number[]; representative: readonly string[] }[]; executedAt: string }[] {
    return [...this.fuzzRuns];
  }

  /**
   * Sequencer session の実行 (design/f07)。sample 数は domain 検証 (30..10000)。
   * 応答は明示注入された adapter からだけ受け取る。
   * token 原文は応答・監査・台帳のいずれにも出さない (F07-UT-006)。
   */

  validateSequencerJob(operator: OperatorProfile, input: SequencerJobParams): void {
    this.requirePermission(operator, 'run.manage');
    const scope = this.currentCase().scope;
    const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
    if (!ScopePolicy.decide(scope, canonical).allowed) throw domainError('OutOfScope', 'sequencer target is out of scope');
    createSamplePlan(input.samples);
    if (input.samples > scope.limits.maxRequests) throw domainError('ValidationFailed', 'sequencer samples exceed the case request limit');
    createSequencerReplayRequest(input.replayRequest);
    createSequencerExtractor(input.tokenSource ?? 'body', input.tokenCookieName, input.tokenFieldName, input.tokenStartDelimiter, input.tokenEndDelimiter);
    if (input.role !== undefined && !this.roleSessionCookies.has(input.role)) throw domainError('ValidationFailed', 'run login for the selected role first');
  }

  startSequencerJob(operator: OperatorProfile, input: SequencerJobParams): string {
    this.validateSequencerJob(operator, input);
    // Credentials remain only in this closure, never in persisted job metadata.
    const params = structuredClone(input);
    const id = this.jobs.create({ kind: 'sequencer', label: 'Sequencer', guarantee: 'Enforced',
      transport: this.deps.sequencerTransport?.adapterKind === 'fixture' || this.deps.sequencerTransport === undefined ? 'fixture' : 'live', budgetLimit: input.samples });
    void this.jobs.execute(id, async signal => {
      this.validateSequencerJob(operator, params);
      this.jobs.emit(id, { category: 'phase', messageKey: 'job.phase', message: 'Collecting samples', params: { phase: 'collect' },
        counters: { progress: { done: 0, total: params.samples, unit: 'samples' } } });
      try {
        const result = await this.runSequencerSession(operator, { ...params, signal, partialOnStop: true });
        return { ...result, targetUrl: redactJobText(result.targetUrl) };
      } catch (cause) {
        if (signal.aborted) throw domainError('Cancelled', 'sequencer session cancelled');
        throw domainError('EngineFailure', 'sequencer collection failed; inspect transport configuration');
      }
    });
    return id;
  }

  async runSequencerSession(
    operator: OperatorProfile,
    input: SequencerJobParams & { readonly signal?: AbortSignal; readonly partialOnStop?: boolean },
  ): Promise<SequencerSessionResult> {
    this.requirePermission(operator, 'run.manage');
    const adapter = this.requireToolAdapter('sequencerTransport');
    const caseRecord = this.currentCase();
    const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
    const decision = ScopePolicy.decide(caseRecord.scope, canonical);
    if (!decision.allowed) {
      throw domainError('OutOfScope', `sequencer target is out of scope: ${decision.reason}`);
    }
    let appliedCookies: readonly LoginSessionCookie[] | undefined;
    if (input.role !== undefined) {
      const session = this.roleSessionCookies.get(input.role);
      if (session === undefined) {
        throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
      }
      appliedCookies = applicableSessionCookies([...session.cookies], canonical);
    }
    const plan = createSamplePlan(input.samples);
    const replayRequest = createSequencerReplayRequest(input.replayRequest);
    const collector = new SampleCollector();
    const extractor = createSequencerExtractor(input.tokenSource ?? 'body', input.tokenCookieName, input.tokenFieldName, input.tokenStartDelimiter, input.tokenEndDelimiter);
    const context = jobContext.getStore();
    const collectionJob = context?.registry.get(context.jobId)?.summary.kind === 'sequencer' ? context : undefined;
    const collectionStartedAt = Date.now();
    let sent = 0;
    const beforeRequest = (): void => {
      throwIfCancelled();
      const current = this.currentCase();
      if (current.caseId !== caseRecord.caseId || !ScopePolicy.decide(current.scope, canonical).allowed) {
        const context = jobContext.getStore();
        context?.registry.emit(context.jobId, { category: 'egress-denied', messageKey: 'job.egress.denied', message: 'Sequencer target denied before sending', params: {} });
        throw domainError('OutOfScope', 'sequencer scope changed during collection');
      }
      if (sent >= Math.min(plan.target, current.scope.limits.maxRequests) || Date.now() - collectionStartedAt >= current.scope.limits.maxDurationMinutes * 60_000) {
        throw domainError('ValidationFailed', 'sequencer collection limit reached');
      }
      sent++;
      if (collectionJob !== undefined) {
        const counters = collectionJob.registry.get(collectionJob.jobId)!.summary.counters;
        collectionJob.registry.emit(collectionJob.jobId, { category: 'budget', messageKey: 'job.request.sent', message: 'Collection request dispatched', params: { method: replayRequest.method },
          counters: { requestsSent: counters.requestsSent + 1, budget: { ...counters.budget, used: counters.budget.used + 1 } } });
      }
    };
    let attempted = 0;
    const recordSample = (response: Parameters<typeof extractSequencerToken>[0]): void => {
      collector.record(extractSequencerToken(response, extractor, pattern));
      attempted++;
      if (collectionJob !== undefined) {
        collectionJob.registry.emit(collectionJob.jobId, { category: 'phase', messageKey: 'job.phase', message: 'Sample collected',
          params: { phase: 'collect', samples: attempted }, counters: { progress: { done: attempted, total: plan.target, unit: 'samples' } } });
      }
    };
    const pattern = /token=([A-Za-z0-9_-]+)/;
    const throwIfCancelled = (): void => {
      if (input.signal?.aborted === true) {
        throw domainError('Cancelled', 'sequencer session cancelled');
      }
    };
    throwIfCancelled();
    {
      try {
        await adapter.collect({
          extractor,
          targetUrl: canonical,
          samples: plan.target,
          replayRequest,
          beforeRequest,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(appliedCookies === undefined ? {} : {
            sessionCookies: appliedCookies.map((cookie) => ({
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
            })),
          }),
          onResponse: (response) => {
            recordSample(response);
            this.recordObservedExchange(
              { url: response.requestUrl, method: replayRequest.method, status: response.status, contentType: response.contentType },
              this.deps.clock.now().toISOString(),
              'sequencer',
              this.deps.sequencerTransport?.adapterKind === 'fixture' || this.deps.sequencerTransport === undefined || (sent > 0 && collectionJob !== undefined),
            );
          },
        });
      } catch (cause) {
        if (!input.signal?.aborted) throw cause;
        if (!input.partialOnStop) throw domainError('Cancelled', 'sequencer session cancelled');
      }
    }
    if (!input.partialOnStop) throwIfCancelled();
    const collection = collector.snapshot();
    const projection = reportProjection(collection);
    const assessment = assess(collection.tokens);
    const sessionId = this.deps.ids.next('seq');
    const verdict = assessment.verdict;
    const adapterKind = adapter.adapterKind ?? 'real';
    const record = {
      sessionId,
      targetUrl: canonical,
      tokenSource: extractor.source,
      adapterKind,
      ...(extractor.source === 'cookie' ? { tokenCookieName: extractor.cookieName } : {}),
      ...(extractor.source === 'hidden' ? { tokenFieldName: extractor.fieldName } : {}),
      ...(extractor.source === 'custom' ? { tokenStartDelimiter: extractor.startDelimiter, tokenEndDelimiter: extractor.endDelimiter } : {}),
      requestMethod: replayRequest.method,
      requestHeaderNames: replayRequest.headers.map(([name]) => name),
      requestBodyBytes: Buffer.byteLength(replayRequest.body, 'utf8'),
      verdict,
      ...projection,
      ...(verdict === 'assessed' ? {
        shannonEntropyBitsPerByte: assessment.entropy.shannonEntropyBitsPerByte,
        shannonEntropyBitsPerToken: assessment.entropy.shannonEntropyBitsPerToken,
        distinctByteValues: assessment.entropy.distinctByteValues,
        byteFrequencyBuckets: assessment.entropy.byteFrequencyBuckets,
        tokenLengthBucketMinimums: assessment.entropy.tokenLengthBucketMinimums,
        tokenByteLengthBuckets: assessment.entropy.tokenByteLengthBuckets,
        tokenCharacterLengthBuckets: assessment.entropy.tokenCharacterLengthBuckets,
        tokenMaximumCharacterRunLengthBuckets: assessment.entropy.tokenMaximumCharacterRunLengthBuckets,
        adjacentTokenBitHammingDistanceBuckets: assessment.entropy.adjacentTokenBitHammingDistanceBuckets,
        adjacentTokenHammingUnequalByteLengthPairs: assessment.entropy.adjacentTokenHammingUnequalByteLengthPairs,
        adjacentNumericAbsoluteDeltaBuckets: assessment.entropy.adjacentNumericAbsoluteDeltaBuckets,
        adjacentNumericDeltaSignCounts: assessment.entropy.adjacentNumericDeltaSignCounts,
        adjacentNumericIneligiblePairs: assessment.entropy.adjacentNumericIneligiblePairs,
        adjacentNumericSerialCorrelationPairs: assessment.entropy.adjacentNumericSerialCorrelationPairs,
        ...(assessment.entropy.adjacentNumericSerialCorrelation === undefined ? {} : { adjacentNumericSerialCorrelation: assessment.entropy.adjacentNumericSerialCorrelation }),
        observedAlphabetSize: assessment.entropy.observedAlphabetSize,
        alphabetClassCounts: assessment.entropy.alphabetClassCounts,
        positionAnalysisLimit: assessment.entropy.positionAnalysisLimit,
        positionAlphabetClassCounts: assessment.entropy.positionAlphabetClassCounts,
        positionOverflowSamples: assessment.entropy.positionOverflowSamples,
      } : { minimum: assessment.minimum }),
      ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
      executedAt: this.deps.clock.now().toISOString(),
    };
    (this.sequencerSessions as typeof record[]).push(record);
    if (!input.signal?.aborted) this.record({
      type: 'SequencerSessionCompleted',
      at: record.executedAt,
      sessionId,
      targetUrl: canonical,
      verdict,
      sampleCount: projection.sampleCount,
      duplicates: projection.duplicates,
      missing: projection.missing,
    });
    const { executedAt: _executedAt, ...result } = record;
    return result;
  }

  listSequencerSessions(): readonly SequencerSessionRecord[] {
    return [...this.sequencerSessions];
  }

  /**
   * OpenAPI/Swagger 仕様の取込 (design/f12)。文書内の instruction/script は実行しない。
   * server は許可 Origin 内だけ候補化し (F12-UT-001)、endpoint (method+path+url) を
   * 返す。path template ({id} 等) は警告付きでそのまま返す — 値は利用者が明示する。
   * 生成された要求は呼出側で ExecutionPlan に入れて確認する (A08 の対象へ設定)。
   */
  importApiSpec(
    operator: OperatorProfile,
    input: { readonly documentLabel: string; readonly document: unknown },
  ): { documentLabel: string; servers: readonly string[]; excludedServers: readonly string[]; endpoints: readonly { method: string; path: string; url: string }[]; warnings: readonly string[] } {
    this.requirePermission(operator, 'case.manage');
    if (input.documentLabel.trim() === '') {
      throw domainError('ValidationFailed', 'documentLabel must not be empty');
    }
    const caseRecord = this.currentCase();
    const parsed = parseOpenApiDocument(input.document);
    // server の scope 除外は domain と同一規則 (F12-UT-001)。URL 構築は basePath を
    // 保持するため生 server 表記を使う (canonicalOrigin は path を落とす)。
    const allowed = parsed.servers.filter((server) => ScopePolicy.decide(caseRecord.scope, server).allowed);
    const excluded = parsed.servers.filter((server) => !ScopePolicy.decide(caseRecord.scope, server).allowed);
    if (allowed.length === 0) {
      throw domainError('OutOfScope', 'no api spec server is within the allowed origins');
    }
    const candidates = allowed.map((server) => server.replace(/\/+$/, ''));
    const endpoints = candidates.flatMap((server) => parsed.endpoints.map((endpoint) => ({ ...endpoint, url: `${server}${endpoint.path}` })));
    const warnings = [...new Set(parsed.endpoints.filter((endpoint) => endpoint.path.includes('{')).map((endpoint) => `path template ${endpoint.path} needs explicit values`))];
    const importedAt = this.deps.clock.now().toISOString();
    (this.apiSpecImports as { documentLabel: string; servers: readonly string[]; excludedServers: readonly string[]; endpoints: readonly (ParsedOpenApiEndpoint & { readonly url: string })[]; importedAt: string }[]).push({ documentLabel: input.documentLabel, servers: candidates, excludedServers: excluded, endpoints, importedAt });
    this.record({
      type: 'ApiSpecImported',
      at: importedAt,
      documentLabel: input.documentLabel,
      endpointCount: endpoints.length,
      excludedServerCount: excluded.length,
    });
    return {
      documentLabel: input.documentLabel,
      servers: candidates,
      excludedServers: excluded,
      endpoints: endpoints.map(({ method, path, url }) => ({ method, path, url })),
      warnings,
    };
  }

  /**
   * OAST attempt の開始 (design/f13)。protocol 能力は provider (fixture は
   * http/dns) で検証し、非対応は CapabilityUnavailable。token はこの応答で
   * 一度だけ返し、監査・一覧には出さない (F13-UT-007)。
   */
  async startOastAttempt(
    operator: OperatorProfile,
    input: { readonly targetUrl: string; readonly protocol: OastProtocol },
  ): Promise<{ attemptId: string; targetUrl: string; protocol: OastProtocol; token: string; waitMs: number; transport: ToolTransport; adapterKind: AdapterKind }> {
    this.requirePermission(operator, 'run.manage');
    const adapter = this.requireToolAdapter('oastProvider');
    const adapterKind = adapter.adapterKind ?? 'real';
    const caseRecord = this.currentCase();
    const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
    const decision = ScopePolicy.decide(caseRecord.scope, canonical);
    if (!decision.allowed) {
      throw domainError('OutOfScope', `oast target is out of scope: ${decision.reason}`);
    }
    const transport = this.deps.oastProvider?.adapterKind ?? 'fixture';
    if (transport === 'unavailable') {
      throw domainError('CapabilityUnavailable', 'oast provider is not configured');
    }
    const supportedProtocols: readonly OastProtocol[] = this.deps.oastProvider !== undefined && 'supportedProtocols' in this.deps.oastProvider ? this.deps.oastProvider.supportedProtocols : ['http', 'dns'];
    if (providerCapability(supportedProtocols, input.protocol) === 'Unsupported') {
      throw domainError('CapabilityUnavailable', `oast provider does not support protocol ${input.protocol}`);
    }
    const attemptId = this.deps.ids.next('oast');
    const pendingEvents: OastProviderEvent[][] = [];
    let attemptRegistered = false;
    const { token } = await adapter.startSession({
          attemptId,
          protocol: input.protocol,
          onEvents: (events) => {
            if (!attemptRegistered) {
              pendingEvents.push([...events]);
              return;
            }
            this.recordProviderOastCallbacks(events);
          },
        });
    this.oastAttempts.push({ attemptId, targetUrl: canonical, protocol: input.protocol, token, issuedAtMs: this.deps.clock.now().getTime(), transport });
    attemptRegistered = true;
    this.record({ type: 'OastAttemptStarted', at: this.deps.clock.now().toISOString(), attemptId, targetUrl: canonical, protocol: input.protocol });
    for (const events of pendingEvents) {
      this.recordProviderOastCallbacks(events);
    }
    return { attemptId, targetUrl: canonical, protocol: input.protocol, token, waitMs: OAST_DEFAULT_WAIT_MS, transport, adapterKind };
  }

  /**
   * provider からの callback 記録 (design/f13)。同一 event は dedupe し
   * (F13-UT-002)、未知 token は uncorrelated として隔離する (F13-UT-003)。
   */
  recordOastCallbacks(
    operator: OperatorProfile,
    input: { readonly events: readonly ProviderEvent[] },
  ): { kept: number; duplicates: number; correlated: number; uncorrelated: number } {
    this.requirePermission(operator, 'run.manage');
    if (input.events.length === 0) {
      throw domainError('ValidationFailed', 'oast callbacks need at least one event');
    }
    return this.recordProviderOastCallbacks(input.events);
  }

  /** provider background poll と fixture API が共有する相関・dedupe 経路。 */
  private recordProviderOastCallbacks(events: readonly OastProviderEvent[]): { kept: number; duplicates: number; correlated: number; uncorrelated: number } {
    const fresh = events.filter((event) => !this.oastSeenEventIds.has(event.eventId));
    const persistedDuplicates = events.length - fresh.length;
    const { kept, duplicates: inCallDuplicates } = normalizeCallbacks(fresh);
    const duplicates = persistedDuplicates + inCallDuplicates;
    for (const event of kept) {
      this.oastSeenEventIds.add(event.eventId);
    }
    const knownTokens = new Set(this.oastAttempts.map((attempt) => attempt.token));
    const callbacks = correlate(kept, knownTokens);
    let correlatedCount = 0;
    let uncorrelatedCount = 0;
    const at = this.deps.clock.now().toISOString();
    for (const [index, callback] of callbacks.entries()) {
      const event = kept[index];
      if (event === undefined) continue;
      const attempt = this.oastAttempts.find((candidate) => candidate.token === callback.token);
      const metadata = oastCallbackMetadata(event.payload, attempt?.protocol ?? 'http');
      const transport = attempt?.transport ?? this.deps.oastProvider?.adapterKind ?? 'fixture';
      if (callback.kind === 'correlated') {
        correlatedCount += 1;
        this.oastInteractions.push({ token: callback.token, payload: callback.payload, recordedAt: at });
      } else {
        uncorrelatedCount += 1;
        this.oastUncorrelated.push({ token: callback.token, reason: callback.reason, recordedAt: at });
      }
      this.oastCallbacks.push({
        eventId: event.eventId,
        attemptId: attempt?.attemptId ?? null,
        protocol: metadata.protocol,
        ...(metadata.remoteAddress === undefined ? {} : { remoteAddress: metadata.remoteAddress }),
        recordedAt: at,
        rawHash: hashStable('scopepilot2.oast.callback.raw', event.payload).slice(0, 12),
        correlation: callback.kind,
        transport,
      });
    }
    this.record({ type: 'OastCallbacksRecorded', at, kept: kept.length, duplicates, correlated: correlatedCount, uncorrelated: uncorrelatedCount });
    return { kept: kept.length, duplicates, correlated: correlatedCount, uncorrelated: uncorrelatedCount };
  }

  /** attempt 一覧 (token なし。interactions と曖昧判定のみ)。 */
  listOastAttempts(): readonly { attemptId: string; targetUrl: string; protocol: OastProtocol; status: 'waiting' | 'expired'; interactions: number; candidateOnly: boolean; transport: ToolTransport }[] {
    const nowMs = this.deps.clock.now().getTime();
    return this.oastAttempts.map((attempt) => {
      const interactions = this.oastInteractions.filter((interaction) => interaction.token === attempt.token);
      const linked = linkFinding(interactions.map(() => ({ kind: 'correlated' as const, token: attempt.token, payload: '' })));
      return {
        attemptId: attempt.attemptId,
        targetUrl: attempt.targetUrl,
        protocol: attempt.protocol,
        status: pollDeadline(attempt.issuedAtMs, nowMs).expired ? ('expired' as const) : ('waiting' as const),
        interactions: interactions.length,
        transport: attempt.transport,
        // 複数 token にまたがる相関は無い (attempt 単位) が、観測 0 件は候補にもしない。
        candidateOnly: linked.linkedTokens.length === 1 && linked.candidateOnly === false ? false : true,
      };
    });
  }

  /** OAST capability and callback list. Tokens and raw provider payloads never leave Core. */
  oastTransport(): { transport: ToolTransport; provider: 'interactsh' | 'fixture' | 'unavailable'; supportedProtocols: readonly OastProtocol[] } {
    const transport = this.deps.oastProvider?.adapterKind ?? 'fixture';
    return {
      transport,
      provider: transport === 'real' ? 'interactsh' : transport,
      supportedProtocols: (this.deps.oastProvider !== undefined && 'supportedProtocols' in this.deps.oastProvider ? this.deps.oastProvider.supportedProtocols : ['http', 'dns']),
    };
  }

  listOastCallbacks(): readonly {
    eventId: string;
    attemptId: string | null;
    protocol: OastProtocol;
    remoteAddress?: string;
    recordedAt: string;
    rawHash: string;
    correlation: 'correlated' | 'uncorrelated';
    transport: ToolTransport;
  }[] {
    return this.oastCallbacks.map((callback) => ({ ...callback }));
  }

  /**
   * WebSocket frame の取込 (design/f14)。text のみ (binary は対象外)。同一 frame は
   * 呼出内・持越しの両方で dedupe する (F14-UT-001)。表示は raw hash と text を
   * 区別して返す (F14-UT-007)。
   */
  importWsFrames(
    operator: OperatorProfile,
    input: { readonly targetUrl: string; readonly frames: readonly { readonly direction: 'sent' | 'received'; readonly payload: string }[] },
  ): { imported: number; duplicates: number } {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
    const decision = ScopePolicy.decide(caseRecord.scope, canonical);
    if (!decision.allowed) {
      throw domainError('OutOfScope', `websocket target is out of scope: ${decision.reason}`);
    }
    if (input.frames.length === 0) {
      throw domainError('ValidationFailed', 'websocket import needs at least one frame');
    }
    const staged: WsFrame[] = input.frames.map((frame, index) => ({
      frameId: this.deps.ids.next('ws'),
      direction: frame.direction,
      payload: frame.payload,
      receivedAtMs: this.deps.clock.now().getTime() + index,
    }));
    // dedupe は direction+payload の fingerprint で (frameId は取込ごとに新規のため
    // domain の id 含む fingerprint には一致しない)。呼出内と持越しの両方で重複を数える。
    const batchFingerprints = new Set<string>();
    const fresh: WsFrame[] = [];
    let duplicates = 0;
    for (const frame of staged) {
      const fingerprint = `${canonical}:${frame.direction}:${frame.payload}`;
      if (this.wsSeenFingerprints.has(fingerprint) || batchFingerprints.has(fingerprint)) {
        duplicates += 1;
        continue;
      }
      batchFingerprints.add(fingerprint);
      fresh.push(frame);
    }
    const { imported } = importFrames(fresh);
    const connectionId = this.deps.ids.next('ws-connection');
    const logicalSessionId = `ws-session-${hashStable('scopepilot2.ws.logical-session', { targetUrl: canonical, source: 'import' }).slice(0, 16)}`;
    for (const frame of imported) {
      this.wsSeenFingerprints.add(`${canonical}:${frame.direction}:${frame.payload}`);
      this.wsFrames.push({ ...frame, connectionId, targetUrl: canonical, transport: 'fixture' });
    }
    if (imported.length > 0) {
      this.wsConnections.push({
        connectionId,
        logicalSessionId,
        targetUrl: canonical,
        transport: 'fixture',
        state: 'imported',
        openedAt: this.deps.clock.now().toISOString(),
        sentFrames: imported.filter((frame) => frame.direction === 'sent').length,
        receivedFrames: imported.filter((frame) => frame.direction === 'received').length,
      });
    }
    this.record({ type: 'WsFramesImported', at: this.deps.clock.now().toISOString(), targetUrl: canonical, imported: imported.length, duplicates });
    return { imported: imported.length, duplicates };
  }

  /** frame 一覧 (text と raw hash を区別した表示素材)。 */
  listWsFrames(): readonly { frameId: string; connectionId: string; targetUrl: string; direction: 'sent' | 'received'; text: string; rawHash: string; recordedAt: string; transport: ToolTransport }[] {
    return this.wsFrames.map((frame) => ({
      frameId: frame.frameId,
      connectionId: frame.connectionId,
      targetUrl: frame.targetUrl,
      direction: frame.direction,
      text: wsEvidence(frame).text,
      rawHash: wsEvidence(frame).rawHash.slice(0, 12),
      recordedAt: new Date(frame.receivedAtMs).toISOString(),
      transport: frame.transport,
    }));
  }

  listWsConnections(): readonly {
    connectionId: string;
    logicalSessionId: string;
    targetUrl: string;
    transport: ToolTransport;
    state: 'closed' | 'failed' | 'imported';
    openedAt: string;
    sentFrames: number;
    receivedFrames: number;
    negotiatedSubprotocol?: string;
  }[] {
    return this.wsConnections.map((connection) => ({ ...connection }));
  }

  webSocketTransport(): { transport: ToolTransport; implementation: 'node-websocket' | 'fixture' | 'unavailable' } {
    const transport = this.deps.webSocketTransport?.adapterKind ?? 'fixture';
    return { transport, implementation: transport === 'real' ? 'node-websocket' : transport };
  }

  /**
   * WebSocket message の送信 (design/f14)。text のみ (binary は Unsupported・
   * F14-UT-003)。plan hash 付きで確認対象を固定し (F14-UT-002)、rate/size 上限は
   * adapter を呼ばずに拒否する (F14-UT-006)。fixture adapter は送信を frame 台帳へ
   * 'sent' として記録するだけ。
   */
  async sendWsMessages(
    operator: OperatorProfile,
    input: { readonly targetUrl: string; readonly messages: readonly string[]; readonly role?: string; readonly subprotocols?: readonly string[] },
  ): Promise<{ planHash: string; sent: number; rejected: 'size' | 'rate' | null; transport: ToolTransport; adapterKind: AdapterKind; connectionId?: string; logicalSessionId?: string; sessionCookieNames?: readonly string[]; negotiatedSubprotocol?: string }> {
    this.requirePermission(operator, 'run.manage');
    const adapter = this.requireToolAdapter('webSocketTransport');
    const adapterKind = adapter.adapterKind ?? 'real';
    const caseRecord = this.currentCase();
    const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
    const decision = ScopePolicy.decide(caseRecord.scope, canonical);
    if (!decision.allowed) {
      throw domainError('OutOfScope', `websocket target is out of scope: ${decision.reason}`);
    }
    if (input.messages.length === 0) {
      throw domainError('ValidationFailed', 'websocket send needs at least one message');
    }
    const subprotocols = validateWsSubprotocols(input.subprotocols ?? []);
    let appliedCookies: readonly LoginSessionCookie[] | undefined;
    if (input.role !== undefined) {
      const session = this.roleSessionCookies.get(input.role);
      if (session === undefined) {
        throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
      }
      appliedCookies = applicableSessionCookies([...session.cookies], canonical);
    }
    const plan = buildWsSendPlan({
      targetUrl: canonical,
      messages: input.messages.map((message) => ({ kind: 'text' as const, payload: message })),
      sessionRevision: this.wsSessionRevision,
      subprotocols,
    });
    const transport = this.deps.webSocketTransport?.adapterKind ?? 'fixture';
    if (transport === 'unavailable') {
      throw domainError('CapabilityUnavailable', 'websocket transport is not configured');
    }
    if (this.deps.webSocketTransport !== undefined) {
      if (input.messages.some((message) => Buffer.byteLength(message, 'utf8') > 1_000_000)) {
        this.record({ type: 'WsMessagesSent', at: this.deps.clock.now().toISOString(), targetUrl: canonical, sent: 0, rejected: 'size' });
        return { planHash: plan.planHash, sent: 0, rejected: 'size', transport, adapterKind };
      }
      const connectionId = this.deps.ids.next('ws-connection');
      const logicalSessionId = `ws-session-${hashStable('scopepilot2.ws.logical-session', { targetUrl: canonical, role: input.role ?? null, subprotocols }).slice(0, 16)}`;
      const openedAt = this.deps.clock.now().toISOString();
      const recordFrame = (direction: 'sent' | 'received', payload: string): void => {
        const frame: WsFrame = { frameId: this.deps.ids.next('ws'), direction, payload, receivedAtMs: this.deps.clock.now().getTime() };
        this.wsFrames.push({ ...frame, connectionId, targetUrl: canonical, transport });
        this.wsSeenFingerprints.add(`${canonical}:${frame.direction}:${frame.payload}`);
      };
      let transported: Awaited<ReturnType<NonNullable<BaselineFlowDeps['webSocketTransport']>['exchange']>>;
      try {
        transported = await this.deps.webSocketTransport.exchange({
          targetUrl: canonical,
          messages: input.messages,
          ...(subprotocols.length === 0 ? {} : { subprotocols }),
          ...(appliedCookies === undefined ? {} : {
            sessionCookies: appliedCookies.map((cookie) => ({
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
            })),
          }),
          onSentFrame: (payload) => recordFrame('sent', payload),
          onTextFrame: (payload) => recordFrame('received', payload),
        });
      } catch (cause) {
        const frames = this.wsFrames.filter((frame) => frame.connectionId === connectionId);
        this.wsConnections.push({ connectionId, logicalSessionId, targetUrl: canonical, transport, state: 'failed', openedAt, sentFrames: frames.filter((frame) => frame.direction === 'sent').length, receivedFrames: frames.filter((frame) => frame.direction === 'received').length });
        throw cause;
      }
      const frames = this.wsFrames.filter((frame) => frame.connectionId === connectionId);
      this.wsConnections.push({
        connectionId,
        logicalSessionId,
        targetUrl: canonical,
        transport,
        state: 'closed',
        openedAt,
        sentFrames: frames.filter((frame) => frame.direction === 'sent').length,
        receivedFrames: frames.filter((frame) => frame.direction === 'received').length,
        ...(transported.negotiatedSubprotocol === undefined ? {} : { negotiatedSubprotocol: transported.negotiatedSubprotocol }),
      });
      this.record({ type: 'WsMessagesSent', at: this.deps.clock.now().toISOString(), targetUrl: canonical, sent: transported.sent });
      return {
        planHash: plan.planHash,
        sent: transported.sent,
        rejected: null,
        transport,
        adapterKind,
        connectionId,
        logicalSessionId,
        ...(transported.negotiatedSubprotocol === undefined ? {} : { negotiatedSubprotocol: transported.negotiatedSubprotocol }),
        ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
      };
    }
    const connectionId = this.deps.ids.next('ws-connection');
    const logicalSessionId = `ws-session-${hashStable('scopepilot2.ws.logical-session', { targetUrl: canonical, role: input.role ?? null, subprotocols }).slice(0, 16)}`;
    const openedAt = this.deps.clock.now().toISOString();
    let virtualMs = 0;
    const result = await sendWithPolicy(
      input.messages,
      { maxMessageBytes: 1_000_000, messagesPerSecond: 10, now: () => (virtualMs += 1000) },
      {
        send: async (message) => {
          const frame: WsFrame = { frameId: this.deps.ids.next('ws'), direction: 'sent', payload: message, receivedAtMs: this.deps.clock.now().getTime() };
          this.wsFrames.push({ ...frame, connectionId, targetUrl: canonical, transport });
          this.wsSeenFingerprints.add(`${canonical}:${frame.direction}:${frame.payload}`);
        },
      },
    );
    this.wsConnections.push({ connectionId, logicalSessionId, targetUrl: canonical, transport, state: 'closed', openedAt, sentFrames: result.sent, receivedFrames: 0 });
    this.record({ type: 'WsMessagesSent', at: this.deps.clock.now().toISOString(), targetUrl: canonical, sent: result.sent });
    return {
      planHash: plan.planHash,
      sent: result.sent,
      rejected: result.rejected,
      transport,
      adapterKind,
      connectionId,
      logicalSessionId,
      ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
    };
  }

  /**
   * transport の選択 (design/f15)。HTTP/3 は能力表で Unsupported。peer が h2 を
   * offer しない場合、fallback 未許可なら CapabilityUnavailable (F15-UT-004)。
   * 明示注入された port で bounded request probe を行い、ALPN/runtime を保持する (F15-UT-007)。
   */
  async negotiateTransportFor(operator: OperatorProfile, input: { readonly targetUrl: string; readonly allowFallback: boolean; readonly requested?: 'h2' | 'http/1.1' | 'h3' }): Promise<{ adapterKind: AdapterKind; protocol: 'h2' | 'http/1.1'; downgraded: boolean; alpn: string; runtime: string; response?: import('../ports/engines.ts').TransportProbeResponseEvidence }> {
    this.requirePermission(operator, 'run.manage');
    const adapter = this.requireToolAdapter('advancedTransport');
    const adapterKind = adapter.adapterKind ?? 'real';
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
    const probe = await adapter.probe({ targetUrl: canonical, requested, allowFallback: input.allowFallback });
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
      adapterKind,
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
  validateTransportHeaders(
    operator: OperatorProfile,
    input: { readonly headers: readonly (readonly [string, string])[]; readonly scheme: string },
  ): { ordered: readonly string[]; authority: string } {
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
  async analyzeDomFlows(
    operator: OperatorProfile,
    input: {
      readonly targetUrl: string;
      readonly observations: readonly { readonly api: string; readonly marker: string }[];
      readonly nodes?: readonly { readonly text: string; readonly looksLikePii: boolean }[];
      readonly live?: boolean;
      /** runLogin 済み role。live observation の browser context にだけ適用する。 */
      readonly role?: string;
    },
  ): Promise<{ candidates: readonly { sourceApi: string; sinkApi: string; confidence: number; marker: string }[]; evidence: readonly string[] }> {
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
        const session = this.roleSessionCookies.get(input.role);
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
      } catch {
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
  installExtension(
    operator: OperatorProfile,
    input: { readonly extensionId: string; readonly version: string; readonly signature: string; readonly publisherTrusted: boolean; readonly permissions: readonly string[]; readonly apiRange: readonly string[] },
  ): { loaded: true; extension: { extensionId: string; version: string; permissions: readonly string[]; apiRange: readonly string[] } } {
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
    } catch {
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
  listExtensions(): readonly { extensionId: string; version: string; permissions: readonly string[]; apiRange: readonly string[] }[] {
    return [...this.loadedExtensions];
  }

  /**
   * HTTPS 記録用 CA profile の台帳 (design/24 §2)。鍵生成は実 engine 接続と共に
   * 後続 — ここは fingerprint・生成元・期限・信頼登録状態の表示と信頼状態の
   * 変更 (監査付き) のみ。秘密鍵の export は設計上存在しない。
   */
  listCaProfiles(): readonly { profileId: string; purpose: string; generatedBy: string; fingerprint: string; createdAt: string; expiresAt: string; trusted: boolean }[] {
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
  setCaProfileTrust(operator: OperatorProfile, profileId: string, trusted: boolean): { profileId: string; trusted: boolean } {
    this.requirePermission(operator, 'case.manage');
    if (profileId !== 'scopepilot2-diagnostics') {
      throw domainError('ValidationFailed', `unknown CA profile ${profileId}`);
    }
    this.caProfileTrusted = trusted;
    this.record({ type: 'CaProfileTrustChanged', at: this.deps.clock.now().toISOString(), profileId, trusted });
    return { profileId, trusted };
  }

  listApiSpecImports(): readonly { documentLabel: string; endpointCount: number; importedAt: string }[] {
    return this.apiSpecImports.map((entry) => ({ documentLabel: entry.documentLabel, endpointCount: entry.endpoints.length, importedAt: entry.importedAt }));
  }

  /** draft の表示形 (UI 確認用に plan hash を添える)。 */
  private repeaterDraftView(draft: RepeaterDraft): { draftId: string; targetUrl: string; protocol: RepeaterDraft['protocol']; revision: number; requestBytes: string; planHash: string } {
    return {
      draftId: draft.draftId,
      targetUrl: draft.targetUrl,
      protocol: draft.protocol,
      revision: draft.revision,
      requestBytes: draft.requestBytes,
      planHash: hashStable('scopepilot2.repeater.request', { bytes: draft.requestBytes, revision: draft.revision, target: draft.targetUrl }),
    };
  }

  listRepeaterDrafts(): readonly ReturnType<BaselineFlowService['repeaterDraftView']>[] {
    return [...this.repeaterDraftViews().values()];
  }

  private repeaterDraftViews(): Map<string, ReturnType<BaselineFlowService['repeaterDraftView']>> {
    const views = new Map<string, ReturnType<BaselineFlowService['repeaterDraftView']>>();
    for (const draft of this.listRepeaterDraftList()) {
      views.set(draft.draftId, this.repeaterDraftView(draft));
    }
    return views;
  }

  private listRepeaterDraftList(): readonly RepeaterDraft[] {
    // DraftRegistry に list は無いが service は get を id 経由で使うため、作成順を別に持つ。
    return this.repeaterDraftOrder.map((draftId) => this.repeaterDrafts.get(draftId)).filter((draft): draft is RepeaterDraft => draft !== undefined);
  }

  /** Repeater draft の作成 (design/f04)。対象 URL は案件 scope 内に限る。 */
  createRepeaterDraft(
    operator: OperatorProfile,
    input: { readonly targetUrl: string; readonly protocol: RepeaterDraft['protocol'] },
  ): ReturnType<BaselineFlowService['repeaterDraftView']> {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
    const decision = ScopePolicy.decide(caseRecord.scope, canonical);
    if (!decision.allowed) {
      throw domainError('OutOfScope', `repeater target is out of scope: ${decision.reason}`);
    }
    const draft = this.repeaterDrafts.create({
      draftId: this.deps.ids.next('draft'),
      baseExchangeId: this.deps.ids.next('exchange'),
      protocol: input.protocol,
      requestBytes: renderInitialRequest(canonical),
      targetUrl: canonical,
    });
    this.repeaterDraftOrder.push(draft.draftId);
    return this.repeaterDraftView(draft);
  }

  /** header/body 編集。改行を含む header は拒否され、revision が進む (F04-UT-002)。 */
  editRepeaterDraft(
    operator: OperatorProfile,
    draftId: string,
    edit: { readonly headers: readonly (readonly [string, string])[]; readonly body: string },
  ): ReturnType<BaselineFlowService['repeaterDraftView']> {
    this.requirePermission(operator, 'run.manage');
    const draft = this.repeaterDrafts.get(draftId);
    if (draft === undefined) {
      throw domainError('ValidationFailed', `repeater draft ${draftId} does not exist`);
    }
    applyEdit(draft, edit);
    return this.repeaterDraftView(draft);
  }

  /**
   * draft の送信。UI が表示した plan hash と現在の hash が一致する場合だけ adapter へ渡す
   * (F04-UT-003)。応答は summary のみ返し、binary は text 化しない (F04-UT-006)。
   * timeout 相当は応答なし attempt として記録する (F04-UT-007)。
   * role 指定時はその role の session cookie を適用する (design/08: F04 は Cookie 適用対象)。
   * cookie は対象 URL の host/path に一致するものだけ (別 Origin への認証送信はしない)。
   */
  async sendRepeaterDraft(
    operator: OperatorProfile,
    draftId: string,
    confirmedPlanHash: string,
    role?: string,
  ): Promise<{ adapterKind: AdapterKind; sent: boolean; reason?: string; attempt?: SendAttemptRecord; response?: ReturnType<typeof summarizeResponse>; sessionCookieNames?: readonly string[] }> {
    this.requirePermission(operator, 'run.manage');
    const adapter = this.requireToolAdapter('repeaterTransport');
    const adapterKind = adapter.adapterKind ?? 'real';
    const draft = this.repeaterDrafts.get(draftId);
    if (draft === undefined) {
      throw domainError('ValidationFailed', `repeater draft ${draftId} does not exist`);
    }
    let appliedCookies: readonly LoginSessionCookie[] | undefined;
    if (role !== undefined) {
      const session = this.roleSessionCookies.get(role);
      if (session === undefined) {
        throw domainError('ValidationFailed', `no session for role '${role}'; run login first`);
      }
      appliedCookies = applicableSessionCookies([...session.cookies], draft.targetUrl);
    }
    const currentHash = hashStable('scopepilot2.repeater.request', { bytes: draft.requestBytes, revision: draft.revision, target: draft.targetUrl });
    let transportResponse: import('../ports/engines.ts').RepeaterTransportResponse | undefined;
    const outcome = await sendCommand(draft, confirmedPlanHash, {
      send: async (command) => {
        transportResponse = await adapter.send({
          targetUrl: draft.targetUrl,
          requestBytes: draft.requestBytes,
          ...(appliedCookies === undefined ? {} : { sessionCookies: appliedCookies.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path })) }),
        });
        this.repeaterSentCommands.push(command);
        this.recordObservedExchange(
          {
            url: draft.targetUrl,
            method: 'GET',
            status: transportResponse.status,
            contentType: transportResponse.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '',
          },
          this.deps.clock.now().toISOString(),
          'repeater',
        );
      },
    }, appliedCookies === undefined ? undefined : [...appliedCookies]);
    if (!outcome.sent) {
      return { adapterKind, sent: false, reason: 'confirmed plan hash does not match the current draft (revision が進んでいないか確認してください)' };
    }
    // 実 transport の redirect は domain と同じ規則で評価する (scope 外 Location は
    // hop 前に停止 — F04-UT-004)。停止した場合は応答を返さない。
    if (transportResponse !== undefined && transportResponse.redirectLocations.length > 0) {
      const redirects = runRedirects(
        transportResponse.redirectLocations.map((location) => ({ location })),
        this.currentCase().scope,
      );
      if (redirects.outcome !== 'completed') {
        return { adapterKind, sent: false, reason: `redirect stopped: ${redirects.outcome}${redirects.lastReason === undefined ? '' : ` (${redirects.lastReason})`}` };
      }
    }
    if (transportResponse === undefined) throw domainError('CapabilityUnavailable', 'repeater returned no response');
    const body = transportResponse.body;
    const attempt = recordSendAttempt(draft.draftId, body);
    this.repeaterAttempts.push(attempt);
    const summaryInput = { status: transportResponse.status, headers: transportResponse.headers, body };
    return {
      adapterKind,
      sent: true,
      attempt,
      response: summarizeResponse(summaryInput),
      // 適用した cookie は名前のみ応答に出す (値は出さない — F09-UT-006 と同一規則)。
      ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
    };
  }

  repeaterAttemptLog(): readonly SendAttemptRecord[] {
    return [...this.repeaterAttempts];
  }

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
  updateFindingStatus(
    operator: OperatorProfile,
    input: {
      readonly findingId: string;
      readonly next: 'confirmed' | 'rejected';
      readonly reproduction: 'reproduced' | 'not-reproduced';
      readonly notes: string;
      readonly severityRationale: string;
      readonly cvss?: { readonly version: '3.1' | '4.0'; readonly vector: string; readonly score: number };
    },
  ): Finding {
    this.requirePermission(operator, 'finding.confirm');
    const at = this.deps.clock.now().toISOString();
    const before = this.importer.list().find((finding) => finding.findingId === input.findingId);
    if (before === undefined) {
      throw domainError('ValidationFailed', `finding ${input.findingId} does not exist`);
    }
    if (input.notes.trim() === '' || input.severityRationale.trim() === '') {
      throw domainError('ValidationFailed', 'human review notes and severity rationale are required');
    }
    if ((input.next === 'confirmed') !== (input.reproduction === 'reproduced')) {
      throw domainError('ValidationFailed', 'review result and reproduction result are inconsistent');
    }
    if (input.cvss !== undefined && (input.cvss.vector.trim() === '' || input.cvss.score < 0 || input.cvss.score > 10)) {
      throw domainError('ValidationFailed', 'CVSS vector and score (0..10) are invalid');
    }
    const updated = this.importer.updateStatus(input.findingId, input.next, {
      now: at,
      changedBy: operator.operatorId,
      review: {
        reproduction: input.reproduction,
        notes: input.notes.trim(),
        severityRationale: input.severityRationale.trim(),
        ...(input.cvss === undefined ? {} : { cvss: input.cvss }),
      },
    });
    this.persistFindings([updated]);
    this.record({ type: 'FindingStatusChanged', at, findingId: input.findingId, from: before.status, to: input.next, changedBy: operator.operatorId });
    return updated;
  }

  readonly runtimeProfile: RuntimeProfile;
  private readonly configuredAt: string;
  private readonly adapterSnapshot: readonly RuntimeAdapterCapability[];

  toolCapabilities(): readonly RuntimeAdapterCapability[] {
    return structuredClone(this.adapterSnapshot);
  }

  runtimeBundleManifest() {
    const content = { runtimeBundleHash: this.deps.runtimeBundleHash, runtimeProfile: this.runtimeProfile,
      adapters: this.toolCapabilities(), engines: this.capabilities() };
    return { ...content, manifestHash: hashStable('scopepilot2.runtime.adapters', content) };
  }

  private async saveRuntimeBundle(runId: string): Promise<void> {
    await this.deps.evidence.saveText(`runtime-bundle:${runId}`, canonicalJson(this.runtimeBundleManifest()), { kind: 'runtime-bundle', runId });
  }

  private requireProductionPlan(plan: ExecutionPlan): void {
    if (this.runtimeProfile === 'production' && plan.steps.some((step) =>
      this.deps.capabilities.some((capability) => capability.engineKind === step.engineKind && capability.source === 'fixture'))) {
      throw domainError('CapabilityUnavailable', 'production plans cannot contain fixture engine routes');
    }
  }

  private describeToolAdapters(): readonly RuntimeAdapterCapability[] {
    return TOOL_PORTS.map((name) => {
      const port = this.deps[name];
      const kind = port?.adapterKind ?? (port === undefined || this.runtimeProfile === 'production' ? 'unavailable' : 'real');
      const allowed = kind !== 'unavailable' && (this.runtimeProfile !== 'production' || kind === 'real');
      return { capability: name, adapterKind: kind, available: allowed, configuredAt: this.configuredAt,
        version: port?.version ?? 'unspecified', constraints: allowed ? [] : [port instanceof UnavailableCapability ? port.reason : `${name} is not configured with an allowed adapter for ${this.runtimeProfile}`],
        ...(kind === 'fixture' ? { fixtureHash: hashStable('scopepilot2.tool.fixture', { name, implementation: Object.entries(port ?? {}).map(([key, value]) => [key, typeof value === 'function' ? value.toString() : value]) }) } : {}) };
    });
  }

  private requireToolAdapter<K extends ToolPortName>(name: K): Exclude<NonNullable<BaselineFlowDeps[K]>, UnavailableCapability> {
    const port = this.deps[name];
    if (port === undefined || port instanceof UnavailableCapability || port.adapterKind === 'unavailable'
      || (this.runtimeProfile === 'production' && port.adapterKind !== 'real')) {
      throw domainError('CapabilityUnavailable', `${name} requires a configured adapter for ${this.runtimeProfile}`, { details: { capability: name, runtimeProfile: this.runtimeProfile, adapterKind: port?.adapterKind ?? 'unavailable' } });
    }
    return port as Exclude<NonNullable<BaselineFlowDeps[K]>, UnavailableCapability>;
  }

  /** 能力表 (fixture または実測)。API 経由で UI/CLI が版と fixture hash を確認するのに使う。 */
  capabilities(): readonly EngineCapabilitySnapshot[] {
    return [...this.deps.capabilities];
  }

  currentCase(): CaseRecord {
    if (this.aggregate === null) {
      throw domainError('ValidationFailed', 'case has not been created yet');
    }
    return this.aggregate.record;
  }

  currentAuthorization(): AuthorizationRecord {
    if (this.authorization === null) {
      throw domainError('ValidationFailed', 'authorization has not been granted yet');
    }
    return this.authorization;
  }

  /** 案件作成。origin は canonicalize 後に保存し、正規化できない URL は拒否する。 */
  createCase(operator: OperatorProfile, input: CreateCaseInput): CaseRecord {
    this.requirePermission(operator, 'case.manage');
    if (input.name.trim() === '') {
      throw domainError('ValidationFailed', 'case name must not be empty');
    }
    this.requirePositiveLimits(input.limits, 'case');
    const allowed = input.allowedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
    const denied = input.deniedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
    if (allowed.length === 0) {
      throw domainError('ValidationFailed', 'case must have at least one allowed origin');
    }
    this.clearAuthentication();
    this.aggregate = CaseAggregate.open({
      caseId: this.deps.ids.next('case'),
      name: input.name,
      revision: 1,
      scope: { allowedOrigins: [...new Set(allowed)], deniedOrigins: [...new Set(denied)], limits: input.limits },
      createdAt: this.deps.clock.now().toISOString(),
    });
    this.deps.caseSink?.save(this.aggregate.record);
    this.record({ type: 'CaseCreated', at: this.deps.clock.now().toISOString(), caseId: this.aggregate.record.caseId, revision: 1 });
    return this.aggregate.record;
  }

  /**
   * scope 更新。expectedRevision 必須 (f01 §4)。狭くなる更新は既存 confirmation を無効化し、
   * 無効化 event を監査記録へ残す。進行中 job への停止要求は run 管理の実装時に接続する。
   */
  updateCaseScope(
    operator: OperatorProfile,
    input: {
      expectedRevision: number;
      allowedOrigins: readonly string[];
      deniedOrigins: readonly string[];
      limits: ScopeLimits;
    },
  ): { revision: number; narrowed: boolean; invalidatedConfirmationIds: readonly string[] } {
    this.requirePermission(operator, 'case.manage');
    const aggregate = this.aggregate;
    if (aggregate === null) {
      throw domainError('ValidationFailed', 'case has not been created yet');
    }
    const allowed = input.allowedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
    const denied = input.deniedOrigins.map((origin) => this.canonicalOriginOrThrow(origin));
    if (allowed.length === 0) {
      throw domainError('ValidationFailed', 'case must have at least one allowed origin');
    }
    this.requirePositiveLimits(input.limits, 'case');
    const outcome = aggregate.updateScope({
      expectedRevision: input.expectedRevision,
      scope: { allowedOrigins: [...new Set(allowed)], deniedOrigins: [...new Set(denied)], limits: input.limits },
    });
    for (const role of this.loginFlows.keys()) this.invalidateRoleSession(role);
    const at = this.deps.clock.now().toISOString();
    this.record({ type: 'CaseScopeUpdated', at, caseId: outcome.record.caseId, revision: outcome.revision, narrowed: outcome.narrowed });
    if (outcome.invalidatedConfirmationIds.length > 0) {
      this.record({
        type: 'ConfirmationsInvalidated',
        at,
        caseId: outcome.record.caseId,
        confirmationIds: [...outcome.invalidatedConfirmationIds],
        reason: 'case scope narrowed',
      });
    }
    this.deps.caseSink?.save(outcome.record);
    return outcome;
  }

  /** 認可の付与。証跡原本は hash 参照のみ持ち、秘密値は保持しない。 */
  async grantAuthorization(operator: OperatorProfile, input: GrantAuthorizationInput): Promise<AuthorizationRecord> {
    this.requirePermission(operator, 'case.manage');
    const caseRecord = this.currentCase();
    if (input.validFrom >= input.validUntil) {
      throw domainError('ValidationFailed', 'authorization validFrom must be before validUntil');
    }
    if (input.allowedOperationClasses.length === 0) {
      throw domainError('ValidationFailed', 'authorization must allow at least one operation class');
    }
    const stored = await this.deps.evidence.saveText(
      input.evidence.label,
      input.evidence.content,
      // 許可欄以外の metadata は保存しない (F01-UT-008)。
      filterAuthorizationEvidenceMetadata(input.evidence.metadata ?? {}),
    );
    this.authorization = {
      authorizationId: this.deps.ids.next('authz'),
      caseId: caseRecord.caseId,
      allowedOperationClasses: input.allowedOperationClasses,
      targetRoles: input.targetRoles,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      evidenceRef: { evidenceId: stored.evidenceId, sha256: stored.sha256, label: stored.label },
    };
    this.deps.authorizationSink?.save(this.authorization);
    this.record({
      type: 'AuthorizationGranted',
      at: this.deps.clock.now().toISOString(),
      authorizationId: this.authorization.authorizationId,
      caseId: caseRecord.caseId,
    });
    return this.authorization;
  }

  /** 探索計画。既定上限と案件上限の狭い方を使う。 */
  buildExplorationPlan(
    operator: OperatorProfile,
    seeds: readonly string[],
    limitsRequest?: { readonly maxRequests: number; readonly maxPages: number; readonly maxDurationMinutes: number },
    options?: { readonly discoverySources?: readonly import('@scopepilot2/contracts').DiscoverySource[] },
  ): { plan: ExecutionPlan; planHash: string } {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    const authorization = this.currentAuthorization();
    const discoverySources = options?.discoverySources;
    if (discoverySources?.some((source) => !['robots', 'sitemap', 'manifest', 'wordlist'].includes(source))) throw domainError('ValidationFailed', 'unknown discovery source');
    if (discoverySources?.length && !authorization.allowedOperationClasses.includes('ActiveCrawl')) throw domainError('PermissionDenied', 'discovery requires ActiveCrawl authorization');
    if (seeds.length === 0) {
      throw domainError('ValidationFailed', 'exploration needs at least one seed URL');
    }
    if (limitsRequest !== undefined) {
      // UI からの上限指定は案件上限へクランプされる (Advanced モードの上限編集・design/02 §3)。
      this.requirePositiveLimits(limitsRequest, 'plan.explore');
    }
    const limits = this.planLimits({ ...DEFAULT_EXPLORE_LIMITS, ...limitsRequest }, caseRecord.scope.limits);
    // document hint は許可 Origin 内の URL だけ追加開始点へ統合する (AGENTS.md)。
    // 計画の target snapshot に含まれるため、hint 由来の送信も確認画面の対象になる。
    const merged = mergeDocumentHintSeeds(
      seeds,
      this.documentHintDocuments.flatMap((document) => document.urls),
      caseRecord.scope,
    );
    const targets = [...new Set([...merged.targets, ...discoverySeeds(seeds.map((url) => new URL(url).origin), discoverySources ?? [])])];
    const inputEvidenceHash = hashStable('scopepilot2.plan.input', { targets: targets.map((url) => ScopePolicy.canonicalUrl(url)).sort(), discoveryVersion: DISCOVERY_VERSION });
    const planId = this.deps.ids.next('plan');
    const plan = buildPlan({
      planId,
      caseId: caseRecord.caseId,
      authorizationId: authorization.authorizationId,
      operatorId: operator.operatorId,
      targetRole: authorization.targetRoles[0] ?? 'unauthenticated',
      steps: [
        {
          kind: 'explore',
          operationClass: discoverySources?.length ? 'ActiveCrawl' : 'Browse',
          ...(discoverySources === undefined ? {} : { discoverySources }),
          targets,
          engineKind: 'playwright',
          guarantee: 'Enforced',
          limits,
        },
      ],
      limits,
      runtimeBundleHash: this.deps.runtimeBundleHash,
      inputEvidenceHash,
      createdAt: this.deps.clock.now().toISOString(),
    });
    this.explorationHintSeeds.set(planId, new Set(merged.hintTargets));
    return { plan, planHash: planHashOf(plan) };
  }

  /**
   * payload 実行検証 (design/f08: 反射の所見と実行確認を区別する)。
   * 検証 URL (payload 付き) を browser で開き、dialog 発火等のコード実行根拠を
   * 観測する。scope 強制はこの入口で行い (Enforced: 送信前拒否)、結果は証跡へ
   * 保存する (信号の文言は先頭のみ・秘密値は出ない)。
   */
  async verifyFindingExecution(
    operator: OperatorProfile,
    input: { readonly url: string; readonly role?: string; readonly findingId?: string },
  ): Promise<{ executed: boolean; signals: readonly string[]; evidenceRef: string }> {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    const decision = ScopePolicy.decide(caseRecord.scope, input.url);
    if (!decision.allowed) {
      throw domainError('OutOfScope', `payload execution verification target is out of scope: ${decision.reason}`);
    }
    let session: BrowserSessionState | undefined;
    if (input.role !== undefined) {
      const roleSession = this.roleSessionCookies.get(input.role);
      if (roleSession === undefined) {
        throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
      }
      session = roleSession.browserState;
    }
    if (typeof this.deps.explorer.verifyPayloadExecution !== 'function') {
      throw domainError('CapabilityUnavailable', 'configured explorer does not support payload execution verification');
    }
    const startedAt = this.deps.clock.now().toISOString();
    const verification = await this.deps.explorer.verifyPayloadExecution(input.url, session);
    const evidence = await this.deps.evidence.saveText(
      `payload-verification:${input.findingId ?? startedAt}`,
      canonicalJson({ url: input.url, role: input.role ?? null, findingId: input.findingId ?? null, executed: verification.executed, signals: verification.signals, verifiedAt: startedAt }),
      { kind: 'payload-verification' },
    );
    return { executed: verification.executed, signals: verification.signals, evidenceRef: evidence.evidenceId };
  }

  /** 能動診断計画。対象は採用済み候補の canonical URL の固定 snapshot。 */
  buildActiveScanPlan(
    operator: OperatorProfile,
    targets: readonly string[],
    limitsRequest?: { readonly maxRequests: number; readonly maxPages: number; readonly maxDurationMinutes: number },
    options: {
      readonly includeNuclei?: boolean;
      readonly includeWorkflowScan?: boolean;
      readonly guidelines?: readonly string[];
      readonly scanPolicyId?: string;
      readonly scanPolicyHash?: string;
      readonly routeOverrides?: ScanPolicyRouteOverrides;
      readonly targetRole?: string;
    } = {},
  ): { plan: ExecutionPlan; planHash: string } {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    const authorization = this.currentAuthorization();
    if (targets.length === 0) {
      throw domainError('ValidationFailed', 'active scan needs at least one adopted target');
    }
    if (limitsRequest !== undefined) {
      this.requirePositiveLimits(limitsRequest, 'plan.scan');
    }
    const limits = this.planLimits({ ...DEFAULT_ACTIVE_SCAN_LIMITS, ...limitsRequest }, caseRecord.scope.limits);
    const selectedPolicy = options.scanPolicyId === undefined
      ? undefined
      : this.scanPolicies.get(caseRecord.caseId, options.scanPolicyId, this.deps.clock.now().toISOString());
    if (selectedPolicy !== undefined && options.scanPolicyHash !== undefined && selectedPolicy.policyHash !== options.scanPolicyHash) {
      throw domainError('Conflict', 'scan policy changed after it was displayed; reload the policy before building the plan', {
        details: { policyId: selectedPolicy.policyId, currentPolicyHash: selectedPolicy.policyHash, displayedPolicyHash: options.scanPolicyHash },
      });
    }
    const routeEnabled = (route: keyof ScanPolicyRouteOverrides): boolean => {
      const configured = route === 'zap'
        ? selectedPolicy?.routes.zap.enabled
        : route === 'genericHttp'
          ? selectedPolicy?.routes.genericHttp.enabled
          : selectedPolicy?.routes.nuclei.enabled;
      return configured === true && options.routeOverrides?.[route] !== false;
    };
    // scanPolicyId がない呼出しは既存 CLI/API 互換。A40 は必ず policyId を渡す。
    const includeZap = selectedPolicy === undefined ? true : routeEnabled('zap');
    const includeNuclei = selectedPolicy === undefined ? options.includeNuclei === true : routeEnabled('nuclei');
    const includeWorkflowScan = selectedPolicy === undefined ? options.includeWorkflowScan === true : routeEnabled('genericHttp');
    if (includeNuclei && this.deps.nucleiRunner === undefined && options.routeOverrides?.nuclei === true) {
      throw domainError('CapabilityUnavailable', 'Nuclei requires both a configured binary and a reviewed HTTP template manifest');
    }
    const effectiveNuclei = includeNuclei && this.deps.nucleiRunner !== undefined;
    if (includeWorkflowScan && this.deps.workflowScanTransportFactory === undefined && options.routeOverrides?.genericHttp === true) {
      throw domainError('CapabilityUnavailable', 'workflow scan transport is not configured');
    }
    const effectiveWorkflowScan = includeWorkflowScan && this.deps.workflowScanTransportFactory !== undefined;
    const enabledStepCount = (includeZap ? 1 : 0) + (effectiveNuclei ? 1 : 0) + (effectiveWorkflowScan ? 1 : 0);
    if (enabledStepCount === 0) {
      throw domainError('ValidationFailed', 'active scan plan needs at least one available diagnostic route');
    }
    if (limits.maxRequests < enabledStepCount) {
      throw domainError('ValidationFailed', `plan needs at least ${String(enabledStepCount)} requests for the selected diagnostic steps`);
    }
    const workflowMaxRequests = effectiveWorkflowScan
      ? Math.min(WORKFLOW_SCAN_DEFAULT_MAX_REQUESTS, Math.floor(limits.maxRequests / enabledStepCount))
      : 0;
    const remainingRequests = limits.maxRequests - workflowMaxRequests;
    const delegatedStepCount = (includeZap ? 1 : 0) + (effectiveNuclei ? 1 : 0);
    const nucleiMaxRequests = effectiveNuclei ? Math.floor(remainingRequests / delegatedStepCount) : 0;
    const zapMaxRequests = includeZap ? remainingRequests - nucleiMaxRequests : 0;
    const withRequestLimit = (maxRequests: number): PlanLimits => ({ ...limits, maxRequests });
    const workflowTargets = [...new Set(targets.map((url) => ScopePolicy.canonicalUrl(url)))];
    const inputEvidenceHash = hashStable('scopepilot2.plan.input', {
      targets: workflowTargets.sort(),
      scanPolicyHash: selectedPolicy?.policyHash ?? null,
    });
    const plan = buildPlan({
      planId: this.deps.ids.next('plan'),
      caseId: caseRecord.caseId,
      authorizationId: authorization.authorizationId,
      operatorId: operator.operatorId,
      targetRole: options.targetRole?.trim() || authorization.targetRoles[0] || 'unauthenticated',
      guidelineIds: options.guidelines ?? [],
      guidelineCoverage: this.guidelineCoverage.planForObservedTargets(
        options.guidelines ?? [], workflowTargets,
        includeWorkflowScan ? this.deps.capabilities : this.deps.capabilities.filter((c) => c.engineKind !== 'node-http'),
      ),
      steps: [
        ...(!includeZap ? [] : [{
          kind: 'active-scan',
          operationClass: 'ActiveScan',
          targets,
          engineKind: 'zap',
          guarantee: 'Delegated',
          engineVersion: this.deps.scanEngine.engineVersion,
          limits: withRequestLimit(zapMaxRequests),
        }] as const),
        ...(!effectiveWorkflowScan ? [] : [{
          kind: 'workflow-scan' as const,
          operationClass: 'ActiveScan' as const,
          targets: workflowTargets,
          engineKind: 'node-http' as const,
          guarantee: 'Enforced' as const,
          engineVersion: WORKFLOW_SCAN_PAYLOAD_SET,
          limits: withRequestLimit(workflowMaxRequests),
        }]),
        ...(!effectiveNuclei || this.deps.nucleiRunner === undefined ? [] : [{
          kind: 'nuclei-scan' as const,
          operationClass: 'NucleiScan' as const,
          targets,
          engineKind: 'nuclei' as const,
          guarantee: 'Delegated' as const,
          engineVersion: this.deps.nucleiRunner.engineVersion,
          limits: withRequestLimit(nucleiMaxRequests),
        }]),
      ],
      limits,
      runtimeBundleHash: this.deps.runtimeBundleHash,
      inputEvidenceHash,
      ...(selectedPolicy === undefined ? {} : { scanPolicyHash: selectedPolicy.policyHash }),
      createdAt: this.deps.clock.now().toISOString(),
    });
    return { plan, planHash: planHashOf(plan) };
  }

  /** 計画の検証と認可結び付け。問題があれば最初の問題を domain error へ変換する。 */
  authorizePlan(plan: ExecutionPlan): { planHash: string } {
    this.requireProductionPlan(plan);
    this.requireCurrentScanPolicy(plan);
    const caseRecord = this.currentCase();
    const authorization = this.currentAuthorization();
    const issues = validatePlan(plan, {
      scope: caseRecord.scope,
      authorization,
      now: this.deps.clock.now(),
      capabilities: this.deps.capabilities,
    });
    const error = firstPlanIssueAsError(issues);
    if (error !== null) {
      throw error;
    }
    const planHash = planHashOf(plan);
    this.record({ type: 'PlanValidated', at: this.deps.clock.now().toISOString(), planHash });
    this.record({
      type: 'PlanAuthorized',
      at: this.deps.clock.now().toISOString(),
      planHash,
      authorizationId: authorization.authorizationId,
    });
    return { planHash };
  }

  /** 計画確認。確認内容の写しと hash の両方を残し、案件 aggregate へ登録する。 */
  confirmPlan(plan: ExecutionPlan, operator: OperatorProfile): PlanConfirmation {
    this.requirePermission(operator, 'run.manage');
    this.requireCurrentScanPolicy(plan);
    const aggregate = this.currentAggregate();
    this.requireProductionPlan(plan);
    const confirmation: PlanConfirmation = {
      confirmationId: this.deps.ids.next('confirm'),
      planHash: planHashOf(plan),
      confirmedBy: operator.operatorId,
      confirmedAt: this.deps.clock.now().toISOString(),
      guidelineIds: plan.guidelineIds,
      confirmedView: plan.steps.map((step) => ({ kind: step.kind, targets: step.targetSnapshot, limits: step.limits })),
    };
    aggregate.registerConfirmation({ confirmationId: confirmation.confirmationId, planHash: confirmation.planHash });
    this.record({
      type: 'PlanConfirmed',
      at: this.deps.clock.now().toISOString(),
      planHash: confirmation.planHash,
      confirmedBy: operator.operatorId,
    });
    return confirmation;
  }

  /**
   * 探索の実行 (Enforced 経路)。各 navigation 前に scope・上限・停止を評価し、
   * scope 外 URL は adapter を呼ばずに拒否記録を残す。
   */
  async runExploration(
    operator: OperatorProfile,
    plan: ExecutionPlan,
    confirmation: PlanConfirmation,
    input: ExploreRunInput,
  ): Promise<ExploreRunResult> {
    this.requirePermission(operator, 'run.manage');
    this.requireProductionPlan(plan);
    this.requireMatchingConfirmation(plan, confirmation);
    const caseRecord = this.currentCase();
    this.assessmentStartedAt ??= this.deps.clock.now().toISOString();
    this.authenticationRole = input.role ?? null;
    const step = plan.steps[0];
    if (step === undefined || step.kind !== 'explore') {
      throw domainError('ValidationFailed', 'plan does not contain an exploration step');
    }
    if (step.discoverySources?.length && (step.operationClass !== 'ActiveCrawl' || !this.currentAuthorization().allowedOperationClasses.includes('ActiveCrawl'))) {
      throw domainError('PermissionDenied', 'discovery execution requires current ActiveCrawl authorization');
    }
    if (input.maxDepth < 1) {
      throw domainError('ValidationFailed', 'maxDepth must be at least 1');
    }
    // role 指定探索 (design/f09): runLogin 済み session のみ。cookie は探索の間だけ
    // explorer へ渡し、記録・応答へは出さない。
    let browserSessionState: BrowserSessionState | undefined;
    if (input.role !== undefined) {
      const session = this.roleSessionCookies.get(input.role);
      if (session === undefined) {
        throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
      }
      if (typeof this.deps.explorer.observeWithSession !== 'function') {
        throw domainError('ValidationFailed', 'configured explorer does not support session observation');
      }
      browserSessionState = session.browserState;
    }

    const runId = this.deps.ids.next('run');
    await this.saveRuntimeBundle(runId);
    const planHash = planHashOf(plan);
    this.record({ type: 'RunStarted', at: this.deps.clock.now().toISOString(), runId, planHash });
    const machine = new RunStateMachine('Confirmed');
    machine.transition('Running');
    this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Running', attempt: 1 });

    const observations: PageObservation[] = [];
    const deniedUrls: { url: string; reason: string }[] = [];
    const visited = new Set<string>();
    // hint 由来の開始点は観測の由来を document-hint として残す (F08・AGENTS.md: 未確認表示)。
    const hintSeeds = this.explorationHintSeeds.get(plan.planId);
    const frontier: { url: string; depth: number; discoveredFrom: string | null; origin: 'crawl' | 'document-hint'; priority: 'high' | 'normal' }[] = step.targetSnapshot.map((url) => ({
      url,
      depth: 0,
      discoveredFrom: null,
      origin: hintSeeds?.has(url) === true ? 'document-hint' : 'crawl',
      // 文書由来の優先付け規則 (pii・payment) に一致する URL は先に処理する。
      priority: this.isPrioritizedUrl(url) ? 'high' : 'normal',
    }));
    // 動的ルートの具体化 (design/22 の安全制御の内側): スクリプト由来の :param 付き
    // テンプレートは観測済み識別子 (API 応答・URL セグメント) だけで具体化する。
    // テンプレート自体は巡回しない。値を推測して送信しない。
    const routeTemplates = new Map<string, number>();
    const observedResourceIdCounts = new Map<string, number>();
    const instantiatedUrls = new Set<string>();
    const instantiatedPerTemplate = new Map<string, number>();
    let instantiationCount = 0;

    let stopReason: StopReason = 'completed';
    let requests = 0;
    let pageVisits = 0;
    const maxFrontier = Math.min(20000, step.limits.maxPages * 4);
    const startedAt = Date.now();
    const negativeFingerprints = new Set<string>();
    // A normal missing path is a negative control for wildcard/soft-404 sites.
    if (step.discoverySources?.length) {
      for (const origin of new Set(step.targetSnapshot.map((url) => new URL(url).origin))) {
        frontier.unshift({ url: new URL('/.scopepilot-missing-7d4f92c1', origin).href, depth: 0, discoveredFrom: null, origin: 'crawl', priority: 'high' });
      }
    }

    while (frontier.length > 0) {
      // 優先付け (AGENTS.md): 高優先 (pii・payment) の entry が残っていれば先に処理する。
      if (input.signal?.aborted) { stopReason = 'user-request'; break; }
      if (Date.now() - startedAt >= step.limits.maxDurationMinutes * 60_000) { stopReason = 'budget-exhausted'; break; }
      let nextIndex = frontier.findIndex((candidate) => candidate.priority === 'high');
      if (nextIndex === -1) {
        nextIndex = 0;
      }
      const entry = frontier.splice(nextIndex, 1)[0];
      if (entry === undefined) {
        break;
      }
      const canonical = ScopePolicy.canonicalBrowserUrl(entry.url);
      if (visited.has(canonical)) {
        continue;
      }
      visited.add(canonical);

      // Filtering these endpoints only when S04 candidates are built is too
      // late: navigating to /logout.php has already invalidated the server-side
      // session. Enforce the exclusion before the explorer adapter is called.
      if (isSessionControlUrl(canonical)) {
        const reason = 'session-control URL is excluded from automated exploration';
        deniedUrls.push({ url: canonical, reason });
        this.record({ type: 'EgressDenied', at: this.deps.clock.now().toISOString(), url: canonical, reason });
        continue;
      }

      const decision = ScopePolicy.decide(caseRecord.scope, canonical);
      if (!decision.allowed) {
        deniedUrls.push({ url: canonical, reason: decision.reason });
        this.record({ type: 'EgressDenied', at: this.deps.clock.now().toISOString(), url: canonical, reason: decision.reason });
        continue;
      }
      if (requests >= step.limits.maxRequests || pageVisits >= step.limits.maxPages) {
        stopReason = 'budget-exhausted';
        break;
      }

      pageVisits++;
      let consumed = false;
      const control = {
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: Math.max(1, step.limits.maxDurationMinutes * 60_000 - (Date.now() - startedAt)),
        consumeRequest: () => {
          consumed = true;
          if (input.signal?.aborted || Date.now() - startedAt >= step.limits.maxDurationMinutes * 60_000 || requests >= step.limits.maxRequests) return false;
          requests++;
          return true;
        },
      };
      const observed =
        browserSessionState === undefined
          ? await this.deps.explorer.observe(canonical, control)
          : await this.deps.explorer.observeWithSession!(canonical, browserSessionState, control);
      if (!consumed) requests++;
      if (input.signal?.aborted) { stopReason = 'user-request'; break; }
      if (observed === null) {
        continue;
      }
      if (new URL(canonical).pathname === '/.scopepilot-missing-7d4f92c1') {
        if (observed.contentFingerprint) negativeFingerprints.add(observed.contentFingerprint);
        continue;
      }
      if ((step.discoverySources?.length && observed.status === 404) || (step.discoverySources?.length && [...DISCOVERY_WORDLIST, '/robots.txt', '/sitemap.xml', '/manifest.json'].includes(new URL(canonical).pathname) && observed.contentFingerprint && negativeFingerprints.has(observed.contentFingerprint))) continue;
      const finalUrl = ScopePolicy.canonicalBrowserUrl(observed.finalUrl ?? observed.url);
      const finalDecision = ScopePolicy.decide(caseRecord.scope, finalUrl);
      if (!finalDecision.allowed) {
        deniedUrls.push({ url: finalUrl, reason: finalDecision.reason });
        this.record({ type: 'EgressDenied', at: this.deps.clock.now().toISOString(), url: finalUrl, reason: finalDecision.reason });
        continue;
      }
      // 探索の追跡情報 (depth・発見元・由来) は core 側の値で上書きして記録する。
      const observation: PageObservation = { ...observed, url: canonical, finalUrl, depth: entry.depth, discoveredFrom: entry.discoveredFrom, originType: entry.origin };
      observations.push(observation);
      await this.processPassiveObservation(observation);
      this.recordObservedExchange({ url: finalUrl, method: 'GET', status: observation.status, contentType: observation.contentType }, this.deps.clock.now().toISOString(), 'explore');

      if (entry.depth + 1 <= input.maxDepth) {
        for (const link of [...observation.links, ...(observation.discoveryLinks ?? []).filter((entry) => step.discoverySources?.length || ['source-map', 'module'].includes(entry.source)).map((entry) => entry.url)]) {
          if (/\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|zip|exe|dll|wasm)(?:[?#]|$)/i.test(link)) continue;
          const linkCanonical = ScopePolicy.canonicalBrowserUrl(link);
          if (!visited.has(linkCanonical) && frontier.length < maxFrontier && !frontier.some((entry) => entry.url === linkCanonical)) {
            frontier.push({ url: linkCanonical, depth: entry.depth + 1, discoveredFrom: finalUrl, origin: 'crawl', priority: this.isPrioritizedUrl(linkCanonical) ? 'high' : 'normal' });
          }
        }
      }

      // 観測で得たルートテンプレートと識別子を蓄積し、両者が揃った時点だけで
      // 具体化 URL を frontier へ追加する。追加先は通常の link と同じ (pop 時に
      // scope・session-control・上限を再評価する)。
      for (const template of observation.routeTemplates ?? []) {
        const canonicalTemplate = ScopePolicy.canonicalBrowserUrl(template);
        if (routeTemplates.size < ROUTE_INSTANTIATION_LIMITS.maxTemplates && !routeTemplates.has(canonicalTemplate)) {
          routeTemplates.set(canonicalTemplate, entry.depth + 1);
        }
      }
      for (const id of observation.observedResourceIds ?? []) {
        if (observedResourceIdCounts.size >= ROUTE_INSTANTIATION_LIMITS.maxResourceIds
          && !observedResourceIdCounts.has(id)) break;
        observedResourceIdCounts.set(id, (observedResourceIdCounts.get(id) ?? 0) + 1);
      }
      if (entry.depth + 1 <= input.maxDepth && instantiationCount < ROUTE_INSTANTIATION_LIMITS.maxTotalInstantiations) {
        // 具体化の優先付け: 複数ページで観測された識別子 (中心的なエンティティ) ほど先に使う。
        // 同頻度は観測順 (Map の挿入順・安定ソート) を維持する。
        const prioritizedResourceIds = [...observedResourceIdCounts.entries()]
          .sort((left, right) => right[1] - left[1])
          .map(([id]) => id);
        for (const template of routeTemplates.keys()) {
          const used = instantiatedPerTemplate.get(template) ?? 0;
          if (used >= ROUTE_INSTANTIATION_LIMITS.maxPerTemplate) continue;
          // 複数パラメータの直積は観測根拠を稀薄にするため対象外。1 パラメータだけ。
          const paramMatch = template.match(/\/:[A-Za-z][\w-]*(?=\/|$)/);
          if (paramMatch === null) continue;
          for (const id of prioritizedResourceIds) {
            if ((instantiatedPerTemplate.get(template) ?? 0) >= ROUTE_INSTANTIATION_LIMITS.maxPerTemplate) break;
            const concrete = template.replace(paramMatch[0]!, `/${id}`);
            const canonical = ScopePolicy.canonicalBrowserUrl(concrete);
            // 具体化結果にパラメータ片が残っていれば使用しない (送信前の防御)。
            if (/\/:[A-Za-z][\w-]*(?=\/|$)/.test(canonical)) continue;
            if (visited.has(canonical) || instantiatedUrls.has(canonical)) continue;
            instantiatedUrls.add(canonical);
            instantiatedPerTemplate.set(template, (instantiatedPerTemplate.get(template) ?? 0) + 1);
            instantiationCount += 1;
            frontier.push({ url: canonical, depth: entry.depth + 1, discoveredFrom: finalUrl, origin: 'crawl', priority: this.isPrioritizedUrl(canonical) ? 'high' : 'normal' });
            if (instantiationCount >= ROUTE_INSTANTIATION_LIMITS.maxTotalInstantiations) break;
          }
          if (instantiationCount >= ROUTE_INSTANTIATION_LIMITS.maxTotalInstantiations) break;
        }
      }
    }

    if (stopReason === 'completed' && (requests >= step.limits.maxRequests || Date.now() - startedAt >= step.limits.maxDurationMinutes * 60000)) stopReason = 'budget-exhausted';
    const reviewAssets = [...new Map(observations.flatMap((observation) => observation.assets ?? []).map((asset) => [asset.url, asset])).values()];
    for (const asset of reviewAssets) {
      const reviewSignals = asset.signals.filter((signal) => !['dependency', 'public-key'].includes(signal.kind) || signal.ruleId === 'weak-rsa-key');
      if (!reviewSignals.length) continue;
      const evidence = await this.deps.evidence.saveText(`client-review:${runId}:${asset.sha256.slice(0, 12)}`, canonicalJson(asset));
      const imported = this.importer.importObservationCandidates(reviewSignals.map((signal) => ({ key: `client-review:${signal.kind}:${signal.ruleId}`, title: `${signal.kind}: ${signal.ruleId} (review required)`, url: asset.url, method: 'GET', param: signal.component?.name ?? signal.ruleId, severity: signal.kind === 'secret' || signal.kind === 'component-db' ? 'medium' as const : 'info' as const })), { now: this.deps.clock.now().toISOString(), engineVersion: asset.analyzerVersion, makeFindingId: () => this.deps.ids.next('finding'), evidenceRef: evidence.evidenceId });
      this.persistFindings([...imported.created, ...imported.reobserved]);
    }
    this.exploredUrlCount = observations.length;
    for (const observation of observations) {
      this.observationsByUrl.set(observation.url, observation);
    }
    for (const denied of deniedUrls) {
      (this.deniedUrlLog as { url: string; reason: string }[]).push(denied);
    }
    // 上限停止は Completed ではなく Stopped として区別する (design/22 §2)。
    let runState: RunState;
    if (stopReason === 'completed') {
      runState = machine.transition('Completed');
    } else {
      machine.transition('Stopping');
      this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Stopping', attempt: 1, stopReason });
      runState = machine.transition('Stopped');
    }
    const runRecord: RunRecord = {
      runId,
      planId: plan.planId,
      caseId: caseRecord.caseId,
      state: runState,
      attempt: 1,
      stopReason,
    };
    this.deps.runSink?.save(runRecord);
    this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason });
    // 観測横断で同一リクエスト/定義の候補を重複させない (同一スクリプトが複数ページで
    // 読み込まれると API 呼び出し定義が毎ページ再抽出されるため、ここで一意化する)。
    const candidates: ScanCandidate[] = [];
    const candidateKeys = new Map<string, number>();
    for (const observation of [...observations, ...this.workflowObservations.values()]) {
      for (const rawCandidate of candidatesFromObservation(observation, this.deps.ids)) {
        const candidate = input.role && observations.includes(observation) && (rawCandidate.requestId || rawCandidate.category !== 'api-endpoint') ? { ...rawCandidate, observedRoles: [input.role] } : rawCandidate;
        const key = `${candidate.category}|${candidate.category === 'page' ? ScopePolicy.canonicalBrowserUrl(candidate.url) : loginMergeKeyOf(candidate.method, candidate.url, candidate.inputPoints ?? [])}`;
        const previousIndex = candidateKeys.get(key);
        if (previousIndex !== undefined) {
          const previous = candidates[previousIndex]!;
          const representative = candidate.confidence > previous.confidence ? candidate : previous;
          candidates[previousIndex] = { ...representative, observedRoles: [...new Set([...(previous.observedRoles ?? []), ...(candidate.observedRoles ?? [])])], provenance: [...(previous.provenance ?? [{ source: previous.guidelineBasis.join(','), url: previous.observationUrl }]), ...(candidate.provenance ?? [{ source: candidate.guidelineBasis.join(','), url: candidate.observationUrl }])] };
          continue;
        }
        candidateKeys.set(key, candidates.length);
        candidates.push(candidate);
      }
    }
    // login 実行時に観測したリクエスト (XHR 裏付けの認証 API 等) を候補へ合成する。
    // 同じ入力点を持つ候補が探索で既に観測されている場合は探索由来を優先する。
    const crawlCandidateKeys = new Set(candidates.map((candidate) => loginMergeKeyOf(candidate.method, candidate.url, candidate.inputPoints ?? [])));
    const loginCandidates: ScanCandidate[] = [];
    const loginSeen = new Set<string>();
    for (const observation of this.loginObservations.values()) {
      for (const candidate of candidatesFromObservation({ ...observation, url: ScopePolicy.canonicalUrl(observation.url) }, this.deps.ids)) {
        if (candidate.category === 'page' || isSessionControlUrl(candidate.url)) continue;
        if (!ScopePolicy.decide(caseRecord.scope, candidate.url).allowed) continue;
        const key = loginMergeKeyOf(candidate.method, candidate.url, candidate.inputPoints ?? []);
        if (crawlCandidateKeys.has(key) || loginSeen.has(key)) continue;
        loginSeen.add(key);
        loginCandidates.push({
          ...candidate,
          detectionReason: `${candidate.detectionReason ?? ''} (login 実行時に観測)`.trim(),
        });
      }
    }
    const mergedCandidates = [...candidates, ...loginCandidates];
    // API 仕様 (OpenAPI) 取込済み endpoint も診断候補へ合成する。閲覧クロールでは
    // 発火しない書き込み API (POST/PUT/DELETE) を仕様から拾うことが目的。
    // path template ({id}) は具体値がないため対象外とし、重複は既存候補を優先する。
    const apiSpecCandidates: ScanCandidate[] = [];
    const specSeen = new Set<string>();
    for (const apiSpec of this.apiSpecImports) {
      for (const endpoint of apiSpec.endpoints) {
        if (endpoint.path.includes('{')) continue;
        if (!ScopePolicy.decide(caseRecord.scope, endpoint.url).allowed) continue;
        const key = loginMergeKeyOf(endpoint.method, endpoint.url, endpoint.inputPoints);
        if (crawlCandidateKeys.has(key) || loginSeen.has(key) || specSeen.has(key)) continue;
        specSeen.add(key);
        if (isSessionControlUrl(endpoint.url)) continue;
        apiSpecCandidates.push({
          candidateId: this.deps.ids.next('cand'),
          url: ScopePolicy.canonicalUrl(endpoint.url),
          method: endpoint.method,
          category: 'api-endpoint',
          guidelineBasis: [`api-spec:${apiSpec.documentLabel}`],
          confidence: 0.8,
          observationUrl: endpoint.url,
          detectionReason: `API 仕様 (${apiSpec.documentLabel}) に ${endpoint.method} ${endpoint.path} が定義されている`,
          dynamic: endpoint.method.toUpperCase() !== 'GET',
          inputPoints: endpoint.inputPoints,
          ...(endpoint.contentType === undefined ? {} : { contentType: endpoint.contentType }),
          diagnosticTracks: diagnosticTracksFor(endpoint.url, endpoint.method, endpoint.inputPoints, false, endpoint.contentType),
        });
      }
    }
    const allCandidates = rankCandidates([...mergedCandidates, ...apiSpecCandidates].filter((candidate) => ScopePolicy.decide(caseRecord.scope, candidate.url).allowed && !isSessionControlUrl(candidate.url)));
    this.latestCandidates = allCandidates;
    this.assessmentEndedAt = this.deps.clock.now().toISOString();
    return { runRecord, planHash, observations, deniedUrls, candidates: allCandidates, authenticationReview: [...this.loginObservations.values()].flatMap((observation) => observation.authenticationReview ?? []), engineVersion: this.deps.explorer.engineVersion };
  }

  /** 候補の採用。基準シナリオでは提示された候補を全採用する。 */
  adoptCandidates(operator: OperatorProfile, candidates: readonly ScanCandidate[]): readonly ScanCandidate[] {
    this.requirePermission(operator, 'run.manage');
    if (candidates.length === 0) {
      throw domainError('ValidationFailed', 'no candidates to adopt');
    }
    const unsafe = candidates.find((candidate) => isSessionControlUrl(candidate.url));
    if (unsafe !== undefined) {
      throw domainError('ValidationFailed', `session-control URL cannot be adopted for automatic scanning: ${unsafe.url}`);
    }
    this.record({
      type: 'CandidatesAdopted',
      at: this.deps.clock.now().toISOString(),
      adoptedCount: candidates.length,
    });
    this.adoptedCandidateUrls = new Set(candidates.map((candidate) => ScopePolicy.canonicalUrl(candidate.url)));
    return candidates;
  }

  /**
   * 能動診断の実行 (Delegated 経路)。確認 hash と能力表を検証してから engine へ入力を渡し、
   * 出力から挙動を推測して記録する。個々の送信は傍受・拒否しない。
   */
  validateJobScan(operator: OperatorProfile, plan: ExecutionPlan, confirmation: PlanConfirmation): void {
    this.requirePermission(operator, 'run.manage');
    this.requireMatchingConfirmation(plan, confirmation);
    this.authorizePlan(plan);
  }
  scanTransport(): 'live' | 'fixture' {
    return this.deps.jobTransport ?? 'live';
  }
  async runActiveScan(
    operator: OperatorProfile,
    plan: ExecutionPlan,
    confirmation: PlanConfirmation,
    adopted: readonly ScanCandidate[],
    role?: string,
    control: ActiveScanExecutionControl = {},
  ): Promise<ActiveScanRunResult> {
    this.requirePermission(operator, 'run.manage');
    this.requireProductionPlan(plan);
    this.requireMatchingConfirmation(plan, confirmation);
    const selectedPolicy = this.requireCurrentScanPolicy(plan);
    const caseRecord = this.currentCase();
    const zapStep = plan.steps.find((candidate) => candidate.kind === 'active-scan');
    const workflowStep = plan.steps.find((candidate) => candidate.kind === 'workflow-scan');
    const nucleiStep = plan.steps.find((candidate) => candidate.kind === 'nuclei-scan');
    const primaryStep = zapStep ?? workflowStep ?? nucleiStep;
    if (primaryStep === undefined) {
      throw domainError('ValidationFailed', 'plan does not contain an active scan diagnostic route');
    }

    const snapshot = zapStep === undefined ? undefined : this.deps.capabilities.find((capability) => capability.engineKind === 'zap');
    if (zapStep !== undefined && (snapshot === undefined || snapshot.engineVersion !== this.deps.scanEngine.engineVersion)) {
      throw domainError('CapabilityUnavailable', 'no capability snapshot for the scan engine version');
    }
    if (zapStep !== undefined && snapshot?.guaranteeLevels.preSendScopeEnforcement === 'Unsupported') {
      throw domainError('CapabilityUnavailable', 'scan engine cannot enforce or delegate scope');
    }

    // 実行対象は計画の target snapshot を正本とする。scope 外候補は snapshot から除外する (F11-UT-003)。
    const targets = primaryStep.targetSnapshot.filter((url) => ScopePolicy.decide(caseRecord.scope, url).allowed && !isSessionControlUrl(url));
    this.assessmentStartedAt ??= this.deps.clock.now().toISOString();
    this.authenticationRole = role ?? null;
    const adoptedUrls = new Set(adopted.map((candidate) => ScopePolicy.canonicalUrl(candidate.url)));
    const uncovered = [...adoptedUrls].filter((url) => !targets.includes(url));
    if (uncovered.length > 0) {
      throw domainError('ValidationFailed', `plan target snapshot does not cover adopted candidates: ${uncovered.join(', ')}`);
    }

    // role session 適用 (design/08: F11)。対象 URL の host/path に一致する cookie 名を
    // scan request へ添える。実 ZAP は proxy 経由 login で jar を作るため値は渡さない。
    let sessionCookieNames: readonly string[] | undefined;
    let scanSessionCookies: readonly LoginSessionCookie[] | undefined;
    let scanSessionHeaders: BrowserSessionState['headers'];
    let scanBrowserSession: BrowserSessionState | undefined;
    let expectedAuthenticatedUrlPrefix: string | undefined;
    let authenticationProbe: { readonly url: string; readonly markers: readonly string[] } | undefined;
    if (role !== undefined) {
      const session = this.roleSessionCookies.get(role);
      if (session === undefined) {
        throw domainError('ValidationFailed', `no session for role '${role}'; run login first`);
      }
      const names: string[] = [];
      for (const target of targets) {
        for (const cookie of applicableSessionCookies([...session.cookies], target)) {
          if (!names.includes(cookie.name)) {
            names.push(cookie.name);
          }
        }
      }
      sessionCookieNames = names;
      scanSessionCookies = session.cookies;
      scanBrowserSession = session.browserState;
      const targetOrigins = new Set(targets.map((target) => new URL(target).origin));
      scanSessionHeaders = (session.browserState.headers ?? []).filter((header) =>
        header.name === 'Authorization'
        && targetOrigins.has(header.origin)
        && header.value.trim() !== ''
        && !/[\r\n]/u.test(header.value));
      expectedAuthenticatedUrlPrefix = session.expectedUrlPrefix;
      if (session.verificationUrl !== undefined) {
        if (!ScopePolicy.decide(caseRecord.scope, session.verificationUrl).allowed) {
          throw domainError('OutOfScope', `authentication verification URL is out of scope: ${session.verificationUrl}`);
        }
        const markers = (session.verificationMarkers ?? []).filter((marker) => marker !== '');
        // Login assertions are browser-DOM assertions. Searching the same marker in
        // ZAP's raw HTTP response rejects valid SPAs because their authenticated UI
        // is rendered only after JavaScript executes. Re-check the live browser state
        // immediately before scanning, including local/session storage. ZAP retains
        // responsibility for detecting redirects and replaced cookies.
        if (this.deps.interactiveBrowser !== undefined) {
          const verification = await this.deps.interactiveBrowser.execute({
            targetUrl: session.verificationUrl,
            scope: caseRecord.scope,
            browserSession: session.browserState,
            steps: [
              { kind: 'navigate', target: session.verificationUrl },
              ...markers.map((marker) => ({ kind: 'assert' as const, target: marker })),
            ],
          });
          if (session.expectedUrlPrefix !== undefined && !verification.finalUrl.startsWith(session.expectedUrlPrefix)) {
            throw domainError('ValidationFailed', `authenticated scan preflight left the expected URL prefix: ${verification.finalUrl}`);
          }
          if (verification.assertions.some((assertion) => !assertion.passed)) {
            throw domainError('ValidationFailed', `authenticated scan preflight failed for ${session.verificationUrl}: browser success marker was not present`);
          }
        }
        authenticationProbe = { url: session.verificationUrl, markers: [] };
      }
    }
    if (workflowStep !== undefined && this.deps.workflowScanTransportFactory === undefined) {
      throw domainError('CapabilityUnavailable', 'workflow scan transport is not configured');
    }

    const runId = this.deps.ids.next('run');
    await this.saveRuntimeBundle(runId);
    if (plan.guidelineCoverage !== undefined) {
      const coverage = this.guidelineCoverage.startRun(runId, plan.guidelineCoverage);
      this.latestCoverageRunId = runId;
      await this.deps.evidence.saveText(`guideline-coverage-snapshot:${runId}`, canonicalJson(coverage));
    }
    const planHash = planHashOf(plan);
    this.record({ type: 'RunStarted', at: this.deps.clock.now().toISOString(), runId, planHash });
    const machine = new RunStateMachine('Confirmed');
    machine.transition('Running');
    this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Running', attempt: 1 });

    try {

    // Delegated 経路は最大 overshoot 分を共有上限の内側に予約する。ガイドラインから
    // 自動接続するScopePilot HTTP検査も同じ案件上限の内側へ先に予約し、ZAP leaseと
    // 二重計上しない。
    const reservedRequests = zapStep === undefined || snapshot === undefined ? 0 : Math.ceil(zapStep.limits.maxRequests * snapshot.maxOvershootRatio);
    const guidelineThemePlans = resolveGuidelineThemeRoutes(plan.guidelineIds);
    const guidelineTargetUrls = [...new Set(targets.map((target) => ScopePolicy.canonicalUrl(target)))].slice(0, 5);
    const desiredAutomaticThemeNos = guidelineThemePlans.filter((route) => route.mode === 'automatic').map((route) => route.themeNo);
    const desiredGuidelineRequestCount = desiredAutomaticThemeNos.reduce(
      (total, themeNo) => total + automaticGuidelineRequestCount(themeNo, guidelineTargetUrls.length),
      0,
    );
    const automaticGuidelineChecksEnabled = desiredGuidelineRequestCount > 0
      && primaryStep.limits.maxRequests - reservedRequests - desiredGuidelineRequestCount >= (zapStep === undefined ? 0 : 1);
    const guidelineRequestReservation = automaticGuidelineChecksEnabled ? desiredGuidelineRequestCount : 0;
    const engineLease = zapStep === undefined ? 0 : zapStep.limits.maxRequests - reservedRequests - guidelineRequestReservation;
    const context = jobContext.getStore();
    if (context) context.registry.emit(context.jobId, { category: 'budget', messageKey: 'job.phase', message: 'Scan request budget leased', params: { engineLease, reservedRequests, guidelineRequestReservation }, counters: { budget: { leased: engineLease, used: 0, limit: plan.limits.maxRequests } } });
    const zapCandidates = adopted.filter(candidateAllowsAutomatedZap);
    const scanRequest: ActiveScanRequest = {
      runId,
      targets,
      attackStrength: selectedPolicy?.routes.zap.attackStrength ?? 'Medium',
      alertThreshold: selectedPolicy?.routes.zap.alertThreshold ?? 'Medium',
      leasedLimits: { ...(zapStep?.limits ?? primaryStep.limits), maxRequests: engineLease },
      authorizationRef: `authorization:${this.currentAuthorization().authorizationId}`,
      ...(sessionCookieNames === undefined ? {} : { sessionCookieNames }),
      requestSeedCount: zapCandidates.length,
    };
    let diagnosticRoutes = planDiagnosticRoutes(adopted, this.deps.domObserver !== undefined);
    let guidelineRoutes: readonly GuidelineRouteResult[] = guidelineThemePlans.map((route) => ({
      routeId: guidelineAutomationPolicy(route.themeNo).routeId,
      themeNo: route.themeNo,
      guidelineIds: route.guidelineIds,
      automationPolicyVersion: route.automationPolicyVersion,
      automationClass: route.automationClass,
      missingInputCodes: route.missingInputCodes,
      limitationCodes: route.limitationCodes,
      status: route.mode === 'needs-input'
        ? 'needs-input'
        : automaticGuidelineChecksEnabled
          ? 'delegated'
          : 'unavailable',
      detail: route.mode === 'needs-input'
        ? guidelineAutomationPolicy(route.themeNo).deferredReason
        : automaticGuidelineChecksEnabled
          ? `確認済みHTTP対象 ${String(guidelineTargetUrls.length)} 件へ自動実行します`
          : '案件の最大リクエスト数にZAP用の最低1件と自動検査分を確保できないため実行しません',
    }));

    const unsupportedAssessments = resolveUnsupportedAssessments(plan.guidelineIds);

    // Theme 17 is an explicit non-sending route; it must never enter the probe loop.
    if (guidelineThemePlans.length > 0) {
      const policy = guidelineAutomationPolicy('17');
      guidelineRoutes = [...guidelineRoutes, {
        routeId: policy.routeId, themeNo: '17',
        guidelineIds: [...new Set(guidelineThemePlans.flatMap((route) => route.guidelineIds))],
        status: 'unavailable', detail: policy.deferredReason,
        automationPolicyVersion: GUIDELINE_AUTOMATION_POLICY_VERSION,
        automationClass: policy.automationClass, missingInputCodes: [], limitationCodes: policy.limitationCodes,
      }];
    }

    let requestCorpusEvidence;
    try {
      requestCorpusEvidence = await this.deps.evidence.saveText(
        `http-request-corpus:${runId}`,
        canonicalJson({
          runId,
          requests: adopted.map((candidate) => ({
            requestId: candidate.requestId ?? candidate.candidateId,
            url: ScopePolicy.canonicalUrl(candidate.url),
            method: candidate.method.toUpperCase(),
            ...(candidate.contentType === undefined ? {} : { contentType: candidate.contentType }),
            inputPoints: candidate.inputPoints ?? [],
            diagnosticTracks: candidate.diagnosticTracks ?? ['zap-active'],
          })),
        }),
      );
    } catch (cause) {
      this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'engine-failure' });
      machine.transition('Failed');
      this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Failed', attempt: 1, stopReason: 'engine-failure' });
      throw domainError('EngineFailure', `request corpus storage failed before scan: ${String(cause)}`, { retryable: true });
    }

    const emit = (event: Omit<ActiveScanExecutionEvent, 'at'>): void => control.onEvent?.({
      at: this.deps.clock.now().toISOString(),
      ...event,
    });
    const throwIfCancelled = (): void => {
      if (control.signal?.aborted === true) {
        throw domainError('Cancelled', 'scan stopped by user');
      }
    };
    throwIfCancelled();
    const deferredRouteCount = diagnosticRoutes.filter((route) => route.status === 'needs-input').length;
    if (deferredRouteCount > 0) {
      emit({
        phase: 'starting',
        engine: 'scopepilot',
        message: `専用診断経路 ${deferredRouteCount} 件は、必要な追加入力を受け取るまで保留します`,
        command: 'ScopePilot diagnostic router: preserve needs-input routes',
        progress: 0,
      });
    }
    const payloadVerifications: ActiveScanPayloadVerification[] = [];
    let zapImportedCount = 0;
    let zapDuplicateCount = 0;
    if (zapStep !== undefined) {
      emit({
      phase: 'starting',
      engine: 'zap',
      message: `ZAP認証コンテキストを構成し、${zapCandidates.length}件のHTTPリクエスト候補を診断します`,
      command: `ZAP API: context + active HTTP session -> core/sendRequest x ${zapCandidates.length} -> spider/scan + ajaxSpider/scan -> ascan/scan(recurse=false, inScopeOnly=true) -> per-run alert delta`,
      progress: 0,
    });
      const engineRunId = await this.deps.scanEngine.start(scanRequest, {
      ...(scanSessionCookies === undefined ? {} : { sessionCookies: scanSessionCookies }),
      ...(scanSessionHeaders === undefined ? {} : { sessionHeaders: scanSessionHeaders }),
      requestSeeds: zapCandidates.map((candidate) => ({
        url: ScopePolicy.canonicalUrl(candidate.url),
        method: candidate.method.toUpperCase(),
        ...(candidate.contentType === undefined ? {} : { contentType: candidate.contentType }),
        inputPoints: candidate.inputPoints ?? [],
      })),
      ...(expectedAuthenticatedUrlPrefix === undefined ? {} : { expectedAuthenticatedUrlPrefix }),
      ...(authenticationProbe === undefined ? {} : { authenticationProbe }),
    });
      emit({ phase: 'running', engine: 'zap', message: `ZAP scan id ${engineRunId} を監視しています`, progress: 0 });
      const monitor = new ScanMonitor(
      this.deps.scanEngine,
      engineRunId,
      MAX_POLL_ITERATIONS,
      2_000,
      this.deps.scanAlertSettleMs ?? 0,
      control.signal,
      (progress) => emit({
        phase: 'running',
        engine: 'zap',
        message: `ZAP active scan ${progress.progress}% (${progress.messageCount} messages)`,
        progress: progress.progress,
      }),
    );
      const monitored = await monitor.collectUntilDone();
      const collectedAlerts = monitored.alerts;

      if (monitored.status === 'stopped') {
      machine.requestStop();
      this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Stopping', attempt: 1, stopReason: 'user-request' });
      const stoppedRecord: RunRecord = {
        runId,
        planId: plan.planId,
        caseId: caseRecord.caseId,
        state: 'Stopped',
        attempt: 1,
        stopReason: 'user-request',
      };
      this.deps.runSink?.save(stoppedRecord);
      machine.transition('Stopped');
      this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'user-request' });
      emit({ phase: 'stopped', engine: 'zap', message: 'ZAP active scan を停止しました', progress: monitored.progress });
      throw domainError('Cancelled', 'scan stopped by user');
    }

    // engine 異常は「URL Does not Exist」等の観測理由とともに失敗として扱い、無制限に再試行しない。
      if (monitored.status === 'failed') {
      this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'engine-failure' });
      machine.transition('Failed');
      this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Failed', attempt: 1, stopReason: 'engine-failure' });
      throw domainError('EngineFailure', monitored.failureReason ?? 'scan engine failed', {
        details: { engineRunId, engineVersion: this.deps.scanEngine.engineVersion },
      });
    }

      diagnosticRoutes = diagnosticRoutes.map((route) => route.track === 'zap-active'
      ? { ...route, status: 'executed' as const, detail: 'ZAP active scanを完了し、run開始前後のalert差分を収集しました' }
      : route);

    // 観測した出力を原本として保存してから取込む (保存成功後だけ event を出す = SYS-UT-005)。
      let rawEvidence;
      try {
      rawEvidence = await this.deps.evidence.saveText(
        `zap-alerts-raw:${engineRunId}`,
        canonicalJson({ engineRunId, alerts: collectedAlerts }),
      );
      } catch (cause) {
      this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'engine-failure' });
      machine.transition('Failed');
      this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Failed', attempt: 1, stopReason: 'engine-failure' });
      throw domainError('EngineFailure', `evidence storage failed before findings import: ${String(cause)}`, {
        retryable: true,
        details: { engineRunId },
      });
    }
      const now = this.deps.clock.now().toISOString();
      const importResult = this.importer.importAlerts(collectedAlerts, {
      now,
      engineVersion: this.deps.scanEngine.engineVersion,
      makeFindingId: () => this.deps.ids.next('finding'),
      evidenceRef: rawEvidence.evidenceId,
    });
      zapImportedCount = importResult.created.length;
      zapDuplicateCount = importResult.duplicateCount;
      this.persistFindings([...importResult.created, ...importResult.reobserved]);

    // payload 実行検証 (design/30 30.1): 反射系 XSS 所見のうち URL に payload が乗っている
    // ものは、browser で実際に開いて dialog 発火を確認する。検証失敗は診断全体を失敗させず
    // 結果に記録する (上限 5 件・browser 検証に非対応の構成では実行しない)。
      if (typeof this.deps.explorer.verifyPayloadExecution === 'function') {
      const verifiableFindings = [...importResult.created, ...importResult.reobserved]
        .filter((finding) => PAYLOAD_EXECUTION_FINDING_PATTERN.test(finding.title) && PAYLOAD_URL_MARKER_PATTERN.test(finding.url))
        .slice(0, PAYLOAD_VERIFICATION_MAX);
      for (const finding of verifiableFindings) {
        throwIfCancelled();
        emit({
          phase: 'running',
          engine: 'scopepilot',
          message: `所見「${finding.title}」の payload 実行を browser で検証します`,
          progress: 95,
        });
        try {
          const verification = await this.verifyFindingExecution(operator, {
            url: finding.url,
            findingId: finding.findingId,
            ...(role === undefined ? {} : { role }),
          });
          payloadVerifications.push({
            findingId: finding.findingId,
            title: finding.title,
            url: finding.url,
            executed: verification.executed,
            signals: verification.signals,
            evidenceRef: verification.evidenceRef,
          });
        } catch (cause) {
          if ((cause instanceof DomainError && cause.code === 'Cancelled') || (control.signal?.aborted === true && cause instanceof Error && cause.name === 'AbortError')) {
            throw domainError('Cancelled', 'scan stopped by user');
          }
          payloadVerifications.push({
            findingId: finding.findingId,
            title: finding.title,
            url: finding.url,
            executed: false,
            signals: [],
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      }
    } else {
      diagnosticRoutes = diagnosticRoutes.filter((route) => route.track !== 'zap-active');
      emit({ phase: 'completed', engine: 'scopepilot', message: 'ZAP 経路は診断ポリシーで無効です', progress: 100 });
    }

    for (const themeNo of automaticGuidelineChecksEnabled ? desiredAutomaticThemeNos : []) {
      throwIfCancelled();
      emit({
        phase: 'running',
        engine: 'scopepilot',
        message: `ガイドライン実行経路 zap-unsupported:${themeNo} を開始します`,
        command: `ScopePilot guideline route: zap-unsupported:${themeNo}`,
      });
      try {
        const summary = await this.runZapUnsupportedCheck(operator, {
          themeNo,
          targetUrls: guidelineTargetUrls,
          ...(role === undefined ? {} : { role }),
        });
        guidelineRoutes = guidelineRoutes.map((route) => route.themeNo === themeNo
          ? {
              ...route,
              status: 'executed' as const,
              detail: `自動HTTP検査を完了しました: ${summary.status}; ${String(summary.totalRequests)} probes`,
              checkId: summary.checkId,
              checkStatus: summary.status,
            }
          : route);
      } catch (cause) {
        if ((cause instanceof DomainError && cause.code === 'Cancelled') || (control.signal?.aborted === true && cause instanceof Error && cause.name === 'AbortError')) {
          throw domainError('Cancelled', 'scan stopped by user');
        }
        const error = cause instanceof Error ? cause.message : String(cause);
        guidelineRoutes = guidelineRoutes.map((route) => route.themeNo === themeNo
          ? { ...route, status: 'unavailable' as const, detail: `自動HTTP検査を完了できませんでした: ${error}` }
          : route);
        emit({ phase: 'running', engine: 'scopepilot', message: `ガイドライン実行経路 zap-unsupported:${themeNo} は独立して失敗しました: ${error}` });
      }
    }

    const domTargets = diagnosticRoutes
      .filter((route) => route.track === 'browser-dom' && route.status === 'delegated')
      .map((route) => route.targetUrl);
    for (const targetUrl of domTargets) {
      throwIfCancelled();
      emit({
        phase: 'running',
        engine: 'scopepilot',
        message: `Playwright DOM value-flow 観測: ${targetUrl}`,
        command: `Playwright DOM observer: ${targetUrl}`,
      });
      try {
        const observer = this.deps.domObserver;
        if (observer === undefined) {
          throw new Error('DOM observer is not configured');
        }
        const appliedCookies = scanSessionCookies === undefined
          ? undefined
          : applicableSessionCookies([...scanSessionCookies], targetUrl);
        const observed = await observer.observe({
          targetUrl,
          scope: caseRecord.scope,
          ...(scanBrowserSession === undefined
            ? appliedCookies === undefined ? {} : { sessionCookies: appliedCookies }
            : { browserSession: scanBrowserSession }),
        });
        const valueFlows = buildDomCandidate(observed.observations);
        const projectedFlows = valueFlows.map((candidate) => ({
          sourceApi: candidate.sourceApi,
          sinkApi: candidate.sinkApi,
          confidence: candidate.confidence,
          marker: `sha256:${hashStable('scopepilot2.dom.marker', candidate.marker)}`,
        }));
        const domEvidence = await this.deps.evidence.saveText(
          `dom-observation:${runId}:${hashStable('scopepilot2.dom.target', targetUrl).slice(0, 12)}`,
          canonicalJson({ targetUrl, valueFlows: projectedFlows, nodes: domEvidenceProjection(observed.nodes) }),
        );
        const domImport = this.importer.importObservationCandidates(
          projectedFlows.map((candidate) => ({
            key: `scopepilot-dom-flow:${candidate.sourceApi}:${candidate.sinkApi}`,
            title: `Potential DOM value flow: ${candidate.sourceApi} -> ${candidate.sinkApi}`,
            url: targetUrl,
            method: 'GET',
            param: `${candidate.sourceApi} -> ${candidate.sinkApi}`,
            severity: candidate.confidence >= 0.8 ? 'low' as const : 'info' as const,
          })),
          {
            now: this.deps.clock.now().toISOString(),
            engineVersion: 'scopepilot-playwright-dom-v1',
            makeFindingId: () => this.deps.ids.next('finding'),
            evidenceRef: domEvidence.evidenceId,
          },
        );
        this.persistFindings([...domImport.created, ...domImport.reobserved]);
        diagnosticRoutes = updateDiagnosticRoute(diagnosticRoutes, 'browser-dom', targetUrl, {
          status: 'executed',
          detail: `Playwrightでsource→sinkを観測し、候補 ${valueFlows.length} 件を証跡化しました`,
          findingCount: valueFlows.length,
        });
        this.record({
          type: 'FindingsImported',
          at: this.deps.clock.now().toISOString(),
          source: 'observation',
          engineVersion: 'scopepilot-playwright-dom-v1',
          importedCount: domImport.created.length,
          duplicateCount: domImport.duplicateCount,
        });
      } catch (cause) {
        diagnosticRoutes = updateDiagnosticRoute(diagnosticRoutes, 'browser-dom', targetUrl, {
          status: 'unavailable',
          detail: `DOM観測を完了できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
        emit({
          phase: 'running',
          engine: 'scopepilot',
          message: `DOM観測を保留しました: ${targetUrl}`,
        });
      }
    }

    let workflowSummary: ActiveScanRunResult['workflow'];
    if (workflowStep !== undefined && this.deps.workflowScanTransportFactory !== undefined) {
      const baseUrls = [...new Set(workflowStep.targetSnapshot.map((target) => new URL(target).origin))];
      const plannedTargets = new Set(workflowStep.targetSnapshot.map((target) => ScopePolicy.canonicalUrl(target)));
      const selectedWorkflowCheckIds: readonly WorkflowScanCheckId[] = selectedPolicy === undefined
        ? resolveWorkflowScanCheckIds(plan.guidelineIds)
        : selectedPolicy.routes.genericHttp.checkIds;
      const budget = { limit: workflowStep.limits.maxRequests, used: 0 };
      const evidenceRefs: string[] = [];
      const allChecks: import('../domain/workflow-scan.ts').WorkflowScanCheckResult[] = [];
      let skipCount = 0;
      let importedCount = 0;
      let duplicateCount = 0;
      const transports: WorkflowScanTransport[] = [];
      try {
        for (const baseUrl of baseUrls) {
          throwIfCancelled();
          const targetsForOrigin = adopted
            .filter((candidate) => new URL(candidate.url).origin === baseUrl && plannedTargets.has(ScopePolicy.canonicalUrl(candidate.url)))
            .map((candidate) => ({
              url: ScopePolicy.canonicalUrl(candidate.url),
              method: candidate.method,
              inputPoints: candidate.inputPoints ?? [],
              ...(candidate.contentType === undefined ? {} : { contentType: candidate.contentType }),
            }));
          const sessionCookies = scanSessionCookies === undefined
            ? []
            : applicableSessionCookies([...scanSessionCookies], baseUrl);
          const sessionHeaders = (scanSessionHeaders ?? [])
            .filter((header) => header.origin === baseUrl)
            .map((header) => ({ name: header.name, value: header.value }));
          const createTransport = (): WorkflowScanTransport => {
            const transport = new SharedBudgetWorkflowTransport(
              this.deps.workflowScanTransportFactory!({
                baseUrl,
                maxRequests: workflowStep.limits.maxRequests,
                redactionValues: [
                  ...sessionCookies.map((cookie) => cookie.value),
                  ...sessionHeaders.map((header) => header.value),
                ],
                sessionCookies: sessionCookies.map((cookie) => ({ name: cookie.name, value: cookie.value })),
                ...(sessionHeaders.length === 0 ? {} : { sessionHeaders }),
                ...(control.signal === undefined ? {} : { signal: control.signal }),
              }),
              budget,
            );
            transports.push(transport);
            return transport;
          };
          const primary = createTransport();
          emit({
            phase: 'starting',
            engine: 'scopepilot',
            message: `汎用HTTP診断 (${String(selectedWorkflowCheckIds.length)}観点・${String(targetsForOrigin.length)}候補) を開始します: ${baseUrl}`,
            command: `ScopePilot generic HTTP diagnostics: ${WORKFLOW_SCAN_PAYLOAD_SET}; maxRequests=${String(workflowStep.limits.maxRequests)}`,
            progress: 0,
          });
          const result = await runWorkflowScan(
            {
              baseUrl,
              targets: targetsForOrigin,
              authenticated: sessionCookies.length > 0 || sessionHeaders.length > 0,
              maxRequests: workflowStep.limits.maxRequests,
              checkIds: selectedWorkflowCheckIds,
              ...(control.signal === undefined ? {} : { signal: control.signal }),
            },
            primary,
            {
              progress: (message) => emit({ phase: 'running', engine: 'scopepilot', message }),
            },
          );
          const evidence = await this.deps.evidence.saveText(
            `workflow-scan:${runId}:${hashStable('scopepilot2.workflow.origin', baseUrl).slice(0, 12)}`,
            canonicalJson({
              runId,
              result,
              alerts: workflowHttpEvidenceRecords(result.checks, result.requestLog, baseUrl),
              totalRequestCount: budget.used,
            }),
          );
          evidenceRefs.push(evidence.evidenceId);
          if (plan.guidelineCoverage !== undefined) {
            for (const execution of this.guidelineCoverage.getRun(runId).executions) {
              const snapshot = plan.guidelineCoverage.snapshots.find((candidate) => candidate.routeId === execution.routeId)!;
              if (execution.guarantee === 'Unsupported' || snapshot.assertionIds.length === 0) continue;
              const skipped = execution.missingInputCodes.includes('ASSERTION_PRECONDITION_NOT_MET') || result.skips.some((skip) => snapshot.assertionIds.includes(skip.checkId));
              // The legacy runner records findings and skips, not successful assertion invocations.
              // A baseline HTTP request alone cannot establish that an item assertion ran.
              const hasAssertionRecords = result.requestLog.length > 0 && snapshot.assertionIds.every((id) => result.checks.some((check) => check.checkId === id));
              const completed = !skipped && hasAssertionRecords;
              this.guidelineCoverage.recordExecution({
                ...execution, executionStatus: skipped ? 'needs-input' : completed ? 'completed' : 'unavailable',
                assessment: completed ? 'inconclusive' : 'not-assessed',
                evidenceRefs: [...execution.evidenceRefs, evidence.evidenceId],
                missingInputCodes: skipped ? ['ASSERTION_PRECONDITION_NOT_MET'] : [],
                limitationCodes: [...execution.limitationCodes, 'GENERIC_WORKFLOW_HAS_NO_ITEM_LEVEL_PASS_ORACLE', ...(hasAssertionRecords ? [] : ['ASSERTION_EXECUTION_RECORD_MISSING'])],
              });
            }
          }
          allChecks.push(...result.checks);
          skipCount += result.skips.length;
          const imported = this.importer.importObservationCandidates(
            result.checks.map((check) => ({
              key: `workflow-scan:${check.checkId}:${hashStable('scopepilot2.workflow.target', check.url).slice(0, 12)}`,
              title: check.title,
              url: new URL(check.url, `${baseUrl}/`).toString(),
              method: check.method,
              param: check.param,
              severity: check.severity,
            })),
            {
              now: this.deps.clock.now().toISOString(),
              engineVersion: result.payloadSet,
              makeFindingId: () => this.deps.ids.next('finding'),
              evidenceRef: evidence.evidenceId,
            },
          );
          importedCount += imported.created.length;
          duplicateCount += imported.duplicateCount;
          this.persistFindings([...imported.created, ...imported.reobserved]);
          this.record({
            type: 'FindingsImported',
            at: this.deps.clock.now().toISOString(),
            source: 'observation',
            engineVersion: result.payloadSet,
            importedCount: imported.created.length,
            duplicateCount: imported.duplicateCount,
          });
        }
        workflowSummary = {
          status: 'completed',
          payloadSet: WORKFLOW_SCAN_PAYLOAD_SET,
          baseUrls,
          requestCount: budget.used,
          checkKindCount: new Set(allChecks.map((check) => check.checkId)).size,
          checkCount: allChecks.length,
          skipCount,
          importedCount,
          duplicateCount,
          evidenceRefs,
        };
        emit({
          phase: 'completed',
          engine: 'scopepilot',
          message: `汎用HTTP診断完了: ${String(workflowSummary.checkKindCount)}/${String(selectedWorkflowCheckIds.length)}観点で所見 ${String(workflowSummary.checkCount)} 件`,
          progress: 100,
        });
      } catch (cause) {
        if ((cause instanceof DomainError && cause.code === 'Cancelled') || (control.signal?.aborted === true && cause instanceof Error && cause.name === 'AbortError')) {
          throw domainError('Cancelled', 'workflow scan stopped by user');
        }
        const error = cause instanceof Error ? cause.message : String(cause);
        const partialLogs = transports.flatMap((transport) => transport.takeRequestLog());
        if (partialLogs.length > 0) {
          const partial = await this.deps.evidence.saveText(
            `workflow-scan-partial:${runId}`,
            canonicalJson({ runId, payloadSet: WORKFLOW_SCAN_PAYLOAD_SET, baseUrls, requestCount: budget.used, requestLog: partialLogs, error }),
          );
          evidenceRefs.push(partial.evidenceId);
        }
        workflowSummary = {
          status: 'failed',
          payloadSet: WORKFLOW_SCAN_PAYLOAD_SET,
          baseUrls,
          requestCount: budget.used,
          checkKindCount: new Set(allChecks.map((check) => check.checkId)).size,
          checkCount: allChecks.length,
          skipCount,
          importedCount,
          duplicateCount,
          evidenceRefs,
          error,
        };
        emit({ phase: 'completed', engine: 'scopepilot', message: `Workflow scan failed independently: ${error}`, progress: 100 });
      }
    }

    await this.deps.evidence.saveText(
      `diagnostic-routes:${runId}`,
      canonicalJson({ runId, routes: diagnosticRoutes }),
    );
    this.latestDiagnosticRoutes = diagnosticRoutes;
    await this.deps.evidence.saveText(
      `guideline-routes:${runId}`,
      canonicalJson({ runId, guidelineIds: plan.guidelineIds, routes: guidelineRoutes, unsupportedAssessments }),
    );
    this.latestGuidelineRoutes = guidelineRoutes;
    this.latestUnsupportedAssessments = unsupportedAssessments;

    let nucleiSummary: ActiveScanRunResult['nuclei'];
    if (nucleiStep !== undefined) {
      try {
        throwIfCancelled();
        const nucleiRunner = this.deps.nucleiRunner;
        if (nucleiRunner === undefined) {
          throw domainError('CapabilityUnavailable', 'confirmed plan requires nuclei but no nuclei runtime is configured');
        }
        const nucleiCapability = this.deps.capabilities.find((capability) => capability.engineKind === 'nuclei');
        if (nucleiCapability === undefined || nucleiCapability.engineVersion !== nucleiRunner.engineVersion) {
          throw domainError('CapabilityUnavailable', 'no capability snapshot for the nuclei engine version');
        }
        const nucleiTargets = nucleiStep.targetSnapshot.filter((url) => ScopePolicy.decide(caseRecord.scope, url).allowed);
        const nucleiCommand = `nuclei -type http -t <reviewed-hash-pinned-template-bundle> -exclude-tags dos,fuzz,intrusive,bruteforce,headless,code,network,file,dns,oast -severity medium,high,critical -l <confirmed-targets:${nucleiTargets.length}> -rate-limit ${nucleiStep.limits.requestsPerSecond} -concurrency ${nucleiStep.limits.maxConcurrency} -max-time ${nucleiStep.limits.maxDurationMinutes}m (shared ScopePilot request guard: ${nucleiStep.limits.maxRequests})`;
        emit({
          phase: 'starting',
          engine: 'nuclei',
          message: `Nuclei reviewed HTTP template scan を開始します (${nucleiTargets.length} confirmed target)`,
          command: nucleiCommand,
          progress: 0,
        });
        const nucleiOutput = await nucleiRunner.run({
          targets: nucleiTargets,
          limits: nucleiStep.limits,
          ...(selectedPolicy === undefined || selectedPolicy.routes.nuclei.templateIds.length === 0
            ? {}
            : { templateIds: selectedPolicy.routes.nuclei.templateIds }),
          ...(control.signal === undefined ? {} : { signal: control.signal }),
          onLog: (line) => emit({ phase: 'running', engine: 'nuclei', message: line }),
        });
        throwIfCancelled();
        await this.deps.evidence.saveText(
          `nuclei-execution:${runId}`,
          canonicalJson({
            runId,
            engineVersion: nucleiRunner.engineVersion,
            templateBundleHash: nucleiRunner.templateBundleHash ?? 'unavailable',
            targets: nucleiTargets,
          }),
        );
        emit({ phase: 'collecting', engine: 'nuclei', message: `Nuclei JSONL ${nucleiOutput.lines.length} 行を取り込みます`, progress: 100 });
        const imported = await this.importNucleiResults(operator, {
          engineVersion: nucleiRunner.engineVersion,
          lines: nucleiOutput.lines,
        });
        nucleiSummary = {
          status: 'completed',
          engineVersion: nucleiRunner.engineVersion,
          ...(nucleiRunner.templateBundleHash === undefined ? {} : { templateBundleHash: nucleiRunner.templateBundleHash }),
          importedCount: imported.importedCount,
          duplicateCount: imported.duplicateCount,
          quarantinedCount: imported.quarantinedCount,
          excludedOutOfScope: imported.excludedOutOfScope,
        };
        emit({ phase: 'completed', engine: 'nuclei', message: `Nuclei scan 完了: 新規所見 ${imported.importedCount} 件`, progress: 100 });
      } catch (cause) {
        if ((cause instanceof DomainError && cause.code === 'Cancelled') || (control.signal?.aborted === true && cause instanceof Error && cause.name === 'AbortError')) {
          machine.requestStop();
          this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Stopping', attempt: 1, stopReason: 'user-request' });
          const stoppedRecord: RunRecord = {
            runId,
            planId: plan.planId,
            caseId: caseRecord.caseId,
            state: 'Stopped',
            attempt: 1,
            stopReason: 'user-request',
          };
          this.deps.runSink?.save(stoppedRecord);
          machine.transition('Stopped');
          this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'user-request' });
          emit({ phase: 'stopped', engine: 'nuclei', message: 'Nuclei scan を停止しました' });
          throw domainError('Cancelled', 'scan stopped by user');
        }
        const error = cause instanceof Error ? cause.message : String(cause);
        nucleiSummary = {
          status: 'failed',
          engineVersion: this.deps.nucleiRunner?.engineVersion ?? 'unavailable',
          ...(this.deps.nucleiRunner?.templateBundleHash === undefined ? {} : { templateBundleHash: this.deps.nucleiRunner.templateBundleHash }),
          importedCount: 0,
          duplicateCount: 0,
          quarantinedCount: 0,
          excludedOutOfScope: 0,
          error,
        };
        emit({ phase: 'completed', engine: 'nuclei', message: `Nuclei step failed independently: ${error}`, progress: 100 });
      }
    }

    this.scannedUrlCount = targets.length;
    this.scannedUrls = new Set(targets.map((url) => ScopePolicy.canonicalUrl(url)));
    this.assessmentEndedAt = this.deps.clock.now().toISOString();
    this.delegatedSteps = [
      ...(zapStep === undefined ? [] : [{ stepId: zapStep.stepId, engineKind: 'zap' as const, engineVersion: this.deps.scanEngine.engineVersion }]),
      ...(workflowStep === undefined ? [] : [{
        stepId: workflowStep.stepId,
        engineKind: 'node-http' as const,
        engineVersion: WORKFLOW_SCAN_PAYLOAD_SET,
      }]),
      ...(nucleiStep === undefined || this.deps.nucleiRunner === undefined ? [] : [{
        stepId: nucleiStep.stepId,
        engineKind: 'nuclei' as const,
        engineVersion: this.deps.nucleiRunner.engineVersion,
      }]),
    ];
    const failed = workflowSummary?.status === 'failed' || nucleiSummary?.status === 'failed';
    if (!failed && control.signal?.aborted === true) {
      machine.requestStop();
      this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Stopping', attempt: 1, stopReason: 'user-request' });
      this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId,
        state: 'Stopped', attempt: 1, stopReason: 'user-request' });
      machine.transition('Stopped');
      this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'user-request' });
      throw domainError('Cancelled', 'scan stopped by user');
    }
    if (plan.guidelineCoverage !== undefined) {
      await this.deps.evidence.saveText(`guideline-coverage-result:${runId}`, canonicalJson(this.guidelineCoverage.getRun(runId)));
    }
    const runRecord: RunRecord = {
      runId,
      planId: plan.planId,
      caseId: caseRecord.caseId,
      state: failed ? 'Failed' : 'Completed',
      attempt: 1,
      stopReason: failed ? 'engine-failure' : 'completed',
    };
    this.deps.runSink?.save(runRecord);
    machine.transition(runRecord.state);
    this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: runRecord.stopReason! });
    emit({ phase: 'completed', engine: 'scopepilot', message: `診断完了: 所見 ${this.importer.list().length} 件`, progress: 100 });
    if (zapStep !== undefined) {
      this.record({
        type: 'FindingsImported',
        at: this.deps.clock.now().toISOString(),
        source: 'zap-alert',
        engineVersion: this.deps.scanEngine.engineVersion,
        importedCount: zapImportedCount,
        duplicateCount: zapDuplicateCount,
      });
    }
    return {
      runRecord,
      planHash,
      scanRequest,
      findings: this.importer.list(),
      overshootReservation: reservedRequests,
      engineVersion: zapStep === undefined ? 'not-selected' : this.deps.scanEngine.engineVersion,
      requestCorpusEvidenceRef: requestCorpusEvidence.evidenceId,
      diagnosticRoutes,
      guidelineRoutes,
      unsupportedAssessments,
      ...(workflowSummary === undefined ? {} : { workflow: workflowSummary }),
      ...(nucleiSummary === undefined ? {} : { nuclei: nucleiSummary }),
      ...(payloadVerifications.length === 0 ? {} : { payloadVerifications }),
    };
    } catch (cause) {
      // Cover failures outside individual adapter handlers, including engine start and final persistence.
      if (!machine.isTerminal()) {
        const cancelled = cause instanceof DomainError && cause.code === 'Cancelled';
        if (cancelled) {
          machine.requestStop();
          this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId,
            state: 'Stopping', attempt: 1, stopReason: 'user-request' });
        }
        const state = cancelled ? 'Stopped' : 'Failed';
        const stopReason = cancelled ? 'user-request' : 'engine-failure';
        this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state, attempt: 1, stopReason });
        machine.transition(state);
        this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason });
      }
      throw cause;
    }
  }

  /**
   * Nuclei 結果 (JSONL) の取込。engine の起動・送信は行わない観測出力の取込経路であり、
   * 実行 (nuclei-scan step) は能力表が実測を満たすまで公開しない (design/22)。
   * 原本を証拠保存してから所見化し、壊れた行は quarantine して継続する。
   */
  async importNucleiResults(operator: OperatorProfile, input: ImportNucleiResultsInput): Promise<ImportNucleiResultsResult> {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    if (input.engineVersion.trim() === '') {
      throw domainError('ValidationFailed', 'engineVersion must not be empty');
    }

    const parsed = parseNucleiJsonl(input.lines);
    const inScope = parsed.matches.filter((match) => ScopePolicy.decide(caseRecord.scope, match.matchedAt).allowed);
    const excludedOutOfScope = parsed.matches.length - inScope.length;
    const batch = importMatches(inScope);

    const importId = this.deps.ids.next('nuclei-import');
    let rawEvidence;
    try {
      rawEvidence = await this.deps.evidence.saveText(
        `nuclei-jsonl-raw:${importId}`,
        canonicalJson({ importId, engineVersion: input.engineVersion, lines: input.lines }),
      );
    } catch (cause) {
      throw domainError('EngineFailure', `evidence storage failed before nuclei import: ${String(cause)}`, {
        retryable: true,
        details: { importId },
      });
    }
    const result = this.importer.importNucleiMatches(batch.imported, {
      now: this.deps.clock.now().toISOString(),
      engineVersion: input.engineVersion,
      makeFindingId: () => this.deps.ids.next('finding'),
      evidenceRef: rawEvidence.evidenceId,
    });
    this.persistFindings([...result.created, ...result.reobserved]);
    this.record({
      type: 'FindingsImported',
      at: this.deps.clock.now().toISOString(),
      source: 'nuclei-match',
      engineVersion: input.engineVersion,
      importedCount: result.created.length,
      duplicateCount: batch.duplicates + result.duplicateCount,
    });
    return {
      findings: this.importer.list(),
      importedCount: result.created.length,
      duplicateCount: batch.duplicates + result.duplicateCount,
      quarantinedCount: parsed.quarantined,
      excludedOutOfScope,
      evidenceRef: rawEvidence.evidenceId,
    };
  }

  /** 報告の生成。delegated step の限界開示を必ず含む。 */
  generateReport(
    operator: OperatorProfile,
    input: { readonly guidelines: readonly string[]; readonly excludeLowAndInfo?: boolean },
  ): ReportArtifact {
    this.requirePermission(operator, 'report.export');
    const caseRecord = this.currentCase();
    const findings = input.excludeLowAndInfo === true
      ? this.importer.list().filter((finding) => finding.severity !== 'low' && finding.severity !== 'info')
      : this.importer.list();
    const model = buildReportModel({
      caseId: caseRecord.caseId,
      generatedAt: this.deps.clock.now().toISOString(),
      guidelines: input.guidelines,
      findings,
      coverage: {
        ...(this.latestCoverageRunId === undefined ? {} : { guidelineCoverage: this.guidelineCoverage.getRun(this.latestCoverageRunId) }),
        exploredUrlCount: this.observationsByUrl.size,
        scannedUrlCount: this.scannedUrls.size,
        delegatedSteps: this.delegatedSteps,
        exploredUrls: [...this.observationsByUrl.values()].map((observation) => ({
          url: observation.url,
          statusCode: observation.status,
          contentType: observation.contentType,
          depth: observation.depth,
          discoveredFrom: observation.discoveredFrom,
          originType: observation.originType,
        })),
        scannedUrls: [...this.scannedUrls],
        excludedUrls: [...this.observationsByUrl.values()]
          .filter((observation) => !this.scannedUrls.has(ScopePolicy.canonicalUrl(observation.url)))
          .map((observation) => {
            const canonical = ScopePolicy.canonicalUrl(observation.url);
            const hasCandidate = this.latestCandidates.some((candidate) => ScopePolicy.canonicalUrl(candidate.url) === canonical);
            const reason = isSessionControlUrl(canonical)
              ? 'セッション状態を変更する URL のため自動能動診断から除外'
              : hasCandidate && !this.adoptedCandidateUrls.has(canonical)
                ? '診断候補として検出されたが、実行対象として選択されなかったため除外'
                : '探索で観測したが、能動診断可能な入力点が確認できなかったため除外';
            return { url: observation.url, reason };
          }),
          ...this.deniedUrlLog.map((denied) => ({ url: denied.url, reason: `scope判定で拒否: ${denied.reason}` })),
        ...(this.assessmentStartedAt === undefined ? {} : { startedAt: this.assessmentStartedAt }),
        endedAt: this.assessmentEndedAt ?? this.deps.clock.now().toISOString(),
        authenticationRole: this.authenticationRole,
        scanPolicies: [
          ...(this.exploredUrlCount > 0 ? ['passive' as const] : []),
          ...(this.scannedUrlCount > 0 ? ['active' as const] : []),
        ],
        diagnosticRoutes: this.latestDiagnosticRoutes.map((route) => ({
          track: route.track,
          targetUrl: route.targetUrl,
          status: route.status,
          detail: route.detail,
        })),
        unsupportedAssessments: this.latestUnsupportedAssessments ?? resolveUnsupportedAssessments(input.guidelines),
        guidelineRoutes: this.latestGuidelineRoutes.map((route) => ({ ...route })),
        limitations: [
          '外部 engine (Delegated 経路) の個々の送信は送信前に拒否できない。入力 scope・停止・版ごとの実測で管理する。',
          'engine 由来の所見は実影響未確認であり、人の確認なしに確定扱いにしない。',
          ...(input.excludeLowAndInfo === true ? ['お客様のご指示によりLow以下は省略されています。'] : []),
        ],
      },
      assessmentScope: {
        caseName: caseRecord.name,
        allowedOrigins: caseRecord.scope.allowedOrigins,
        deniedOrigins: caseRecord.scope.deniedOrigins,
        limits: caseRecord.scope.limits,
        ...(this.authorization === null ? {} : {
          authorization: {
            allowedOperationClasses: this.authorization.allowedOperationClasses,
            targetRoles: this.authorization.targetRoles,
            validFrom: this.authorization.validFrom,
            validUntil: this.authorization.validUntil,
            evidenceRef: this.authorization.evidenceRef.evidenceId,
          },
        }),
      },
    });
    const reportId = this.deps.ids.next('report');
    const artifact = renderMarkdown(model, reportId);
    this.record({ type: 'ReportGenerated', at: this.deps.clock.now().toISOString(), reportId, modelHash: artifact.modelHash });
    return artifact;
  }

  private requirePermission(operator: OperatorProfile, permission: OperatorPermission): void {
    if (!operator.permissions.includes(permission)) {
      throw domainError('PermissionDenied', `operator ${operator.operatorId} lacks permission ${permission}`);
    }
  }

  private requireMatchingConfirmation(plan: ExecutionPlan, confirmation: PlanConfirmation): void {
    const aggregate = this.currentAggregate();
    if (aggregate.isConfirmationInvalidated(confirmation.confirmationId)) {
      throw domainError('ConfirmationRequired', `plan confirmation was invalidated: ${aggregate.invalidationReason(confirmation.confirmationId) ?? 'unknown reason'}`);
    }
    if (!confirmationMatches(plan, confirmation)) {
      throw domainError('ConfirmationRequired', 'plan confirmation does not match the current plan');
    }
  }

  private requireCurrentScanPolicy(plan: ExecutionPlan): ScanPolicy | undefined {
    if (plan.scanPolicyHash === undefined) return undefined;
    const caseRecord = this.currentCase();
    const policy = this.scanPolicies.findCurrentByHash(caseRecord.caseId, plan.scanPolicyHash, this.deps.clock.now().toISOString());
    if (policy === undefined) {
      throw domainError('ConfirmationRequired', 'scan policy changed after the plan was built; rebuild and confirm the plan');
    }
    return policy;
  }

  private currentAggregate(): CaseAggregate {
    if (this.aggregate === null) {
      throw domainError('ValidationFailed', 'case has not been created yet');
    }
    return this.aggregate;
  }

  private canonicalOriginOrThrow(origin: string): string {
    try {
      return ScopePolicy.canonicalOrigin(origin);
    } catch (cause) {
      throw domainError('ValidationFailed', `invalid origin: ${origin}`, { details: { cause: String(cause) } });
    }
  }

  private requirePositiveLimits(limits: ScopeLimits, label: string): void {
    for (const [key, value] of Object.entries(limits)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw domainError('ValidationFailed', `${label} limit ${key} must be a positive integer`);
      }
    }
  }

  private planLimits(requested: PlanLimits, caseLimits: ScopeLimits): PlanLimits {
    return {
      maxRequests: Math.min(requested.maxRequests, caseLimits.maxRequests),
      maxPages: Math.min(requested.maxPages, caseLimits.maxPages),
      maxDurationMinutes: Math.min(requested.maxDurationMinutes, caseLimits.maxDurationMinutes),
      // 並列度・rate は安全規定値を超えられない (案件上限に含まれないため既定で頭打ち)。
      maxConcurrency: Math.min(requested.maxConcurrency, PLAN_SAFETY_CEILING.maxConcurrency),
      requestsPerSecond: Math.min(requested.requestsPerSecond, PLAN_SAFETY_CEILING.requestsPerSecond),
    };
  }

  private record(event: BaselineFlowEvent): void {
    const context = jobContext.getStore();
    if (context !== undefined) {
      if (event.type === 'RunStarted') { context.runId = event.runId; context.registry.bindRun(context.jobId, event.runId); }
      event = { ...event, jobId: context.jobId, ...(context.runId === undefined ? {} : { runId: context.runId }) };
      if (event.type === 'EgressDenied') context.registry.emit(context.jobId, { category: 'egress-denied', level: 'warn', messageKey: 'job.egress.denied', message: event.reason, params: {}, refs: { url: event.url } });
      if (event.type === 'FindingsImported') {
        const counters = context.registry.get(context.jobId)!.summary.counters;
        context.registry.emit(context.jobId, { category: 'finding', messageKey: 'job.findings.imported', message: 'Findings imported', params: { importedCount: event.importedCount, duplicateCount: event.duplicateCount }, counters: { findings: counters.findings + event.importedCount } });
      }
    }
    event = JSON.parse(JSON.stringify(event), (_key, value) => typeof value === 'string' ? redactJobText(value) : value) as BaselineFlowEvent;
    this.deps.jobStore?.appendAudit(event);
    this.eventsLog.push(event);
    for (const listener of this.auditListeners) listener(event, this.eventsLog.length);
  }
}

/**
 * 観測から診断候補を生成する seed。分類根拠の guideline 参照は
 * catalog (design/27) の実装まで仮ラベル (`provisional:*`) を使う。
 */
function candidatesFromObservation(observation: PageObservation, ids: IdGenerator): ScanCandidate[] {
  const pageUrl = observation.finalUrl ?? observation.url;
  const parsedUrl = new URL(pageUrl);
  const queryParameterCount = [...parsedUrl.searchParams].length;
  const queryInputPoints: RequestInputPoint[] = [...new Set(parsedUrl.searchParams.keys())]
    .map((name) => ({ name, location: 'query', type: 'string' }));
  const javascriptSignals = observation.javascriptSignals;
  const javascriptSignalCount = javascriptSignals === undefined
    ? 0
    : javascriptSignals.scriptElements + javascriptSignals.inlineEventHandlers + javascriptSignals.javascriptUrls;
  const pageHasDynamicInput = queryParameterCount > 0 || javascriptSignalCount > 0;
  const dynamicReasons = [
    ...(queryParameterCount === 0 ? [] : [`GETパラメータ ${queryParameterCount} 件`]),
    ...(javascriptSignals === undefined || javascriptSignalCount === 0 ? [] : [
      `JavaScript要素 ${javascriptSignals.scriptElements} 件・インラインイベント ${javascriptSignals.inlineEventHandlers} 件・javascript: URL ${javascriptSignals.javascriptUrls} 件`,
    ]),
  ];
  const candidates: ScanCandidate[] = [
    {
      candidateId: ids.next('cand'),
      url: pageUrl,
      method: 'GET',
      category: 'page',
      guidelineBasis: ['provisional:page'],
      confidence: 0.7,
      observationUrl: pageUrl,
      detectionReason: observation.discoveredFrom === null
        ? `探索開始URLとして観測 (HTTP ${observation.status}, ${observation.contentType})${dynamicReasons.length === 0 ? '' : `。${dynamicReasons.join('、')}を検出`}`
        : `${observation.discoveredFrom} からリンクを検出 (HTTP ${observation.status}, ${observation.contentType})${dynamicReasons.length === 0 ? '' : `。${dynamicReasons.join('、')}を検出`}`,
      dynamic: pageHasDynamicInput,
      inputPoints: queryInputPoints,
      diagnosticTracks: diagnosticTracksFor(pageUrl, 'GET', queryInputPoints, javascriptSignalCount > 0),
    },
  ];
  for (const form of observation.forms) {
    const location = form.method.toUpperCase() === 'GET' ? 'query' : 'body';
    const inputPoints: RequestInputPoint[] = form.fields.map((field) => ({
      name: field.name,
      location: field.type.toLowerCase() === 'file' ? 'file' : location,
      type: field.type,
    }));
    candidates.push({
      candidateId: ids.next('cand'),
      url: ScopePolicy.canonicalUrl(form.actionUrl),
      method: form.method,
      category: 'form',
      guidelineBasis: [`provisional:form:${form.classification}`],
      confidence: 0.9,
      observationUrl: pageUrl,
      detectionReason: `${pageUrl} で ${form.classification} フォームを検出 (${form.method.toUpperCase()}, 入力 ${form.fields.length} 項目)`,
      dynamic: true,
      inputPoints,
      ...(location === 'query' ? {} : {
        contentType: inputPoints.some((point) => point.location === 'file')
          ? 'multipart/form-data'
          : 'application/x-www-form-urlencoded',
      }),
      diagnosticTracks: diagnosticTracksFor(form.actionUrl, form.method, inputPoints, false),
    });
  }
  const seenRequests = new Set<string>();
  for (const request of observation.requests ?? []) {
    if (request.resourceType !== 'xhr' && request.resourceType !== 'fetch' && request.inputPoints.length === 0 && request.method === 'GET') continue;
    if (isTransportChannelUrl(request.url)) continue;
    const key = `${request.method}|${ScopePolicy.canonicalUrl(request.url)}|${request.inputPoints.map((point) => `${point.location}:${point.name}`).sort().join(',')}`;
    if (seenRequests.has(key)) continue;
    seenRequests.add(key);
    candidates.push({
      candidateId: ids.next('cand'),
      url: ScopePolicy.canonicalUrl(request.url),
      method: request.method,
      category: request.resourceType === 'xhr' || request.resourceType === 'fetch' ? 'api-endpoint' : 'form',
      guidelineBasis: [`observed-http:${request.resourceType}`],
      confidence: 0.95,
      observationUrl: pageUrl,
      detectionReason: `${pageUrl} のブラウザー通信で ${request.method} リクエストと入力点 ${request.inputPoints.length} 件を観測`,
      dynamic: true,
      requestId: request.requestId,
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
      inputPoints: request.inputPoints,
      diagnosticTracks: diagnosticTracksFor(request.url, request.method, request.inputPoints, false, request.contentType),
    });
  }
  // スクリプト内の API 呼び出し定義 (書き込み API は操作でしか発火せず閲覧観測に現れない)。
  // 実行時観測 (requests) と同一視できるものは観測由来を優先する。
  for (const call of observation.scriptApiCalls ?? []) {
    const method = call.method.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
    if (isTransportChannelUrl(call.url)) continue;
    if (/\/:[A-Za-z]|[{}]/.test(new URL(call.url).pathname)) continue;
    const canonical = ScopePolicy.canonicalUrl(call.url);
    const key = `${method}|${canonical}|`;
    if (seenRequests.has(key)) continue;
    seenRequests.add(key);
    candidates.push({
      candidateId: ids.next('cand'),
      url: canonical,
      method,
      category: 'api-endpoint',
      guidelineBasis: ['script-api-call'],
      confidence: 0.75,
      observationUrl: pageUrl,
      detectionReason: `読込済みスクリプト内の ${method} API 呼び出し定義 (${new URL(call.url).pathname})。閲覧観測では発火しない操作系 API を含む`,
      dynamic: method !== 'GET',
      diagnosticTracks: diagnosticTracksFor(call.url, method, [], false),
    });
  }
  for (const route of observation.clientRoutes ?? []) {
    if (route.url === pageUrl || isSessionControlUrl(route.url)) continue;
    candidates.push({ candidateId: ids.next('cand'), url: route.url, method: 'GET', category: 'page', guidelineBasis: ['observed-client-route'], confidence: 0.9, observationUrl: pageUrl, detectionReason: `Client route observed via ${route.source}; server reachability unverified`, diagnosticTracks: ['browser-dom'], provenance: [{ source: route.source, url: pageUrl }] });
  }
  return candidates;
}

export function isSessionControlUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const pathname = (parsed.hash.startsWith('#/') || parsed.hash.startsWith('#!/') ? parsed.hash.replace(/^#!?/, '').split('?')[0]! : parsed.pathname).toLowerCase();
    return /\/(?:logout|log-out|logoff|signout|sign-out)(?:\.php)?\/?$/.test(pathname)
      || /\/(?:setup|install)(?:\.php)?\/?$/.test(pathname);
  } catch {
    return true;
  }
}

/** login 観測候補と探索候補の重複判定キー (method・URL・入力点の一致で同一視)。 */
function loginMergeKeyOf(method: string, url: string, inputPoints: readonly RequestInputPoint[]): string {
  return [
    method.toUpperCase(),
    ScopePolicy.canonicalUrl(url),
    ...inputPoints.map((point) => `${point.location}:${point.name}`).sort(),
  ].join('|');
}

/**
 * Well-known リアルタイム通信チャネルの path。これらは応答も入力も転送管理が主目的で
 * 診断対象としての価値が低く、一意なポーリング URL が候補枠を圧迫するため候補化から除外する。
 */
function isTransportChannelUrl(url: string): boolean {
  try {
    return /\/(?:socket\.io|engine\.io|sockjs|signalr|pusher|mqtt)(?:\/|$)/i.test(new URL(url).pathname);
  } catch {
    return true;
  }
}

function diagnosticTracksFor(
  url: string,
  method: string,
  inputPoints: readonly RequestInputPoint[],
  hasJavascript: boolean,
  observedContentType?: string,
): readonly DiagnosticTrack[] {
  const text = `${url} ${method} ${inputPoints.map((point) => `${point.name}:${point.type}`).join(' ')}`.toLowerCase();
  const tracks = new Set<DiagnosticTrack>();
  const interactiveMutation = requiresInteractiveStateChange(inputPoints);
  if (inputPoints.length > 0 && !interactiveMutation) tracks.add('zap-active');
  if (interactiveMutation) tracks.add('workflow-state');
  if (hasJavascript || /\b(?:javascript|script|html|content)\b/.test(text)) tracks.add('browser-dom');
  if (/\b(?:csrf|captcha|confirm|approval|state|step)\b/.test(text)) tracks.add('workflow-state');
  if (/\b(?:session|token|jwt|sid)\b/.test(text)) tracks.add('session-analysis');
  if (/authori[sz]|\brole\b|\buser[_-]?id\b|\baccount[_-]?id\b/.test(text)) tracks.add('authorization-differential');
  if (inputPoints.some((point) => point.location === 'file') || /upload/.test(text)) tracks.add('upload-workflow');
  if (/\/api(?:\/|$)|graphql|openapi|swagger/.test(text)) tracks.add('api-schema');
  if (/crypt|cipher|encrypt|decrypt/.test(text)) tracks.add('cryptography-review');
  // 観測済みの JSON 応答は API 表面の強い根拠 (パス命名に依存しない api-schema 適用)。
  if (observedContentType !== undefined && /application\/(?:[\w.+-]*\+)?json/i.test(observedContentType)) tracks.add('api-schema');
  // エンティティ ID を持つ読み取り経路は認可差分 (role 間比較) の対象になる。
  try {
    if (/\/\d+(?:\/|$)/.test(new URL(url).pathname)) tracks.add('authorization-differential');
  } catch {
    // 相対 URL 等はスキップ (他規則で評価)。
  }
  if (tracks.size === 0) tracks.add('zap-active');
  return [...tracks];
}

function requiresInteractiveStateChange(inputPoints: readonly RequestInputPoint[]): boolean {
  const names = inputPoints.map((point) => point.name.trim().toLowerCase().replace(/[-\s]+/g, '_'));
  const changesCredential = names.some((name) => /^(?:new_?)?(?:pass|passwd|password)(?:_new|_conf|_confirm|_confirmation)?$/.test(name)
    && (name.includes('new') || name.includes('conf')));
  const hasMutationSubmit = names.some((name) => /^(?:change|update|save|reset|delete|remove|disable|enable)$/.test(name));
  return changesCredential && hasMutationSubmit;
}

function candidateAllowsAutomatedZap(candidate: ScanCandidate): boolean {
  const tracks = candidate.diagnosticTracks ?? ['zap-active'];
  return tracks.includes('zap-active') && !requiresInteractiveStateChange(candidate.inputPoints ?? []);
}

function diagnosticRouteDetail(track: DiagnosticTrack, domAvailable: boolean): Pick<DiagnosticRouteResult, 'status' | 'detail'> {
  switch (track) {
    case 'zap-active':
      return { status: 'delegated', detail: '認証済みHTTP request seedとしてZAPへ委譲します' };
    case 'browser-dom':
      return domAvailable
        ? { status: 'delegated', detail: 'PlaywrightでDOM source→sinkを自動観測します' }
        : { status: 'unavailable', detail: 'Playwright DOM observerが構成されていません' };
    case 'workflow-state':
      return { status: 'needs-input', detail: '保存型XSS、CSRF、CAPTCHA等の状態遷移・確認手順が必要です' };
    case 'session-analysis':
      return { status: 'needs-input', detail: 'トークン抽出位置と再送手順が必要です' };
    case 'authorization-differential':
      return { status: 'needs-input', detail: '比較する複数roleと期待結果が必要です' };
    case 'upload-workflow':
      return { status: 'needs-input', detail: '許可されたサンプルファイルと成功判定が必要です' };
    case 'api-schema':
      return { status: 'needs-input', detail: 'OpenAPI/GraphQL schemaまたは有効なrequest body例が必要です' };
    case 'cryptography-review':
      return { status: 'needs-input', detail: '対象データ、期待する保護要件、復号・検証手順が必要です' };
  }
}

function planDiagnosticRoutes(adopted: readonly ScanCandidate[], domAvailable: boolean): readonly DiagnosticRouteResult[] {
  const grouped = new Map<string, { track: DiagnosticTrack; targetUrl: string; candidateCount: number }>();
  for (const candidate of adopted) {
    const targetUrl = ScopePolicy.canonicalUrl(candidate.url);
    for (const track of candidate.diagnosticTracks ?? ['zap-active']) {
      if (track === 'zap-active' && !candidateAllowsAutomatedZap(candidate)) continue;
      const key = `${track}\0${targetUrl}`;
      const existing = grouped.get(key);
      grouped.set(key, {
        track,
        targetUrl,
        candidateCount: (existing?.candidateCount ?? 0) + 1,
      });
    }
  }
  return [...grouped.values()].map((route) => ({
    ...route,
    ...diagnosticRouteDetail(route.track, domAvailable),
  }));
}

function updateDiagnosticRoute(
  routes: readonly DiagnosticRouteResult[],
  track: DiagnosticTrack,
  targetUrl: string,
  update: Pick<DiagnosticRouteResult, 'status' | 'detail'> & { readonly findingCount?: number },
): readonly DiagnosticRouteResult[] {
  return routes.map((route) => route.track === track && route.targetUrl === targetUrl
    ? { ...route, ...update }
    : route);
}

class SharedBudgetWorkflowTransport implements WorkflowScanTransport {
  private readonly delegate: WorkflowScanTransport;
  private readonly budget: { readonly limit: number; used: number };

  constructor(
    delegate: WorkflowScanTransport,
    budget: { readonly limit: number; used: number },
  ) {
    this.delegate = delegate;
    this.budget = budget;
  }

  get baseUrl(): string {
    return this.delegate.baseUrl;
  }

  get requestCount(): number {
    return this.budget.used;
  }

  async request(spec: WorkflowScanRequestSpec): Promise<WorkflowScanHttpResponse> {
    if (this.budget.used >= this.budget.limit) {
      throw domainError('OutOfScope', `workflow scan request limit reached (${String(this.budget.limit)})`);
    }
    this.budget.used += 1;
    return this.delegate.request(spec);
  }

  takeRequestLog(): import('../domain/workflow-scan.ts').WorkflowScanRequestLogEntry[] {
    return this.delegate.takeRequestLog();
  }
}

function workflowHttpEvidenceRecords(
  checks: readonly import('../domain/workflow-scan.ts').WorkflowScanCheckResult[],
  requestLog: readonly import('../domain/workflow-scan.ts').WorkflowScanRequestLogEntry[],
  baseUrl: string,
): readonly Readonly<Record<string, unknown>>[] {
  const host = new URL(baseUrl).host;
  return checks.map((check) => {
    const checkUrl = new URL(check.url, `${baseUrl}/`);
    const exactTarget = `${checkUrl.pathname}${checkUrl.search}`;
    const pathMatches = requestLog.filter((entry) => {
      try {
        const entryUrl = new URL(entry.url, `${baseUrl}/`);
        return `${entryUrl.pathname}${entryUrl.search}` === exactTarget;
      } catch {
        return false;
      }
    });
    const samePath = requestLog.filter((entry) => {
      try {
        return new URL(entry.url, `${baseUrl}/`).pathname === checkUrl.pathname;
      } catch {
        return false;
      }
    });
    const exchange = pathMatches.findLast((entry) => entry.method.toUpperCase() === check.method.toUpperCase())
      ?? pathMatches.at(-1)
      ?? samePath.findLast((entry) => entry.method.toUpperCase() === check.method.toUpperCase())
      ?? samePath.at(-1);
    if (exchange === undefined) {
      throw new Error(`workflow HTTP evidence is missing for ${check.checkId} ${checkUrl.pathname}`);
    }
    const requestTarget = exchange.url;
    const requestBody = exchange.requestPreview;
    const responseBody = exchange.responsePreview;
    const location = exchange.location;
    return {
      pluginId: `workflow-scan:${check.checkId}:${check.securityLevel || 'global'}`,
      url: checkUrl.toString(),
      method: check.method,
      param: check.param,
      request: `${check.method.toUpperCase()} ${requestTarget} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ScopePilot2-WorkflowScan/1.0\r\n${requestBody === '' ? '' : `Content-Type: application/x-www-form-urlencoded\r\n\r\n${requestBody}`}`,
      response: `HTTP/1.1 ${String(exchange.status)} Observed\r\n${location === '' ? '' : `Location: ${location}\r\n`}\r\n${responseBody}`,
      attack: check.param,
      evidenceSummary: check.evidence,
      description: check.description,
      remediation: check.remediation,
      cwe: check.cwe,
    };
  });
}
