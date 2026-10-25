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
        'Authorization': `Bearer bearer-secret-${sequence.toString(36)}==`,
      });
      response.end(`token=secret-token-${sequence.toString(36)}<input value="hidden-secret-${sequence.toString(36)}" name="csrf_token" type="hidden">`);
    });
    const base = await listen(server);
    try {
      const rateResponses: { body: string; setCookieHeaders?: readonly string[]; authorizationHeader?: string }[] = [];
      const normalRate = new NodeSequencerTransport({ timeoutMs: 5_000 });
      await normalRate.collect({
        targetUrl: `${base}/token`,
        samples: 2,
        replayRequest: { method: 'GET', headers: [], body: '' },
        sessionCookies: [{ name: 'SEQ_SESSION', value: 'transport-secret', domain: '127.0.0.1', path: '/' }],
        onResponse: (response) => rateResponses.push({
          body: response.body,
          ...(response.setCookieHeaders === undefined ? {} : { setCookieHeaders: response.setCookieHeaders }),
          ...(response.authorizationHeader === undefined ? {} : { authorizationHeader: response.authorizationHeader }),
        }),
      });
      assert.equal(rateResponses.length, 2);
      assert.deepEqual(rateResponses.map((response) => response.setCookieHeaders), [
        ['SEQ_TOKEN=cookie-secret-1; Path=/; HttpOnly'],
        ['SEQ_TOKEN=cookie-secret-2; Path=/; HttpOnly'],
      ]);
      assert.deepEqual(rateResponses.map((response) => response.authorizationHeader), [
        'Bearer bearer-secret-1==',
        'Bearer bearer-secret-2==',
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

      const custom = await service.runSequencerSession(OPERATOR, {
        targetUrl: `${base}/token`,
        samples: 30,
        tokenSource: 'custom',
        tokenStartDelimiter: 'token=',
        tokenEndDelimiter: '<input',
      });
      assert.equal(custom.verdict, 'assessed');
      assert.equal(custom.sampleCount, 30);
      assert.equal(custom.tokenSource, 'custom');
      assert.equal(custom.tokenStartDelimiter, 'token=');
      assert.equal(custom.tokenEndDelimiter, '<input');
      assert.equal(JSON.stringify(result).includes('secret-token'), false, '結果に token 原文を出さない');
      assert.equal(JSON.stringify(result).includes('cookie-secret'), false, '結果に cookie token 原文を出さない');
      assert.equal(JSON.stringify(result).includes('hidden-secret'), false, '結果に hidden token 原文を出さない');
      assert.equal(JSON.stringify(result).includes('bearer-secret'), false, '結果に bearer token 原文を出さない');
      assert.equal(JSON.stringify(service.events()).includes('secret-token'), false, '監査に token 原文を出さない');
      assert.equal(JSON.stringify(service.events()).includes('cookie-secret'), false, '監査に cookie token 原文を出さない');
      assert.equal(JSON.stringify(service.events()).includes('hidden-secret'), false, '監査に hidden token 原文を出さない');
      assert.equal(JSON.stringify(service.events()).includes('bearer-secret'), false, '監査に bearer token 原文を出さない');
      assert.equal(JSON.stringify(service.listSequencerSessions()).includes('secret-token'), false, '台帳に token 原文を出さない');
      assert.equal(JSON.stringify(service.listSequencerSessions()).includes('cookie-secret'), false, '台帳に cookie token 原文を出さない');
      assert.equal(JSON.stringify(service.listSequencerSessions()).includes('hidden-secret'), false, '台帳に hidden token 原文を出さない');
      assert.equal(JSON.stringify(service.listSequencerSessions()).includes('bearer-secret'), false, '台帳に bearer token 原文を出さない');
      const traffic = service.listTraffic(100);
      assert.equal(traffic.total, 60);
      assert.ok(traffic.entries?.every((entry) => entry.source === 'sequencer' && entry.status === 200));
      assert.equal(JSON.stringify(traffic).includes('secret-token'), false, '通信 log に token 原文を出さない');
      assert.equal(JSON.stringify(traffic).includes('bearer-secret'), false, '通信 log に bearer token 原文を出さない');
    } finally {
      await close(server);
    }
  });

  test('採取専用再送要求のmethod/header/bodyを各sampleへ適用する', async () => {
    const received: {
      method: string | undefined;
      probe: string | undefined;
      authorization: string | undefined;
      cookie: string | undefined;
      body: string;
    }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          method: request.method,
          probe: request.headers['x-probe'] as string | undefined,
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('token=replayed');
      });
    });
    const base = await listen(server);
    try {
      const transport = new NodeSequencerTransport({ timeoutMs: 5_000, requestsPerSecond: 1000 });
      await transport.collect({
        targetUrl: `${base}/token`,
        samples: 2,
        replayRequest: {
          method: 'POST',
          headers: [['X-Probe', 'probe-secret'], ['Authorization', 'Bearer request-secret'], ['Cookie', 'manual=one']],
          body: 'seed=request-secret',
        },
        sessionCookies: [{ name: 'ROLE', value: 'role-secret', domain: '127.0.0.1', path: '/' }],
        onResponse: () => undefined,
      });
      assert.deepEqual(received, [
        { method: 'POST', probe: 'probe-secret', authorization: 'Bearer request-secret', cookie: 'manual=one; ROLE=role-secret', body: 'seed=request-secret' },
        { method: 'POST', probe: 'probe-secret', authorization: 'Bearer request-secret', cookie: 'manual=one; ROLE=role-secret', body: 'seed=request-secret' },
      ]);
    } finally {
      await close(server);
    }
  });

  test('cancel は進行中の収集を止め、次のHTTP requestを送らない', async () => {
    let requests = 0;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const server = createServer(() => {
      requests += 1;
      markStarted?.();
      // 応答待ちのままにし、AbortSignalが進行中requestを破棄することを確認する。
    });
    const base = await listen(server);
    const cancellation = new AbortController();
    try {
      const transport = new NodeSequencerTransport({ timeoutMs: 5_000, requestsPerSecond: 1000 });
      const pending = transport.collect({
        targetUrl: `${base}/token`,
        samples: 30,
        replayRequest: { method: 'GET', headers: [], body: '' },
        signal: cancellation.signal,
        onResponse: () => assert.fail('cancelled in-flight request must not produce a response'),
      });
      await started;
      cancellation.abort();
      await assert.rejects(
        pending,
        (error: unknown) => {
          assert.equal((error as Error).name, 'AbortError');
          return true;
        },
      );
      assert.equal(requests, 1);
    } finally {
      await close(server);
    }
  });
});
