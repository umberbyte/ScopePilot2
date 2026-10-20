import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as nodeHttp from 'node:http';
import { describe, test } from 'node:test';
import { BaselineFlowService, InMemoryEvidenceStore, SequentialIdGenerator, SystemClock } from '@scopepilot2/core';
import type { OperatorProfile } from '@scopepilot2/contracts';
import { ZapProxyAdapter } from '../src/zap-proxy.ts';
import { startVulnerableTarget } from './vulnerable-target.ts';

/**
 * 実 ZAP proxy を listener とする結合検証 (design/f02)。既定では skip。
 *   SCOPEPILOT_ZAP_BASE_URL=http://127.0.0.1:8090 \
 *   SCOPEPILOT_ZAP_API_KEY=... npm run test:gated -w @scopepilot2/adapters
 * ※実 ZAP を共有する gated test は並列実行すると互いの状態を消すため直列で実行。
 */
const zapBaseUrl = process.env['SCOPEPILOT_ZAP_BASE_URL'] ?? '';
const gated = zapBaseUrl !== '' ? describe : describe.skip;

const OPERATOR: OperatorProfile = {
  operatorId: 'operator-zap-proxy',
  displayName: 'ZAP Proxy Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

/** node:http の proxy 形式 (絶対 URI の request line) で実通信を ZAP 経由で出す。 */
function fetchViaProxy(proxyBase: string, targetUrl: string): Promise<{ status: number }> {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyBase);
  return new Promise((resolve, reject) => {
    const request = nodeHttp.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: 'GET',
      path: targetUrl,
      setHost: false,
    }, (response) => {
      void response.resume();
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0 });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

gated('ZapProxyAdapter (実 ZAP proxy listener)', () => {
  test('proxy 経由の実通信を観測し break queue へ流せる。CA は公開部のみ', { timeout: 180_000 }, async () => {
    const target = await startVulnerableTarget();
    const adapter = new ZapProxyAdapter({ baseUrl: zapBaseUrl, timeoutMs: 30_000 });
    const service = new BaselineFlowService({
      clock: new SystemClock(),
      ids: new SequentialIdGenerator(),
      evidence: new InMemoryEvidenceStore(),
      explorer: { engineVersion: 'fixture', observe: async () => null },
      scanEngine: {
        engineVersion: 'fixture-zap',
        start: async () => 'run',
        progress: async () => ({ status: 'complete' as const, progress: 100, lastActivityAt: '', messageCount: 0 }),
        alerts: async (_id, cursor) => ({ alerts: [], nextCursor: cursor }),
        stop: async () => undefined,
      },
      capabilities: [],
      runtimeBundleHash: 'zap-proxy-it',
    });
    try {
      // 1. session 開始 (過去通信の切り離し) → proxy 経由で実通信を出す。
      await adapter.startSession();
      const origin = new URL(target.base).origin;
      service.createCase(OPERATOR, {
        name: 'zap-proxy-it',
        allowedOrigins: [origin],
        deniedOrigins: [],
        limits: { maxRequests: 100, maxPages: 10, maxDurationMinutes: 5 },
      });
      const proxied = await fetchViaProxy(zapBaseUrl, target.plainUrl);
      assert.equal(proxied.status, 200, 'proxy 経由の実通信が通らない');

      // 2. 観測: messages API から該当通信が見え、素材 (method/URL) が写像される。
      let observed = await adapter.observeMessages(0, 100);
      let match = observed.messages.find((message) => message.url.startsWith(target.base));
      for (let retry = 0; retry < 10 && match === undefined; retry += 1) {
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
        observed = await adapter.observeMessages(0, 100);
        match = observed.messages.find((message) => message.url.startsWith(target.base));
      }
      assert.ok(match !== undefined, `proxy 通信が観測できない: ${JSON.stringify(observed.messages.slice(0, 3))}`);
      assert.equal(match?.method, 'GET');

      // 3. 観測した通信を break queue へ intake し、scope 判断 (forward) を通す。
      const item = service.enqueueBreakItem(OPERATOR, { direction: 'request', messageReference: match?.messageReference ?? '' });
      const requestHash = createHash('sha256').update(match?.url ?? '').digest('hex').slice(0, 16);
      const forwarded = service.decideBreakItem(OPERATOR, item.itemId, { requestHash, targetUrl: match?.url ?? target.plainUrl });
      assert.equal(forwarded.action, 'forward', `scope 内なのに拒否: ${forwarded.reason ?? ''}`);
      assert.equal(service.listBreakItems().find((entry) => entry.itemId === item.itemId)?.state, 'Forwarded');

      // 4. root CA: 公開部 (PEM) のみ・fingerprint が取れる・private key を含まない。
      const ca = await adapter.rootCaCertificate();
      assert.ok(ca.pem.includes('BEGIN CERTIFICATE'));
      assert.match(ca.sha256Fingerprint, /^[0-9a-f]{64}$/);
      assert.ok(!ca.pem.includes('PRIVATE KEY'), 'private key material が含まれている');

      // 5. session 停止 (観測の終了 — 以後の messages は次 session のもの)。
      await adapter.stopSession();
    } finally {
      target.server.close();
    }
  });
});
