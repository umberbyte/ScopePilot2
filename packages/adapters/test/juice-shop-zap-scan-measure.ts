/**
 * Juice Shop ZAP 能動診断の実測ハーネス (ベンチマーク測定専用)。
 *
 * 使用法: env JUICE_SHOP_BASE_URL=... [JUICE_SHOP_ROLE=none|user|admin
 *   JUICE_SHOP_LOGIN_EMAIL=... JUICE_SHOP_LOGIN_PASSWORD=...] node test/juice-shop-zap-scan-measure.ts
 *
 * 製品と同じ構成 (composeEngines: ZAP daemon 自前起動・探索は ZAP proxy 経由・
 * login は隔離 browser・cookie を scan へ明示渡し) で「探索→候補→ZAP 診断→取込」を
 * 通しで実行し、challenge の解決差分と findings を記録する。
 * Juice Shop 固有の知識は本測定スクリプトにだけ存在する。
 */
import assert from 'node:assert/strict';
import {
  BaselineFlowService,
  InMemoryEvidenceStore,
  ScopePolicy,
  SequentialIdGenerator,
  SystemClock,
} from '@scopepilot2/core';
import type { OperatorProfile, ScanCandidate } from '@scopepilot2/contracts';
import { composeEngines } from '../src/engine-config.ts';

const baseUrl = process.env.JUICE_SHOP_BASE_URL ?? '';
assert.notEqual(baseUrl, '', 'JUICE_SHOP_BASE_URL is required');
const role = process.env.JUICE_SHOP_ROLE ?? 'none';
const loginEmail = process.env.JUICE_SHOP_LOGIN_EMAIL ?? '';
const loginPassword = process.env.JUICE_SHOP_LOGIN_PASSWORD ?? '';
const targetCap = Number(process.env.JUICE_SHOP_TARGET_CAP ?? '40');
const explorePages = Number(process.env.JUICE_SHOP_EXPLORE_PAGES ?? '60');
const scanRequests = Number(process.env.JUICE_SHOP_SCAN_REQUESTS ?? '3000');

interface ChallengeEntry {
  readonly key: string;
  readonly name: string;
  readonly category: string;
  readonly solved: boolean;
}

async function challenges(): Promise<readonly ChallengeEntry[]> {
  const response = await fetch(`${baseUrl}/api/Challenges`, { signal: AbortSignal.timeout(15_000) });
  const payload = await response.json() as { data?: readonly ChallengeEntry[] };
  return (payload.data ?? []).map((entry) => ({ key: entry.key, name: entry.name, category: entry.category, solved: entry.solved }));
}

