import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, test } from 'node:test';
import {
  BaselineFlowService,
  InMemoryEvidenceStore,
  SequentialIdGenerator,
  SystemClock,
  type ActiveScanEnginePort,
} from '@scopepilot2/core';
import type { EngineCapabilitySnapshot, OperatorProfile } from '@scopepilot2/contracts';
import { PlaywrightLoginExecutor } from '../src/login-executor.ts';
import { PlaywrightExplorerAdapter } from '../src/playwright-explorer.ts';
import { PlaywrightInteractiveBrowser } from '../src/interactive-browser.ts';
import { startBrowserSessionSpaTarget } from './browser-session-spa-target.ts';
import { startVulnerableTarget } from './vulnerable-target.ts';

/**
 * 実 playwright (chromium) との結合検証。既定では skip し、
 * SCOPEPILOT_PLAYWRIGHT_IT=1 が設定されているときだけ実行する。
 * 対象は所有している vulnerable-target (127.0.0.1) のみ。
 */
const gated = process.env['SCOPEPILOT_PLAYWRIGHT_IT'] === '1' ? describe : describe.skip;

const OPERATOR: OperatorProfile = {
  operatorId: 'operator-owned-spa',
  displayName: 'Owned SPA integration',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

class UnusedScanEngine implements ActiveScanEnginePort {
  readonly engineVersion = 'unused-scan-engine';
  async start(): Promise<never> { throw new Error('scan is not used by this exploration integration test'); }
  async progress(): Promise<never> { throw new Error('scan is not used by this exploration integration test'); }
  async alerts(): Promise<never> { throw new Error('scan is not used by this exploration integration test'); }
  async stop(): Promise<void> {}
}

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

gated('Playwright explorer adapter (実 browser 結合)', () => {
  test('認証preflightはSPAのlocal/session storageを復元して描画後markerを確認する', { timeout: 60_000 }, async () => {
    const target = await startBrowserSessionSpaTarget();
    const loginExecutor = new PlaywrightLoginExecutor();
    const browser = new PlaywrightInteractiveBrowser();
    try {
      const login = await loginExecutor.execute({
        baseUrl: target.baseUrl,
        expectedUrlPrefix: target.appUrl,
        secretValues: { email: 'user@example.test', password: 'fixture-password-secret' },
        steps: [
          { kind: 'navigate', target: target.loginUrl },
          { kind: 'fill', target: 'input[name="email"]', secretReference: 'email' },
          { kind: 'fill', target: 'input[name="password"]', secretReference: 'password' },
          { kind: 'click', target: 'button[type="submit"]' },
          { kind: 'wait', target: '#state[data-ready="true"]' },
          { kind: 'assert', target: 'Dashboard ready' },
        ],
      });
      assert.equal(login.authenticated, true);
      assert.ok(login.browserState);

      const verification = await browser.execute({
        targetUrl: target.appUrl,
        scope: { allowedOrigins: [target.baseUrl], deniedOrigins: [] },
        browserSession: login.browserState,
        steps: [
          { kind: 'navigate', target: target.appUrl },
          { kind: 'wait', target: '#state[data-ready="true"]' },
          { kind: 'assert', target: 'Dashboard ready' },
        ],
      });
      assert.equal(verification.finalUrl, target.appUrl);
      assert.deepEqual(verification.assertions, [{ kind: 'assert', target: 'Dashboard ready', passed: true }]);
    } finally {
      await loginExecutor.close();
      await target.close();
    }
  });

  test('Bearer SPAのlocal/session storageをメモリ内で引き継ぎ、実API通信とSPAルートを探索する', { timeout: 120_000 }, async () => {
    const target = await startBrowserSessionSpaTarget();
    const explorer = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: [target.baseUrl], deniedOrigins: [] },
    });
    const loginExecutor = new PlaywrightLoginExecutor();
    try {
      const now = new Date();
      const capabilities: readonly EngineCapabilitySnapshot[] = [{
        engineKind: 'playwright',
        engineVersion: explorer.engineVersion,
        source: 'measured',
        guaranteeLevels: {
          preSendScopeEnforcement: 'Enforced',
          stopControl: 'Enforced',
          budgetLease: 'Enforced',
          rateLimit: 'Enforced',
        },
        maxOvershootRatio: 0,
        measuredAt: now.toISOString(),
      }];
      const service = new BaselineFlowService({
        clock: new SystemClock(),
        ids: new SequentialIdGenerator(),
        evidence: new InMemoryEvidenceStore(),
        explorer,
        scanEngine: new UnusedScanEngine(),
        capabilities,
        runtimeBundleHash: 'owned-bearer-spa-integration',
        loginExecutor,
      });
      service.createCase(OPERATOR, {
        name: 'Owned bearer SPA',
        allowedOrigins: [target.baseUrl],
        deniedOrigins: [],
        limits: { maxRequests: 50, maxPages: 20, maxDurationMinutes: 2 },
      });
      await service.grantAuthorization(OPERATOR, {
        allowedOperationClasses: ['Browse'],
        targetRoles: ['user'],
        validFrom: new Date(now.getTime() - 60_000).toISOString(),
        validUntil: new Date(now.getTime() + 60 * 60_000).toISOString(),
        evidence: { label: 'owned fixture', content: 'Local, owned SPA integration target' },
      });
      service.registerLoginFlow(OPERATOR, {
        role: 'user',
        flowVersion: 'generic-bearer-spa-v1',
        steps: [
          { kind: 'navigate', target: target.loginUrl },
          { kind: 'fill', target: 'input[name="email"]', secretReference: 'fixture-email' },
          { kind: 'fill', target: 'input[name="password"]', secretReference: 'fixture-password' },
          { kind: 'click', target: 'button[type="submit"]' },
          { kind: 'wait', target: '#state[data-ready="true"]' },
          { kind: 'assert', target: 'Dashboard ready' },
        ],
      });
      const login = await service.runLogin(OPERATOR, {
        role: 'user',
        baseUrl: target.baseUrl,
        secretValues: { 'fixture-email': 'user@example.test', 'fixture-password': 'fixture-password-secret' },
        expectedUrlPrefix: target.baseUrl,
      });
      assert.equal(login.authenticated, true);
      assert.deepEqual(login.cookieNames, [], 'Bearer SPA fixture intentionally has no authentication cookie');

      const { plan } = service.buildExplorationPlan(OPERATOR, [target.appUrl]);
      service.authorizePlan(plan);
      const confirmation = service.confirmPlan(plan, OPERATOR);
      const exploration = await service.runExploration(OPERATOR, plan, confirmation, { maxDepth: 2, role: 'user' });

      const observed = new Set(exploration.observations.map((entry) => entry.finalUrl ?? entry.url));
      assert.ok(observed.has(target.appUrl));
      assert.ok(observed.has(`${target.baseUrl}/app/profile`));
      assert.ok(observed.has(`${target.baseUrl}/app/orders`));
      assert.ok(observed.has(`${target.baseUrl}/app/reports`), 'route present only in an already-loaded script is crawled');
      assert.ok(observed.has(`${target.baseUrl}/app#settings`), 'fragment-based SPA route remains a distinct crawl identity');
      // 動的ルート: /api/orders の観測識別子 (7, 11) で app/detail/:id を具体化して巡回する。
      assert.ok(observed.has(`${target.baseUrl}/app/detail/7`), 'dynamic route instantiated with observed id 7');
      assert.ok(observed.has(`${target.baseUrl}/app/detail/11`), 'dynamic route instantiated with observed id 11');
      assert.ok(![...observed].some((url) => url.includes(':id')), 'route template is never navigated as-is');
      assert.deepEqual(new Set(target.authorizedApiPaths), new Set(['/api/me', '/api/profile', '/api/orders', '/api/reports', '/api/detail/7', '/api/detail/11']));
      assert.ok(exploration.candidates.some((candidate) => candidate.category === 'api-endpoint' && candidate.url === `${target.baseUrl}/api/me`));

      const exposedText = JSON.stringify({ events: service.events(), observations: exploration.observations, candidates: exploration.candidates });
      assert.ok(!exposedText.includes('owned-fixture-access-token'));
      assert.ok(!exposedText.includes('owned-fixture-session-marker'));
      assert.ok(!exposedText.includes('fixture-password-secret'));
    } finally {
      await explorer.close();
      await loginExecutor.close();
      await target.close();
    }
  });

  test(
    'observe: 実 chromium で title・絶対 link 取得。void(0) は除外',
    { timeout: 120_000 },
    async () => {
      const target = await startVulnerableTarget();
      const adapter = new PlaywrightExplorerAdapter({
        scope: { allowedOrigins: [target.base], deniedOrigins: [] },
      });
      try {
        const observation = await adapter.observe(target.indexUrl);
        assert.ok(observation !== null);
        assert.equal(observation.status, 200);
        assert.equal(observation.title, 'ScopePilot IT Target');
        assert.ok(observation.links.includes(target.echoUrl), `links に echo がない: ${observation.links.join(' ')}`);
        assert.ok(observation.links.includes(target.plainUrl), `links に plain がない: ${observation.links.join(' ')}`);
        assert.ok(observation.links.every((link) => link.startsWith('http://') || link.startsWith('https://')));
        assert.equal(adapter.engineVersionLabel, 'playwright-chromium');
      } finally {
        await adapter.close();
        target.server.close();
      }
    },
  );

  test('scope 外 URL は browser を起動すらしない (Enforced: 送信前拒否)', { timeout: 30_000 }, async () => {
    const target = await startVulnerableTarget();
    const adapter = new PlaywrightExplorerAdapter({
      // 全 origin 不許可: observe が browser context を作ったら検知できる。
      scope: { allowedOrigins: [], deniedOrigins: [target.base] },
    });
    try {
      const observation = await adapter.observe(target.indexUrl);
      assert.equal(observation, null);
      assert.equal(adapter.engineVersionLabel, 'playwright (未起動)');
    } finally {
      await adapter.close();
      target.server.close();
    }
  });

  test('scope 外の subresource・fetch・WebSocket は browser 送信前に遮断する', { timeout: 30_000 }, async () => {
    let outsideRequestCount = 0;
    const outside = createServer((_request, response) => {
      outsideRequestCount += 1;
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end('globalThis.outsideLoaded = true;');
    });
    outside.on('upgrade', (_request, socket) => {
      outsideRequestCount += 1;
      socket.destroy();
    });
    const outsideBase = await listenOnLoopback(outside);
    const outsideWebSocket = outsideBase.replace(/^http:/, 'ws:');
    const inside = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end([
        '<!doctype html><title>Scoped page</title>',
        `<script src="${outsideBase}/outside.js"></script>`,
        `<script>fetch('${outsideBase}/outside.json').catch(() => undefined)</script>`,
        `<script>new WebSocket('${outsideWebSocket}/outside.ws')</script>`,
        `<img src="${outsideBase}/outside.png">`,
      ].join(''));
    });
    const insideBase = await listenOnLoopback(inside);
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: [insideBase], deniedOrigins: [outsideBase] },
    });
    try {
      const observation = await adapter.observe(`${insideBase}/`);
      assert.equal(observation?.status, 200);
      assert.equal(outsideRequestCount, 0, 'denied origin must receive no HTTP or WebSocket handshake');
      assert.ok(observation?.requests?.every((request) => new URL(request.url).origin === insideBase));
    } finally {
      await adapter.close();
      await closeServer(inside);
      await closeServer(outside);
    }
  });

  test('404 は status 観測のみ (link 抽出なし)', { timeout: 60_000 }, async () => {
    const target = await startVulnerableTarget();
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: [target.base], deniedOrigins: [] },
    });
    try {
      const observation = await adapter.observe(`${target.base}/missing`);
      assert.ok(observation !== null);
      assert.equal(observation.status, 404);
      assert.deepEqual(observation.links, []);
    } finally {
      await adapter.close();
      target.server.close();
    }
  });

  test('attachment 応答は実 chromium でも探索を中断しない', { timeout: 60_000 }, async () => {
    const target = await startVulnerableTarget();
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: [target.base], deniedOrigins: [] },
    });
    try {
      const observation = await adapter.observe(target.downloadUrl);
      assert.ok(observation !== null);
      assert.equal(observation.url, target.downloadUrl);
      assert.equal(observation.status, 200);
      assert.equal(observation.contentType, 'application/octet-stream');
      assert.deepEqual(observation.links, []);
      assert.deepEqual(observation.forms, []);
    } finally {
      await adapter.close();
      target.server.close();
    }
  });

  test('payload 実行検証: innerHTML 反射 XSS の alert 発火を検出し、無害 URL は実行なしと判定する', { timeout: 60_000 }, async () => {
    const target = await startVulnerableTarget();
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: [target.base], deniedOrigins: [] },
    });
    try {
      const malicious = await adapter.verifyPayloadExecution(target.xssUrl('<img src=x onerror="alert(\'scopepilot-xss-proof\')">'));
      assert.equal(malicious.executed, true, `dialog が検出されない: ${JSON.stringify(malicious.signals)}`);
      assert.ok(malicious.signals.some((signal) => signal.includes('scopepilot-xss-proof')));

      const benign = await adapter.verifyPayloadExecution(target.xssUrl('plain text'));
      assert.equal(benign.executed, false);

      // scope 外の検証 URL は送信前に拒否する。
      await assert.rejects(
        () => adapter.verifyPayloadExecution(`http://elsewhere.example/xss?q=x`),
        /denied by scope/,
      );
    } finally {
      await adapter.close();
      target.server.close();
    }
  });
});

