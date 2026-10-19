import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BaselineFlowService,
  FixedClock,
  InMemoryEvidenceStore,
  ScopePolicy,
  SequentialIdGenerator,
  SystemClock,
  type ActiveScanEnginePort,
  type ExplorationPort,
} from '@scopepilot2/core';
import type { EngineCapabilitySnapshot, OperatorProfile, PlanConfirmation, ScanCandidate } from '@scopepilot2/contracts';
import { ZapEngineAdapter } from '../src/zap-engine.ts';
import { PlaywrightExplorerAdapter } from '../src/playwright-explorer.ts';
import { PlaywrightLoginExecutor } from '../src/login-executor.ts';
import { loginDvwaDirect, loginDvwaViaZapProxy } from './dvwa-login.ts';

/**
 * DVWA を用いたワークフロー確認 (AGENTS.md「開発完了後、DVWA を用いてテストを行う」
 * および「探索・証拠保存・診断ツール連携・結果取込のワークフロー確認目的」)。
 * 検出率の benchmark ではない (既定の受け入れ基準にしない方針どおり)。
 *
 * 既定では skip。SCOPEPILOT_DVWA_BASE_URL (例: http://192.168.0.27) と
 * SCOPEPILOT_ZAP_BASE_URL の両方で実行する (実 ZAP daemon と実 chromium が必要)。
 * 認証付き test はさらに SCOPEPILOT_DVWA_USERNAME / SCOPEPILOT_DVWA_PASSWORD が必要
 * (秘密値は環境変数のみ。test file に持ち込まない — F21-UT-007)。
 *   SCOPEPILOT_DVWA_BASE_URL=http://192.168.0.27 \
 *   SCOPEPILOT_ZAP_BASE_URL=http://127.0.0.1:8090 \
 *   SCOPEPILOT_ZAP_API_KEY=... SCOPEPILOT_DVWA_USERNAME=... SCOPEPILOT_DVWA_PASSWORD=... \
 *   npm test -w @scopepilot2/adapters
 *
 * 認証付き test では login 後に security.php で Low へ変更してから診断する
 * (利用者運用手順どおり。Low でなければ診断が通らない)。
 */
const dvwaBase = process.env['SCOPEPILOT_DVWA_BASE_URL'] ?? '';
const zapBaseUrl = process.env['SCOPEPILOT_ZAP_BASE_URL'] ?? '';
const gated = dvwaBase !== '' && zapBaseUrl !== '' ? describe : describe.skip;

const NOW = '2026-10-19T17:00:00.000Z';

