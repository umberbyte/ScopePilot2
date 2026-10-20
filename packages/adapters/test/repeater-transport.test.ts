import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BaselineFlowService, InMemoryEvidenceStore, SequentialIdGenerator, SystemClock } from '@scopepilot2/core';
import type { OperatorProfile } from '@scopepilot2/contracts';
import { NodeRepeaterTransport } from '../src/repeater-transport.ts';
import { startVulnerableTarget } from './vulnerable-target.ts';

/**
 * Repeater 実送信 transport (design/f04) の所有ターゲットに対する結合検証。
 * ZAP 不要 (直接送信) のため常時実行する (unit 扱い・外部依存なし)。
 */
const OPERATOR: OperatorProfile = {
  operatorId: 'operator-repeater-transport',
  displayName: 'Repeater Transport Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

describe('NodeRepeaterTransport (実 HTTP 送信)', () => {
  test('draft を実送信し応答 summary・通信 log・session cookie が反映される', { timeout: 60_000 }, async () => {
    const target = await startVulnerableTarget();
    try {
      const transport = new NodeRepeaterTransport({ timeoutMs: 10_000 });
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
        runtimeBundleHash: 'repeater-transport-it',
        repeaterTransport: transport,
      });
      service.createCase(OPERATOR, {
        name: 'repeater-transport-it',
        allowedOrigins: [new URL(target.base).origin],
        deniedOrigins: [],
        limits: { maxRequests: 100, maxPages: 10, maxDurationMinutes: 5 },
      });

      // 1. GET 送信: 実応答 (status 200・text/html・本体に page 内容)。
      const draft = service.createRepeaterDraft(OPERATOR, { targetUrl: target.plainUrl, protocol: 'http/1.1' });
      const sent = await service.sendRepeaterDraft(OPERATOR, draft.draftId, draft.planHash);
      assert.equal(sent.sent, true, sent.reason ?? '');
      assert.equal(sent.response?.status, 200, '実応答の status が返る');
      assert.equal(sent.response?.contentType.includes('text/html'), true);
      assert.equal(sent.response?.bodyPreview?.includes('plain page'), true, '実本体の preview が返る');
      assert.equal(sent.attempt?.outcome, 'responded');
      // 通信 log (F03) にも実応答が載る。
      const traffic = service.listTraffic(10);
      const entry = traffic.entries?.find((candidate) => candidate.url === target.plainUrl);
      assert.ok(entry !== undefined, '通信 log に実送信が記録されていない');
      assert.equal(entry.status, 200);

      // 2. 編集 (header 追加) でも hash 更新後に実送信できる。
      const edited = service.editRepeaterDraft(OPERATOR, draft.draftId, { headers: [['X-ScopePilot', '1']], body: '' });
      const sentEdited = await service.sendRepeaterDraft(OPERATOR, edited.draftId, edited.planHash);
      assert.equal(sentEdited.sent, true, sentEdited.reason ?? '');
      assert.equal(sentEdited.response?.status, 200);

      // 3. echo endpoint への GET (query のみ) でも実応答が返る。
      const echoDraft = service.createRepeaterDraft(OPERATOR, { targetUrl: target.echoUrl, protocol: 'http/1.1' });
      const echoSent = await service.sendRepeaterDraft(OPERATOR, echoDraft.draftId, echoDraft.planHash);
      assert.equal(echoSent.sent, true);
      assert.equal(echoSent.response?.bodyPreview?.includes('reflected: abc'), true);

      // 4. 認証頁 (session cookie 付き) — cookie 無しでも transport は 302 を
      //    redirectLocations として返し、core の runRedirects が scope 内なら完了。
      //    (scope 外 Location の停止は domain UT で担保 — ここは実経路の確認)
      const authDraft = service.createRepeaterDraft(OPERATOR, { targetUrl: target.authenticatedUrl, protocol: 'http/1.1' });
      const authSent = await service.sendRepeaterDraft(OPERATOR, authDraft.draftId, authDraft.planHash);
      assert.equal(authSent.sent, true, authSent.reason ?? '');
      // 未認証なので 302 → Location /login は scope 内 → 応答は 302 のまま返る。
      assert.equal(authSent.response?.status, 302);
    } finally {
      target.server.close();
    }
  });

  test('scope 外への redirect は core の規則で停止する (F04-UT-004 の実経路)', { timeout: 60_000 }, async () => {
    // redirect 先が scope 外の対象を作る。
    const { createServer } = await import('node:http');
    const server = createServer((request, response) => {
      response.writeHead(302, { Location: 'http://elsewhere.example/out' });
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP address');
    }
    try {
      const base = `http://127.0.0.1:${address.port}`;
      const transport = new NodeRepeaterTransport({ timeoutMs: 10_000 });
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
        runtimeBundleHash: 'repeater-transport-it2',
        repeaterTransport: transport,
      });
      service.createCase(OPERATOR, {
        name: 'repeater-redirect-it',
        allowedOrigins: [base],
        deniedOrigins: [],
        limits: { maxRequests: 100, maxPages: 10, maxDurationMinutes: 5 },
      });
      const draft = service.createRepeaterDraft(OPERATOR, { targetUrl: `${base}/hop`, protocol: 'http/1.1' });
      const sent = await service.sendRepeaterDraft(OPERATOR, draft.draftId, draft.planHash);
      assert.equal(sent.sent, false, 'scope 外 redirect で送信完了扱いにしない');
      assert.match(sent.reason ?? '', /stopped-out-of-scope/);
    } finally {
      server.close();
    }
  });
});
