import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EngineAlert, PageObservation, ScanCandidate } from '@scopepilot2/contracts';
import type { ActiveScanEnginePort, ExplorationPort } from '../../../src/ports/engines.ts';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * 通常診断 (runActiveScan) からの payload 実行検証の自動接続 (design/30 30.1):
 * 反射系 XSS 所見で URL に payload が乗っているものを browser で開き、
 * dialog 発火を実行確認として結果に載せる。対象外の所見は検証しない。
 */

class AlertScanEngine implements ActiveScanEnginePort {
  // testCapabilities() の zap 能力表は fake-zap-1 版を登録するため同一版名を使う。
  readonly engineVersion = 'fake-zap-1';
  readonly emitted: readonly EngineAlert[] = [];

  constructor(alerts: readonly EngineAlert[]) {
    this.emitted = alerts;
  }

  async start(): Promise<string> {
    return 'fake-run-1';
  }

  async progress(): Promise<{ status: 'complete'; progress: 100; lastActivityAt: ''; messageCount: 1 }> {
    return { status: 'complete', progress: 100, lastActivityAt: '', messageCount: 1 };
  }

  async alerts(): Promise<{ alerts: readonly EngineAlert[]; nextCursor: number }> {
    return { alerts: this.emitted, nextCursor: this.emitted.length };
  }

  async stop(): Promise<void> {}
}

class VerifyingExplorer implements ExplorationPort {
  readonly engineVersion = 'fake-explorer-1';
  readonly verificationUrls: string[] = [];
  private readonly executedUrls: readonly string[];

  constructor(executedUrls: readonly string[]) {
    this.executedUrls = executedUrls;
  }

  async observe(url: string): Promise<PageObservation> {
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

  async verifyPayloadExecution(url: string): Promise<{ executed: boolean; signals: readonly string[] }> {
    this.verificationUrls.push(url);
    return this.executedUrls.includes(url)
      ? { executed: true, signals: ['dialog:alert xss-proof'] }
      : { executed: false, signals: [] };
  }
}

function xssAlert(overrides: Partial<EngineAlert>): EngineAlert {
  return {
    engineAlertId: 'alert-1',
    pluginId: '40012',
    name: 'Cross Site Scripting (Reflected)',
    risk: 'High',
    url: 'http://fixture.target.test/search?q=%3Cscript%3Ealert(1)%3C/script%3E',
    method: 'GET',
    evidenceSummary: 'reflected',
    ...overrides,
  } as EngineAlert;
}

const ADOPTED: readonly ScanCandidate[] = [{
  candidateId: 'cand-0001',
  url: 'http://fixture.target.test/',
  method: 'GET',
  category: 'page',
  guidelineBasis: ['provisional:page'],
  confidence: 0.7,
  observationUrl: 'http://fixture.target.test/',
}];

async function runScanWith(alerts: readonly EngineAlert[], explorer: ExplorationPort) {
  const flow = await bootstrapFlow({
    allowedOrigins: ['http://fixture.target.test'],
    allowedOperationClasses: ['Browse', 'ActiveScan'],
    explorer,
    scanEngine: new AlertScanEngine(alerts),
  });
  const { plan } = flow.service.buildActiveScanPlan(flow.operator, ['http://fixture.target.test/']);
  flow.service.authorizePlan(plan);
  const confirmation = flow.service.confirmPlan(plan, flow.operator);
  const result = await flow.service.runActiveScan(flow.operator, plan, confirmation, ADOPTED);
  return { result, explorer };
}

describe('通常診断: payload 実行検証の自動接続', () => {
  test('反射 XSS 所見 (payload 付き URL) を browser 検証し、実行確認を結果に載せる', async () => {
    const payloadUrl = 'http://fixture.target.test/search?q=%3Cscript%3Ealert(1)%3C/script%3E';
    const explorer = new VerifyingExplorer([payloadUrl]);
    const { result } = await runScanWith([xssAlert({ url: payloadUrl })], explorer);

    assert.deepEqual(explorer.verificationUrls, [payloadUrl], 'XSS 所見の URL を 1 件検証した');
    assert.equal(result.payloadVerifications?.length, 1);
    assert.equal(result.payloadVerifications?.[0]?.executed, true);
    assert.deepEqual(result.payloadVerifications?.[0]?.signals, ['dialog:alert xss-proof']);
    assert.ok((result.payloadVerifications?.[0]?.evidenceRef ?? '') !== '', '検証結果の証跡参照がある');
    assert.equal(result.runRecord.state, 'Completed', '診断自体は完了');
  });

  test('dialog が発火しない payload は実行なしと判定する', async () => {
    const payloadUrl = 'http://fixture.target.test/search?q=%3Cscript%3Ealert(1)%3C/script%3E';
    const explorer = new VerifyingExplorer([]);
    const { result } = await runScanWith([xssAlert({ url: payloadUrl })], explorer);

    assert.equal(result.payloadVerifications?.[0]?.executed, false);
    assert.equal(result.payloadVerifications?.[0]?.signals.length, 0);
  });

  test('payload が URL に無い所見・非 XSS 所見は検証しない', async () => {
    const explorer = new VerifyingExplorer([]);
    const { result } = await runScanWith([
      xssAlert({ url: 'http://fixture.target.test/search?q=plain', engineAlertId: 'a1' }),
      xssAlert({ url: 'http://fixture.target.test/search?q=%3Cscript%3E', engineAlertId: 'a2', name: 'SQL Injection' }),
    ], explorer);

    assert.equal(explorer.verificationUrls.length, 0, '対象外の所見は検証しない');
    assert.equal(result.payloadVerifications, undefined);
  });
});
