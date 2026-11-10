import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { describe, test } from 'node:test';
import { BaselineFlowService, InMemoryEvidenceStore, SequentialIdGenerator, SystemClock } from '@scopepilot2/core';
import type { OperatorProfile } from '@scopepilot2/contracts';
import { NodeFuzzTransport } from '../src/fuzz-transport.ts';

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
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
    server.closeAllConnections?.();
  });
}

const OPERATOR: OperatorProfile = {
  operatorId: 'operator-fuzz-transport',
  displayName: 'Fuzz Transport Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

function serviceWith(transport: NodeFuzzTransport): BaselineFlowService {
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
    runtimeBundleHash: 'fuzz-transport-it',
    fuzzTransport: transport,
  });
}

describe('NodeFuzzTransport (実 HTTP 送信)', () => {
  test('position を query に適用し cookie を送る。応答は bounded metadata のみ返し redirect は追わない', { timeout: 30_000 }, async () => {
    const requests: { url: string; cookie: string }[] = [];
    let followed = 0;
    const server = createServer((request, response) => {
      const url = request.url ?? '/';
      requests.push({ url, cookie: request.headers.cookie ?? '' });
      if (url.startsWith('/redirect')) {
        response.writeHead(302, { Location: '/follow' });
        response.end();
        return;
      }
      if (url.startsWith('/follow')) {
        followed += 1;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('response-body');
    });
    const base = await listen(server);
    try {
      const transport = new NodeFuzzTransport({ timeoutMs: 5_000 });
      const result = await transport.send({
        targetUrl: `${base}/fuzz?fixed=1`,
        positions: [
          { name: 'user', values: ['admin'] },
          { name: 'id', values: ['2'] },
        ],
        combination: ['admin', '2'],
        sessionCookies: [{ name: 'SESSION', value: 'cookie-value', domain: '127.0.0.1', path: '/' }],
      });
      assert.equal(requests[0]?.url, '/fuzz?fixed=1&user=admin&id=2');
      assert.equal(requests[0]?.cookie, 'SESSION=cookie-value');
      assert.equal(result.status, 200);
      assert.equal(result.contentType, 'application/json');
      assert.equal(result.contentLength, Buffer.byteLength('response-body'));
      assert.equal(result.bodyHash, createHash('sha256').update('response-body').digest('hex'));
      assert.equal(result.requestUrl, `${base}/fuzz?fixed=1&user=admin&id=2`);

      const redirect = await transport.send({
        targetUrl: `${base}/redirect`,
        positions: [{ name: 'q', values: ['x'] }],
        combination: ['x'],
      });
      assert.equal(redirect.status, 302);
      assert.equal(followed, 0, 'redirect を自動追従しない');
      await assert.rejects(
        transport.send({ targetUrl: `${base}/fuzz`, positions: [{ name: 'a', values: ['1'] }], combination: [] }),
        /length mismatch/,
      );
    } finally {
      await close(server);
    }
  });

  test('service 経路で実応答を cluster・通信 log に反映し、2 RPS を守る', { timeout: 30_000 }, async () => {
    const receivedAt: number[] = [];
    const server = createServer((request, response) => {
      receivedAt.push(Date.now());
      const user = new URL(request.url ?? '/', 'http://target.invalid').searchParams.get('user') ?? '';
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(`response:${user}`);
    });
    const base = await listen(server);
    try {
      const service = serviceWith(new NodeFuzzTransport({ timeoutMs: 5_000 }));
      service.createCase(OPERATOR, {
        name: 'fuzz-transport-it',
        allowedOrigins: [base],
        deniedOrigins: [],
        limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 5 },
      });
      const result = await service.runFuzzSession(OPERATOR, {
        targetUrl: `${base}/fuzz`,
        positions: [{ name: 'user', values: ['admin', 'guest'] }],
      });
      assert.equal(result.sent, 2);
      assert.equal(result.clusters.length, 2);
      assert.equal(receivedAt.length, 2);
      assert.ok((receivedAt[1] ?? 0) - (receivedAt[0] ?? 0) >= 400, '実時間で 2 RPS の間隔を守る');
      const traffic = service.listTraffic(10);
      assert.equal(traffic.total, 2);
      assert.ok(traffic.entries?.every((entry) => entry.source === 'fuzzer' && entry.url.includes('user=')));
    } finally {
      await close(server);
    }
  });
});


test('GO-15: body insertion transport sends method, UTF-8 byte length and body without query duplication', async () => {
  let observed: { method: string | undefined; body: string; length: string | undefined; url: string | undefined } | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      observed = { method: request.method, body: Buffer.concat(chunks).toString('utf8'), length: request.headers['content-length'], url: request.url };
      response.end('ok');
    });
  });
  const base = await listen(server);
  try {
    const result = await new NodeFuzzTransport().send({ targetUrl: `${base}/body?keep=yes`, positions: [], combination: [], request: { method: 'POST', body: 'value=\u65e5', contentType: 'text/plain' } });
    assert.equal(observed?.method, 'POST');
    assert.equal(observed?.body, 'value=\u65e5');
    assert.equal(Number(observed?.length), Buffer.byteLength('value=\u65e5'));
    assert.equal(observed?.url, '/body?keep=yes');
    assert.equal(result.status, 200);
  } finally { await close(server); }
});
