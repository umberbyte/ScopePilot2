/**
 * simulation harness の組み立て。固定 clock・連番 ID・in-memory 証拠保存と
 * fixture adapter を配線し、決定的に基準シナリオを実行できる環境を作る。
 * `docs/detailed-design/f21-cli-automation.md` 3章 (SimulationHarness)。
 *
 * engines option で実 engine (adapters の composeEngines 由来) を差し込める。
 * 実 engine 時は SystemClock と実測能力表を渡すこと (呼出側の責務)。
 */
import { BaselineFlowService } from '@scopepilot2/core';
import { FixedClock, InMemoryEvidenceStore, SequentialIdGenerator } from '@scopepilot2/core';
import type { ActiveScanEnginePort, Clock, ExplorationPort, LoginExecutorPort } from '@scopepilot2/core';
import type { EngineCapabilitySnapshot, OperatorProfile } from '@scopepilot2/contracts';
import { FixtureExplorer } from './adapters/fixture-explorer.ts';
import { FixtureLoginExecutor } from './adapters/fixture-login.ts';
import { FixtureZapEngine } from './adapters/fixture-zap.ts';
import { fixtureCapabilitySnapshots, FIXTURE_RUNTIME_BUNDLE_HASH } from './fixtures/capability-snapshots.ts';

/** 固定時刻。案件作成から報告までの各記録がこの範囲に収まる。 */
export const FIXTURE_CLOCK_TIMES: readonly string[] = [
  '2026-10-18T09:00:00.000Z',
  '2026-10-18T09:01:00.000Z',
  '2026-10-18T09:02:00.000Z',
  '2026-10-18T09:03:00.000Z',
  '2026-10-18T09:04:00.000Z',
  '2026-10-18T09:05:00.000Z',
  '2026-10-18T09:06:00.000Z',
];

/** 認可の有効期間 (固定時刻を挟む)。 */
export const FIXTURE_AUTHORIZATION_PERIOD: { validFrom: string; validUntil: string } = {
  validFrom: '2026-10-18T00:00:00.000Z',
  validUntil: '2026-10-19T00:00:00.000Z',
};

export const FIXTURE_OPERATOR: OperatorProfile = {
  operatorId: 'operator-fixture',
  displayName: 'Fixture Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

export interface SimulationHarness {
  readonly service: BaselineFlowService;
  readonly explorer: ExplorationPort;
  readonly scanEngine: ActiveScanEnginePort;
  readonly capabilities: readonly EngineCapabilitySnapshot[];
  readonly runtimeBundleHash: string;
}

/** 案件・run 記録の保存先 (design/20 §2・design/22 §6)。指定しない場合は保存しない。 */
export interface HarnessOptions {
  readonly runSink?: { save(record: import('@scopepilot2/contracts').RunRecord): void };
  readonly caseSink?: { save(record: import('@scopepilot2/contracts').CaseRecord): void };
  /** 実 engine 差し込み (adapters の composeEngines 由来)。既定は fixture 構成。 */
  readonly engines?: {
    readonly explorer: ExplorationPort;
    readonly scanEngine: ActiveScanEnginePort;
    readonly capabilities: readonly EngineCapabilitySnapshot[];
    readonly clock?: Clock;
    readonly runtimeBundleHash?: string;
    readonly loginExecutor?: LoginExecutorPort;
    readonly repeaterTransport?: import('@scopepilot2/core').RepeaterTransportPort;
    readonly fuzzTransport?: import('@scopepilot2/core').FuzzTransportPort;
    readonly sequencerTransport?: import('@scopepilot2/core').SequencerTransportPort;
    readonly oastProvider?: import('@scopepilot2/core').OastProviderPort;
    readonly webSocketTransport?: import('@scopepilot2/core').WebSocketTransportPort;
  };
}

export function createHarness(options: HarnessOptions = {}): SimulationHarness {
  const explorer: ExplorationPort = options.engines?.explorer ?? new FixtureExplorer();
  const scanEngine: ActiveScanEnginePort = options.engines?.scanEngine ?? new FixtureZapEngine();
  const capabilities = options.engines?.capabilities ?? fixtureCapabilitySnapshots();
  const runtimeBundleHash = options.engines?.runtimeBundleHash ?? FIXTURE_RUNTIME_BUNDLE_HASH;
  // login 実行器は既定も fixture (認証付き workflow を fixture 構成で回帰できる)。
  const loginExecutor: LoginExecutorPort = options.engines?.loginExecutor ?? new FixtureLoginExecutor();
  const service = new BaselineFlowService({
    // 実 engine 時は実時間 (認可の有効期間・監査記録)。既定は決定的な固定 clock。
    clock: options.engines?.clock ?? new FixedClock(FIXTURE_CLOCK_TIMES),
    ids: new SequentialIdGenerator(),
    evidence: new InMemoryEvidenceStore(),
    explorer,
    scanEngine,
    capabilities,
    runtimeBundleHash,
    loginExecutor,
    ...(options.engines?.repeaterTransport === undefined ? {} : { repeaterTransport: options.engines.repeaterTransport }),
    ...(options.engines?.fuzzTransport === undefined ? {} : { fuzzTransport: options.engines.fuzzTransport }),
    ...(options.engines?.sequencerTransport === undefined ? {} : { sequencerTransport: options.engines.sequencerTransport }),
    ...(options.engines?.oastProvider === undefined ? {} : { oastProvider: options.engines.oastProvider }),
    ...(options.engines?.webSocketTransport === undefined ? {} : { webSocketTransport: options.engines.webSocketTransport }),
    ...(options.runSink === undefined ? {} : { runSink: options.runSink }),
    ...(options.caseSink === undefined ? {} : { caseSink: options.caseSink }),
  });
  return { service, explorer, scanEngine, capabilities, runtimeBundleHash };
}