const OPERATOR: OperatorProfile = {
  operatorId: 'operator-juice-shop-measure',
  displayName: 'Juice Shop ZAP measurement',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

const before = await challenges();
const solvedBefore = new Set(before.filter((entry) => entry.solved).map((entry) => entry.key));
console.log(`challenges before: ${before.length} total, ${solvedBefore.size} solved`);

const engines = await composeEngines(process.env, [new URL(baseUrl).origin]);
console.log(`engines: zap=${engines.scanEngine.engineVersion} explorer=${engines.explorer.engineVersion}`);
const service = new BaselineFlowService({
  clock: new SystemClock(),
  ids: new SequentialIdGenerator(),
  evidence: new InMemoryEvidenceStore(),
  explorer: engines.explorer,
  scanEngine: engines.scanEngine,
  loginExecutor: engines.loginExecutor,
  capabilities: engines.capabilities,
  runtimeBundleHash: engines.runtimeBundleHash,
  workflowScanTransportFactory: engines.workflowScanTransportFactory,
});
try {
  const now = new Date();
  service.createCase(OPERATOR, {
    name: 'Juice Shop ZAP measurement',
    allowedOrigins: [new URL(baseUrl).origin],
    deniedOrigins: [],
    limits: { maxRequests: scanRequests + explorePages * 8, maxPages: explorePages * 2, maxDurationMinutes: 120 },
  });
  engines.updateExplorationScope?.({ allowedOrigins: [new URL(baseUrl).origin], deniedOrigins: [] });
  await service.grantAuthorization(OPERATOR, {
    allowedOperationClasses: ['Browse', 'ActiveScan'],
    targetRoles: [role === 'none' ? 'unauthenticated' : role],
    validFrom: new Date(now.getTime() - 60_000).toISOString(),
    validUntil: new Date(now.getTime() + 120 * 60_000).toISOString(),
    evidence: { label: 'owned benchmark', content: 'Local Juice Shop benchmark instance (explicit user request)' },
  });

  if (role !== 'none') {
    service.registerLoginFlow(OPERATOR, {
      role,
      flowVersion: 'generic-email-password-v1',
      steps: [
        { kind: 'navigate', target: '/#/login' },
        { kind: 'wait', target: 'app-welcome-banner .close-dialog' },
        { kind: 'click', target: 'app-welcome-banner .close-dialog' },
        { kind: 'fill', target: '#email', secretReference: 'login-email' },
        { kind: 'fill', target: '#password', secretReference: 'login-password' },
        { kind: 'click', target: '#loginButton' },
        { kind: 'wait', target: 'app-search-result' },
        // ZAP の認証プレフライトは素の HTTP 再生で marker を検証するため、
        // SPA hash 画面ではなく応答本文が認証状態を反映する API で終える。
        { kind: 'navigate', target: '/rest/user/whoami' },
        { kind: 'assert', target: '"email"' },
      ],
    });
    const login = await service.runLogin(OPERATOR, {
      role,
      baseUrl,
      secretValues: { 'login-email': loginEmail, 'login-password': loginPassword },
      expectedUrlPrefix: baseUrl,
    });
    console.log(`login.authenticated = ${login.authenticated} (cookies: ${login.cookieNames.join(',')})`);
    assert.equal(login.authenticated, true, 'login must succeed');
  }

  // 探索 (ZAP proxy 経由なので browser 通信がそのまま ZAP の site tree を構築する)。
  const { plan: explorePlan } = service.buildExplorationPlan(OPERATOR, [`${baseUrl}/`], {
    maxRequests: explorePages * 8,
    maxPages: explorePages,
    maxDurationMinutes: 60,
  });
  service.authorizePlan(explorePlan);
  const exploreConfirmation = service.confirmPlan(explorePlan, OPERATOR);
  const exploration = await service.runExploration(OPERATOR, explorePlan, exploreConfirmation, {
    maxDepth: 2,
    ...(role === 'none' ? {} : { role }),
  });
  console.log(`exploration: ${exploration.observations.length} pages, ${exploration.candidates.length} candidates, denied=${exploration.deniedUrls.length}`);

  // 候補選定 (測定スクリプト側): page と api-endpoint を優先し上限まで。
  // socket.io ポーリング (エフェメラルな t=/sid= 付き) と静的アセットは診断対象として
  // 意味が薄い (かつ枠を消費する) ため除外する。
  const isNoiseTarget = (url: string): boolean => {
    const parsed = new URL(url);
    if (parsed.pathname === '/socket.io/' || parsed.searchParams.has('transport')) return true;
    return /\.(?:json|js|css|png|jpe?g|svg|ico|woff2?)$/i.test(parsed.pathname);
  };
  const selected: ScanCandidate[] = [];
  const seen = new Set<string>();
  for (const category of ['api-endpoint', 'form', 'page'] as const) {
    for (const candidate of exploration.candidates) {
      if (selected.length >= targetCap) break;
      const canonical = ScopePolicy.canonicalUrl(candidate.url);
      if (candidate.category !== category || seen.has(canonical) || isNoiseTarget(canonical)) continue;
      seen.add(canonical);
      selected.push(candidate);
    }
  }
  console.log(`adopted targets: ${selected.length}`);
  for (const candidate of selected) {
    console.log(`  target [${candidate.category}] ${candidate.method} ${candidate.url} inputs=${(candidate.inputPoints ?? []).map((point) => point.name).join(',')}`);
  }
  const loginCandidateInPool = exploration.candidates.find((candidate) => /login/i.test(new URL(candidate.url).pathname));
  console.log(`login endpoint in candidate pool: ${loginCandidateInPool === undefined ? 'NO' : `${loginCandidateInPool.method} ${loginCandidateInPool.url}`}`);
  const loginTarget = selected.find((candidate) => /login/i.test(new URL(candidate.url).pathname));
  console.log(`login endpoint in adopted targets: ${loginTarget !== undefined ? `${loginTarget.method} ${loginTarget.url}` : 'NO'}`);
  service.adoptCandidates(OPERATOR, selected);

  const { plan: scanPlan } = service.buildActiveScanPlan(OPERATOR, [...seen], {
    maxRequests: scanRequests,
    maxPages: explorePages,
    maxDurationMinutes: 90,
  });
  service.authorizePlan(scanPlan);
  const scanConfirmation = service.confirmPlan(scanPlan, OPERATOR);
  const scanStartedAt = Date.now();
  const scan = await service.runActiveScan(OPERATOR, scanPlan, scanConfirmation, selected, role === 'none' ? undefined : role);
  console.log(`scan: state=${scan.runRecord.state} stopReason=${scan.runRecord.stopReason} findings=${scan.findings.length} (engine ${scan.engineVersion}, ${((Date.now() - scanStartedAt) / 1000).toFixed(0)}s)`);
  const bySeverity = new Map<string, number>();
  for (const finding of scan.findings) {
    bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
  }
  console.log(`findings by severity: ${JSON.stringify([...bySeverity.entries()])}`);
  const byTitle = new Map<string, { severity: string; count: number; urls: string[] }>();
  for (const finding of scan.findings) {
    const entry = byTitle.get(finding.title) ?? { severity: finding.severity, count: 0, urls: [] };
    entry.count += 1;
    if (entry.urls.length < 3 && !entry.urls.includes(finding.url)) entry.urls.push(finding.url);
    byTitle.set(finding.title, entry);
  }
  for (const [title, entry] of [...byTitle.entries()].sort((left, right) => right[1].count - left[1].count)) {
    console.log(`  [${entry.severity}] ${title} x${entry.count} @ ${entry.urls.join(' , ').slice(0, 140)}`);
  }
} finally {
  await engines.close();
}

const after = await challenges();
const newly = after.filter((entry) => entry.solved && !solvedBefore.has(entry.key));
console.log('--- challenge diff ---');
console.log(`solved after: ${after.filter((entry) => entry.solved).length} (newly solved: ${newly.length})`);
for (const entry of newly) {
  console.log(`  + [${entry.category}] ${entry.name} (${entry.key})`);
}
