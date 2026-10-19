/**
 * simulation harness の組み立て。固定 clock・連番 ID・in-memory 証拠保存と
 * fixture adapter を配線し、決定的に基準シナリオを実行できる環境を作る。
 * `docs/detailed-design/f21-cli-automation.md` 3章 (SimulationHarness)。
 */
import { BaselineFlowService } from '@scopepilot2/core';
import { FixedClock, InMemoryEvidenceStore, SequentialIdGenerator } from '@scopepilot2/core';
import type { EngineCapabilitySnapshot, OperatorProfile } from '@scopepilot2/contracts';
import { FixtureExplorer } from './adapters/fixture-explorer.ts';
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
  readonly explorer: FixtureExplorer;
  readonly scanEngine: FixtureZapEngine;
  readonly capabilities: readonly EngineCapabilitySnapshot[];
  readonly runtimeBundleHash: string;
}

/** 案件・run 記録の保存先 (design/20 §2・design/22 §6)。指定しない場合は保存しない。 */
export interface HarnessOptions {
  readonly runSink?: { save(record: import('@scopepilot2/contracts').RunRecord): void };
  readonly caseSink?: { save(record: import('@scopepilot2/contracts').CaseRecord): void };
}

export function createHarness(options: HarnessOptions = {}): SimulationHarness {
  const explorer = new FixtureExplorer();
  const scanEngine = new FixtureZapEngine();
  const capabilities = fixtureCapabilitySnapshots();
  const service = new BaselineFlowService({
    clock: new FixedClock(FIXTURE_CLOCK_TIMES),
    ids: new SequentialIdGenerator(),
    evidence: new InMemoryEvidenceStore(),
    explorer,
    scanEngine,
    capabilities,
    runtimeBundleHash: FIXTURE_RUNTIME_BUNDLE_HASH,
    ...(options.runSink === undefined ? {} : { runSink: options.runSink }),
    ...(options.caseSink === undefined ? {} : { caseSink: options.caseSink }),
  });
  return { service, explorer, scanEngine, capabilities, runtimeBundleHash: FIXTURE_RUNTIME_BUNDLE_HASH };
}
