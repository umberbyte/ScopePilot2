import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, test } from 'node:test';
import { BaselineFlowService, InMemoryEvidenceStore, SequentialIdGenerator, SystemClock } from '@scopepilot2/core';
import type { OperatorProfile } from '@scopepilot2/contracts';
import { NodeSequencerTransport } from '../src/sequencer-transport.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
    server.closeAllConnections?.();
  });
}

const OPERATOR: OperatorProfile = {
  operatorId: 'operator-sequencer-transport',
  displayName: 'Sequencer Transport Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

function serviceWith(transport: NodeSequencerTransport): BaselineFlowService {
  return new BaselineFlowService({
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
    runtimeBundleHash: 'sequencer-transport-it',
    sequencerTransport: transport,
  });
}

describe('NodeSequencerTransport (実 HTTP sample 収集)', () => {
  test('実応答から token 統計を作り、原文を保存せず通信 log と 2 RPS を維持する', { timeout: 30_000 }, async () => {
    let sequence = 0;
    const receivedAt: number[] = [];
    const receivedCookies: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      receivedAt.push(Date.now());
      receivedCookies.push(request.headers.cookie);
      sequence += 1;
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': `SEQ_TOKEN=cookie-secret-${sequence.toString(36)}; Path=/; HttpOnly`,
      });
      response.end(`token=secret-token-${sequence.toString(36)}<input value="hidden-secret-${sequence.toString(36)}" name="csrf_token" type="hidden">`);
    });
    const base = await listen(server);
    try {
      const rateResponses: { body: string; setCookieHeaders?: readonly string[] }[] = [];
      const normalRate = new NodeSequencerTransport({ timeoutMs: 5_000 });
      await normalRate.collect({
        targetUrl: `${base}/token`,
        samples: 2,
        sessionCookies: [{ name: 'SEQ_SESSION', value: 'transport-secret', domain: '127.0.0.1', path: '/' }],
        onResponse: (response) => rateResponses.push({
          body: response.body,
          ...(response.setCookieHeaders === undefined ? {} : { setCookieHeaders: response.setCookieHeaders }),
        }),
      });
      assert.equal(rateResponses.length, 2);
      assert.deepEqual(rateResponses.map((response) => response.setCookieHeaders), [
        ['SEQ_TOKEN=cookie-secret-1; Path=/; HttpOnly'],
        ['SEQ_TOKEN=cookie-secret-2; Path=/; HttpOnly'],
      ]);
      assert.ok((receivedAt[1] ?? 0) - (receivedAt[0] ?? 0) >= 400, '既定 2 RPS の間隔を守る');
      assert.deepEqual(receivedCookies.slice(0, 2), ['SEQ_SESSION=transport-secret', 'SEQ_SESSION=transport-secret']);

      // service 結合は高速 test rate で最小30 sampleを収集する。製品配線は既定2 RPS。
      const service = serviceWith(new NodeSequencerTransport({ timeoutMs: 5_000, requestsPerSecond: 1000 }));
      service.createCase(OPERATOR, {
        name: 'sequencer-transport-it',
        allowedOrigins: [base],
        deniedOrigins: [],
        limits: { maxRequests: 100, maxPages: 10, maxDurationMinutes: 5 },
      });
      const result = await service.runSequencerSession(OPERATOR, { targetUrl: `${base}/token`, samples: 30, tokenSource: 'hidden', tokenFieldName: 'csrf_token' });
      assert.equal(result.verdict, 'assessed');
      assert.equal(result.sampleCount, 30);
      assert.equal(result.duplicates, 0);
      assert.equal(result.missing, 0);
      assert.equal(result.tokenSource, 'hidden');
      assert.equal(result.tokenFieldName, 'csrf_token');
      assert.equal(JSON.stringify(result).includes('secret-token'), false, '結果に token 原文を出さない');
      assert.equal(JSON.stringify(result).includes('cookie-secret'), false, '結果に cookie token 原文を出さない');
      assert.equal(JSON.stringify(result).includes('hidden-secret'), false, '結果に hidden token 原文を出さない');
      assert.equal(JSON.stringify(service.events()).includes('secret-token'), false, '監査に token 原文を出さない');
      assert.equal(JSON.stringify(service.events()).includes('cookie-secret'), false, '監査に cookie token 原文を出さない');
      assert.equal(JSON.stringify(service.events()).includes('hidden-secret'), false, '監査に hidden token 原文を出さない');
      assert.equal(JSON.stringify(service.listSequencerSessions()).includes('secret-token'), false, '台帳に token 原文を出さない');
      assert.equal(JSON.stringify(service.listSequencerSessions()).includes('cookie-secret'), false, '台帳に cookie token 原文を出さない');
      assert.equal(JSON.stringify(service.listSequencerSessions()).includes('hidden-secret'), false, '台帳に hidden token 原文を出さない');
      const traffic = service.listTraffic(100);
      assert.equal(traffic.total, 30);
      assert.ok(traffic.entries?.every((entry) => entry.source === 'sequencer' && entry.status === 200));
      assert.equal(JSON.stringify(traffic).includes('secret-token'), false, '通信 log に token 原文を出さない');
    } finally {
      await close(server);
    }
  });
});
