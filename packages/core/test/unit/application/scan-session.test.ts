import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoginExecutionInput, LoginExecutorPort, LoginSessionCookie } from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * 能動診断 (F11) への role session 適用 (design/08)。scan request には適用 cookie の
 * 名前のみが添えられる (値は入れない — API 応答に scanRequest が映るため)。
 */
describe('active scan session (design/08)', () => {
  test('role 指定の診断は適用 cookie 名を scan request に添える。未登録 role は拒否', async () => {
    const executor = new (class implements LoginExecutorPort {
      readonly engineVersion = 'fake-login-1';
      nextCookies: readonly LoginSessionCookie[] = [{ name: 'PHPSESSID', value: 'session-value', domain: 'fixture.target.test', path: '/' }];
      async execute(
        input: LoginExecutionInput,
      ): Promise<{ authenticated: boolean; finalUrl: string; cookies: readonly LoginSessionCookie[] }> {
        return { authenticated: true, finalUrl: 'http://fixture.target.test/', cookies: [...this.nextCookies] };
      }
    })();
    const { service, operator, scanEngine } = await bootstrapFlow({ loginExecutor: executor });
    service.registerLoginFlow(operator, {
      role: 'admin',
      flowVersion: 'f1',
      steps: [
        { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
        { kind: 'fill', target: '#u', secretReference: 'vault://admin-user' },
        { kind: 'fill', target: '#p', secretReference: 'vault://admin-pass' },
        { kind: 'click', target: 'input[type=submit]' },
        { kind: 'assert', target: 'Welcome' },
      ],
    });
    await service.runLogin(operator, {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });

    const { plan } = service.buildActiveScanPlan(operator, ['http://fixture.target.test/', 'http://fixture.target.test/login.php']);
    service.authorizePlan(plan);
    const confirmation = service.confirmPlan(plan, operator);
    const adopted = [
      { candidateId: 'c1', url: 'http://fixture.target.test/', method: 'GET' as const, category: 'page' as const, guidelineBasis: [], confidence: 0.5, observationUrl: 'http://fixture.target.test/' },
    ];
    const result = await service.runActiveScan(operator, plan, confirmation, adopted, 'admin');
    assert.equal(result.runRecord.state, 'Completed');
    assert.deepEqual(result.scanRequest.sessionCookieNames, ['PHPSESSID']);
    assert.equal(scanEngine.startCalls[0]?.sessionCookies[0]?.value, 'session-value', 'cookie value reaches only the engine execution context');
    assert.equal(scanEngine.startCalls[0]?.requestSeeds.length, 1);
    assert.equal(JSON.stringify(result.scanRequest).includes('session-value'), false, 'cookie 値は要求に入れない');

    // role 未指定は従来どおり session なし。
    const plain = await service.runActiveScan(operator, plan, service.confirmPlan(plan, operator), adopted);
    assert.equal(plain.scanRequest.sessionCookieNames, undefined);

    // 未登録 role は拒否。
    await assert.rejects(service.runActiveScan(operator, plan, confirmation, adopted, 'ghost'), /no session for role/);

    // 対象 URL のどれにも一致しない domain の cookie は添えない。
    executor.nextCookies = [{ name: 'OTHER', value: 'v', domain: 'elsewhere.example', path: '/' }];
    await service.runLogin(operator, {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });
    const filtered = await service.runActiveScan(operator, plan, service.confirmPlan(plan, operator), adopted, 'admin');
    assert.deepEqual(filtered.scanRequest.sessionCookieNames, [], '別 Origin の cookie は適用しない');
  });

  test('browser-dom経路はPlaywright観測を実行し、fingerprint化した候補を所見へ取り込む', async () => {
    const { service, operator } = await bootstrapFlow({
      domObserver: {
        async observe() {
          return {
            observations: [
              { api: 'location.search', marker: 'scopepilot-dom-marker' },
              { api: 'innerHTML', marker: 'scopepilot-dom-marker' },
            ],
            nodes: [],
          };
        },
      },
    });
    const target = 'http://fixture.target.test/vulnerabilities/xss_d/?default=English';
    const { plan } = service.buildActiveScanPlan(operator, [target]);
    service.authorizePlan(plan);
    const result = await service.runActiveScan(operator, plan, service.confirmPlan(plan, operator), [{
      candidateId: 'dom-1',
      url: target,
      method: 'GET',
      category: 'page',
      guidelineBasis: [],
      confidence: 0.8,
      observationUrl: target,
      diagnosticTracks: ['zap-active', 'browser-dom'],
      inputPoints: [{ name: 'default', location: 'query', type: 'text' }],
    }]);

    const domRoute = result.diagnosticRoutes.find((route) => route.track === 'browser-dom');
    assert.equal(domRoute?.status, 'executed');
    assert.equal(domRoute?.findingCount, 1);
    const domFinding = result.findings.find((finding) => finding.source.kind === 'observation');
    assert.equal(domFinding?.severity, 'low');
    assert.equal(JSON.stringify(result).includes('scopepilot-dom-marker'), false);
  });

  test('credential-changing forms stay in the interactive workflow and are not seeded into ZAP', async () => {
    const { service, operator, scanEngine } = await bootstrapFlow();
    const safeTarget = 'http://fixture.target.test/vulnerabilities/sqli/?id=1';
    const mutationTarget = 'http://fixture.target.test/vulnerabilities/csrf/';
    const { plan } = service.buildActiveScanPlan(operator, [safeTarget, mutationTarget]);
    service.authorizePlan(plan);
    const result = await service.runActiveScan(operator, plan, service.confirmPlan(plan, operator), [{
      candidateId: 'safe', url: safeTarget, method: 'GET', category: 'page', guidelineBasis: [], confidence: 1,
      observationUrl: safeTarget, inputPoints: [{ name: 'id', location: 'query', type: 'text' }], diagnosticTracks: ['zap-active'],
    }, {
      candidateId: 'credential-change', url: mutationTarget, method: 'GET', category: 'form', guidelineBasis: [], confidence: 1,
      observationUrl: mutationTarget,
      inputPoints: [
        { name: 'password_new', location: 'query', type: 'password' },
        { name: 'password_conf', location: 'query', type: 'password' },
        { name: 'Change', location: 'query', type: 'submit' },
      ],
      diagnosticTracks: ['zap-active', 'workflow-state'],
    }]);

    assert.deepEqual(scanEngine.startCalls[0]?.requestSeeds.map((seed) => seed.url), [safeTarget]);
    assert.equal(result.scanRequest.requestSeedCount, 1);
    assert.equal(result.diagnosticRoutes.some((route) => route.track === 'zap-active' && route.targetUrl === mutationTarget), false);
    assert.equal(result.diagnosticRoutes.find((route) => route.track === 'workflow-state' && route.targetUrl === mutationTarget)?.status, 'needs-input');
  });
});


describe('ca profiles (design/24)', () => {
  test('profile 一覧は fingerprint・期限・信頼状態を返し、信頼変更は監査に残る', async () => {
    const { service, operator } = await bootstrapFlow();
    const before = service.listCaProfiles();
    assert.equal(before.length, 1);
    assert.equal(before[0]?.profileId, 'scopepilot2-diagnostics');
    assert.equal(before[0]?.trusted, false);
    assert.match(before[0]?.fingerprint ?? '', /^[0-9a-f]{32}$/);

    const changed = service.setCaProfileTrust(operator, 'scopepilot2-diagnostics', true);
    assert.deepEqual(changed, { profileId: 'scopepilot2-diagnostics', trusted: true });
    assert.equal(service.listCaProfiles()[0]?.trusted, true);
    assert.ok(JSON.stringify(service.events()).includes('CaProfileTrustChanged'));

    assert.throws(
      () => service.setCaProfileTrust(operator, 'unknown-profile', true),
      /unknown CA profile/,
    );
  });
});