const ACCEPTANCE_OPERATOR: OperatorProfile = {
  operatorId: 'operator-dvwa-acceptance',
  displayName: 'DVWA Acceptance Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

gated('DVWA ワークフロー確認 (探索・診断連携・結果取込・報告)', () => {
  test(
    '未認証探索 → 対象採用 → ZAP 能動診断 → 所見取込 → 報告生成まで通る',
    { timeout: 600_000 },
    async () => {
      const zap = new ZapEngineAdapter({ baseUrl: zapBaseUrl, timeoutMs: 60_000 });
      const explorer = new PlaywrightExplorerAdapter({
        scope: { allowedOrigins: [dvwaBase], deniedOrigins: [] },
      });
      try {
        const zapVersion = await zap.resolvedVersion();
        assert.match(zapVersion, /^zap \d+\.\d+/);
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
        const capabilities: readonly EngineCapabilitySnapshot[] = [
          { engineKind: 'playwright', engineVersion: explorer.engineVersion, source: 'measured', guaranteeLevels: enforced, maxOvershootRatio: 0, measuredAt: NOW },
          { engineKind: 'zap', engineVersion: zap.engineVersion, source: 'measured', guaranteeLevels: delegated, maxOvershootRatio: 0.05, measuredAt: NOW },
        ];
        const service = new BaselineFlowService({
          clock: new FixedClock([NOW]),
          ids: new SequentialIdGenerator(),
          evidence: new InMemoryEvidenceStore(),
          explorer: explorer as ExplorationPort,
          scanEngine: zap as ActiveScanEnginePort,
          capabilities,
          runtimeBundleHash: 'acceptance-dvwa',
        });

        // 1. 案件と認可 (許可 Origin は DVWA の origin のみ)。
        service.createCase(ACCEPTANCE_OPERATOR, {
          name: 'dvwa-acceptance',
          allowedOrigins: [dvwaBase],
          deniedOrigins: [],
          limits: { maxRequests: 1000, maxPages: 100, maxDurationMinutes: 20 },
        });
        await service.grantAuthorization(ACCEPTANCE_OPERATOR, {
          allowedOperationClasses: ['Browse', 'ActiveScan'],
          targetRoles: ['unauthenticated'],
          validFrom: '2026-10-19T00:00:00.000Z',
          validUntil: '2026-10-21T00:00:00.000Z',
          evidence: { label: '認可(DVWA確認)', content: 'dvwa acceptance authorization evidence' },
        });

        // 2. 探索 (実 chromium・未認証)。予算内で完走すること。
        // 未認証の DVWA は / が login.php へ redirect し、login.php の link は外部
        // (GitHub) のみのため、未認証で到達可能な頁を seed に与える (実測)。
        const seeds = [`${dvwaBase}/`, `${dvwaBase}/login.php`, `${dvwaBase}/setup.php`, `${dvwaBase}/robots.txt`];
        const exploration = service.buildExplorationPlan(ACCEPTANCE_OPERATOR, seeds, {
          maxRequests: 60,
          maxPages: 20,
          maxDurationMinutes: 5,
        });
        service.authorizePlan(exploration.plan);
        const explorationConfirmation: PlanConfirmation = service.confirmPlan(exploration.plan, ACCEPTANCE_OPERATOR);
        const explorationResult = await service.runExploration(ACCEPTANCE_OPERATOR, exploration.plan, explorationConfirmation, { maxDepth: 1 });

        assert.equal(explorationResult.runRecord.state, 'Completed');
        assert.equal(explorationResult.runRecord.stopReason, 'completed', '予算切れではなく完走であること');
        assert.ok(explorationResult.observations.length >= 4, `観測が少なすぎる: ${explorationResult.observations.length}`);
        // 観測はすべて許可 origin の内側 (Enforced + core 入口評価)。
        for (const observation of explorationResult.observations) {
          assert.ok(observation.url.startsWith(`${dvwaBase}/`), `scope 外観測: ${observation.url}`);
        }
        // 通信 log と観測台帳に記録されていること (F03)。
        const traffic = service.listTraffic(100);
        assert.equal(traffic.mode, 'list');
        assert.ok((traffic.entries ?? []).length >= explorationResult.observations.length);
        assert.ok(service.listObservations().length >= explorationResult.observations.length);

        // 3. 採用 (runtime 保持のため対象は先頭 4 件に絞る) と診断計画。
        const adopted = service.adoptCandidates(ACCEPTANCE_OPERATOR, explorationResult.candidates.slice(0, 4));
        assert.ok(adopted.length >= 1);
        const targets = adopted.map((candidate) => ScopePolicy.canonicalUrl(candidate.url));
        const scanPlanBundle = service.buildActiveScanPlan(ACCEPTANCE_OPERATOR, targets, {
          maxRequests: 600,
          maxPages: 20,
          maxDurationMinutes: 12,
        });
        service.authorizePlan(scanPlanBundle.plan);
        const scanConfirmation: PlanConfirmation = service.confirmPlan(scanPlanBundle.plan, ACCEPTANCE_OPERATOR);

        // 4. 実 ZAP で診断 (session を作り直して過去 run の所見を混入させない)。
        const zapApiKey = process.env['SCOPEPILOT_ZAP_API_KEY'] ?? '';
        await fetch(`${zapBaseUrl}/JSON/core/action/newSession/?apikey=${zapApiKey}`);
        const scanResult = await service.runActiveScan(ACCEPTANCE_OPERATOR, scanPlanBundle.plan, scanConfirmation, adopted);

        assert.equal(scanResult.runRecord.state, 'Completed');
        assert.equal(scanResult.runRecord.stopReason, 'completed');
        assert.equal(scanResult.engineVersion, zapVersion);
        assert.ok(scanResult.findings.length > 0, '所見が 1 件も取込まれていない');
        for (const finding of scanResult.findings) {
          assert.ok(finding.url.startsWith(`${dvwaBase}/`) || finding.url === '', `scope 外 URL の所見: ${finding.url}`);
          assert.ok(finding.evidenceRefs.length > 0, `証跡参照がない所見: ${finding.findingId}`);
        }

        // 5. 報告生成 (coverage と限界開示を含む)。
        const report = service.generateReport(ACCEPTANCE_OPERATOR, { guidelines: ['owasp-wascheck-4.0'] });
        assert.equal(report.format, 'markdown');
        assert.match(report.content, /DVWA|dvwa-acceptance|192\.168\.0\.27|所見/i);
        assert.ok(report.content.includes('送信前に拒否できない'), 'Delegated 限界の開示がない');
      } finally {
        await explorer.close();
      }
    },
  );
});

const dvwaUsername = process.env['SCOPEPILOT_DVWA_USERNAME'] ?? '';
const dvwaPassword = process.env['SCOPEPILOT_DVWA_PASSWORD'] ?? '';
const gatedAuthenticated = dvwaBase !== '' && zapBaseUrl !== '' && dvwaUsername !== '' && dvwaPassword !== '' ? describe : describe.skip;

/** ZAP daemon の proxy アドレス (API と同 port)。 */
function zapProxyServer(): string {
  return zapBaseUrl;
}

gatedAuthenticated('DVWA 認証付きワークフロー確認 (login → security Low → 探索・診断)', () => {
  test(
    'login session で認証後頁を探索し、ZAP も同じ session で診断できる',
    { timeout: 600_000 },
    async () => {
      const zapUrl = new URL(zapBaseUrl);
      const zap = new ZapEngineAdapter({ baseUrl: zapBaseUrl, timeoutMs: 60_000 });
      const credentials = { username: dvwaUsername, password: dvwaPassword };

      // 1. 直接 login: Playwright 探索用 session。security.php は Low へ (ハーネス内)。
      const directSession = await loginDvwaDirect(dvwaBase, credentials);

      // 2. ZAP proxy 経由 login: ZAP の cookie jar に認証済み session を作る。
      //    (ZAP に cookie 設定 API は無く、proxy 経由の実通信で session を
      //     蓄積させるのが正規流儀。探索で logout.php を踏んでも ZAP 側は無関係。)
      const proxySession = await loginDvwaViaZapProxy(
        dvwaBase,
        credentials,
        { host: zapUrl.hostname, port: Number(zapUrl.port === '' ? '8080' : zapUrl.port) },
        {
          baseUrl: zapBaseUrl,
          ...(process.env['SCOPEPILOT_ZAP_API_KEY'] === undefined ? {} : { apiKey: process.env['SCOPEPILOT_ZAP_API_KEY'] }),
        },
      );
      assert.ok(proxySession.phpSessId !== '');

      const explorer = new PlaywrightExplorerAdapter({
        scope: { allowedOrigins: [dvwaBase], deniedOrigins: [] },
        cookies: directSession.browserCookies,
      });
      try {
        const zapVersion = await zap.resolvedVersion();
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
        const capabilities: readonly EngineCapabilitySnapshot[] = [
          { engineKind: 'playwright', engineVersion: explorer.engineVersion, source: 'measured', guaranteeLevels: enforced, maxOvershootRatio: 0, measuredAt: NOW },
          { engineKind: 'zap', engineVersion: zap.engineVersion, source: 'measured', guaranteeLevels: delegated, maxOvershootRatio: 0.05, measuredAt: NOW },
        ];
        const service = new BaselineFlowService({
          clock: new FixedClock([NOW]),
          ids: new SequentialIdGenerator(),
          evidence: new InMemoryEvidenceStore(),
          explorer: explorer as ExplorationPort,
          scanEngine: zap as ActiveScanEnginePort,
          capabilities,
          runtimeBundleHash: 'acceptance-dvwa-auth',
        });
        service.createCase(ACCEPTANCE_OPERATOR, {
          name: 'dvwa-acceptance-auth',
          allowedOrigins: [dvwaBase],
          deniedOrigins: [],
          limits: { maxRequests: 1000, maxPages: 200, maxDurationMinutes: 20 },
        });
        await service.grantAuthorization(ACCEPTANCE_OPERATOR, {
          allowedOperationClasses: ['Browse', 'ActiveScan'],
          targetRoles: ['authenticated'],
          validFrom: '2026-10-19T00:00:00.000Z',
          validUntil: '2026-10-21T00:00:00.000Z',
          evidence: { label: '認可(DVWA認証付き確認)', content: 'dvwa authenticated acceptance evidence' },
        });

        // 3. 認証済み探索: 認証後 menu が見えるため /vulnerabilities/ 系が発見できる。
        //    予算は menu 全頁 + depth 2 を cover する余裕を持たせる。
        const seeds = [`${dvwaBase}/index.php`, `${dvwaBase}/vulnerabilities/sqli/`];
        const exploration = service.buildExplorationPlan(ACCEPTANCE_OPERATOR, seeds, {
          maxRequests: 150,
          maxPages: 80,
          maxDurationMinutes: 8,
        });
        service.authorizePlan(exploration.plan);
        const explorationConfirmation: PlanConfirmation = service.confirmPlan(exploration.plan, ACCEPTANCE_OPERATOR);
        const explorationResult = await service.runExploration(ACCEPTANCE_OPERATOR, exploration.plan, explorationConfirmation, { maxDepth: 2 });

        assert.equal(explorationResult.runRecord.state, 'Completed');
        assert.equal(explorationResult.runRecord.stopReason, 'completed', '予算切れではなく完走であること');
        const observedUrls = explorationResult.observations.map((observation) => observation.url);
        assert.ok(observedUrls.length >= 10, `観測が少なすぎる: ${observedUrls.length}`);
        assert.ok(
          observedUrls.some((url) => url.includes('/vulnerabilities/')),
          `認証後 menu (/vulnerabilities/) が発見できていない: ${observedUrls.join(' ')}`,
        );
        for (const observation of explorationResult.observations) {
          assert.ok(observation.url.startsWith(`${dvwaBase}/`), `scope 外観測: ${observation.url}`);
        }

        // 4. 採用対象は index + 認証後ページ中心に選ぶ (logout.php 等は外す)。
        const preferred = ['/index.php', '/vulnerabilities/sqli/', '/vulnerabilities/xss_r/', '/vulnerabilities/brute/'];
        const selected: ScanCandidate[] = [];
        for (const pattern of preferred) {
          const found = explorationResult.candidates.find((candidate) => candidate.url === `${dvwaBase}${pattern}`);
          if (found !== undefined) {
            selected.push(found);
          }
        }
        assert.ok(selected.length >= 2, `診断対象候補が集まらない: ${observedUrls.join(' ')}`);
        const adopted = service.adoptCandidates(ACCEPTANCE_OPERATOR, selected);
        const targets = adopted.map((candidate) => ScopePolicy.canonicalUrl(candidate.url));

        // 5. ZAP 診断 (認証済み jar のまま。newSession は jar を失うため呼ばない)。
        const scanPlanBundle = service.buildActiveScanPlan(ACCEPTANCE_OPERATOR, targets, {
          maxRequests: 600,
          maxPages: 20,
          maxDurationMinutes: 10,
        });
        service.authorizePlan(scanPlanBundle.plan);
        const scanConfirmation: PlanConfirmation = service.confirmPlan(scanPlanBundle.plan, ACCEPTANCE_OPERATOR);
        const scanResult = await service.runActiveScan(ACCEPTANCE_OPERATOR, scanPlanBundle.plan, scanConfirmation, adopted);

        assert.equal(scanResult.runRecord.state, 'Completed');
        assert.equal(scanResult.runRecord.stopReason, 'completed');
        assert.equal(scanResult.engineVersion, zapVersion);
        assert.ok(scanResult.findings.length > 0, '所見が 1 件も取込まれていない');
        for (const finding of scanResult.findings) {
          assert.ok(finding.url.startsWith(`${dvwaBase}/`) || finding.url === '', `scope 外 URL の所見: ${finding.url}`);
          assert.ok(finding.evidenceRefs.length > 0, `証跡参照がない所見: ${finding.findingId}`);
        }
        // 認証が必要な頁の所見がある = ZAP が認証済み session で到達できた証左。
        assert.ok(
          scanResult.findings.some((finding) => finding.url.includes('/vulnerabilities/')),
          '認証後ページ (/vulnerabilities/) の所見がない — ZAP session が診断に使えていない可能性',
        );
      } finally {
        await explorer.close();
      }
    },
  );
});

/**
 * 製品経路 (design/f09 §4) の実機確認: service の runLogin (実 PlaywrightLoginExecutor・
 * ZAP proxy 経由) で session を作り、runExploration の role 指定で実 chromium 探索に
 * session を渡す。harness (dvwa-login.ts) ではなく本体の port/adapter 経路であること
 * が前 test との違い。
 */
gatedAuthenticated('DVWA 製品経路 login (f09) → role session 探索', () => {
  test('runLogin (実 executor) → runExploration role 指定で認証後頁を探索できる', { timeout: 300_000 }, async () => {
    const explorer = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: [dvwaBase], deniedOrigins: [] },
    });
    const loginExecutor = new PlaywrightLoginExecutor();
    try {
      const zap = new ZapEngineAdapter({ baseUrl: zapBaseUrl, timeoutMs: 60_000 });
      const zapVersion = await zap.resolvedVersion();
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
      const capabilities: readonly EngineCapabilitySnapshot[] = [
        { engineKind: 'playwright', engineVersion: explorer.engineVersion, source: 'measured', guaranteeLevels: enforced, maxOvershootRatio: 0, measuredAt: NOW },
        { engineKind: 'zap', engineVersion: zapVersion, source: 'measured', guaranteeLevels: delegated, maxOvershootRatio: 0.05, measuredAt: NOW },
      ];
      const service = new BaselineFlowService({
        clock: new SystemClock(),
        ids: new SequentialIdGenerator(),
        evidence: new InMemoryEvidenceStore(),
        explorer: explorer as ExplorationPort,
        scanEngine: zap as ActiveScanEnginePort,
        capabilities,
        runtimeBundleHash: 'acceptance-dvwa-login',
        loginExecutor,
      });
      service.createCase(ACCEPTANCE_OPERATOR, {
        name: 'dvwa-acceptance-login',
        allowedOrigins: [dvwaBase],
        deniedOrigins: [],
        limits: { maxRequests: 1000, maxPages: 200, maxDurationMinutes: 20 },
      });
      await service.grantAuthorization(ACCEPTANCE_OPERATOR, {
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['admin'],
        validFrom: '2026-10-19T00:00:00.000Z',
        validUntil: '2026-10-21T00:00:00.000Z',
        evidence: { label: '認可(DVWA製品経路login)', content: 'dvwa product-path login evidence' },
      });

      // 1. login flow 登録 (fill は秘密値の参照のみ) と runLogin (ZAP proxy 経由)。
      service.registerLoginFlow(ACCEPTANCE_OPERATOR, {
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
      const login = await service.runLogin(ACCEPTANCE_OPERATOR, {
        role: 'admin',
        baseUrl: dvwaBase,
        secretValues: { 'dvwa-username': dvwaUsername, 'dvwa-password': dvwaPassword },
        expectedUrlPrefix: `${dvwaBase}/`,
        proxyServer: zapProxyServer(),
      });
      assert.equal(login.authenticated, true, `login が認証済みにならない (finalUrl: ${login.finalUrl})`);
      assert.ok(login.cookieNames.includes('PHPSESSID'));
      // 監査には参照のみ (値が出ない)。値は JSON 内で quote されて現れるため
      // quote 付きで検査する (参照名 'dvwa-password' が部分一致しないように)。
      const eventsText = JSON.stringify(service.events());
      assert.ok(eventsText.includes('LoginCompleted'));
      assert.ok(!eventsText.includes(JSON.stringify(dvwaPassword)));

      // 2. role 指定探索: runLogin の session で認証後 menu が見える。
      const { plan } = service.buildExplorationPlan(ACCEPTANCE_OPERATOR, [`${dvwaBase}/index.php`, `${dvwaBase}/vulnerabilities/sqli/`], {
        maxRequests: 150,
        maxPages: 80,
        maxDurationMinutes: 8,
      });
      service.authorizePlan(plan);
      const confirmation: PlanConfirmation = service.confirmPlan(plan, ACCEPTANCE_OPERATOR);
      const run = await service.runExploration(ACCEPTANCE_OPERATOR, plan, confirmation, { maxDepth: 2, role: 'admin' });
      assert.equal(run.runRecord.stopReason, 'completed');
      const urls = run.observations.map((observation) => observation.url);
      assert.ok(urls.length >= 10, `観測が少なすぎる: ${urls.length}`);
      assert.ok(urls.some((url) => url.includes('/vulnerabilities/')), `認証後 menu が発見できない: ${urls.join(' ')}`);
      for (const observation of run.observations) {
        assert.ok(observation.url.startsWith(`${dvwaBase}/`), `scope 外観測: ${observation.url}`);
      }
    } finally {
      await explorer.close();
      await loginExecutor.close();
    }
  });
});
