/**
 * Juice Shop 実測ハーネス (ベンチマーク測定専用)。
 *
 * 使用法: SCOPEPILOT 測定用環境変数を設定して node test/juice-shop-crawl-measure.ts
 *   JUICE_SHOP_BASE_URL / JUICE_SHOP_LOGIN_EMAIL / JUICE_SHOP_LOGIN_PASSWORD /
 *   JUICE_SHOP_ROLE (admin|user) / JUICE_SHOP_MAX_DEPTH
 *
 * 一般化実装の実測 (認証後クローリング・動的ルート具体化) だけを確認する。
 * Juice Shop 固有の知識 (セレクタ・文言) は本測定スクリプトにだけ存在し、
 * 製品コードには持ち込まない。
 */
import assert from 'node:assert/strict';
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

const baseUrl = process.env.JUICE_SHOP_BASE_URL ?? '';
assert.notEqual(baseUrl, '', 'JUICE_SHOP_BASE_URL is required');
const loginEmail = process.env.JUICE_SHOP_LOGIN_EMAIL ?? '';
const loginPassword = process.env.JUICE_SHOP_LOGIN_PASSWORD ?? '';
const role = process.env.JUICE_SHOP_ROLE ?? 'admin';
const maxDepth = Number(process.env.JUICE_SHOP_MAX_DEPTH ?? '2');

class UnusedScanEngine implements ActiveScanEnginePort {
  readonly engineVersion = 'unused';
  async start(): Promise<never> { throw new Error('not used'); }
  async progress(): Promise<never> { throw new Error('not used'); }
  async alerts(): Promise<never> { throw new Error('not used'); }
  async stop(): Promise<void> {}
}

const OPERATOR: OperatorProfile = {
  operatorId: 'operator-juice-shop-measure',
  displayName: 'Juice Shop measurement',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

const explorer = new PlaywrightExplorerAdapter({ scope: { allowedOrigins: [baseUrl], deniedOrigins: [] } });
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
    runtimeBundleHash: 'juice-shop-measurement',
    loginExecutor,
  });
  service.createCase(OPERATOR, {
    name: 'Juice Shop measurement',
    allowedOrigins: [baseUrl],
    deniedOrigins: [],
    limits: { maxRequests: 500, maxPages: 300, maxDurationMinutes: 30 },
  });
  await service.grantAuthorization(OPERATOR, {
    allowedOperationClasses: ['Browse'],
    targetRoles: [role],
    validFrom: new Date(now.getTime() - 60_000).toISOString(),
    validUntil: new Date(now.getTime() + 60 * 60_000).toISOString(),
    evidence: { label: 'owned benchmark', content: 'Local Juice Shop benchmark instance (explicit user request)' },
  });
  service.registerLoginFlow(OPERATOR, {
    role,
    flowVersion: 'generic-email-password-v1',
    steps: [
      { kind: 'navigate', target: '/#/login' },
      // 初回表示の welcome dialog が modal overlay で画面を覆うため先に閉じる。
      { kind: 'wait', target: 'app-welcome-banner .close-dialog' },
      { kind: 'click', target: 'app-welcome-banner .close-dialog' },
      { kind: 'fill', target: '#email', secretReference: 'login-email' },
      { kind: 'fill', target: '#password', secretReference: 'login-password' },
      { kind: 'click', target: '#loginButton' },
      { kind: 'wait', target: 'app-search-result' },
      { kind: 'assert', target: 'All Products' },
    ],
  });
  const login = await service.runLogin(OPERATOR, {
    role,
    baseUrl,
    secretValues: { 'login-email': loginEmail, 'login-password': loginPassword },
    expectedUrlPrefix: baseUrl,
  });
  console.log(`login.authenticated = ${login.authenticated}`);
  assert.equal(login.authenticated, true, 'login must succeed');

  const { plan } = service.buildExplorationPlan(OPERATOR, [`${baseUrl}/`]);
  service.authorizePlan(plan);
  const confirmation = service.confirmPlan(plan, OPERATOR);

  // API 仕様取込 (任意): JUICE_SHOP_API_SPEC_PATH に OpenAPI JSON を渡すと
  // 取込済み endpoint が探索候補へ合成される (書き込み API を含む)。
  const specPath = process.env.JUICE_SHOP_API_SPEC_PATH ?? '';
  if (specPath !== '') {
    const { readFileSync } = await import('node:fs');
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as unknown;
    const imported = service.importApiSpec(OPERATOR, { documentLabel: 'measure-spec', document: spec });
    console.log(`api spec imported: ${imported.endpoints.length} endpoints from ${imported.servers.join(', ')}`);
  }

  const startedAt = Date.now();
  const exploration = await service.runExploration(OPERATOR, plan, confirmation, { maxDepth, role });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  const observations = exploration.observations;
  const urls = observations.map((entry) => entry.finalUrl ?? entry.url);
  const failed = observations.filter((entry) => entry.status >= 400);
  const apiPaths = new Set<string>();
  for (const observation of observations) {
    for (const request of observation.requests ?? []) {
      const pathname = new URL(request.url).pathname;
      apiPaths.add(`${request.method} ${pathname.replace(/\/[^/]+$/, '/')}`);
    }
  }
  const templateUrls = observations.flatMap((entry) => entry.routeTemplates ?? []);
  const instantiated = observations.filter((entry) => (entry.discoveredFrom ?? '') !== '' && /\/\d+(?:[/?#]|$)/.test(entry.url));

  console.log('--- summary ---');
  console.log(`elapsed: ${elapsedSec}s (depth ${maxDepth})`);
  console.log(`visited unique URLs: ${urls.length}`);
  console.log(`failed (>=400): ${failed.length}`);
  for (const entry of failed.slice(0, 10)) console.log(`  ${entry.status} ${entry.url}`);
  console.log(`observed API path shapes: ${apiPaths.size}`);
  for (const path of [...apiPaths].sort()) console.log(`  ${path}`);
  console.log(`route templates observed: ${new Set(templateUrls).size}`);
  for (const template of [...new Set(templateUrls)].sort()) console.log(`  ${template}`);
  console.log(`instantiated dynamic-route visits (numeric last segment): ${instantiated.length}`);
  for (const entry of instantiated.slice(0, 20)) console.log(`  <- ${entry.discoveredFrom} : ${entry.url}`);
  const byDepth = new Map<number, number>();
  for (const entry of observations) byDepth.set(entry.depth, (byDepth.get(entry.depth) ?? 0) + 1);
  console.log(`by depth: ${JSON.stringify([...byDepth.entries()])}`);
  const deniedCount = exploration.deniedUrls.length;
  console.log(`denied URLs: ${deniedCount}`);
  console.log(`candidates: ${exploration.candidates.length}`);

  // 診断適用可能判定のための観測ダンプ (チャレンジ対応表との交差に使う)。
  const dumpPath = process.env.JUICE_SHOP_DUMP_PATH;
  if (dumpPath !== undefined && dumpPath !== '') {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dumpPath, JSON.stringify({
      baseUrl,
      role,
      visitedUrls: urls,
      apiPathShapes: [...apiPaths].sort(),
      candidates: exploration.candidates.map((candidate) => ({
        url: candidate.url,
        method: candidate.method,
        category: candidate.category,
        inputPoints: candidate.inputPoints ?? [],
        diagnosticTracks: candidate.diagnosticTracks ?? [],
      })),
    }, null, 1), 'utf8');
    console.log(`observation dump: ${dumpPath}`);
  }
} finally {
  await explorer.close();
  await loginExecutor.close();
}
