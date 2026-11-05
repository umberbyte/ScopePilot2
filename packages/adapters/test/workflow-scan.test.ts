import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import {
  WORKFLOW_SCAN_CHECK_IDS,
  analyzeSessionPattern,
  clientSideTokenCandidates,
  detectRepeatingKey,
  findDomSink,
  md5Hex,
  parseExternalScriptOrigins,
  resolveWorkflowScanCheckIds,
  runWorkflowScan,
  tryGetHost,
  xorBytes,
} from '@scopepilot2/core';
import { NodeWorkflowScanTransport } from '../src/workflow-scan-transport.ts';

describe('Generic HTTP diagnostics', () => {
  let server: Server | undefined;
  let baseUrl = '';

  before(async () => {
    server = createServer((request, response) => {
      const target = new URL(request.url ?? '/', 'http://fixture.invalid');
      const origin = request.headers.origin;
      if (typeof origin === 'string') {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Set-Cookie', 'fixture_session=opaque');
      if (target.pathname === '/go') {
        response.statusCode = 302;
        response.setHeader('Location', target.searchParams.get('next') ?? '/');
        response.end('redirect');
        return;
      }
      if (target.pathname === '/download' && target.searchParams.get('file')?.includes('../') === true) {
        response.end('root:x:0:0:root:/root:/bin/bash');
        return;
      }
      const query = target.searchParams.get('q') ?? '';
      if (query === "'") {
        response.statusCode = 500;
        response.end('SQL syntax error near quotation');
        return;
      }
      response.end(`<html><script>const value = location.search; document.write(value);</script><body>${query}</body></html>`);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fixture server did not bind');
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server?.close((error) => error === undefined ? resolve() : reject(error)) ?? resolve());
  });

  test('uses observed URLs and input points without assuming a target product', async () => {
    const transport = new NodeWorkflowScanTransport({
      baseUrl,
      maxRequests: 100,
      sessionCookies: [{ name: 'authenticated_session', value: 'secret-session-value' }],
      redactionValues: ['secret-session-value'],
    });
    const result = await runWorkflowScan({
      baseUrl,
      authenticated: true,
      targets: [
        { url: `${baseUrl}/catalog/search?q=book`, method: 'GET', inputPoints: [{ name: 'q', location: 'query', type: 'text' }] },
        { url: `${baseUrl}/go?next=%2Fhome`, method: 'GET', inputPoints: [{ name: 'next', location: 'query', type: 'url' }] },
        { url: `${baseUrl}/download?file=manual.pdf`, method: 'GET', inputPoints: [{ name: 'file', location: 'query', type: 'text' }] },
      ],
    }, transport);

    const detected = new Set(result.checks.map((check) => check.checkId));
    for (const expected of ['security-headers', 'cookie-security', 'cors-policy', 'dom-source-sink', 'reflected-input', 'sql-error', 'open-redirect', 'path-traversal']) {
      assert.ok(detected.has(expected), `missing ${expected}: ${[...detected].join(', ')}`);
    }
    assert.equal(result.authenticated, true);
    assert.equal(result.originalSecurityLevel, '');
    assert.deepEqual(result.testedSecurityLevels, []);
    assert.ok(result.requestCount <= 100);
    assert.ok(!JSON.stringify(result.requestLog).includes('secret-session-value'));
    assert.ok(result.checks.every((check) => !check.url.includes('/vulnerabilities/')));
  });

  test('does not invent a body for a non-GET candidate', async () => {
    const transport = new NodeWorkflowScanTransport({ baseUrl, maxRequests: 20 });
    const result = await runWorkflowScan({
      baseUrl,
      targets: [{ url: `${baseUrl}/account/update`, method: 'POST', inputPoints: [{ name: 'displayName', location: 'body', type: 'text' }] }],
    }, transport);
    assert.equal(result.requestCount, 0);
    assert.equal(result.checks.length, 0);
    assert.equal(result.skips.length, WORKFLOW_SCAN_CHECK_IDS.length);
    assert.ok(result.skips.every((entry) => entry.note.includes('元本文値を保存していない')));
  });

  test('DS-221 selects only applicable generic HTTP checks', () => {
    const checks = resolveWorkflowScanCheckIds(['デジタル庁 DS-221']);
    assert.ok(checks.includes('security-headers'));
    assert.ok(checks.includes('cookie-security'));
    assert.ok(!checks.includes('dom-source-sink'));
    assert.ok(!checks.includes('sql-error'));
    assert.deepEqual(resolveWorkflowScanCheckIds(['OWASP ASVS 5.0']), WORKFLOW_SCAN_CHECK_IDS);
  });
});

describe('HTTP diagnostic pure helpers', () => {
  test('session sequence analysis is product independent', () => {
    assert.equal(analyzeSessionPattern(['1', '2', '3', '4'])?.name, '単純連番');
    const now = String(Math.floor(Date.now() / 1000));
    assert.equal(analyzeSessionPattern([now, now, now])?.name, '現在時刻');
    assert.equal(analyzeSessionPattern([md5Hex('7'), md5Hex('7')])?.name, '連番のMD5（7）');
  });

  test('repeating XOR and browser helpers remain reusable', () => {
    const key = new TextEncoder().encode('generalkey');
    const plain = new TextEncoder().encode('generic known plaintext long enough to repeat the complete key twice');
    const recovered = detectRepeatingKey(xorBytes(xorBytes(plain, key), plain));
    assert.equal(new TextDecoder().decode(recovered), 'generalkey');
    assert.ok(findDomSink('const value = location.search; document.write(value);') !== undefined);
    assert.equal(parseExternalScriptOrigins("script-src 'self' https://cdn.example.test")[0], 'https://cdn.example.test');
    assert.equal(tryGetHost('//redirect.example.test/path'), 'redirect.example.test');
    assert.equal(clientSideTokenCandidates('success').length, 3);
  });
});
