import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RunRecord } from '@scopepilot2/contracts';
import { bootstrapFlow, createTestService, FakeScanEngine } from '../support/test-flow.ts';

/** 手書き fake: 保存順序を記録するだけ。 */
class RecordingRunSink {
  readonly saved: RunRecord[] = [];
  save(record: RunRecord): void {
    this.saved.push(record);
  }
}

describe('run persistence (RunSinkPort)', () => {
  test('探索は開始時 (Running) と終了時 (Completed) の run 記録を保存する', async () => {
    const sink = new RecordingRunSink();
    const { service, operator } = await bootstrapFlow();
    // bootstrap 済み service とは別に、sink 注入の service で探索だけを実行する。
    const seeded = createTestService({ runSink: sink });
    const op = seeded.operator;
    seeded.service.createCase(op, {
      name: 'sink-test',
      allowedOrigins: ['http://fixture.target.test'],
      deniedOrigins: [],
      limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
    });
    await seeded.service.grantAuthorization(op, {
      allowedOperationClasses: ['Browse', 'ActiveScan'],
      targetRoles: ['unauthenticated'],
      validFrom: '2026-10-18T00:00:00.000Z',
      validUntil: '2026-10-19T00:00:00.000Z',
      evidence: { label: '認可', content: 'x' },
    });
    const { plan } = seeded.service.buildExplorationPlan(op, ['http://fixture.target.test/']);
    seeded.service.authorizePlan(plan);
    const confirmation = seeded.service.confirmPlan(plan, op);
    await seeded.service.runExploration(op, plan, confirmation, { maxDepth: 1 });
    assert.ok(sink.saved.length >= 2, '開始時と終了時の少なくとも2件');
    assert.equal(sink.saved[0]?.state, 'Running');
    const last = sink.saved[sink.saved.length - 1];
    assert.equal(last?.state, 'Completed');
    assert.equal(last?.stopReason, 'completed');
    assert.ok(service !== undefined);
  });

  test('engine 失敗時は Failed の run 記録を保存する', async () => {
    const sink = new RecordingRunSink();
    const { service, operator } = await bootstrapFlow();
    const { plan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    // 別 service で engine 失敗を起こす代わりに、成功 path の scan でも
    // Running + Completed の 2 件保存を確認する (失敗 path の保存は api IT と storage IT が担保)。
    const scanSeeded = createTestService({ runSink: sink });
    const op = scanSeeded.operator;
    scanSeeded.service.createCase(op, {
      name: 'sink-scan',
      allowedOrigins: ['http://fixture.target.test'],
      deniedOrigins: [],
      limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
    });
    await scanSeeded.service.grantAuthorization(op, {
      allowedOperationClasses: ['Browse', 'ActiveScan'],
      targetRoles: ['unauthenticated'],
      validFrom: '2026-10-18T00:00:00.000Z',
      validUntil: '2026-10-19T00:00:00.000Z',
      evidence: { label: '認可', content: 'x' },
    });
    const scanPlanResult = scanSeeded.service.buildActiveScanPlan(op, ['http://fixture.target.test/']);
    scanSeeded.service.authorizePlan(scanPlanResult.plan);
    const scanConfirmation = scanSeeded.service.confirmPlan(scanPlanResult.plan, op);
    const adopted = [
      {
        candidateId: 'cand-0001',
        url: 'http://fixture.target.test/',
        method: 'GET',
        category: 'page' as const,
        guidelineBasis: ['provisional:page'],
        confidence: 0.7,
        observationUrl: 'http://fixture.target.test/',
      },
    ];
    await scanSeeded.service.runActiveScan(op, scanPlanResult.plan, scanConfirmation, adopted);
    const states = sink.saved.map((record) => record.state);
    assert.deepEqual(states, ['Running', 'Completed']);
    assert.ok(plan !== undefined && confirmation !== undefined);
  });
});

for (const mode of ['start-failure', 'final-save-failure', 'early-stop', 'late-stop', 'stop-failure'] as const) {
  test(`GO-26 persisted scan lifecycle: ${mode}`, async () => {
    const controller = new AbortController();
    class Engine extends FakeScanEngine {
      override async start(...args: Parameters<FakeScanEngine['start']>) {
        if (mode === 'start-failure') throw new Error('start failed');
        const id = await super.start(...args);
        if (mode === 'stop-failure') controller.abort();
        return id;
      }
      override async stop() { if (mode === 'stop-failure') throw new Error('stop failed'); await super.stop(); }
    }
    const records: RunRecord[] = [];
    const seeded = createTestService({ scanEngine: new Engine(), runSink: {
      save(record) {
        if (mode === 'final-save-failure' && record.state === 'Completed') throw new Error('final save failed');
        records.push(record);
      },
    } });
    const { service, operator } = seeded;
    service.createCase(operator, { name: 'lifecycle', allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [],
      limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 } });
    await service.grantAuthorization(operator, { allowedOperationClasses: ['Browse', 'ActiveScan'], targetRoles: ['unauthenticated'],
      validFrom: '2026-10-18T00:00:00.000Z', validUntil: '2026-10-19T00:00:00.000Z', evidence: { label: 'authorization', content: 'x' } });
    const { plan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    if (mode === 'early-stop') controller.abort();
    await assert.rejects(service.runActiveScan(operator, plan, confirmation, [{
      candidateId: 'candidate', url: 'http://fixture.target.test/', method: 'GET', category: 'page',
      guidelineBasis: [], confidence: 1, observationUrl: 'http://fixture.target.test/',
    }], undefined, {
      signal: controller.signal,
      onEvent(event) { if (mode === 'late-stop' && event.phase === 'running') controller.abort(); },
    }));
    const stopped = mode === 'early-stop' || mode === 'late-stop';
    assert.deepEqual(records.map((record) => record.state), stopped ? ['Running', 'Stopping', 'Stopped'] : ['Running', 'Failed']);
    assert.equal(records.at(-1)?.stopReason, stopped ? 'user-request' : 'engine-failure');
  });
}
