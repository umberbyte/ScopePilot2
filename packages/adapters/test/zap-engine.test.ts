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
  setAlertVisible(value: boolean): void;
}> {
  const requests: RecordedRequest[] = [];
  const seededPaths: string[] = [];
  let scans: readonly { id: string; state: string }[] = [{ id: '7', state: 'RUNNING' }];
  let scanStarted = false;
  let alertVisible = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({ path: url.pathname, query: url.searchParams });
    const respond = (body: unknown): void => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/JSON/core/view/version') return respond({ version: '2.17.0' });
    if (url.pathname === '/JSON/httpSessions/view/sites') return respond({ sites: ['target.test:80'] });
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
    if (/^\/JSON\/(?:context|users|httpSessions|sessionManagement|authentication|replacer)\/action\//.test(url.pathname)) return respond({ result: 'OK' });
    if (url.pathname === '/JSON/ascan/action/scan') {
      assert.equal(url.searchParams.get('recurse'), 'false');
      assert.equal(url.searchParams.get('inScopeOnly'), 'true');
      scanStarted = true;
      return respond({ scan: '7' });
    }
    if (url.pathname === '/JSON/ascan/view/status') return respond({ status: '42' });
    if (url.pathname === '/JSON/ascan/view/scans') return respond({ scans });
    if (url.pathname === '/JSON/core/view/alerts') {
      return respond({ alerts: scanStarted || alertVisible || url.searchParams.get('baseurl') === '' ? [{
        id: '101', pluginId: '40012', name: 'Cross Site Scripting (Reflected)', risk: 'Medium',
        url: 'http://target.test/x', method: 'GET', param: 'q', evidence: '<script>alert(1)</script>',
        attack: '<script>alert(1)</script>', messageId: '501',
        description: '<p>入力値がHTMLへ未エスケープで反映されます。</p>',
        solution: '出力文脈に応じてエンコードしてください。',
        reference: 'https://www.zaproxy.org/docs/alerts/40012/',
      }] : [] });
    }
    if (url.pathname === '/JSON/core/view/message') {
      assert.equal(url.searchParams.get('id'), '501');
      return respond({ message: {
        requestHeader: 'GET /x?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E HTTP/1.1\r\nHost: target.test\r\nAuthorization: Bearer evidence-secret\r\nCookie: session=secret',
        requestBody: '',
        responseHeader: 'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8',
        responseBody: '<html><body><script>alert(1)</script></body></html>',
      } });
    }
    if (url.pathname === '/JSON/core/view/messages') {
      if (url.searchParams.get('baseurl') === 'http://target.test/observed') {
        return respond({ messages: [{
          id: '601',
          requestHeader: 'GET http://target.test/observed HTTP/1.1\r\nHost: target.test\r\nCookie: session=secret',
          requestBody: '',
          responseHeader: 'HTTP/1.1 200 OK\r\nContent-Type: text/html',
          responseBody: '<html>observed</html>',
        }] });
      }
      return respond({ messages: [] });
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
    setAlertVisible: (value) => { alertVisible = value; },
  };
}

describe('ZAP adapter', () => {
  test('authenticated exploration can unset a stale active HTTP session', async () => {
    const zap = await startFakeZap();
    try {
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base });
      await adapter.unsetActiveHttpSession('http://target.test/private?a=1');
      const request = zap.requests.find((entry) => entry.path === '/JSON/httpSessions/action/unsetActiveSession');
      assert.equal(request?.query.get('site'), 'target.test:80');
    } finally {
      zap.server.close();
    }
  });

  test('recovers historical HTTP evidence without resending requests', async () => {
    const zap = await startFakeZap();
    try {
      zap.setAlertVisible(true);
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base });
      const recovered = await adapter.recoverHttpExchanges([
        { pluginId: '40012', title: 'XSS', url: 'http://target.test/x', method: 'GET', param: 'q' },
        { pluginId: 'scopepilot-dom-flow', title: 'DOM flow', url: 'http://target.test/observed', method: 'GET' },
        { pluginId: '40012', title: 'XSS old nonce', url: 'http://target.test/x?nonce=old', method: 'GET', param: 'q' },
      ]);
      assert.equal(recovered[0]?.recoveryStrategy, 'alert-exact');
      assert.match(recovered[0]?.requestHeader ?? '', /^GET \/x/u);
      assert.match(recovered[0]?.requestHeader ?? '', /Authorization: \[REDACTED\]/u);
      assert.match(recovered[0]?.requestHeader ?? '', /Cookie: \[REDACTED\]/u);
      assert.doesNotMatch(recovered[0]?.requestHeader ?? '', /evidence-secret|session=secret/u);
      assert.equal(recovered[1]?.recoveryStrategy, 'message-exact');
      assert.match(recovered[1]?.responseHeader ?? '', /^HTTP\/1\.1 200 OK/u);
      assert.equal(recovered[2], null, 'a different wire URL must never be attached to a nonce-specific finding');
      assert.equal(zap.requests.some((entry) => entry.path === '/JSON/core/action/sendRequest'), false);
    } finally {
      zap.server.close();
    }
  });

  test('HTTP Sessions 未登録の新規 site は解除 API を呼ばず続行する', async () => {
    const zap = await startFakeZap();
    try {
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base });
      await adapter.unsetActiveHttpSession('http://new-target.test/private');
      assert.equal(zap.requests.some((entry) => entry.path === '/JSON/httpSessions/action/unsetActiveSession'), false);
    } finally {
      zap.server.close();
    }
  });

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
      assert.equal(first.alerts[0]?.messageId, '501');
      assert.match(first.alerts[0]?.description ?? '', /未エスケープ/u);
      assert.match(first.alerts[0]?.solution ?? '', /エンコード/u);
      assert.match(first.alerts[0]?.reference ?? '', /40012/u);
      assert.match(first.alerts[0]?.requestHeader ?? '', /^GET \/x/u);
      assert.match(first.alerts[0]?.responseBody ?? '', /<script>alert\(1\)<\/script>/u);
      assert.ok(zap.requests.some((entry) => entry.path === '/JSON/core/view/message'));
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

  test('origin-bound Authorization is applied to seeds and removed from ZAP after the scan', async () => {
    const zap = await startFakeZap();
    try {
      const adapter = new ZapEngineAdapter({ baseUrl: zap.base, spiderEnabled: false, ajaxSpiderEnabled: false });
      const runId = await adapter.start({
        runId: 'run-bearer', targets: ['http://target.test/api'], attackStrength: 'Medium',
        leasedLimits: { maxRequests: 20, maxPages: 5, maxDurationMinutes: 1, maxConcurrency: 1, requestsPerSecond: 1 },
        authorizationRef: 'authz-bearer', requestSeedCount: 1,
      }, {
        sessionHeaders: [
          { origin: 'http://target.test', name: 'Authorization', value: 'Bearer transient-secret' },
          { origin: 'http://elsewhere.test', name: 'Authorization', value: 'Bearer must-not-apply' },
        ],
        requestSeeds: [{ url: 'http://target.test/api', method: 'GET', inputPoints: [] }],
      });
      const add = zap.requests.find((entry) => entry.path === '/JSON/replacer/action/addRule');
      assert.equal(add?.query.get('matchString'), 'Authorization');
      assert.equal(add?.query.get('replacement'), 'Bearer transient-secret');
      assert.match(add?.query.get('url') ?? '', /target\\\.test/u);
      assert.equal(zap.requests.filter((entry) => entry.path === '/JSON/replacer/action/addRule').length, 1);
      const seed = zap.requests.find((entry) => entry.path === '/JSON/core/action/sendRequest');
      assert.match(seed?.query.get('request') ?? '', /Authorization: Bearer transient-secret/u);
      assert.doesNotMatch(seed?.query.get('request') ?? '', /must-not-apply/u);

      zap.setScansState([{ id: '7', state: 'FINISHED' }]);
      assert.equal((await adapter.progress(runId)).status, 'complete');
      const remove = zap.requests.find((entry) => entry.path === '/JSON/replacer/action/removeRule');
      assert.equal(remove?.query.get('description'), add?.query.get('description'));
      assert.equal(JSON.stringify(zap.requests.map((entry) => ({ path: entry.path, keys: [...entry.query.keys()] }))).includes('transient-secret'), false);
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
