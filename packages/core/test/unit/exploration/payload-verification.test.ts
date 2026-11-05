import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PageObservation } from '@scopepilot2/contracts';
import type { ExplorationPort } from '../../../src/ports/engines.ts';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * payload 実行検証 (design/f08): 反射ベースの所見と「実行確認」を区別する経路。
 * scope 強制 (Enforced)・未対応 explorer の CapabilityUnavailable・証跡保存を検証する。
 */

class VerifyingExplorer implements ExplorationPort {
  readonly engineVersion = 'verifying-1';
  verificationCalls: { readonly url: string; readonly withSession: boolean }[] = [];

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
    this.verificationCalls.push({ url, withSession: false });
    return url.includes('payload')
      ? { executed: true, signals: ['dialog:alert scopepilot-proof'] }
      : { executed: false, signals: [] };
  }
}

describe('payload 実行検証 (service)', () => {
  test('dialog 発火を実行確認として記録し、証跡を保存する', async () => {
    const explorer = new VerifyingExplorer();
    const flow = await bootstrapFlow({ allowedOrigins: ['http://fixture.target.test'], explorer });
    const result = await flow.service.verifyFindingExecution(flow.operator, {
      url: 'http://fixture.target.test/search?q=%3Cscript%3Epayload%3C/script%3E',
    });
    assert.equal(result.executed, true);
    assert.deepEqual(result.signals, ['dialog:alert scopepilot-proof']);
    assert.ok(result.evidenceRef.length > 0);
    assert.equal(explorer.verificationCalls.length, 1);
  });

  test('無害な URL は実行なしと判定する', async () => {
    const explorer = new VerifyingExplorer();
    const flow = await bootstrapFlow({ allowedOrigins: ['http://fixture.target.test'], explorer });
    const result = await flow.service.verifyFindingExecution(flow.operator, {
      url: 'http://fixture.target.test/search?q=plain',
    });
    assert.equal(result.executed, false);
    assert.deepEqual(result.signals, []);
  });

  test('scope 外の検証 URL は送信前に拒否する', async () => {
    const explorer = new VerifyingExplorer();
    const flow = await bootstrapFlow({ allowedOrigins: ['http://fixture.target.test'], explorer });
    await assert.rejects(
      () => flow.service.verifyFindingExecution(flow.operator, { url: 'http://elsewhere.example/x?q=payload' }),
      /out of scope/,
    );
    assert.equal(explorer.verificationCalls.length, 0, 'scope 外は explorer を呼ばない');
  });

  test('未対応 explorer は CapabilityUnavailable', async () => {
    const flow = await bootstrapFlow({ allowedOrigins: ['http://fixture.target.test'] });
    await assert.rejects(
      () => flow.service.verifyFindingExecution(flow.operator, { url: 'http://fixture.target.test/x?q=payload' }),
      (error: unknown) => (error as { code?: string }).code === 'CapabilityUnavailable',
    );
  });

  test('role 指定時は login 済み session を検証へ渡す (未 login は ValidationFailed)', async () => {
    const flow = await bootstrapFlow({ allowedOrigins: ['http://fixture.target.test'] });
    await assert.rejects(
      () => flow.service.verifyFindingExecution(flow.operator, { url: 'http://fixture.target.test/x?q=payload', role: 'admin' }),
      /no session for role/,
    );
  });
});
