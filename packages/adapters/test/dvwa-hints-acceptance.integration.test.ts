import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BaselineFlowService,
  InMemoryEvidenceStore,
  SequentialIdGenerator,
  SystemClock,
  type ActiveScanEnginePort,
  type ExplorationPort,
} from '@scopepilot2/core';
import type { EngineCapabilitySnapshot, OperatorProfile, PlanConfirmation, ScanCandidate } from '@scopepilot2/contracts';
import { ZapEngineAdapter } from '../src/zap-engine.ts';
import { PlaywrightExplorerAdapter } from '../src/playwright-explorer.ts';
import { PlaywrightLoginExecutor } from '../src/login-executor.ts';

/**
 * DVWA 追加シナリオの実機確認 (AGENTS.md「入力ドキュメントの活用」の実ワークフロー)。
 * document hints (URL 追加開始点・クロール優先付け) と parameter バリエーションの
 * 参照を、実 chromium 探索・実 ZAP 診断 (role 指定) の product 経路で確認する。
 * 検出率の benchmark ではない。
 *
 * 既定では skip。実 DVWA・実 ZAP daemon・実 chromium が必要:
 *   SCOPEPILOT_DVWA_BASE_URL=http://192.168.0.27 \
 *   SCOPEPILOT_ZAP_BASE_URL=http://127.0.0.1:8090 \
 *   SCOPEPILOT_ZAP_API_KEY=... npm run test:gated -w @scopepilot2/adapters
 * 認証付き test はさらに SCOPEPILOT_DVWA_USERNAME / SCOPEPILOT_DVWA_PASSWORD が
 * 必要 (秘密値は環境変数のみ — F21-UT-007)。
 * ※実 ZAP を共有する gated test は並列実行すると newSession が他 test の
 * scan/alert/login jar を消し合うため必ず直列で: npm run test:gated -w @scopepilot2/adapters
 */
const dvwaBase = process.env['SCOPEPILOT_DVWA_BASE_URL'] ?? '';
const zapBaseUrl = process.env['SCOPEPILOT_ZAP_BASE_URL'] ?? '';
const zapApiKey = process.env['SCOPEPILOT_ZAP_API_KEY'] ?? '';
const dvwaUsername = process.env['SCOPEPILOT_DVWA_USERNAME'] ?? '';
const dvwaPassword = process.env['SCOPEPILOT_DVWA_PASSWORD'] ?? '';
const gated = dvwaBase !== '' && zapBaseUrl !== '' ? describe : describe.skip;
const gatedAuthenticated = dvwaUsername !== '' && dvwaPassword !== '' ? describe : describe.skip;

const NOW = '2026-10-20T10:00:00.000Z';

