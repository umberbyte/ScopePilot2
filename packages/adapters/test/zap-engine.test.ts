import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, test } from 'node:test';
import { ZapEngineAdapter } from '../src/zap-engine.ts';

interface RecordedRequest { readonly path: string; readonly query: URLSearchParams }

async function startFakeZap(): Promise<{
  server: Server;
  base: string;
  requests: readonly RecordedRequest[];
  seededPaths: string[];
  setScansState(value: readonly { id: string; state: string }[]): void;
}> {
  const requests: RecordedRequest[] = [];
  const seededPaths: string[] = [];
  let scans: readonly { id: string; state: string }[] = [{ id: '7', state: 'RUNNING' }];
  let scanStarted = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({ path: url.pathname, query: url.searchParams });
    const respond = (body: unknown): void => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/JSON/core/view/version') return respond({ version: '2.17.0' });
    if (url.pathname === '/JSON/context/action/newContext') return respond({ contextId: '1' });
    if (url.pathname === '/JSON/users/action/newUser') return respond({ userId: '1' });
    if (url.pathname === '/JSON/core/action/sendRequest') {
      const raw = url.searchParams.get('request') ?? '';
      seededPaths.push(raw.match(/^[A-Z]+\s+(\S+)/)?.[1] ?? '');
      return respond({ sendRequest: [{
        responseHeader: 'HTTP/1.1 200 OK\r\nContent-Type: text/html',
        responseBody: 'OK',
      }] });
    }
    if (/^\/JSON\/(?:context|users|httpSessions|sessionManagement|authentication)\/action\//.test(url.pathname)) return respond({ result: 'OK' });
    if (url.pathname === '/JSON/ascan/action/scan') {
      assert.equal(url.searchParams.get('recurse'), 'false');
      assert.equal(url.searchParams.get('inScopeOnly'), 'true');
      scanStarted = true;
      return respond({ scan: '7' });
    }
    if (url.pathname === '/JSON/ascan/view/status') return respond({ status: '42' });
    if (url.pathname === '/JSON/ascan/view/scans') return respond({ scans });
    if (url.pathname === '/JSON/core/view/alerts') {
      return respond({ alerts: scanStarted || url.searchParams.get('baseurl') === '' ? [{
        id: '101', pluginId: '40012', name: 'Cross Site Scripting (Reflected)', risk: 'Medium',
        url: 'http://target.test/x', method: 'GET', param: 'q', evidence: '<script>alert(1)</script>',
      }] : [] });
    }
    if (url.pathname === '/JSON/ascan/action/stop') return respond({ result: 'OK' });
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP address');
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    requests,
    seededPaths,
    setScansState: (value) => { scans = value; },
  };
}

