import { createFixtureToolAdapters } from '../../../../../tools/simulation/src/adapters/fixture-tools.ts';
/**
 * core 単体テスト用の最小 fake 群と flow の組み立て helper。
 * `docs/detailed-design/03-unit-test-strategy.md` 4章: 呼出し記録と明示した結果だけを提供する。
 */
import {
  BaselineFlowService,
  FixedClock,
  type StoredEvidence,
  InMemoryEvidenceStore,
  SequentialIdGenerator,
  type ActiveScanEnginePort,
  type ExplorationPort,
} from '@scopepilot2/core';
import type {
  EngineCapabilitySnapshot,
  OperatorPermission,
  OperatorProfile,
  PageObservation,
  OperationClass,
  PlanLimits,
  ScopeLimits,
} from '@scopepilot2/contracts';

export const TEST_OPERATOR: OperatorProfile = {
  operatorId: 'operator-test',
  displayName: 'Test Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

export const TEST_NOW = '2026-10-18T09:00:00.000Z';

/** 任意 URL に 1 リンク (子パス) を返す合成観測。budget 停止の試験に使う。 */
function synthesizeObservation(url: string): PageObservation {
  return {
    url,
    status: 200,
    contentType: 'text/html',
    discoveredFrom: null,
    depth: 0,
    originType: 'crawl',
    links: [new URL('child/', url).toString()],
    forms: [],
  };
}

export class FakeExplorer implements ExplorationPort {
  readonly engineVersion = 'fake-explorer-1';
  private readonly observeCalls: string[] = [];

  async observe(url: string): Promise<PageObservation | null> {
    this.observeCalls.push(url);
    return synthesizeObservation(url);
  }

  calls(): readonly string[] {
    return [...this.observeCalls];
  }
}

export class FakeScanEngine implements ActiveScanEnginePort {
  readonly engineVersion = 'fake-zap-1';
  readonly startCalls: ActiveScanEngineStartCall[] = [];
  stopCalls = 0;
  private sequence = 0;

  async start(request: Parameters<ActiveScanEnginePort['start']>[0], context?: Parameters<ActiveScanEnginePort['start']>[1]): Promise<string> {
    this.startCalls.push({
      targets: [...request.targets],
      leasedMaxRequests: request.leasedLimits.maxRequests,
      sessionCookies: context?.sessionCookies ?? [],
      sessionHeaders: context?.sessionHeaders ?? [],
      requestSeeds: context?.requestSeeds ?? [],
      ...(context?.authenticationProbe === undefined ? {} : { authenticationProbe: context.authenticationProbe }),
    });
    this.sequence += 1;
    return `fake-run-${this.sequence}`;
  }

  async progress(): Promise<{ status: 'complete'; progress: 100; lastActivityAt: ''; messageCount: 1 }> {
    return { status: 'complete', progress: 100, lastActivityAt: '', messageCount: 1 };
  }

  async alerts(_engineRunId: string, cursor: number): Promise<{ alerts: []; nextCursor: number }> {
    return { alerts: [], nextCursor: cursor };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

/** alert 原本の保存だけに失敗する証拠 store (SYS-UT-005)。認可証跡の保存は成功する。 */
export class FailingAlertEvidenceStore extends InMemoryEvidenceStore {
  override async saveText(
    label: string,
    content: string,
    metadata?: Readonly<Record<string, string>>,
  ): Promise<StoredEvidence> {
    if (label.startsWith('zap-alerts-raw:')) {
      throw new Error('evidence storage failure (test)');
    }
    return super.saveText(label, content, metadata);
  }
}

export interface ActiveScanEngineStartCall {
  readonly targets: readonly string[];
  readonly leasedMaxRequests: number;
  readonly sessionCookies: readonly import('../../../src/ports/engines.ts').LoginSessionCookie[];
  readonly sessionHeaders: readonly import('../../../src/ports/engines.ts').BrowserSessionHeader[];
  readonly requestSeeds: readonly {
    readonly url: string;
    readonly method: string;
    readonly contentType?: string;
    readonly inputPoints: readonly import('@scopepilot2/contracts').RequestInputPoint[];
  }[];
  readonly authenticationProbe?: {
    readonly url: string;
    readonly markers: readonly string[];
  };
}

function testCapabilities(zapVersion = 'fake-zap-1', nucleiVersion?: string): readonly EngineCapabilitySnapshot[] {
  const enforced = {
    preSendScopeEnforcement: 'Enforced',
    stopControl: 'Enforced',
    budgetLease: 'Enforced',
    rateLimit: 'Enforced',
  } as const;
  const delegated = {
    preSendScopeEnforcement: 'Delegated',
    stopControl: 'Delegated',
    budgetLease: 'Delegated',
    rateLimit: 'Delegated',
  } as const;
  return [
    { engineKind: 'node-http', engineVersion: 'scopepilot-workflow-transport-v1', source: 'fixture', guaranteeLevels: enforced, maxOvershootRatio: 0, measuredAt: TEST_NOW },
    { engineKind: 'playwright', engineVersion: 'fake-explorer-1', source: 'fixture', guaranteeLevels: enforced, maxOvershootRatio: 0, measuredAt: TEST_NOW },
    { engineKind: 'zap', engineVersion: zapVersion, source: 'fixture', guaranteeLevels: delegated, maxOvershootRatio: 0.05, measuredAt: TEST_NOW },
    ...(nucleiVersion === undefined ? [] : [{ engineKind: 'nuclei' as const, engineVersion: nucleiVersion, source: 'fixture' as const, guaranteeLevels: delegated, maxOvershootRatio: 0.05, measuredAt: TEST_NOW }]),
  ];
}

export interface BootstrapOptions {
  readonly allowedOrigins?: readonly string[];
  readonly caseLimits?: ScopeLimits;
  readonly allowedOperationClasses?: readonly OperationClass[];
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly operatorPermissions?: readonly OperatorPermission[];
  readonly evidenceFailure?: boolean;
  readonly zapCapabilityVersion?: string;
  /** login 実行器 (design/f09 の runLogin 検証用 fake を渡す)。 */
  readonly loginExecutor?: import('../../../src/ports/engines.ts').LoginExecutorPort;
  /** 許可済み fixture の OTP inbox (テーマ6 OTP sub-check 検証用 fake)。 */
  readonly otpInbox?: import('../../../src/ports/engines.ts').OtpInboxPort;
  /** 隔離試験 IdP/SP の SAML fixture (テーマ6 sub-check 検証用 fake)。 */
  readonly samlFixture?: import('../../../src/ports/engines.ts').SamlFixturePort;
  /** 実待機の差替え (期限切れ確認を即時解決にする等)。 */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly loginProxyServer?: string;
  /** explorer 差替え (session 対応 explorer の検証用)。 */
  readonly explorer?: import('../../../src/ports/engines.ts').ExplorationPort;
  /** 診断 engine 差替え (alert を返す fake 等)。未指定は FakeScanEngine。 */
  readonly scanEngine?: ActiveScanEnginePort;
  /** Repeater 実 transport 経路の検証用 fake。 */
  readonly repeaterTransport?: import('../../../src/ports/engines.ts').RepeaterTransportPort;
  /** Fuzzer 実 transport 経路の検証用 fake。 */
  readonly fuzzTransport?: import('../../../src/ports/engines.ts').FuzzTransportPort;
  /** Sequencer 実 transport 経路の検証用 fake。 */
  readonly sequencerTransport?: import('../../../src/ports/engines.ts').SequencerTransportPort;
  /** OAST 実 provider 経路の検証用 fake。 */
  readonly oastProvider?: import('../../../src/ports/engines.ts').OastProviderPort;
  /** WebSocket 実 transport 経路の検証用 fake。 */
  readonly webSocketTransport?: import('../../../src/ports/engines.ts').WebSocketTransportPort;
  readonly advancedTransport?: import('../../../src/ports/engines.ts').AdvancedTransportPort;
  readonly domObserver?: import('../../../src/ports/engines.ts').DomObservationPort;
  readonly interactiveBrowser?: import('../../../src/ports/engines.ts').InteractiveBrowserPort;
  readonly nucleiRunner?: import('../../../src/ports/engines.ts').NucleiScanPort;
  readonly workflowScanTransportFactory?: import('../../../src/application/baseline-flow.ts').BaselineFlowDeps['workflowScanTransportFactory'];
}

export interface TestFlow {
  readonly service: BaselineFlowService;
  readonly explorer: FakeExplorer;
  readonly scanEngine: FakeScanEngine;
  readonly operator: OperatorProfile;
}

/** 案件作成前の状態から使える service を組み立てる。 */
export function createTestService(
  options: Pick<BootstrapOptions, 'operatorPermissions' | 'evidenceFailure' | 'zapCapabilityVersion' | 'loginExecutor' | 'loginProxyServer' | 'explorer' | 'scanEngine' | 'repeaterTransport' | 'fuzzTransport' | 'sequencerTransport' | 'oastProvider' | 'webSocketTransport' | 'advancedTransport' | 'domObserver' | 'interactiveBrowser' | 'nucleiRunner' | 'workflowScanTransportFactory' | 'otpInbox' | 'samlFixture' | 'sleep'> & {
    runSink?: import('../../../src/ports/infra.ts').RunSinkPort;
    caseSink?: { save(record: import('@scopepilot2/contracts').CaseRecord): void };
  } = {},
): TestFlow {
  const explorer = options.explorer ?? new FakeExplorer();
  const scanEngine = options.scanEngine ?? new FakeScanEngine();
  const service = new BaselineFlowService({
    runtimeProfile: 'test',
    ...createFixtureToolAdapters(),
    clock: new FixedClock([TEST_NOW]),
    ids: new SequentialIdGenerator(),
    evidence: options.evidenceFailure === true ? new FailingAlertEvidenceStore() : new InMemoryEvidenceStore(),
    explorer,
    scanEngine,
    capabilities: testCapabilities(options.zapCapabilityVersion, options.nucleiRunner?.engineVersion),
    runtimeBundleHash: 'test-runtime-bundle',
    ...(options.loginExecutor === undefined ? {} : { loginExecutor: options.loginExecutor }),
    ...(options.loginProxyServer === undefined ? {} : { loginProxyServer: options.loginProxyServer }),
    ...(options.otpInbox === undefined ? {} : { otpInbox: options.otpInbox }),
    ...(options.samlFixture === undefined ? {} : { samlFixture: options.samlFixture }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.repeaterTransport === undefined ? {} : { repeaterTransport: options.repeaterTransport }),
    ...(options.fuzzTransport === undefined ? {} : { fuzzTransport: options.fuzzTransport }),
    ...(options.sequencerTransport === undefined ? {} : { sequencerTransport: options.sequencerTransport }),
    ...(options.oastProvider === undefined ? {} : { oastProvider: options.oastProvider }),
    ...(options.webSocketTransport === undefined ? {} : { webSocketTransport: options.webSocketTransport }),
    ...(options.advancedTransport === undefined ? {} : { advancedTransport: options.advancedTransport }),
    ...(options.domObserver === undefined ? {} : { domObserver: options.domObserver }),
    ...(options.interactiveBrowser === undefined ? {} : { interactiveBrowser: options.interactiveBrowser }),
    ...(options.nucleiRunner === undefined ? {} : { nucleiRunner: options.nucleiRunner }),
    ...(options.workflowScanTransportFactory === undefined ? {} : { workflowScanTransportFactory: options.workflowScanTransportFactory }),
    ...(options.runSink === undefined ? {} : { runSink: options.runSink }),
    ...(options.caseSink === undefined ? {} : { caseSink: options.caseSink }),
  });
  const operator: OperatorProfile = {
    ...TEST_OPERATOR,
    ...(options.operatorPermissions === undefined ? {} : { permissions: options.operatorPermissions }),
  };
  // options.explorer 差替え時は FakeExplorer ではないため cast (TestFlow 型は既定構成の便宜)。
  return { service, explorer: explorer as FakeExplorer, scanEngine: scanEngine as FakeScanEngine, operator };
}

/** 案件作成と認可付与まで済ませた flow を組み立てる。 */
export async function bootstrapFlow(options: BootstrapOptions = {}): Promise<TestFlow> {
  const flow = createTestService(options);
  const { service, operator } = flow;
  service.createCase(operator, {
    name: 'unit test case',
    allowedOrigins: options.allowedOrigins ?? ['http://fixture.target.test'],
    deniedOrigins: [],
    limits: options.caseLimits ?? { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
  });
  await service.grantAuthorization(operator, {
    allowedOperationClasses: options.allowedOperationClasses ?? ['Browse', 'ActiveScan'],
    targetRoles: ['unauthenticated'],
    validFrom: options.validFrom ?? '2026-10-18T00:00:00.000Z',
    validUntil: options.validUntil ?? '2026-10-19T00:00:00.000Z',
    evidence: { label: '認可(unit test)', content: 'unit test authorization evidence' },
  });
  return flow;
}

export const DEFAULT_PLAN_LIMITS_FOR_TEST: PlanLimits = {
  maxRequests: 2000,
  maxPages: 500,
  maxDurationMinutes: 30,
  maxConcurrency: 2,
  requestsPerSecond: 2,
};
