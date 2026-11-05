import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  resolveWorkflowScanCheckIds,
  resolveGuidelineThemeRoutes,
  runWorkflowScan,
  type WorkflowScanTransport,
} from '@scopepilot2/core';
import { NodeWorkflowScanTransport } from '../src/workflow-scan-transport.ts';
import { NodeRepeaterTransport } from '../src/repeater-transport.ts';
import { bootstrapFlow } from '../../core/test/unit/support/test-flow.ts';

const baseUrl = process.env['SCOPEPILOT_DVWA_BASE_URL'] ?? '';
const username = process.env['SCOPEPILOT_DVWA_USERNAME'] ?? '';
const password = process.env['SCOPEPILOT_DVWA_PASSWORD'] ?? '';
const gated = baseUrl !== '' ? describe : describe.skip;

function transport(maxRequests: number): WorkflowScanTransport {
  return new NodeWorkflowScanTransport({
    baseUrl,
    maxRequests,
    redactionValues: [username, password],
  });
}

gated('実HTTP対象でのガイドライン別汎用診断（既定fixtureはDVWA）', () => {
  test('追加ヘッダーとHTTPメソッドのZAP非対応テーマを実通信で評価する', { timeout: 60_000 }, async () => {
    const { service, operator } = await bootstrapFlow({
      allowedOrigins: [new URL(baseUrl).origin],
      repeaterTransport: new NodeRepeaterTransport({ timeoutMs: 10_000 }),
    });
    const headerResult = await service.runZapUnsupportedCheck(operator, {
      themeNo: '24',
      targetUrls: [`${baseUrl}/login.php`],
      params: { sensitivePage: 'true' },
    });
    assert.ok(headerResult.results.some((probe) => probe.pattern === 'header:referrer-policy'));
    assert.ok(headerResult.results.some((probe) => probe.pattern === 'sec-fetch-cross-site'));

    const methodResult = await service.runZapUnsupportedCheck(operator, {
      themeNo: '25',
      targetUrls: [`${baseUrl}/login.php`],
    });
    assert.ok(methodResult.results.some((probe) => probe.pattern === 'options-allow'));
    assert.ok(methodResult.results.some((probe) => probe.pattern === 'method:trace'));
    assert.ok(methodResult.results.some((probe) => probe.pattern === 'method:track'));

    const publicSurfaceResult = await service.runZapUnsupportedCheck(operator, {
      themeNo: '30',
      targetUrls: [`${baseUrl}/login.php`],
    });
    assert.equal(publicSurfaceResult.results.find((probe) => probe.pattern === 'version-header:server')?.outcome, 'exposed');
    assert.equal(publicSurfaceResult.results.find((probe) => probe.pattern === 'response-content-type')?.outcome, 'denied');
  });

  test('ASVS選択は全汎用HTTPチェックを実行経路へ載せる', { timeout: 180_000 }, async () => {
    const checkIds = resolveWorkflowScanCheckIds(['OWASP ASVS 5.0']);
    assert.deepEqual(resolveWorkflowScanCheckIds(['OWASP WSTG 4.2']), checkIds);
    assert.deepEqual(resolveWorkflowScanCheckIds(['IPA/NISC/WebAppPentestGuidelines']), checkIds);
    for (const guideline of ['OWASP ASVS 5.0', 'OWASP WSTG 4.2', 'IPA/NISC/WebAppPentestGuidelines']) {
      assert.equal(resolveGuidelineThemeRoutes([guideline]).find((route) => route.themeNo === '30')?.mode, 'automatic');
    }
    const result = await runWorkflowScan(
      { baseUrl, targets: [{ url: `${baseUrl}/login.php`, method: 'GET' }], maxRequests: 2000, checkIds },
      transport(2000),
    );
    assert.equal(result.authenticated, false);
    assert.equal(checkIds.length, 9);
    assert.ok(result.requestCount <= 2000);
    assert.ok(!JSON.stringify(result.requestLog).includes(password));
  });

  test('DS-221選択は対応するHTTPチェックだけに切り替わる', { timeout: 180_000 }, async () => {
    const checkIds = resolveWorkflowScanCheckIds(['デジタル庁 DS-221']);
    const result = await runWorkflowScan(
      { baseUrl, targets: [{ url: `${baseUrl}/login.php`, method: 'GET' }], maxRequests: 1200, checkIds },
      transport(1200),
    );
    assert.equal(result.authenticated, false);
    assert.equal(checkIds.length, 6);
    assert.ok(checkIds.includes('security-headers'));
    assert.ok(checkIds.includes('cookie-security'));
    assert.ok(!checkIds.includes('dom-source-sink'));
    assert.ok(!checkIds.includes('sql-error'));
  });
});
