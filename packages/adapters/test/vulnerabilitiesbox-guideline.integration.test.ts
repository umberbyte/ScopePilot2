import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoginExecutorPort } from '@scopepilot2/core';
import { NodeRepeaterTransport } from '../src/repeater-transport.ts';
import { NodeWebSocketTransport } from '../src/websocket-transport.ts';
import { bootstrapFlow } from '../../core/test/unit/support/test-flow.ts';

const baseUrl = process.env['SCOPEPILOT_VBOX_BASE_URL'] ?? '';
const loginPath = process.env['SCOPEPILOT_VBOX_LOGIN_PATH'] ?? '';
const targetPath = process.env['SCOPEPILOT_VBOX_TARGET_PATH'] ?? '';
const tokenPath = process.env['SCOPEPILOT_VBOX_TOKEN_PATH'] ?? '';
const protectedPath = process.env['SCOPEPILOT_VBOX_PROTECTED_PATH'] ?? '';
const kind = process.env['SCOPEPILOT_VBOX_CHECK_KIND'] ?? '';
const expected = process.env['SCOPEPILOT_VBOX_EXPECTED'] ?? '';
const gated = baseUrl !== '' && loginPath !== '' && targetPath !== '' && ['graphql', 'websocket', 'mail-header', 'jwt', 'ldap-injection', 'xpath-injection', 'ssrf', 'mfa-stage'].includes(kind) && ['exposed', 'denied'].includes(expected)
  ? describe
  : describe.skip;

async function authenticatedCookie(): Promise<{ name: string; value: string; domain: string; path: string }> {
  const loginUrl = new URL(loginPath, baseUrl);
  const username = kind === 'jwt' ? 'admin' : 'alice';
  const password = `Fixture-${username}-2026!`;
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
    redirect: 'manual',
  });
  assert.equal(response.status, 200);
  const raw = response.headers.getSetCookie().find((value) => value.startsWith('sid='));
  assert.ok(raw !== undefined, 'sid cookie was not issued');
  const value = /^sid=([^;]+)/u.exec(raw)?.[1];
  assert.ok(value !== undefined && value !== '');
  return { name: 'sid', value, domain: loginUrl.hostname, path: '/' };
}

