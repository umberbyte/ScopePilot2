import { type AuthorizationRecord, type CaseRecord, type EngineCapabilitySnapshot, type Finding, type PageObservation, type RunRecord, type ScanCandidate, type ScopeLimits, type ActiveScanRequest, type DiagnosticTrack } from '@scopepilot2/contracts';
import { type AlphabetClassCounts, type NumericDeltaSignCounts } from '../domain/sequencer.ts';
import { type WorkflowScanTransport } from '../domain/workflow-scan.ts';
import type { Clock, EvidenceStorePort, IdGenerator } from '../ports/infra.ts';
import type { ActiveScanEnginePort, ExplorationPort, InteractiveBrowserFile, InteractiveBrowserPort, InteractiveBrowserStep, LoginExecutorPort, NucleiScanPort } from '../ports/engines.ts';
export interface BaselineFlowDeps {
    readonly runtimeProfile?: import('./services/runtime-profile.ts').RuntimeProfile;
    readonly adapterKinds?: Readonly<Partial<Record<'repeaterTransport' | 'fuzzTransport' | 'sequencerTransport' | 'oastProvider' | 'webSocketTransport', import('./services/runtime-profile.ts').AdapterKind>>>;
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
        readonly sessionCookies?: readonly {
            readonly name: string;
            readonly value: string;
        }[];
        readonly sessionHeaders?: readonly {
            readonly name: 'Authorization';
            readonly value: string;
        }[];
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
    readonly caseSink?: {
        save(record: CaseRecord): void;
    };
    /** 認可記録の永続化 (任意)。案件再オープン時に最新の認可を復元する。 */
    readonly authorizationSink?: {
        save(record: AuthorizationRecord): void;
    };
    readonly findingSink?: import('../ports/infra.ts').FindingSinkPort;
    readonly initialFindings?: readonly Finding[];
    /** 実 engine 診断の完了後、alert 生成の遅れを待つ時間 (ms)。fixture では 0。 */
    readonly scanAlertSettleMs?: number;
    /** Repeater の実 transport (design/f04)。未構成なら CapabilityUnavailable。fixture は test/simulation で明示注入する。 */
    readonly repeaterTransport?: import('../ports/engines.ts').RepeaterTransportPort;
    /** Fuzz の実 transport (design/f05)。未構成なら CapabilityUnavailable。fixture は test/simulation で明示注入する。 */
    readonly fuzzTransport?: import('../ports/engines.ts').FuzzTransportPort;
    /** Sequencer の実収集 transport (design/f07)。未構成なら CapabilityUnavailable。fixture は test/simulation で明示注入する。 */
    readonly sequencerTransport?: import('../ports/engines.ts').SequencerTransportPort;
    /** OAST の実 provider session (design/f13)。未構成なら CapabilityUnavailable。 */
    readonly oastProvider?: import('../ports/engines.ts').OastProviderPort;
    /** WebSocket の実 text transport (design/f14)。未構成なら CapabilityUnavailable。 */
    readonly webSocketTransport?: import('../ports/engines.ts').WebSocketTransportPort;
    /** HTTP/2 negotiation/request probe (design/f15). Omitted for deterministic fixtures. */
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
    readonly evidence: {
        readonly label: string;
        readonly content: string;
        readonly metadata?: Readonly<Record<string, string>>;
    };
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
    readonly deniedUrls: readonly {
        readonly url: string;
        readonly reason: string;
    }[];
    readonly candidates: readonly ScanCandidate[];
    readonly engineVersion: string;
}
export type InteractiveDiagnosticTrack = 'workflow-state' | 'session-analysis' | 'authorization-differential' | 'upload-workflow' | 'api-schema' | 'cryptography-review';
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
    readonly apiDocuments: readonly {
        readonly inputRef: string;
        readonly name: string;
        readonly document: unknown;
    }[];
}
export interface InteractiveDiagnosticItemResult {
    readonly itemId: string;
    readonly track: InteractiveDiagnosticTrack;
    readonly targetUrl: string;
    readonly status: 'completed' | 'passed' | 'failed' | 'inconclusive';
    readonly detail: string;
    readonly evidenceId?: string;
}
export type SequencerTokenSource = 'body' | 'cookie' | 'hidden' | 'bearer' | 'custom';
export type SequencerSessionRecord = {
    sessionId: string;
    targetUrl: string;
    tokenSource: SequencerTokenSource;
    tokenCookieName?: string;
    tokenFieldName?: string;
    tokenStartDelimiter?: string;
    tokenEndDelimiter?: string;
    requestMethod: string;
    requestHeaderNames: readonly string[];
    requestBodyBytes: number;
    verdict: 'assessed' | 'insufficient';
    sampleCount: number;
    duplicates: number;
    missing: number;
    shannonEntropyBitsPerByte?: number;
    shannonEntropyBitsPerToken?: number;
    distinctByteValues?: number;
    byteFrequencyBuckets?: readonly number[];
    tokenLengthBucketMinimums?: readonly number[];
    tokenByteLengthBuckets?: readonly number[];
    tokenCharacterLengthBuckets?: readonly number[];
    tokenMaximumCharacterRunLengthBuckets?: readonly number[];
    adjacentTokenBitHammingDistanceBuckets?: readonly number[];
    adjacentTokenHammingUnequalByteLengthPairs?: number;
    adjacentNumericAbsoluteDeltaBuckets?: readonly number[];
    adjacentNumericDeltaSignCounts?: NumericDeltaSignCounts;
    adjacentNumericIneligiblePairs?: number;
    adjacentNumericSerialCorrelationPairs?: number;
    adjacentNumericSerialCorrelation?: number;
    observedAlphabetSize?: number;
    alphabetClassCounts?: AlphabetClassCounts;
    positionAnalysisLimit?: number;
    positionAlphabetClassCounts?: readonly AlphabetClassCounts[];
    positionOverflowSamples?: number;
    minimum?: number;
    sessionCookieNames?: readonly string[];
    executedAt: string;
};
export type SequencerSessionResult = Omit<SequencerSessionRecord, 'executedAt'>;
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
export interface GuidelineRouteResult {
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
