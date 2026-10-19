import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { ZapEngineAdapter } from '../src/zap-engine.ts';

/**
 * ZAP HTTP API adapter の契約検証。実 ZAP は使わず、ZAP の API 応答形式を模した
 * stub server (node:http) に対して adapter の request/response 写像を検証する。
 * 実 ZAP との結合は実 engine 環境での確認項目 (NeedsInput)。
 */
interface RecordedRequest {
  readonly path: string;
  readonly query: URLSearchParams;
}

async function startFakeZap(): Promise<{ server: Server; base: string; requests: readonly RecordedRequest[]; accessUrls: string[]; setScansState: (scans: readonly { id: string; state: string }[]) => void; scansState: readonly { id: string; state: string }[] }> {
  const requests: RecordedRequest[] = [];
  const accessUrls: string[] = [];
  let scans: readonly { id: string; state: string }[] = [{ id: '7', state: 'RUNNING' }];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const query = url.searchParams;
    requests.push({ path: url.pathname, query });
    const respond = (body: unknown): void => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/JSON/core/view/version') {
      respond({ version: '2.14.0' });
      return;
    }
    if (url.pathname === '/JSON/core/action/accessUrl') {
      accessUrls.push(query.get('url') ?? '');
      respond({ result: 'OK' });
      return;
    }
    if (url.pathname === '/JSON/ascan/action/scan') {
      assert.equal(query.get('recurse'), 'true');
      respond({ scan: '7' });
      return;
    }
    if (url.pathname === '/JSON/ascan/view/status') {
      respond({ status: '42' });
      return;
    }
    if (url.pathname === '/JSON/ascan/view/scans') {
      respond({ scans });
      return;
    }
    if (url.pathname === '/JSON/core/view/alerts') {
      respond({
        alerts: [
          {
            id: '101',
            pluginId: '40012',
            name: 'Cross Site Scripting (Reflected)',
            risk: 'Medium',
            url: 'http://target.test/x',
            method: 'GET',
            param: 'q',
            evidence: '<script>alert(1)</script>',
          },
        ],
      });
      return;
    }
    if (url.pathname === '/JSON/ascan/action/stop') {
      respond({ result: 'OK' });
      return;
    }
    response.writeHead(404);
    response.end('{}');
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
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    requests,
    accessUrls,
    setScansState: (next: readonly { id: string; state: string }[]) => {
      scans = next;
    },
    get scansState(): readonly { id: string; state: string }[] {
      return scans;
    },
  };
}

describe('ZAP adapter (fake server 契約検証)', () => {
  test('start は accessUrl で site tree に載せてから scan を開始する (URL Does not Exist 回避)', async () => {
    const zap = await startFakeZap();
    try {
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base });
      assert.equal(await adapter.resolvedVersion(), 'zap 2.14.0');
      assert.equal(adapter.engineVersion, 'zap 2.14.0');

      const scanId = await adapter.start({
        runId: 'run-0001',
        targets: ['http://target.test/a', 'http://target.test/b'],
        attackStrength: 'Medium',
        leasedLimits: { maxRequests: 100, maxPages: 10, maxDurationMinutes: 5, maxConcurrency: 2, requestsPerSecond: 2 },
        authorizationRef: 'authz-0001',
      });
      assert.equal(scanId, '7');
      // 両対象を ZAP に取得させている。
      assert.deepEqual(zap.accessUrls, ['http://target.test/a', 'http://target.test/b']);
      // scan 開始 URL は先頭対象。
      const scanCall = zap.requests.find((entry) => entry.path === '/JSON/ascan/action/scan');
      assert.equal(scanCall?.query.get('url'), 'http://target.test/a');
    } finally {
      zap.server.close();
    }
  });

  test('progress と alerts の写像 (risk 正規化・id prefix・cursor)', async () => {
    const zap = await startFakeZap();
    try {
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base });
      const progress = await adapter.progress('7');
      assert.equal(progress.status, 'running');
      assert.equal(progress.progress, 42);

      const { alerts, nextCursor } = await adapter.alerts('7', 0);
      assert.equal(alerts.length, 1);
      const alert = alerts[0];
      assert.equal(alert?.engineAlertId, 'zap-101');
      assert.equal(alert?.pluginId, '40012');
      assert.equal(alert?.risk, 'Medium');
      assert.equal(alert?.param, 'q');
      assert.equal(alert?.evidenceSummary, '<script>alert(1)</script>');
      // 1 ページ未満 (stub は 1 件だけ返す) なので cursor は進まない (=打切り)。
      assert.equal(nextCursor, 0);

      await adapter.stop('7');
      const stopCall = zap.requests.find((entry) => entry.path === '/JSON/ascan/action/stop');
      assert.equal(stopCall?.query.get('scanId'), '7');
    } finally {
      zap.server.close();
    }
  });

  test('API key は環境変数から付き、argv 由来にしない', async () => {
    const zap = await startFakeZap();
    const previous = process.env['SCOPEPILOT_ZAP_API_KEY'];
    process.env['SCOPEPILOT_ZAP_API_KEY'] = 'test-key';
    try {
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base });
      await adapter.resolvedVersion();
      const versionCall = zap.requests.find((entry) => entry.path === '/JSON/core/view/version');
      assert.equal(versionCall?.query.get('apikey'), 'test-key');
      void adapter;
    } finally {
      if (previous === undefined) {
        delete process.env['SCOPEPILOT_ZAP_API_KEY'];
      } else {
        process.env['SCOPEPILOT_ZAP_API_KEY'] = previous;
      }
      zap.server.close();
    }
  });

  test('実 ZAP の完了表記 FINISHED は complete に写像する', async () => {
    const zap = await startFakeZap();
    try {
      // 実 ZAP 2.17 の ascan/view/scans は FINISHED を返す (COMPLETED ではない)。
      const original = zap.scansState;
      zap.setScansState([{ id: '7', state: 'FINISHED' }]);
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base });
      const progress = await adapter.progress('7');
      assert.equal(progress.status, 'complete');
      zap.setScansState(original);
    } finally {
      zap.server.close();
    }
  });
});
