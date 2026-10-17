/**
 * core 単体テスト用の最小 fake 群と flow の組み立て helper。
 * `docs/detailed-design/03-unit-test-strategy.md` 4章: 呼出し記録と明示した結果だけを提供する。
 */
import {
  BaselineFlowService,
  FixedClock,
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
  private sequence = 0;

  async start(request: Parameters<ActiveScanEnginePort['start']>[0]): Promise<string> {
    this.startCalls.push({ targets: [...request.targets], leasedMaxRequests: request.leasedLimits.maxRequests });
    this.sequence += 1;
    return `fake-run-${this.sequence}`;
  }

  async progress(): Promise<{ status: 'complete'; progress: 100; lastActivityAt: ''; messageCount: 1 }> {
    return { status: 'complete', progress: 100, lastActivityAt: '', messageCount: 1 };
  }

  async alerts(_engineRunId: string, cursor: number): Promise<{ alerts: []; nextCursor: number }> {
    return { alerts: [], nextCursor: cursor };
  }

  async stop(): Promise<void> {}
}

export interface ActiveScanEngineStartCall {
  readonly targets: readonly string[];
  readonly leasedMaxRequests: number;
}

function testCapabilities(): readonly EngineCapabilitySnapshot[] {
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
    { engineKind: 'playwright', engineVersion: 'fake-explorer-1', source: 'fixture', guaranteeLevels: enforced, maxOvershootRatio: 0, measuredAt: TEST_NOW },
    { engineKind: 'zap', engineVersion: 'fake-zap-1', source: 'fixture', guaranteeLevels: delegated, maxOvershootRatio: 0.05, measuredAt: TEST_NOW },
  ];
}

export interface BootstrapOptions {
  readonly allowedOrigins?: readonly string[];
  readonly caseLimits?: ScopeLimits;
  readonly allowedOperationClasses?: readonly OperationClass[];
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly operatorPermissions?: readonly OperatorPermission[];
}

export interface TestFlow {
  readonly service: BaselineFlowService;
  readonly explorer: FakeExplorer;
  readonly scanEngine: FakeScanEngine;
  readonly operator: OperatorProfile;
}

/** 案件作成前の状態から使える service を組み立てる。 */
export function createTestService(options: Pick<BootstrapOptions, 'operatorPermissions'> = {}): TestFlow {
  const explorer = new FakeExplorer();
  const scanEngine = new FakeScanEngine();
  const service = new BaselineFlowService({
    clock: new FixedClock([TEST_NOW]),
    ids: new SequentialIdGenerator(),
    evidence: new InMemoryEvidenceStore(),
    explorer,
    scanEngine,
    capabilities: testCapabilities(),
    runtimeBundleHash: 'test-runtime-bundle',
  });
  const operator: OperatorProfile = {
    ...TEST_OPERATOR,
    ...(options.operatorPermissions === undefined ? {} : { permissions: options.operatorPermissions }),
  };
  return { service, explorer, scanEngine, operator };
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
