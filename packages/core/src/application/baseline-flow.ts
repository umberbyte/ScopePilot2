/**
 * 基準シナリオ「案件作成→認可→探索→候補採用→能動診断→取込→所見→報告」の
 * application service seed。`docs/design/19-cli-automation.md` 5章、`docs/design/22-execution-control.md`。
 *
 * 本体実装より先に simulation fixture で自動完走させる回帰基準となる層で、
 * command pipeline の順序 (権限判定 → 認可 → 確認 → domain 処理 → 証跡 → event) を
 * 最初から踏襲する (SYS-UT-001/005 の土台)。
 */
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
  DocumentAuthMethods,
  DocumentPriorityCategories,
} from '@scopepilot2/contracts';
import { ScopePolicy } from '../domain/scope-policy.ts';
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
import { FindingImporter } from '../domain/finding-importer.ts';
import { BreakQueue, decideIntercept, type BreakItem, type BreakQueueEvent, type InterceptDecision } from '../domain/proxy-intercept.ts';
import { SiteMapProjector, planTrafficQuery } from '../domain/target-logger.ts';
import {
  businessTargetInScope,
  compareObservations,
  evaluateRestore,
  parseExpectation,
  planRoleMatrix,
  resolveOutcome,
  type ComparisonOutcome,
} from '../domain/business-logic.ts';
import {
  RoleSessionRegistry,
  SessionCoordinator,
  checkFlowDeadline,
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
import { assess, createSamplePlan, createSequencerExtractor, extractSequencerToken, reportProjection, SampleCollector } from '../domain/sequencer.ts';
import { parseOpenApiDocument } from '../domain/api-scanning.ts';
import { correlate, linkFinding, normalizeCallbacks, OAST_DEFAULT_WAIT_MS, pollDeadline, providerCapability, TokenIssuer, type OastProtocol, type ProviderEvent } from '../domain/oast.ts';
import { buildWsSendPlan, importFrames, sendWithPolicy, validateWsSubprotocols, wsEvidence, type WsFrame } from '../domain/websocket.ts';
import { checkAuthorityScope, negotiateTransport, transportCapability, transportEvidence, validateHeaderValues, validatePseudoHeaders } from '../domain/advanced-transport.ts';
import { buildDomCandidate, domEvidenceProjection } from '../domain/dom-investigation.ts';
import { checkCompatibility, respondToSecretRead, verifyExtensionManifest, type ExtensionManifest } from '../domain/product-api.ts';
import { buildReportModel, renderMarkdown } from '../domain/report-builder.ts';
import type { Clock, EvidenceStorePort, IdGenerator } from '../ports/infra.ts';
import type { ActiveScanEnginePort, ExplorationPort, LoginExecutorPort, LoginSessionCookie, OastProviderEvent } from '../ports/engines.ts';

/** 計画の並列度・rate が超えられない安全上天井 (UI 指定でも引き上げ不可)。 */
const PLAN_SAFETY_CEILING = { maxConcurrency: 2, requestsPerSecond: 2 } as const;

export interface BaselineFlowDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly evidence: EvidenceStorePort;
  readonly explorer: ExplorationPort;
  readonly scanEngine: ActiveScanEnginePort;
  readonly capabilities: readonly EngineCapabilitySnapshot[];
  readonly runtimeBundleHash: string;
  /** run 記録の永続化 (任意)。開始時 (Running) と終了時の両方へ保存する。 */
  readonly runSink?: import('../ports/infra.ts').RunSinkPort;
  /** 案件記録の永続化 (任意)。作成・scope 更新時に保存する (runs FK の参照先)。 */
  readonly caseSink?: { save(record: CaseRecord): void };
  /** 実 engine 診断の完了後、alert 生成の遅れを待つ時間 (ms)。fixture では 0。 */
  readonly scanAlertSettleMs?: number;
  /** Repeater の実 transport (design/f04)。未構成なら fixture 応答を使う。 */
  readonly repeaterTransport?: import('../ports/engines.ts').RepeaterTransportPort;
  /** Fuzz の実 transport (design/f05)。未構成なら fixture 応答を使う。 */
  readonly fuzzTransport?: import('../ports/engines.ts').FuzzTransportPort;
  /** Sequencer の実収集 transport (design/f07)。未構成なら fixture 応答を使う。 */
  readonly sequencerTransport?: import('../ports/engines.ts').SequencerTransportPort;
  /** OAST の実 provider session (design/f13)。未構成なら fixture token を発行する。 */
  readonly oastProvider?: import('../ports/engines.ts').OastProviderPort;
  /** WebSocket の実 text transport (design/f14)。未構成なら fixture 台帳だけを使う。 */
  readonly webSocketTransport?: import('../ports/engines.ts').WebSocketTransportPort;
  /** HTTP/2 negotiation/request probe (design/f15). Omitted for deterministic fixtures. */
  readonly advancedTransport?: import('../ports/engines.ts').AdvancedTransportPort;
  /** Playwright-backed live DOM observation (design/f16). */
  readonly domObserver?: import('../ports/engines.ts').DomObservationPort;

  /** login 実行器 (design/f09)。未構成の service では runLogin が ValidationFailed。 */
  readonly loginExecutor?: LoginExecutorPort;
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
  readonly engineVersion: string;
}

export interface ActiveScanRunResult {
  readonly runRecord: RunRecord;
  readonly planHash: string;
  readonly scanRequest: ActiveScanRequest;
  readonly findings: readonly Finding[];
  readonly overshootReservation: number;
  readonly engineVersion: string;
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
  private aggregate: CaseAggregate | null = null;
  private authorization: AuthorizationRecord | null = null;
  private readonly eventsLog: BaselineFlowEvent[] = [];
  private readonly importer = new FindingImporter();
  /** proxy の break queue (design/f02)。deadline 経過は既定で drop (暗黙 forward しない)。 */
  private readonly breakQueue = new BreakQueue(100);

