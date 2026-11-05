import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ObservedHttpRequest, PageObservation } from '@scopepilot2/contracts';
import type { ExplorationPort, LoginExecutionResult, LoginExecutorPort } from '../../../src/ports/engines.ts';
import { bootstrapFlow, type TestFlow } from '../support/test-flow.ts';

/**
 * login 実行時の観測から診断候補を合成する (design/f09):
 * SPA の XHR 裏付け認証 API (POST /login 相当) は探索では観測できない。
 * 秘密値が観測結果・候補・event へ露出しないことも確認する。
 */

class FakeLoginExecutor implements LoginExecutorPort {
  readonly engineVersion = 'fake-login-1';
  executions = 0;
  result: LoginExecutionResult = { authenticated: true, finalUrl: 'http://fixture.target.test/app', cookies: [] };

  async execute(): Promise<LoginExecutionResult> {
    this.executions += 1;
    return this.result;
  }
}

/** 探索観測に指定 URL の GET リクエストを含める fake explorer (重複判定の試験用)。 */
class RequestObservingExplorer implements ExplorationPort {
  readonly engineVersion = 'request-observing-1';
  private readonly requestUrls: readonly string[];

  constructor(requestUrls: readonly string[]) {
    this.requestUrls = requestUrls;
  }

  async observe(url: string): Promise<PageObservation> {
    return {
      url,
      status: 200,
      contentType: 'text/html',
      discoveredFrom: null,
      depth: 0,
      originType: 'crawl',
      links: [],
      forms: [],
      requests: this.requestUrls.map((requestUrl, index) => ({
        requestId: `browser-${String(index + 1).padStart(6, '0')}`,
        url: requestUrl,
        method: 'GET',
        resourceType: 'xhr',
        inputPoints: [],
        sourceUrl: url,
      })),
    };
  }
}

function observed(overrides: Partial<Omit<ObservedHttpRequest, 'contentType'>> & { readonly contentType?: string }): ObservedHttpRequest {
  return {
    requestId: 'login-000001',
    url: 'http://fixture.target.test/rest/user/login',
    method: 'POST',
    resourceType: 'xhr',
    contentType: 'application/json',
    inputPoints: [
      { name: 'email', location: 'body', type: 'json' },
      { name: 'password', location: 'body', type: 'json' },
    ],
    sourceUrl: 'http://fixture.target.test/',
    ...overrides,
  };
}

async function flowWithLogin(loginExecutor: FakeLoginExecutor, explorer?: ExplorationPort): Promise<TestFlow> {
  const flow = await bootstrapFlow({
    allowedOrigins: ['http://fixture.target.test'],
    allowedOperationClasses: ['Browse', 'ActiveScan'],
    loginExecutor,
    ...(explorer === undefined ? {} : { explorer }),
  });
  flow.service.registerLoginFlow(flow.operator, {
    role: 'user',
    flowVersion: 'v1',
    steps: [
      { kind: 'navigate', target: 'http://fixture.target.test/login' },
      { kind: 'assert', target: 'Dashboard' },
    ],
  });
  const login = await flow.service.runLogin(flow.operator, {
    role: 'user',
    baseUrl: 'http://fixture.target.test',
    secretValues: { 'login-secret': 'super-secret-login-value' },
    expectedUrlPrefix: 'http://fixture.target.test',
  });
  assert.equal(login.authenticated, true);
  return flow;
}

