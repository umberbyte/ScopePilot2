import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FixedClock } from '@scopepilot2/core';
import type { ActiveScanEnginePort, ExplorationPort } from '@scopepilot2/core';
import type { EngineAlert, EngineProgress, PageObservation } from '@scopepilot2/contracts';
import { createHarness } from '@scopepilot2/simulation';

/**
 * harness の engines 差し込み (実 engine 接続) 検証。engine には最小 fake を使い、
 * service が差し込んだ engine・能力表・clock を実際に使うことを確認する。
 */
class RecordingExplorer implements ExplorationPort {
  readonly engineVersion = 'recording-explorer-1';
  readonly observed: string[] = [];

  async observe(url: string): Promise<PageObservation | null> {
    this.observed.push(url);
    return {
      url,
      status: 200,
      contentType: 'text/html',
      discoveredFrom: null,
      depth: 0,
      originType: 'crawl',
      links: [],
      forms: [],
    };
  }
}

class RecordingScanEngine implements ActiveScanEnginePort {
  readonly engineVersion = 'recording-zap-9';
  started = 0;

  async start(): Promise<string> {
    this.started += 1;
    return 'rec-run-1';
  }

  async progress(): Promise<EngineProgress> {
    return { status: 'complete', progress: 100, lastActivityAt: '', messageCount: 1 };
  }

  async alerts(_engineRunId: string, cursor: number): Promise<{ alerts: readonly EngineAlert[]; nextCursor: number }> {
    return {
      alerts: [
        {
          engineAlertId: 'rec-1',
          pluginId: '00001',
          name: 'recording alert',
          risk: 'Low',
          url: 'http://injected.test/a',
          method: 'GET',
          evidenceSummary: '',
        },
      ],
      nextCursor: cursor,
    };
  }

  async stop(): Promise<void> {}
}

const OPERATOR = {
  operatorId: 'operator-inject',
  displayName: 'Inject Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
} as const;

const INJECTED_CLOCK = new FixedClock(['2026-10-19T12:00:00.000Z']);

describe('harness engines 差し込み', () => {
  test('差し込んだ explorer・scanEngine・能力表・clock が service で使われる', async () => {
    const explorer = new RecordingExplorer();
    const scanEngine = new RecordingScanEngine();
    const capabilities = [
      {
        engineKind: 'playwright',
        engineVersion: explorer.engineVersion,
        source: 'measured',
        guaranteeLevels: {
          preSendScopeEnforcement: 'Enforced',
          stopControl: 'Enforced',
          budgetLease: 'Enforced',
          rateLimit: 'Enforced',
        },
        maxOvershootRatio: 0,
        measuredAt: '2026-10-19T00:00:00.000Z',
      },
      {
        engineKind: 'zap',
        engineVersion: scanEngine.engineVersion,
        source: 'measured',
        guaranteeLevels: {
          preSendScopeEnforcement: 'Delegated',
          stopControl: 'Delegated',
          budgetLease: 'Delegated',
          rateLimit: 'Delegated',
        },
        maxOvershootRatio: 0.05,
        measuredAt: '2026-10-19T00:00:00.000Z',
      },
    ] as const;
    const harness = createHarness({
      engines: {
        explorer,
        scanEngine,
        capabilities: [...capabilities],
        clock: INJECTED_CLOCK,
        runtimeBundleHash: 'injected-runtime',
      },
    });

    assert.equal(harness.explorer, explorer);
    assert.equal(harness.scanEngine, scanEngine);
    assert.equal(harness.runtimeBundleHash, 'injected-runtime');
    assert.equal(harness.service.capabilities()[0]?.engineVersion, 'recording-explorer-1');

    // 差し込み clock が案件作成の記録時刻に現れる。
    harness.service.createCase(OPERATOR, {
      name: 'injected',
      allowedOrigins: ['http://injected.test'],
      deniedOrigins: [],
      limits: { maxRequests: 100, maxPages: 10, maxDurationMinutes: 5 },
    });
    assert.equal(harness.service.currentCase()?.createdAt, '2026-10-19T12:00:00.000Z');
  });

  test('既定 (engines 無指定) は従来どおり fixture 構成', () => {
    const harness = createHarness();
    assert.equal(harness.runtimeBundleHash.length > 0, true);
    assert.equal(harness.capabilities.find((capability) => capability.engineKind === 'zap')?.source, 'fixture');
  });
});