gated('GO-31 owned workflow observation', () => {
  test('reviewed click records runtime history/hash routes and request metadata without body values', { timeout: 30000 }, async () => {
    const server = createServer((req, res) => {
      if (req.url === '/api/events') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<button id="open">Open</button><script>
        document.querySelector('#open').onclick = async () => {
          await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'private-canary-value' }) });
          history.pushState({}, '', '/runtime/' + (20 + 22));
          location.hash = '/panel/' + (40 + 2);
          document.body.insertAdjacentHTML('beforeend', '<p id="ready">Ready</p>');
        };
      </script>`);
    });
    const origin = await listenOnLoopback(server);
    try {
      const browser = new PlaywrightInteractiveBrowser();
      const result = await browser.execute({ targetUrl: origin, scope: { allowedOrigins: [origin], deniedOrigins: [] }, steps: [{ kind: 'navigate', target: origin }, { kind: 'click', target: '#open' }, { kind: 'wait', target: '#ready' }], maxRequests: 20 });
      assert.ok(result.clientRoutes?.some((route) => route.source === 'history' && route.url.endsWith('/runtime/42')));
      assert.ok(result.clientRoutes?.some((route) => route.source === 'hash' && route.url.includes('#/panel/42')));
      const request = result.observedRequests?.find((request) => request.method === 'POST');
      assert.equal(request?.inputPoints[0]?.name, 'note');
      assert.equal(JSON.stringify(result.observedRequests).includes('private-canary-value'), false);
      const controller = new AbortController(); controller.abort();
      await assert.rejects(browser.execute({ targetUrl: origin, scope: { allowedOrigins: [origin], deniedOrigins: [] }, steps: [{ kind: 'navigate', target: origin }], signal: controller.signal }), /abort/i);
    } finally { await closeServer(server); }
  });
});

gated('GO-31 browser discovery budgets', () => {
  test('subrequest budget blocks additional sends and worker registration attempts stay distinguishable', { timeout: 30000 }, async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url!);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<script>
        navigator.serviceWorker.register('/owned-worker.js').catch(() => {});
        fetch('/extra-a').catch(() => {}); fetch('/extra-b').catch(() => {});
      </script><p>Owned page</p>`);
    });
    const origin = await listenOnLoopback(server);
    const explorer = new PlaywrightExplorerAdapter({ scope: { allowedOrigins: [origin], deniedOrigins: [] } });
    try {
      let sent = 0;
      const observation = await explorer.observe(origin, { timeoutMs: 10000, consumeRequest: () => { if (sent >= 1) return false; sent++; return true; } });
      assert.equal(sent, 1);
      assert.deepEqual(hits, ['/']);
      assert.ok(observation?.serviceWorkerRegistrations?.some((registration) => registration.url === `${origin}/owned-worker.js` && registration.status === 'attempted'));
    } finally { await explorer.close(); await closeServer(server); }
  });
});