describe('探索: login 実行時の観測を診断候補へ合成する', () => {
  test('XHR 裏付けの認証 API が api-endpoint 候補になる (入力点・contentType 付き)', async () => {
    const loginExecutor = new FakeLoginExecutor();
    loginExecutor.result = {
      ...loginExecutor.result,
      observedRequests: [observed({})],
    };
    const flow = await flowWithLogin(loginExecutor);
    const { plan } = flow.service.buildExplorationPlan(flow.operator, ['http://fixture.target.test/']);
    flow.service.authorizePlan(plan);
    const confirmation = flow.service.confirmPlan(plan, flow.operator);
    const run = await flow.service.runExploration(flow.operator, plan, confirmation, { maxDepth: 1 });

    const loginCandidate = run.candidates.find(
      (candidate) => candidate.category === 'api-endpoint' && candidate.url === 'http://fixture.target.test/rest/user/login',
    );
    assert.ok(loginCandidate !== undefined, 'login API 候補が存在しない');
    assert.equal(loginCandidate.method, 'POST');
    assert.equal(loginCandidate.contentType, 'application/json');
    assert.deepEqual(loginCandidate.inputPoints, [
      { name: 'email', location: 'body', type: 'json' },
      { name: 'password', location: 'body', type: 'json' },
    ]);
    assert.match(loginCandidate.detectionReason ?? '', /login 実行時に観測/);
  });

  test('探索で既に観測済みのリクエストは重複して候補化しない', async () => {
    // 探索側の観測に /rest/user/whoami を含める (login 観測と同一リクエスト)。
    const explorer = new RequestObservingExplorer(['http://fixture.target.test/rest/user/whoami']);
    const loginExecutor = new FakeLoginExecutor();
    const whoamiRequest = observed({
      url: 'http://fixture.target.test/rest/user/whoami',
      method: 'GET',
      inputPoints: [],
    });
    const { contentType: _contentType, ...whoamiWithoutContentType } = whoamiRequest;
    loginExecutor.result = {
      ...loginExecutor.result,
      observedRequests: [whoamiWithoutContentType],
    };
    const flow = await flowWithLogin(loginExecutor, explorer);
    const { plan } = flow.service.buildExplorationPlan(flow.operator, ['http://fixture.target.test/']);
    flow.service.authorizePlan(plan);
    const confirmation = flow.service.confirmPlan(plan, flow.operator);
    const run = await flow.service.runExploration(flow.operator, plan, confirmation, { maxDepth: 1 });

    const whoami = run.candidates.filter(
      (candidate) => candidate.url === 'http://fixture.target.test/rest/user/whoami' && candidate.method === 'GET',
    );
    assert.equal(whoami.length, 1, '同一リクエストの候補が重複しない');
    assert.doesNotMatch(whoami[0]!.detectionReason ?? '', /login 実行時に観測/, '探索由来を優先する');
  });

  test('scope 外・session-control URL・秘密値は候補化しない', async () => {
    const loginExecutor = new FakeLoginExecutor();
    loginExecutor.result = {
      ...loginExecutor.result,
      observedRequests: [
        observed({ url: 'http://elsewhere.example/api/login' }),
        observed({ url: 'http://fixture.target.test/logout' }),
      ],
    };
    const flow = await flowWithLogin(loginExecutor);
    const { plan } = flow.service.buildExplorationPlan(flow.operator, ['http://fixture.target.test/']);
    flow.service.authorizePlan(plan);
    const confirmation = flow.service.confirmPlan(plan, flow.operator);
    const run = await flow.service.runExploration(flow.operator, plan, confirmation, { maxDepth: 1 });

    assert.ok(!run.candidates.some((candidate) => candidate.url.startsWith('http://elsewhere.example')));
    assert.ok(!run.candidates.some((candidate) => candidate.url === 'http://fixture.target.test/logout'));
    const exposed = JSON.stringify({ events: flow.service.events(), candidates: run.candidates });
    assert.ok(!exposed.includes('super-secret-login-value'), '秘密値は観測結果・候補へ出ない (入力点名のみ)');
  });

  test('観測が無い login は候補を合成しない', async () => {
    const loginExecutor = new FakeLoginExecutor();
    const flow = await flowWithLogin(loginExecutor);
    const { plan } = flow.service.buildExplorationPlan(flow.operator, ['http://fixture.target.test/']);
    flow.service.authorizePlan(plan);
    const confirmation = flow.service.confirmPlan(plan, flow.operator);
    const run = await flow.service.runExploration(flow.operator, plan, confirmation, { maxDepth: 1 });

    assert.ok(!run.candidates.some((candidate) => candidate.detectionReason?.includes('login 実行時に観測')));
  });
});