gated('vulnerabilitiesBox補助fixture ガイドライン診断', () => {
  test(`${kind} のV/F境界をScopePilotのZAP非対応テーマで判定する`, { timeout: 60_000 }, async () => {
    const cookie = await authenticatedCookie();
    const loginExecutor: LoginExecutorPort = {
      engineVersion: 'vulnerabilitiesbox-session-fixture-v1',
      execute: async (input) => ({
        authenticated: true,
        finalUrl: input.expectedUrlPrefix,
        cookies: [cookie],
      }),
    };
    const { service, operator } = await bootstrapFlow({
      allowedOrigins: [new URL(baseUrl).origin],
      loginExecutor,
      repeaterTransport: new NodeRepeaterTransport({ timeoutMs: 10_000 }),
      webSocketTransport: new NodeWebSocketTransport({ connectTimeoutMs: 5_000, responseWaitMs: 150 }),
    });
    service.registerLoginFlow(operator, {
      role: 'member',
      flowVersion: 'vbox-session-v1',
      steps: [
        { kind: 'fill', target: 'username', secretReference: 'username' },
        { kind: 'fill', target: 'password', secretReference: 'password' },
        { kind: 'assert', target: 'authenticated' },
      ],
    });
    await service.runLogin(operator, {
      role: 'member',
      baseUrl,
      expectedUrlPrefix: baseUrl,
      secretValues: {
        username: kind === 'jwt' ? 'admin' : 'alice',
        password: kind === 'jwt' ? 'Fixture-admin-2026!' : 'Fixture-alice-2026!',
      },
    });
    const targetUrl = new URL(targetPath, baseUrl).toString();
    if (kind === 'mfa-stage') {
      assert.ok(protectedPath !== '', 'SCOPEPILOT_VBOX_PROTECTED_PATH is required for mfa-stage');
      const result = await service.runZapUnsupportedCheck(operator, {
        themeNo: '6',
        targetUrls: [targetUrl, new URL(protectedPath, baseUrl).toString()],
        secretValues: { username: 'alice', password: 'Fixture-alice-2026!' },
      });
      assert.equal(result.results.find((probe) => probe.pattern === 'mfa-stage-skip')?.outcome, expected);
      return;
    }
    if (kind === 'jwt') {
      assert.ok(tokenPath !== '', 'SCOPEPILOT_VBOX_TOKEN_PATH is required for jwt');
      const issued = await fetch(new URL(tokenPath, baseUrl), { headers: { Cookie: `${cookie.name}=${cookie.value}` } });
      assert.equal(issued.status, 200);
      const validToken = (await issued.json() as { token?: string }).token;
      assert.ok(validToken !== undefined && validToken !== '');
      const result = await service.runZapUnsupportedCheck(operator, {
        themeNo: '9',
        targetUrls: [targetUrl],
        secretValues: { validToken },
      });
      assert.equal(result.results.find((probe) => probe.pattern === 'jwt-alg-none')?.outcome, expected);
      return;
    }
    if (kind === 'graphql') {
      const result = await service.runZapUnsupportedCheck(operator, {
        themeNo: '26',
        role: 'member',
        targetUrls: [targetUrl],
        params: {
          baselineQuery: '{node{label child{label}}}',
          deepQuery: '{node{child{child{child{label}}}}}',
        },
      });
      assert.equal(result.results.find((probe) => probe.pattern === 'graphql-depth-cost')?.outcome, expected);
      return;
    }
    if (kind === 'ldap-injection') {
      const result = await service.runZapUnsupportedCheck(operator, {
        themeNo: '15',
        role: 'member',
        targetUrls: [targetUrl],
        params: {
          pattern: 'ldap-filter',
          baselineJson: JSON.stringify({ uid: 'alice' }),
          variantJson: JSON.stringify({ uid: '*)(uid=*' }),
          successMarker: 'Bob Private',
        },
      });
      assert.equal(result.results.find((probe) => probe.pattern === 'injection:ldap-filter')?.outcome, expected);
      return;
    }
    if (kind === 'xpath-injection') {
      const result = await service.runZapUnsupportedCheck(operator, {
        themeNo: '15',
        role: 'member',
        targetUrls: [targetUrl],
        params: {
          pattern: 'xpath-expression',
          baselineJson: JSON.stringify({ operation: 'normal', xpathValue: 'alice' }),
          variantJson: JSON.stringify({ operation: 'boundary', xpathValue: "missing' or @name='bob" }),
          successMarker: 'canary_',
        },
      });
      assert.equal(result.results.find((probe) => probe.pattern === 'injection:xpath-expression')?.outcome, expected);
      return;
    }
    if (kind === 'ssrf') {
      const result = await service.runZapUnsupportedCheck(operator, {
        themeNo: '16',
        role: 'member',
        targetUrls: [targetUrl],
        params: {
          baselineJson: JSON.stringify({ url: 'http://public.fixture.test/' }),
          fieldName: 'url',
          probeUrl: 'http://internal.fixture.test/',
          successMarker: '"target":"private"',
        },
      });
      assert.equal(result.results.find((probe) => probe.pattern === 'ssrf-reviewed-probe')?.outcome, expected);
      return;
    }
    if (kind === 'websocket') {
      const result = await service.runZapUnsupportedCheck(operator, {
        themeNo: '27',
        role: 'member',
        targetUrls: [targetUrl],
        params: { evilOrigins: 'http://evil.benchmark.test:8080', message: '{"action":"report"}' },
      });
      assert.equal(result.results.find((probe) => probe.pattern.startsWith('websocket-cross-origin:'))?.outcome, expected);
      return;
    }
    const result = await service.runZapUnsupportedCheck(operator, {
      themeNo: '14',
      role: 'member',
      targetUrls: [targetUrl],
    });
    assert.equal(result.results.find((probe) => probe.pattern === 'mail-header-crlf')?.outcome, expected);
  });
});