  /** HTTP 通信 log と endpoint 集約 (design/f03)。探索・Repeater・Fuzzer の観測通信を記録する。 */
  private readonly trafficLog: readonly { exchangeId: string; url: string; method: string; status: number; contentType: string; at: string; source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer' }[] = [];
  private readonly siteMapProjector = new SiteMapProjector();

  /** 業務ロジック検証の実行履歴 (design/f17)。 */
  private readonly businessChecks: readonly { checkId: string; roles: readonly string[]; targetUrl: string; status: string; comparison: string; restore: string; executedAt: string }[] = [];

  /** 認証・session 管理 (design/f09)。secret 値は参照のみ保持し、値は受け付けない。 */
  private readonly loginFlows = new Map<string, { flowVersion: string; steps: readonly LoginFlowStep[]; secretReferences: readonly string[] }>();
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
  private readonly fuzzRuns: readonly { runId: string; targetUrl: string; total: number; sent: number; clusters: readonly { key: string; members: readonly number[]; representative: readonly string[] }[]; executedAt: string }[] = [];

  /** OAST の attempt・観測 (design/f13)。token は発行時に一度だけ応答し、一覧には出さない。 */
  private readonly oastIssuer = new TokenIssuer();
  private readonly oastAttempts: { attemptId: string; targetUrl: string; protocol: OastProtocol; token: string; issuedAtMs: number }[] = [];
  private readonly oastSeenEventIds = new Set<string>();
  private readonly oastInteractions: { token: string; payload: string; recordedAt: string }[] = [];
  private readonly oastUncorrelated: { token: string; reason: string; recordedAt: string }[] = [];

  /** WebSocket frame 台帳 (design/f14)。text のみ・重複 fingerprint は持越しで dedupe。 */
  private readonly wsFrames: WsFrame[] = [];
  private readonly wsSeenFingerprints = new Set<string>();
  private wsSessionRevision = 1;

  /** CA profile の信頼登録状態 (design/24。既定は未登録)。 */
  private caProfileTrusted = false;

  /** 読み込み済み extension (design/f20)。manifest の署名検証を通過したもののみ。 */
  private readonly loadedExtensions: readonly { extensionId: string; version: string; permissions: readonly string[]; apiRange: readonly string[] }[] = [];

  /** 取り込んだ API 仕様の記録 (design/f12)。endpoint の一覧は都度応答する。 */
  private readonly apiSpecImports: readonly { documentLabel: string; servers: readonly string[]; excludedServers: readonly string[]; endpoints: readonly { method: string; path: string; url: string }[]; importedAt: string }[] = [];

  /** Sequencer session の台帳 (design/f07)。token 原文は保存しない (統計のみ)。 */
  private readonly sequencerSessions: readonly { sessionId: string; targetUrl: string; tokenSource: 'body' | 'cookie' | 'hidden' | 'bearer'; tokenCookieName?: string; tokenFieldName?: string; verdict: 'assessed' | 'insufficient'; sampleCount: number; duplicates: number; missing: number; shannonEntropyBitsPerByte?: number; distinctByteValues?: number; minimum?: number; sessionCookieNames?: readonly string[]; executedAt: string }[] = [];

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
  private readonly roleSessionCookies = new Map<string, { readonly cookies: readonly LoginSessionCookie[]; readonly createdAt: string }>();
  private exploredUrlCount = 0;
  private scannedUrlCount = 0;
  private delegatedSteps: {
    readonly stepId: string;
    readonly engineKind: 'zap';
    readonly engineVersion: string;
  }[] = [];

  private readonly deps: BaselineFlowDeps;

  constructor(deps: BaselineFlowDeps) {
    this.deps = deps;
  }

  events(): readonly BaselineFlowEvent[] {
    return [...this.eventsLog];
  }

  /** 現在の全所見 (作成順)。UI/CLI の organizer 表示用。 */
  listFindings(): readonly Finding[] {
    return this.importer.list();
  }

  /** site map (観測済み page の一覧・初回観測順)。 */
  listObservations(): readonly PageObservation[] {
    return [...this.observationsByUrl.values()];
  }

  /** 探索で scope 拒否された URL (開示用)。 */
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
  private recordObservedExchange(summary: { url: string; method: string; status: number; contentType: string }, at: string, source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer'): void {
    (this.trafficLog as { exchangeId: string; url: string; method: string; status: number; contentType: string; at: string; source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer' }[]).push({
      exchangeId: this.deps.ids.next('exchange'),
      ...summary,
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
    parseExpectation(input.expectation);
    const matrix = planRoleMatrix(input.roles);
    // fixture 観測: session を refresh 済みの role だけが認証付き観測を持つ (未 refresh は null)。
    const observations = input.roles.map((role) => ({
      role,
      observation: this.sessionRevisions.get(role) !== undefined ? `business-response:${role}` : null,
    }));
    const primary = observations[0]?.observation ?? null;
    const expected = typeof input.expectation.args[0] === 'string' ? (input.expectation.args[0] as string) : null;
    // どれかの role でも観測が欠けたら inconclusive (成功/失敗を推測しない)。
    const missingObservation = observations.some((entry) => entry.observation === null);
    const comparison = missingObservation ? { outcome: 'inconclusive' as const } : compareObservations(expected, primary);
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

  /** login flow の登録 (design/f09)。step 構成は domain 検証 (上限 10・allowlist・fill は secret 参照必須)。 */
  registerLoginFlow(
    operator: OperatorProfile,
    input: { readonly role: string; readonly flowVersion: string; readonly steps: readonly LoginFlowStep[] },
  ): { role: string; stepCount: number; secretReferences: readonly { flowVersion: string; secretReference: string }[] } {
    this.requirePermission(operator, 'run.manage');
    if (input.role.trim() === '') {
      throw domainError('ValidationFailed', 'role must not be empty');
    }
    if (input.steps.some((step) => (step as { secretValue?: unknown }).secretValue !== undefined)) {
      // secret 値の持ち込みは最初から拒否 (F09-UT-006: 参照のみ)。
      throw domainError('ValidationFailed', 'inline secret values are not accepted; use secretReference');
    }
    const { stepCount } = validateLoginFlow(input.steps);
    const secretReferences = input.steps
      .filter((step) => step.secretReference !== undefined)
      .map((step) => vaultEvidenceProjection({ flowVersion: input.flowVersion, secretReference: step.secretReference ?? '' }));
    this.loginFlows.set(input.role, { flowVersion: input.flowVersion, steps: input.steps, secretReferences: secretReferences.map((entry) => entry.secretReference) });
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
    const flow = this.loginFlows.get(input.role);
    if (flow === undefined) {
      throw domainError('ValidationFailed', `login flow for ${input.role} is not registered`);
    }
    const executor = this.deps.loginExecutor;
    if (executor === undefined) {
      throw domainError('ValidationFailed', 'login executor is not configured for this service');
    }
    for (const reference of flow.secretReferences) {
      if (input.secretValues[reference] === undefined) {
        throw domainError('NeedsInput', `secret value for reference '${reference}' was not provided`);
      }
    }
    const startedAtMs = this.deps.clock.now().getTime();
    const result = await executor.execute({
      baseUrl: input.baseUrl,
      steps: flow.steps,
      secretValues: input.secretValues,
      expectedUrlPrefix: input.expectedUrlPrefix,
      ...(input.proxyServer === undefined ? {} : { proxyServer: input.proxyServer }),
    });
    checkFlowDeadline(this.deps.clock.now().getTime() - startedAtMs);
    if (result.authenticated) {
      this.roleSessionCookies.set(input.role, { cookies: result.cookies, createdAt: this.deps.clock.now().toISOString() });
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
  listSessions(): readonly { role: string; flowVersion: string; stepCount: number; secretReferences: readonly string[]; cookieNames: readonly string[]; sessionRevision: number }[] {
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
      };
    });
  }

  /** session の refresh (single-flight・lockout 回避は domain)。 */
  async refreshSession(operator: OperatorProfile, role: string): Promise<{ outcome: 'refreshed' | 'stopped-lockout-guard'; sessionRevision: number }> {
    this.requirePermission(operator, 'run.manage');
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
    input: { readonly targetUrl: string; readonly positions: readonly FuzzPosition[]; readonly maxRequests?: number; readonly role?: string },
  ): Promise<{ runId: string; targetUrl: string; total: number; sent: number; clusters: readonly { key: string; members: readonly number[]; representative: readonly string[] }[]; sessionCookieNames?: readonly string[] }> {
    this.requirePermission(operator, 'run.manage');
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
    const cap = input.maxRequests ?? Math.min(200, caseRecord.scope.limits.maxRequests);
    const { total } = planCombinations(input.positions, cap);
    // 実 transport 構成時は rate (2 req/s) を実時間で守る。fixture は仮想時計のまま。
    const realTransport = this.deps.fuzzTransport;
    let virtualNowMs = 0;
    const outcomes: FuzzResponseOutcome[] = [];
    const result = await runFuzz(
      {
        send: async (_index, combination) => {
          if (realTransport !== undefined) {
            const response = await realTransport.send({
              targetUrl: canonical,
              combination,
              positions: input.positions,
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
            this.recordObservedExchange(
              { url: response.requestUrl, method: 'GET', status: response.status, contentType: response.contentType },
              this.deps.clock.now().toISOString(),
              'fuzzer',
            );
            return;
          }
          // fixture adapter: 応答は先頭 position の値だけで決まる (cluster 集約の実演)。
          const body = `resp:${combination[0] ?? ''}`;
          outcomes.push({ status: 200, contentLength: body.length, bodyHash: hashStable('scopepilot2.fuzz.body', body) });
        },
      },
      input.positions,
      total,
      {
        isCancelled: () => false,
        now: () => (realTransport === undefined ? virtualNowMs : Date.now()),
        sleep: async (ms) => {
          if (realTransport === undefined) {
            virtualNowMs += ms;
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
      representative: combinationAt(input.positions, cluster.members[0] ?? 0),
    }));
    const runId = this.deps.ids.next('fuzz');
    const record = { runId, targetUrl: canonical, total, sent: result.sent, clusters, executedAt: this.deps.clock.now().toISOString() };
    (this.fuzzRuns as { runId: string; targetUrl: string; total: number; sent: number; clusters: readonly { key: string; members: readonly number[]; representative: readonly string[] }[]; executedAt: string }[]).push(record);
    this.record({ type: 'FuzzRunCompleted', at: record.executedAt, runId, targetUrl: canonical, total, sent: result.sent });
    return {
      runId,
      targetUrl: canonical,
      total,
      sent: result.sent,
      clusters,
      // 適用した cookie は名前のみ (値は出さない — Repeater と同一規則)。
      ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
    };
  }

  listFuzzRuns(): readonly { runId: string; targetUrl: string; total: number; sent: number; clusters: readonly { key: string; members: readonly number[]; representative: readonly string[] }[]; executedAt: string }[] {
    return [...this.fuzzRuns];
  }

  /**
   * Sequencer session の実行 (design/f07)。sample 数は domain 検証 (30..10000)。
   * fixture adapter は対象 URL から決定的な token 応答を作る (URL に fixed が
   * 含まれる場合は毎回同一 token = 低 entropy・重複の実演、no-token は欠落混入)。
   * token 原文は応答・監査・台帳のいずれにも出さない (F07-UT-006)。
   */
  async runSequencerSession(
    operator: OperatorProfile,
    input: { readonly targetUrl: string; readonly samples: number; readonly role?: string; readonly tokenSource?: 'body' | 'cookie' | 'hidden' | 'bearer'; readonly tokenCookieName?: string; readonly tokenFieldName?: string; readonly signal?: AbortSignal },
  ): Promise<{ sessionId: string; targetUrl: string; tokenSource: 'body' | 'cookie' | 'hidden' | 'bearer'; tokenCookieName?: string; tokenFieldName?: string; verdict: 'assessed' | 'insufficient'; sampleCount: number; duplicates: number; missing: number; shannonEntropyBitsPerByte?: number; distinctByteValues?: number; minimum?: number; sessionCookieNames?: readonly string[] }> {
    this.requirePermission(operator, 'run.manage');
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
    const collector = new SampleCollector();
    const extractor = createSequencerExtractor(input.tokenSource ?? 'body', input.tokenCookieName, input.tokenFieldName);
    const pattern = /token=([A-Za-z0-9_-]+)/;
    const throwIfCancelled = (): void => {
      if (input.signal?.aborted === true) {
        throw domainError('Cancelled', 'sequencer session cancelled');
      }
    };
    throwIfCancelled();
    if (this.deps.sequencerTransport === undefined) {
      for (let index = 0; index < plan.target; index += 1) {
        throwIfCancelled();
        if (input.signal !== undefined) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          throwIfCancelled();
        }
        let token: string | undefined;
        if (canonical.includes('no-token') && index % 5 === 4) {
          token = undefined;
        } else if (canonical.includes('fixed')) {
          token = 'fixed-token-value';
        } else {
          token = `sample-${index.toString(36)}-${(index * 7 + 3).toString(36)}`;
        }
        const response = extractor.source === 'cookie'
          ? {
              body: 'cookie token response',
              ...(token === undefined ? {} : { setCookieHeaders: [`${extractor.cookieName}=${token}; Path=/; HttpOnly`] }),
            }
          : extractor.source === 'hidden'
            ? { body: token === undefined ? '<form></form>' : `<form><input value="${token}" name="${extractor.fieldName}" type="hidden"></form>` }
            : extractor.source === 'bearer'
              ? { body: 'bearer token response', ...(token === undefined ? {} : { authorizationHeader: `Bearer ${token}` }) }
              : { body: token === undefined ? 'no token in this response' : `token=${token}` };
        collector.record(extractSequencerToken(response, extractor, pattern));
      }
    } else {
      try {
        await this.deps.sequencerTransport.collect({
          targetUrl: canonical,
          samples: plan.target,
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
            collector.record(extractSequencerToken(response, extractor, pattern));
            this.recordObservedExchange(
              { url: response.requestUrl, method: 'GET', status: response.status, contentType: response.contentType },
              this.deps.clock.now().toISOString(),
              'sequencer',
            );
          },
        });
      } catch (cause) {
        if (input.signal?.aborted === true) {
          throw domainError('Cancelled', 'sequencer session cancelled');
        }
        throw cause;
      }
    }
    throwIfCancelled();
    const collection = collector.snapshot();
    const projection = reportProjection(collection);
    const assessment = assess(collection.tokens);
    const sessionId = this.deps.ids.next('seq');
    const verdict = assessment.verdict;
    const record = {
      sessionId,
      targetUrl: canonical,
      tokenSource: extractor.source,
      ...(extractor.source === 'cookie' ? { tokenCookieName: extractor.cookieName } : {}),
      ...(extractor.source === 'hidden' ? { tokenFieldName: extractor.fieldName } : {}),
      verdict,
      ...projection,
      ...(verdict === 'assessed' ? { shannonEntropyBitsPerByte: assessment.entropy.shannonEntropyBitsPerByte, distinctByteValues: assessment.entropy.distinctByteValues } : { minimum: assessment.minimum }),
      ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
      executedAt: this.deps.clock.now().toISOString(),
    };
    (this.sequencerSessions as typeof record[]).push(record);
    this.record({
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

  listSequencerSessions(): readonly { sessionId: string; targetUrl: string; tokenSource: 'body' | 'cookie' | 'hidden' | 'bearer'; tokenCookieName?: string; tokenFieldName?: string; verdict: 'assessed' | 'insufficient'; sampleCount: number; duplicates: number; missing: number; shannonEntropyBitsPerByte?: number; distinctByteValues?: number; minimum?: number; sessionCookieNames?: readonly string[]; executedAt: string }[] {
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
    const endpoints = candidates.flatMap((server) => parsed.endpoints.map((endpoint) => ({ method: endpoint.method, path: endpoint.path, url: `${server}${endpoint.path}` })));
    const warnings = [...new Set(parsed.endpoints.filter((endpoint) => endpoint.path.includes('{')).map((endpoint) => `path template ${endpoint.path} needs explicit values`))];
    const importedAt = this.deps.clock.now().toISOString();
    (this.apiSpecImports as { documentLabel: string; servers: readonly string[]; excludedServers: readonly string[]; endpoints: readonly { method: string; path: string; url: string }[]; importedAt: string }[]).push({ documentLabel: input.documentLabel, servers: candidates, excludedServers: excluded, endpoints, importedAt });
    this.record({
      type: 'ApiSpecImported',
      at: importedAt,
      documentLabel: input.documentLabel,
      endpointCount: endpoints.length,
      excludedServerCount: excluded.length,
    });
    return { documentLabel: input.documentLabel, servers: candidates, excludedServers: excluded, endpoints, warnings };
  }

  /**
   * OAST attempt の開始 (design/f13)。protocol 能力は provider (fixture は
   * http/dns) で検証し、非対応は CapabilityUnavailable。token はこの応答で
   * 一度だけ返し、監査・一覧には出さない (F13-UT-007)。
   */
  async startOastAttempt(
    operator: OperatorProfile,
    input: { readonly targetUrl: string; readonly protocol: OastProtocol },
  ): Promise<{ attemptId: string; targetUrl: string; protocol: OastProtocol; token: string; waitMs: number }> {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    const canonical = ScopePolicy.canonicalUrl(input.targetUrl);
    const decision = ScopePolicy.decide(caseRecord.scope, canonical);
    if (!decision.allowed) {
      throw domainError('OutOfScope', `oast target is out of scope: ${decision.reason}`);
    }
    const supportedProtocols = this.deps.oastProvider?.supportedProtocols ?? ['http', 'dns'];
    if (providerCapability(supportedProtocols, input.protocol) === 'Unsupported') {
      throw domainError('CapabilityUnavailable', `oast provider does not support protocol ${input.protocol}`);
    }
    const attemptId = this.deps.ids.next('oast');
    const pendingEvents: OastProviderEvent[][] = [];
    let attemptRegistered = false;
    const { token } = this.deps.oastProvider === undefined
      ? this.oastIssuer.issue(attemptId)
      : await this.deps.oastProvider.startSession({
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
    this.oastAttempts.push({ attemptId, targetUrl: canonical, protocol: input.protocol, token, issuedAtMs: this.deps.clock.now().getTime() });
    attemptRegistered = true;
    this.record({ type: 'OastAttemptStarted', at: this.deps.clock.now().toISOString(), attemptId, targetUrl: canonical, protocol: input.protocol });
    for (const events of pendingEvents) {
      this.recordProviderOastCallbacks(events);
    }
    return { attemptId, targetUrl: canonical, protocol: input.protocol, token, waitMs: OAST_DEFAULT_WAIT_MS };
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
    for (const callback of callbacks) {
      if (callback.kind === 'correlated') {
        correlatedCount += 1;
        this.oastInteractions.push({ token: callback.token, payload: callback.payload, recordedAt: at });
      } else {
        uncorrelatedCount += 1;
        this.oastUncorrelated.push({ token: callback.token, reason: callback.reason, recordedAt: at });
      }
    }
    this.record({ type: 'OastCallbacksRecorded', at, kept: kept.length, duplicates, correlated: correlatedCount, uncorrelated: uncorrelatedCount });
    return { kept: kept.length, duplicates, correlated: correlatedCount, uncorrelated: uncorrelatedCount };
  }

  /** attempt 一覧 (token なし。interactions と曖昧判定のみ)。 */
  listOastAttempts(): readonly { attemptId: string; targetUrl: string; protocol: OastProtocol; status: 'waiting' | 'expired'; interactions: number; candidateOnly: boolean }[] {
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
        // 複数 token にまたがる相関は無い (attempt 単位) が、観測 0 件は候補にもしない。
        candidateOnly: linked.linkedTokens.length === 1 && linked.candidateOnly === false ? false : true,
      };
    });
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
      const fingerprint = `${frame.direction}:${frame.payload}`;
      if (this.wsSeenFingerprints.has(fingerprint) || batchFingerprints.has(fingerprint)) {
        duplicates += 1;
        continue;
      }
      batchFingerprints.add(fingerprint);
      fresh.push(frame);
    }
    const { imported } = importFrames(fresh);
    for (const frame of imported) {
      this.wsSeenFingerprints.add(`${frame.direction}:${frame.payload}`);
      this.wsFrames.push(frame);
    }
    this.record({ type: 'WsFramesImported', at: this.deps.clock.now().toISOString(), targetUrl: canonical, imported: imported.length, duplicates });
    return { imported: imported.length, duplicates };
  }

  /** frame 一覧 (text と raw hash を区別した表示素材)。 */
  listWsFrames(): readonly { frameId: string; direction: 'sent' | 'received'; text: string; rawHash: string }[] {
    return this.wsFrames.map((frame) => ({ frameId: frame.frameId, direction: frame.direction, text: wsEvidence(frame).text, rawHash: wsEvidence(frame).rawHash.slice(0, 12) }));
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
  ): Promise<{ planHash: string; sent: number; rejected: 'size' | 'rate' | null; sessionCookieNames?: readonly string[]; negotiatedSubprotocol?: string }> {
    this.requirePermission(operator, 'run.manage');
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
    if (this.deps.webSocketTransport !== undefined) {
      if (input.messages.some((message) => Buffer.byteLength(message, 'utf8') > 1_000_000)) {
        this.record({ type: 'WsMessagesSent', at: this.deps.clock.now().toISOString(), targetUrl: canonical, sent: 0, rejected: 'size' });
        return { planHash: plan.planHash, sent: 0, rejected: 'size' };
      }
      const recordFrame = (direction: 'sent' | 'received', payload: string): void => {
        const frame: WsFrame = { frameId: this.deps.ids.next('ws'), direction, payload, receivedAtMs: this.deps.clock.now().getTime() };
        this.wsFrames.push(frame);
        this.wsSeenFingerprints.add(`${frame.direction}:${frame.payload}`);
      };
      const transported = await this.deps.webSocketTransport.exchange({
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
      this.record({ type: 'WsMessagesSent', at: this.deps.clock.now().toISOString(), targetUrl: canonical, sent: transported.sent });
      return {
        planHash: plan.planHash,
        sent: transported.sent,
        rejected: null,
        ...(transported.negotiatedSubprotocol === undefined ? {} : { negotiatedSubprotocol: transported.negotiatedSubprotocol }),
        ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
      };
    }
    let virtualMs = 0;
    const result = await sendWithPolicy(
      input.messages,
      { maxMessageBytes: 1_000_000, messagesPerSecond: 10, now: () => (virtualMs += 1000) },
      {
        send: async (message) => {
          const frame: WsFrame = { frameId: this.deps.ids.next('ws'), direction: 'sent', payload: message, receivedAtMs: this.deps.clock.now().getTime() };
          this.wsFrames.push(frame);
          this.wsSeenFingerprints.add(`${frame.direction}:${frame.payload}`);
        },
      },
    );
    this.record({
      type: 'WsMessagesSent',
      at: this.deps.clock.now().toISOString(),
      targetUrl: canonical,
      sent: result.sent,
      ...(result.rejected === null ? {} : { rejected: result.rejected }),
    });
    return {
      planHash: plan.planHash,
      sent: result.sent,
      rejected: result.rejected,
      ...(appliedCookies === undefined ? {} : { sessionCookieNames: appliedCookies.map((cookie) => cookie.name) }),
    };
  }

  /**
   * transport の選択 (design/f15)。HTTP/3 は能力表で Unsupported。peer が h2 を
   * offer しない場合、fallback 未許可なら CapabilityUnavailable (F15-UT-004)。
   * 実 port 構成時は bounded request probe を行い、未構成時は URL に h1-only を含む
   * fixture peer だけが h2 を offer しない。結果は ALPN/runtime を保持する (F15-UT-007)。
   */
  async negotiateTransportFor(operator: OperatorProfile, input: { readonly targetUrl: string; readonly allowFallback: boolean; readonly requested?: 'h2' | 'http/1.1' | 'h3' }): Promise<{ protocol: 'h2' | 'http/1.1'; downgraded: boolean; alpn: string; runtime: string; response?: import('../ports/engines.ts').TransportProbeResponseEvidence }> {
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
  ): Promise<{ sent: boolean; reason?: string; attempt?: SendAttemptRecord; response?: ReturnType<typeof summarizeResponse>; sessionCookieNames?: readonly string[] }> {
    this.requirePermission(operator, 'run.manage');
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
        if (this.deps.repeaterTransport === undefined) {
          // fixture adapter: 対象 URL から決定的な text 応答を返す。実 transport 未構成時の経路。
          this.repeaterSentCommands.push(command);
          this.recordObservedExchange({ url: draft.targetUrl, method: 'GET', status: 200, contentType: 'text/html' }, this.deps.clock.now().toISOString(), 'repeater');
          return;
        }
        transportResponse = await this.deps.repeaterTransport.send({
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
      return { sent: false, reason: 'confirmed plan hash does not match the current draft (revision が進んでいないか確認してください)' };
    }
    // 実 transport の redirect は domain と同じ規則で評価する (scope 外 Location は
    // hop 前に停止 — F04-UT-004)。停止した場合は応答を返さない。
    if (transportResponse !== undefined && transportResponse.redirectLocations.length > 0) {
      const redirects = runRedirects(
        transportResponse.redirectLocations.map((location) => ({ location })),
        this.currentCase().scope,
      );
      if (redirects.outcome !== 'completed') {
        return { sent: false, reason: `redirect stopped: ${redirects.outcome}${redirects.lastReason === undefined ? '' : ` (${redirects.lastReason})`}` };
      }
    }
    const body = transportResponse?.body ?? Buffer.from(`<html><body>fixture response for ${new URL(draft.targetUrl).pathname}</body></html>`, 'utf8');
    const attempt = recordSendAttempt(draft.draftId, body);
    this.repeaterAttempts.push(attempt);
    const summaryInput = transportResponse === undefined
      ? { status: 200, headers: [['content-type', 'text/html']] as readonly (readonly [string, string])[], body }
      : { status: transportResponse.status, headers: transportResponse.headers, body };
    return {
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
    input: { readonly findingId: string; readonly next: 'confirmed' | 'rejected' },
  ): Finding {
    this.requirePermission(operator, 'finding.confirm');
    const at = this.deps.clock.now().toISOString();
    const before = this.importer.list().find((finding) => finding.findingId === input.findingId);
    if (before === undefined) {
      throw domainError('ValidationFailed', `finding ${input.findingId} does not exist`);
    }
    const updated = this.importer.updateStatus(input.findingId, input.next, { now: at, changedBy: operator.operatorId });
    this.record({ type: 'FindingStatusChanged', at, findingId: input.findingId, from: before.status, to: input.next, changedBy: operator.operatorId });
    return updated;
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
  ): { plan: ExecutionPlan; planHash: string } {
    this.requirePermission(operator, 'run.manage');
    const caseRecord = this.currentCase();
    const authorization = this.currentAuthorization();
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
    const inputEvidenceHash = hashStable('scopepilot2.plan.input', merged.targets.map((url) => ScopePolicy.canonicalUrl(url)).sort());
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
          operationClass: 'Browse',
          targets: merged.targets,
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

  /** 能動診断計画。対象は採用済み候補の canonical URL の固定 snapshot。 */
  buildActiveScanPlan(
    operator: OperatorProfile,
    targets: readonly string[],
    limitsRequest?: { readonly maxRequests: number; readonly maxPages: number; readonly maxDurationMinutes: number },
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
    const inputEvidenceHash = hashStable('scopepilot2.plan.input', targets.map((url) => ScopePolicy.canonicalUrl(url)).sort());
    const plan = buildPlan({
      planId: this.deps.ids.next('plan'),
      caseId: caseRecord.caseId,
      authorizationId: authorization.authorizationId,
      operatorId: operator.operatorId,
      targetRole: authorization.targetRoles[0] ?? 'unauthenticated',
      steps: [
        {
          kind: 'active-scan',
          operationClass: 'ActiveScan',
          targets,
          engineKind: 'zap',
          guarantee: 'Delegated',
          engineVersion: this.deps.scanEngine.engineVersion,
          limits,
        },
      ],
      limits,
      runtimeBundleHash: this.deps.runtimeBundleHash,
      inputEvidenceHash,
      createdAt: this.deps.clock.now().toISOString(),
    });
    return { plan, planHash: planHashOf(plan) };
  }

  /** 計画の検証と認可結び付け。問題があれば最初の問題を domain error へ変換する。 */
  authorizePlan(plan: ExecutionPlan): { planHash: string } {
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
    const aggregate = this.currentAggregate();
    const confirmation: PlanConfirmation = {
      confirmationId: this.deps.ids.next('confirm'),
      planHash: planHashOf(plan),
      confirmedBy: operator.operatorId,
      confirmedAt: this.deps.clock.now().toISOString(),
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
    this.requireMatchingConfirmation(plan, confirmation);
    const caseRecord = this.currentCase();
    const step = plan.steps[0];
    if (step === undefined || step.kind !== 'explore') {
      throw domainError('ValidationFailed', 'plan does not contain an exploration step');
    }
    if (input.maxDepth < 1) {
      throw domainError('ValidationFailed', 'maxDepth must be at least 1');
    }
    // role 指定探索 (design/f09): runLogin 済み session のみ。cookie は探索の間だけ
    // explorer へ渡し、記録・応答へは出さない。
    let sessionCookies: readonly LoginSessionCookie[] | undefined;
    if (input.role !== undefined) {
      const session = this.roleSessionCookies.get(input.role);
      if (session === undefined) {
        throw domainError('ValidationFailed', `no session for role '${input.role}'; run login first`);
      }
      const sessionAware = this.deps.explorer as ExplorationPort & {
        observeWithSession?: (url: string, session: { cookies: readonly LoginSessionCookie[] }) => Promise<PageObservation | null>;
      };
      if (typeof sessionAware.observeWithSession !== 'function') {
        throw domainError('ValidationFailed', 'configured explorer does not support session observation');
      }
      sessionCookies = session.cookies;
    }

    const runId = this.deps.ids.next('run');
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

    let stopReason: StopReason = 'completed';
    let requests = 0;

    while (frontier.length > 0) {
      // 優先付け (AGENTS.md): 高優先 (pii・payment) の entry が残っていれば先に処理する。
      let nextIndex = frontier.findIndex((candidate) => candidate.priority === 'high');
      if (nextIndex === -1) {
        nextIndex = 0;
      }
      const entry = frontier.splice(nextIndex, 1)[0];
      if (entry === undefined) {
        break;
      }
      const canonical = ScopePolicy.canonicalUrl(entry.url);
      if (visited.has(canonical)) {
        continue;
      }
      visited.add(canonical);

      const decision = ScopePolicy.decide(caseRecord.scope, canonical);
      if (!decision.allowed) {
        deniedUrls.push({ url: canonical, reason: decision.reason });
        this.record({ type: 'EgressDenied', at: this.deps.clock.now().toISOString(), url: canonical, reason: decision.reason });
        continue;
      }
      if (requests >= step.limits.maxRequests || observations.length >= step.limits.maxPages) {
        stopReason = 'budget-exhausted';
        break;
      }

      requests += 1;
      const observed =
        sessionCookies === undefined
          ? await this.deps.explorer.observe(canonical)
          : await (this.deps.explorer as ExplorationPort & {
              observeWithSession: (url: string, session: { cookies: readonly LoginSessionCookie[] }) => Promise<PageObservation | null>;
            }).observeWithSession(canonical, { cookies: sessionCookies });
      if (observed === null) {
        continue;
      }
      // 探索の追跡情報 (depth・発見元・由来) は core 側の値で上書きして記録する。
      const observation: PageObservation = { ...observed, url: canonical, depth: entry.depth, discoveredFrom: entry.discoveredFrom, originType: entry.origin };
      observations.push(observation);
      this.recordObservedExchange({ url: canonical, method: 'GET', status: observation.status, contentType: observation.contentType }, this.deps.clock.now().toISOString(), 'explore');

      if (entry.depth + 1 <= input.maxDepth) {
        for (const link of observation.links) {
          const linkCanonical = ScopePolicy.canonicalUrl(link);
          if (!visited.has(linkCanonical)) {
            frontier.push({ url: linkCanonical, depth: entry.depth + 1, discoveredFrom: canonical, origin: 'crawl', priority: this.isPrioritizedUrl(linkCanonical) ? 'high' : 'normal' });
          }
        }
      }
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
    const candidates = observations.flatMap((observation) => candidatesFromObservation(observation, this.deps.ids));
    return { runRecord, planHash, observations, deniedUrls, candidates, engineVersion: this.deps.explorer.engineVersion };
  }

  /** 候補の採用。基準シナリオでは提示された候補を全採用する。 */
  adoptCandidates(operator: OperatorProfile, candidates: readonly ScanCandidate[]): readonly ScanCandidate[] {
    this.requirePermission(operator, 'run.manage');
    if (candidates.length === 0) {
      throw domainError('ValidationFailed', 'no candidates to adopt');
    }
    this.record({
      type: 'CandidatesAdopted',
      at: this.deps.clock.now().toISOString(),
      adoptedCount: candidates.length,
    });
    return candidates;
  }

  /**
   * 能動診断の実行 (Delegated 経路)。確認 hash と能力表を検証してから engine へ入力を渡し、
   * 出力から挙動を推測して記録する。個々の送信は傍受・拒否しない。
   */
  async runActiveScan(
    operator: OperatorProfile,
    plan: ExecutionPlan,
    confirmation: PlanConfirmation,
    adopted: readonly ScanCandidate[],
    role?: string,
  ): Promise<ActiveScanRunResult> {
    this.requirePermission(operator, 'run.manage');
    this.requireMatchingConfirmation(plan, confirmation);
    const caseRecord = this.currentCase();
    const step = plan.steps[0];
    if (step === undefined || step.kind !== 'active-scan') {
      throw domainError('ValidationFailed', 'plan does not contain an active-scan step');
    }

    const snapshot = this.deps.capabilities.find((capability) => capability.engineKind === 'zap');
    if (snapshot === undefined || snapshot.engineVersion !== this.deps.scanEngine.engineVersion) {
      throw domainError('CapabilityUnavailable', 'no capability snapshot for the scan engine version');
    }
    if (snapshot.guaranteeLevels.preSendScopeEnforcement === 'Unsupported') {
      throw domainError('CapabilityUnavailable', 'scan engine cannot enforce or delegate scope');
    }

    // 実行対象は計画の target snapshot を正本とする。scope 外候補は snapshot から除外する (F11-UT-003)。
    const targets = step.targetSnapshot.filter((url) => ScopePolicy.decide(caseRecord.scope, url).allowed);
    const adoptedUrls = new Set(adopted.map((candidate) => ScopePolicy.canonicalUrl(candidate.url)));
    const uncovered = [...adoptedUrls].filter((url) => !targets.includes(url));
    if (uncovered.length > 0) {
      throw domainError('ValidationFailed', `plan target snapshot does not cover adopted candidates: ${uncovered.join(', ')}`);
    }

    // role session 適用 (design/08: F11)。対象 URL の host/path に一致する cookie 名を
    // scan request へ添える。実 ZAP は proxy 経由 login で jar を作るため値は渡さない。
    let sessionCookieNames: readonly string[] | undefined;
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
    }

    const runId = this.deps.ids.next('run');
    const planHash = planHashOf(plan);
    this.record({ type: 'RunStarted', at: this.deps.clock.now().toISOString(), runId, planHash });
    const machine = new RunStateMachine('Confirmed');
    machine.transition('Running');
    this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Running', attempt: 1 });

    // Delegated 経路は最大 overshoot 分を共有上限の内側に予約する。
    const reservedRequests = Math.ceil(step.limits.maxRequests * snapshot.maxOvershootRatio);
    const engineLease = step.limits.maxRequests - reservedRequests;
    const scanRequest: ActiveScanRequest = {
      runId,
      targets,
      attackStrength: 'Low',
      leasedLimits: { ...step.limits, maxRequests: engineLease },
      authorizationRef: `authorization:${this.currentAuthorization().authorizationId}`,
      ...(sessionCookieNames === undefined ? {} : { sessionCookieNames }),
    };

    const engineRunId = await this.deps.scanEngine.start(scanRequest);
    const monitor = new ScanMonitor(this.deps.scanEngine, engineRunId, MAX_POLL_ITERATIONS, 2_000, this.deps.scanAlertSettleMs ?? 0);
    const monitored = await monitor.collectUntilDone();
    const collectedAlerts = monitored.alerts;

    // engine 異常は「URL Does not Exist」等の観測理由とともに失敗として扱い、無制限に再試行しない。
    if (monitored.status === 'failed') {
      this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'engine-failure' });
      machine.transition('Failed');
      this.deps.runSink?.save({ runId, planId: plan.planId, caseId: caseRecord.caseId, state: 'Failed', attempt: 1, stopReason: 'engine-failure' });
      throw domainError('EngineFailure', monitored.failureReason ?? 'scan engine failed', {
        details: { engineRunId, engineVersion: this.deps.scanEngine.engineVersion },
      });
    }

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

    this.scannedUrlCount = targets.length;
    this.delegatedSteps = [
      { stepId: step.stepId, engineKind: 'zap', engineVersion: this.deps.scanEngine.engineVersion },
    ];
    const runRecord: RunRecord = {
      runId,
      planId: plan.planId,
      caseId: caseRecord.caseId,
      state: machine.transition('Completed'),
      attempt: 1,
      stopReason: 'completed',
    };
    this.deps.runSink?.save(runRecord);
    this.record({ type: 'RunCompleted', at: this.deps.clock.now().toISOString(), runId, stopReason: 'completed' });
    this.record({
      type: 'FindingsImported',
      at: this.deps.clock.now().toISOString(),
      source: 'zap-alert',
      engineVersion: this.deps.scanEngine.engineVersion,
      importedCount: importResult.created.length,
      duplicateCount: importResult.duplicateCount,
    });
    return {
      runRecord,
      planHash,
      scanRequest,
      findings: this.importer.list(),
      overshootReservation: reservedRequests,
      engineVersion: this.deps.scanEngine.engineVersion,
    };
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
    input: { readonly guidelines: readonly string[] },
  ): ReportArtifact {
    this.requirePermission(operator, 'report.export');
    const caseRecord = this.currentCase();
    const model = buildReportModel({
      caseId: caseRecord.caseId,
      generatedAt: this.deps.clock.now().toISOString(),
      guidelines: input.guidelines,
      findings: this.importer.list(),
      coverage: {
        exploredUrlCount: this.exploredUrlCount,
        scannedUrlCount: this.scannedUrlCount,
        delegatedSteps: this.delegatedSteps,
        limitations: [
          '外部 engine (Delegated 経路) の個々の送信は送信前に拒否できない。入力 scope・停止・版ごとの実測で管理する。',
          'engine 由来の所見は実影響未確認であり、人の確認なしに確定扱いにしない。',
          '本報告は固定 fixture に基づく workflow 検証であり、実対象の診断結果ではない。',
        ],
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
    this.eventsLog.push(event);
  }
}

/**
 * 観測から診断候補を生成する seed。分類根拠の guideline 参照は
 * catalog (design/27) の実装まで仮ラベル (`provisional:*`) を使う。
 */
function candidatesFromObservation(observation: PageObservation, ids: IdGenerator): ScanCandidate[] {
  const candidates: ScanCandidate[] = [
    {
      candidateId: ids.next('cand'),
      url: observation.url,
      method: 'GET',
      category: 'page',
      guidelineBasis: ['provisional:page'],
      confidence: 0.7,
      observationUrl: observation.url,
    },
  ];
  for (const form of observation.forms) {
    candidates.push({
      candidateId: ids.next('cand'),
      url: ScopePolicy.canonicalUrl(form.actionUrl),
      method: form.method,
      category: 'form',
      guidelineBasis: [`provisional:form:${form.classification}`],
      confidence: 0.9,
      observationUrl: observation.url,
    });
  }
  return candidates;
}