const OPERATOR: OperatorProfile = {
  operatorId: 'operator-dvwa-hints',
  displayName: 'DVWA Hints Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

function buildService(explorer: ExplorationPort, zap: ActiveScanEnginePort, zapVersion: string, loginExecutor?: PlaywrightLoginExecutor): BaselineFlowService {
  const enforced = {
    preSendScopeEnforcement: 'Enforced',
    stopControl: 'Enforced',
    budgetLease: 'Enforced',
    rateLimit: 'Enforced',
  } as const;
  const delegated = {
    preSendScopeEnforcement: 'Delegated',
    stopControl: 'Delegated',
    budgetLease: 'Delegated',
    rateLimit: 'Delegated',
  } as const;
  const explorerIsReal = explorer instanceof PlaywrightExplorerAdapter;
  const capabilities: readonly EngineCapabilitySnapshot[] = [
    { engineKind: 'playwright', engineVersion: explorer.engineVersion, source: explorerIsReal ? 'measured' : 'fixture', guaranteeLevels: enforced, maxOvershootRatio: 0, measuredAt: NOW },
    { engineKind: 'zap', engineVersion: zapVersion, source: 'measured', guaranteeLevels: delegated, maxOvershootRatio: 0.05, measuredAt: NOW },
  ];
  return new BaselineFlowService({
    clock: new SystemClock(),
    ids: new SequentialIdGenerator(),
    evidence: new InMemoryEvidenceStore(),
    explorer,
    scanEngine: zap,
    capabilities,
    runtimeBundleHash: 'acceptance-dvwa-hints',
    ...(loginExecutor === undefined ? {} : { loginExecutor }),
    scanAlertSettleMs: 4_000,
  });
}

async function setupCase(service: BaselineFlowService, roles: readonly string[]): Promise<void> {
  service.createCase(OPERATOR, {
    name: 'dvwa-hints-acceptance',
    allowedOrigins: [dvwaBase],
    deniedOrigins: [],
    limits: { maxRequests: 600, maxPages: 120, maxDurationMinutes: 10 },
  });
  await service.grantAuthorization(OPERATOR, {
    allowedOperationClasses: ['Browse', 'ActiveScan'],
    targetRoles: roles,
    validFrom: '2026-10-20T00:00:00.000Z',
    validUntil: '2026-10-21T00:00:00.000Z',
    evidence: { label: '認可(DVWA hints)', content: 'dvwa hints acceptance evidence' },
  });
}

gated('DVWA document hints 実ワークフロー (AGENTS.md 入力ドキュメントの活用)', () => {
  test(
    '未認証: hint URL が計画へ統合され、優先付け (pii) が観測順の先頭に効く。parameter バリエーションは参照として保持',
    { timeout: 300_000 },
    async () => {
      const explorer = new PlaywrightExplorerAdapter({ scope: { allowedOrigins: [dvwaBase], deniedOrigins: [] } });
      const zap = new ZapEngineAdapter({ baseUrl: zapBaseUrl, timeoutMs: 60_000 });
      try {
        const zapVersion = await zap.resolvedVersion();
        assert.match(zapVersion, /^zap \d+\.\d+/);
        const service = buildService(explorer, zap, zapVersion);
        await setupCase(service, ['unauthenticated']);

        // 1. document hints: 未認証到達可能頁を追加開始点に登録 (許可 Origin 内のみ統合)。
        const hintUrls = [`${dvwaBase}/setup.php`, `${dvwaBase}/robots.txt`];
        const registered = service.registerDocumentHints(OPERATOR, {
          documentLabel: 'DVWA 手順書 (実機確認)',
          urls: [...hintUrls, 'http://elsewhere.example/not-merged'],
        });
        assert.deepEqual(registered, { documentLabel: 'DVWA 手順書 (実機確認)', urlCount: 3, acceptedUrlCount: 2 });

        // 2. 優先付け: setup.php を pii 扱いにする (処理順の先頭に来るはず)。
        service.registerDocumentPriorityHints(OPERATOR, {
          documentLabel: 'DVWA 手順書 (実機確認)',
          rules: [{ urlIncludes: '/setup.php', category: 'pii' }],
        });

        // 3. parameter バリエーション (参照のみ・値を持たない)。
        service.registerDocumentParameterHints(OPERATOR, {
          documentLabel: 'DVWA API 仕様 (実機確認)',
          parameters: [{ name: 'id', values: ['1', '2', "1'"] }],
        });
        assert.deepEqual(service.listDocumentParameterHints(), [
          { documentLabel: 'DVWA API 仕様 (実機確認)', parameters: [{ name: 'id', values: ['1', '2', "1'"] }] },
        ]);

        // 4. 計画: 明示 seed に hint 2 頁が統合される (確認対象に含まれる)。
        const { plan } = service.buildExplorationPlan(OPERATOR, [`${dvwaBase}/`, `${dvwaBase}/login.php`], {
          maxRequests: 120,
          maxPages: 30,
          maxDurationMinutes: 5,
        });
        service.authorizePlan(plan);
        for (const url of hintUrls) {
          assert.ok(plan.steps[0]?.targetSnapshot.includes(url), `計画へ統合されていない: ${url}`);
        }
        assert.ok(!plan.steps[0]?.targetSnapshot.includes('elsewhere.example'), '許可外は統合しない');

        // 5. 実行 (実 chromium): pii 優先の setup.php が最初に観測される。
        const confirmation: PlanConfirmation = service.confirmPlan(plan, OPERATOR);
        const run = await service.runExploration(OPERATOR, plan, confirmation, { maxDepth: 1 });
        assert.equal(run.runRecord.stopReason, 'completed');
        const urls = run.observations.map((observation) => observation.url);
        assert.ok(urls.length > 0, `観測なし: ${JSON.stringify(urls)}`);
        assert.ok(urls[0]?.includes('/setup.php'), `pii 優先が先頭になっていない: ${urls[0]}`);
        assert.ok(urls.some((url) => url.includes('/login.php')), 'login.php が観測できない');
        for (const observation of run.observations) {
          assert.ok(observation.url.startsWith(`${dvwaBase}/`), `scope 外観測: ${observation.url}`);
        }
        // 監査は計数のみ。
        const eventsText = JSON.stringify(service.events());
        assert.ok(eventsText.includes('DocumentHintsRegistered'));
        assert.ok(eventsText.includes('DocumentPriorityHintsRegistered'));
        assert.ok(eventsText.includes('DocumentParameterHintsRegistered'));
      } finally {
        await explorer.close();
      }
    },
  );
});

gatedAuthenticated('DVWA 認証付き hints ワークフロー (product 経路・role 探索と role 診断)', () => {
  test(
    'login (proxy 経由) → role 探索で hint 頁と認証後 menu → role 診断の sessionCookieNames と所見',
    { timeout: 600_000 },
    async () => {
      // 他 test の state を消さないよう、login 前に session を作り直す
      // (jar はこの後の proxy login で入れ直す)。
      await fetch(`${zapBaseUrl}/JSON/core/action/newSession/?apikey=${zapApiKey}`);
      const explorer = new PlaywrightExplorerAdapter({ scope: { allowedOrigins: [dvwaBase], deniedOrigins: [] } });
      const zap = new ZapEngineAdapter({ baseUrl: zapBaseUrl, timeoutMs: 60_000 });
      const loginExecutor = new PlaywrightLoginExecutor();
      try {
        const zapVersion = await zap.resolvedVersion();
        const service = buildService(explorer, zap, zapVersion, loginExecutor);
        await setupCase(service, ['admin']);

        // 1. hints: 認証後到達可能頁を追加開始点にし、優先付けは vulnerabilities 系へ。
        service.registerDocumentHints(OPERATOR, {
          documentLabel: 'DVWA 手順書 (認証付き)',
          urls: [`${dvwaBase}/vulnerabilities/sqli/`, `${dvwaBase}/security.php`],
        });
        service.registerDocumentPriorityHints(OPERATOR, {
          documentLabel: 'DVWA 手順書 (認証付き)',
          rules: [{ urlIncludes: '/vulnerabilities/', category: 'pii' }],
        });

        // 2. login flow 登録 (参照のみ) と runLogin (ZAP proxy 経由 = jar へ session)。
        service.registerLoginFlow(OPERATOR, {
          role: 'admin',
          flowVersion: 'dvwa-login-1',
          steps: [
            { kind: 'navigate', target: '/login.php' },
            { kind: 'fill', target: "input[name='username']", secretReference: 'dvwa-username' },
            { kind: 'fill', target: "input[name='password']", secretReference: 'dvwa-password' },
            { kind: 'click', target: "input[name='Login']" },
            { kind: 'assert', target: 'Welcome' },
          ],
        });
        const login = await service.runLogin(OPERATOR, {
          role: 'admin',
          baseUrl: dvwaBase,
          secretValues: { 'dvwa-username': dvwaUsername, 'dvwa-password': dvwaPassword },
          expectedUrlPrefix: `${dvwaBase}/`,
          proxyServer: zapBaseUrl,
        });
        assert.equal(login.authenticated, true, `login が認証済みにならない (finalUrl: ${login.finalUrl})`);
        assert.ok(login.cookieNames.includes('PHPSESSID'));

        // 3. role 探索: hint 頁 + 認証後 menu が観測され、pii (vulnerabilities) が先頭。
        const { plan } = service.buildExplorationPlan(OPERATOR, [`${dvwaBase}/index.php`], {
          maxRequests: 150,
          maxPages: 60,
          maxDurationMinutes: 6,
        });
        service.authorizePlan(plan);
        const confirmation: PlanConfirmation = service.confirmPlan(plan, OPERATOR);
        const run = await service.runExploration(OPERATOR, plan, confirmation, { maxDepth: 2, role: 'admin' });
        assert.equal(run.runRecord.stopReason, 'completed');
        const urls = run.observations.map((observation) => observation.url);
        assert.ok(urls.some((url) => url.includes('/vulnerabilities/sqli/')), `hint 頁が観測できない: ${urls.join(' ')}`);
        assert.ok(urls.some((url) => url.includes('/security.php')), `hint 頁 (security.php) が観測できない`);
        assert.ok(urls[0]?.includes('/vulnerabilities/'), `pii 優先が先頭になっていない: ${urls[0]}`);
        const vulnerabilitiesFirst = urls.findIndex((url) => url.includes('/vulnerabilities/'));
        const loginIndex = urls.findIndex((url) => url.includes('/login.php'));
        if (loginIndex >= 0 && vulnerabilitiesFirst >= 0) {
          assert.ok(vulnerabilitiesFirst < loginIndex, 'pii (/vulnerabilities/) が login.php より先に観測される');
        }

        // 4. role 診断: session cookie 名が scan request に付き、認証後頁に所見。
        const target = `${dvwaBase}/vulnerabilities/sqli/`;
        const scanPlan = service.buildActiveScanPlan(OPERATOR, [target], { maxRequests: 120, maxPages: 10, maxDurationMinutes: 4 });
        service.authorizePlan(scanPlan.plan);
        const scanConfirmation = service.confirmPlan(scanPlan.plan, OPERATOR);
        const candidate: ScanCandidate = {
          candidateId: 'c-sqli',
          url: target,
          method: 'GET',
          category: 'page',
          guidelineBasis: ['provisional:page'],
          confidence: 0.7,
          observationUrl: target,
        };
        service.adoptCandidates(OPERATOR, [candidate]);
        const scan = await service.runActiveScan(OPERATOR, scanPlan.plan, scanConfirmation, [candidate], 'admin');
        assert.equal(scan.runRecord.state, 'Completed', `state: ${scan.runRecord.state} / stopReason: ${scan.runRecord.stopReason}`);
        assert.ok(scan.scanRequest.sessionCookieNames?.includes('PHPSESSID'), `sessionCookieNames: ${scan.scanRequest.sessionCookieNames?.join(',')}`);
        const authFindings = scan.findings.filter((finding) => finding.url.includes('/vulnerabilities/'));
        assert.ok(authFindings.length > 0, `認証後頁の所見が無い: ${scan.findings.map((finding) => finding.url).join(' ')}`);
        // 秘密値は監査へ出ない。
        const eventsText = JSON.stringify(service.events());
        assert.ok(!eventsText.includes(JSON.stringify(dvwaPassword)));
      } finally {
        await explorer.close();
        await loginExecutor.close();
      }
    },
  );
});
