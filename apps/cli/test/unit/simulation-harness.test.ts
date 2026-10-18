import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runSimulate } from '../../src/simulate.ts';
import { FIXTURE_NUCLEI_VERSION, FIXTURE_ZAP_VERSION } from '@scopepilot2/simulation';

describe('SimulationHarness (scopepilot simulate)', () => {
  test('[F21-UT-009] 固定 fixture で探索→診断→Nuclei取込→所見が完走し、版情報と証跡参照を記録する', async () => {
    const outcome = await runSimulate();
    assert.equal(outcome.summary.status, 'completed');
    // 所見ありは完了 (0) と別の終了 code。
    assert.equal(outcome.exitCode, 4);
    assert.equal(outcome.summary.findingsCount, 6);
    assert.equal(outcome.summary.importedCount, 6);
    assert.equal(outcome.summary.duplicateCount, 2);
    assert.equal(outcome.summary.engineVersions.zap, FIXTURE_ZAP_VERSION);
    assert.equal(outcome.summary.engineVersions.nuclei, FIXTURE_NUCLEI_VERSION);
    assert.ok(outcome.summary.capabilityFixtureHashes.zap !== undefined);
    assert.ok(outcome.summary.capabilityFixtureHashes.nuclei !== undefined);
    assert.ok(outcome.summary.eventsCount >= 17);
    assert.ok(outcome.summary.explorePlanHash.length > 0);
    assert.ok(outcome.summary.scanPlanHash.length > 0);

    // 同じ入力から安定した計画 hash。
    const second = await runSimulate();
    assert.equal(second.summary.explorePlanHash, outcome.summary.explorePlanHash);
    assert.equal(second.summary.scanPlanHash, outcome.summary.scanPlanHash);
  });

  test('[F21-UT-009] 既知失敗 (URL Does not Exist) は engine 失敗として報告する', async () => {
    const outcome = await runSimulate({ injectUnknownScanTarget: true });
    assert.equal(outcome.summary.status, 'failed');
    assert.equal(outcome.exitCode, 7);
    assert.equal(outcome.summary.failure?.code, 'EngineFailure');
    assert.match(outcome.summary.failure?.message ?? '', /URL Does not Exist/);
  });
});