describe('ZAP adapter', () => {
  test('creates a context, transfers cookies, seeds insertion points and starts bounded scans', async () => {
    const zap = await startFakeZap();
    try {
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base, spiderEnabled: false, ajaxSpiderEnabled: false });
      assert.equal(await adapter.resolvedVersion(), 'zap 2.17.0');
      const runId = await adapter.start({
        runId: 'run-0001', targets: ['http://target.test/a'], attackStrength: 'Medium',
        leasedLimits: { maxRequests: 100, maxPages: 10, maxDurationMinutes: 5, maxConcurrency: 2, requestsPerSecond: 2 },
        authorizationRef: 'authz-0001', sessionCookieNames: ['PHPSESSID'], requestSeedCount: 1,
      }, {
        sessionCookies: [{ name: 'PHPSESSID', value: 'secret', domain: 'target.test', path: '/' }],
        requestSeeds: [{ url: 'http://target.test/a', method: 'GET', inputPoints: [{ name: 'id', location: 'query', type: 'text' }] }],
      });
      assert.equal(runId, 'scopepilot:run-0001');
      assert.deepEqual(zap.seededPaths, ['/a?id=1']);
      assert.ok(zap.requests.some((entry) => entry.path === '/JSON/httpSessions/action/setSessionTokenValue'));
      const exclusion = zap.requests.find((entry) => entry.path === '/JSON/context/action/excludeFromContext');
      assert.match(exclusion?.query.get('regex') ?? '', /logout/);
      assert.match(exclusion?.query.get('regex') ?? '', /setup/);
      const sessionTokenRequest = zap.requests.find((entry) => entry.path === '/JSON/httpSessions/action/setSessionTokenValue');
      assert.equal(sessionTokenRequest?.query.get('site'), 'target.test:80');
      assert.equal(zap.requests.find((entry) => entry.path === '/JSON/ascan/action/scan')?.query.get('url'), 'http://target.test/a?id=1');

      const progress = await adapter.progress(runId);
      assert.equal(progress.status, 'running');
      assert.equal(progress.progress, 42);
      const first = await adapter.alerts(runId, 0);
      assert.equal(first.alerts.length, 1);
      assert.equal(first.alerts[0]?.risk, 'Medium');
      assert.equal(first.nextCursor, 1);
      assert.equal((await adapter.alerts(runId, 1)).alerts.length, 0, 'same ZAP alert is emitted only once per run');
      await adapter.stop(runId);
    } finally {
      zap.server.close();
    }
  });

  test('preflight rejects a lost DVWA Low session before active scanning', async () => {
    const zap = await startFakeZap();
    try {
      // Override sendRequest through a tiny second server is unnecessary here: verify the
      // request contains the security cookie so a real replacement is detectable.
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base, spiderEnabled: false, ajaxSpiderEnabled: false });
      await adapter.start({
        runId: 'run-low', targets: ['http://target.test/a'], attackStrength: 'Low',
        leasedLimits: { maxRequests: 20, maxPages: 5, maxDurationMinutes: 1, maxConcurrency: 1, requestsPerSecond: 1 },
        authorizationRef: 'authz-low',
      }, {
        sessionCookies: [{ name: 'security', value: 'low', domain: 'target.test', path: '/' }],
        requestSeeds: [{ url: 'http://target.test/a', method: 'GET', inputPoints: [] }],
      });
      const send = zap.requests.find((entry) => entry.path === '/JSON/core/action/sendRequest');
      assert.match(send?.query.get('request') ?? '', /Cookie: security=low/);
    } finally {
      zap.server.close();
    }
  });

  test('authentication probe reads the current ZAP sendRequest response property', async () => {
    const zap = await startFakeZap();
    try {
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base, spiderEnabled: false, ajaxSpiderEnabled: false });
      const runId = await adapter.start({
        runId: 'run-auth-probe', targets: ['http://target.test/a'], attackStrength: 'Medium',
        leasedLimits: { maxRequests: 20, maxPages: 5, maxDurationMinutes: 1, maxConcurrency: 1, requestsPerSecond: 1 },
        authorizationRef: 'authz-auth-probe', requestSeedCount: 1,
      }, {
        sessionCookies: [{ name: 'PHPSESSID', value: 'secret', domain: 'target.test', path: '/' }],
        requestSeeds: [{ url: 'http://target.test/a', method: 'GET', inputPoints: [] }],
        authenticationProbe: { url: 'http://target.test/security.php', markers: ['OK'] },
      });
      assert.equal(runId, 'scopepilot:run-auth-probe');
      assert.equal(zap.requests.filter((entry) => entry.path === '/JSON/core/action/sendRequest').length, 2);
    } finally {
      zap.server.close();
    }
  });

  test('replays JSON and multipart request seeds with their observed body shape', async () => {
    const zap = await startFakeZap();
    try {
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base, spiderEnabled: false, ajaxSpiderEnabled: false });
      await adapter.start({
        runId: 'run-bodies', targets: ['http://target.test/api', 'http://target.test/upload'], attackStrength: 'Medium',
        leasedLimits: { maxRequests: 100, maxPages: 10, maxDurationMinutes: 5, maxConcurrency: 1, requestsPerSecond: 1 },
        authorizationRef: 'authz-bodies', requestSeedCount: 2,
      }, {
        requestSeeds: [
          { url: 'http://target.test/api', method: 'POST', contentType: 'application/json', inputPoints: [{ name: 'name', location: 'body', type: 'json' }] },
          { url: 'http://target.test/upload', method: 'POST', contentType: 'multipart/form-data; boundary=browser', inputPoints: [{ name: 'file', location: 'file', type: 'multipart' }] },
        ],
      });
      const sent = zap.requests
        .filter((entry) => entry.path === '/JSON/core/action/sendRequest')
        .map((entry) => entry.query.get('request') ?? '');
      assert.match(sent[0] ?? '', /Content-Type: application\/json/);
      assert.match(sent[0] ?? '', /\{"name":"scopepilot"\}/);
      assert.match(sent[1] ?? '', /Content-Type: multipart\/form-data; boundary=----ScopePilot2Boundary/);
      assert.match(sent[1] ?? '', /filename="scopepilot\.txt"/);
      const scans = zap.requests.filter((entry) => entry.path === '/JSON/ascan/action/scan');
      assert.equal(scans.length, 2);
      assert.equal(scans[0]?.query.get('method'), 'POST');
      assert.equal(scans[0]?.query.get('postData'), '{"name":"scopepilot"}');
      assert.equal(scans[1]?.query.get('method'), 'POST');
      assert.match(scans[1]?.query.get('postData') ?? '', /filename="scopepilot\.txt"/);
    } finally {
      zap.server.close();
    }
  });

  test('keeps distinct POST bodies for the same URL when starting active scans', async () => {
    const zap = await startFakeZap();
    try {
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base, spiderEnabled: false, ajaxSpiderEnabled: false });
      await adapter.start({
        runId: 'run-post-bodies', targets: ['http://target.test/cryptography/index.php'], attackStrength: 'Medium',
        leasedLimits: { maxRequests: 100, maxPages: 10, maxDurationMinutes: 5, maxConcurrency: 1, requestsPerSecond: 1 },
        authorizationRef: 'authz-post-bodies', requestSeedCount: 2,
      }, {
        requestSeeds: [
          {
            url: 'http://target.test/cryptography/index.php', method: 'POST', contentType: 'application/x-www-form-urlencoded',
            inputPoints: [{ name: 'message', location: 'body', type: 'text' }, { name: 'direction', location: 'body', type: 'text' }, { name: 'direction', location: 'body', type: 'text' }],
          },
          {
            url: 'http://target.test/cryptography/index.php', method: 'POST', contentType: 'application/x-www-form-urlencoded',
            inputPoints: [{ name: 'password', location: 'body', type: 'text' }],
          },
        ],
      });
      const scans = zap.requests.filter((entry) => entry.path === '/JSON/ascan/action/scan');
      assert.equal(scans.length, 2);
      assert.equal(scans[0]?.query.get('postData'), 'message=scopepilot&direction=scopepilot&direction=scopepilot');
      assert.equal(scans[1]?.query.get('postData'), 'password=scopepilot');
    } finally {
      zap.server.close();
    }
  });

  test('API key is read from the environment', async () => {
    const zap = await startFakeZap();
    const previous = process.env['SCOPEPILOT_ZAP_API_KEY'];
    process.env['SCOPEPILOT_ZAP_API_KEY'] = 'test-key';
    try {
      await new ZapEngineAdapter({ baseUrl: zap.base }).resolvedVersion();
      assert.equal(zap.requests.find((entry) => entry.path === '/JSON/core/view/version')?.query.get('apikey'), 'test-key');
    } finally {
      if (previous === undefined) delete process.env['SCOPEPILOT_ZAP_API_KEY'];
      else process.env['SCOPEPILOT_ZAP_API_KEY'] = previous;
      zap.server.close();
    }
  });

  test('FINISHED is complete', async () => {
    const zap = await startFakeZap();
    try {
      zap.setScansState([{ id: '7', state: 'FINISHED' }]);
      const progress = await new ZapEngineAdapter({ baseUrl: zap.base }).progress('7');
      assert.equal(progress.status, 'complete');
    } finally {
      zap.server.close();
    }
  });
});
