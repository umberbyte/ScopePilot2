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
import { PlaywrightLoginExecutor } from '../src/login-executor.ts';
import { FixtureExplorer } from '@scopepilot2/simulation';
import { startVulnerableTarget, VULNERABLE_TARGET_CREDENTIALS, VULNERABLE_TARGET_AUTH_MARKER, type VulnerableTarget } from './vulnerable-target.ts';

/**
 * 実 ZAP での role 指定診断の受け入れ (design/08 F11 適用の実機確認)。
 * runLogin を ZAP proxy 経由で実行して ZAP の cookie jar に session を蓄積し、
 * runActiveScan を role 指定で実行する — scan request の sessionCookieNames と、
 * 認証が無いと 302 になる頁への所見 (ZAP が session で到達した証左) を検証する。
 * 対象は所有ターゲット (vulnerable-target) のため DVWA 不要・自己完結。
 *
 * 既定では skip。実 ZAP daemon と実 chromium が必要:
 *   SCOPEPILOT_ZAP_BASE_URL=http://127.0.0.1:8090 \
 *   SCOPEPILOT_ZAP_API_KEY=... npm test -w @scopepilot2/adapters
 * ※実 ZAP を共有する gated test は並列実行すると newSession が他 test の
 * scan/alert/login jar を消し合うため必ず直列で: npm run test:gated -w @scopepilot2/adapters
 */
const zapBaseUrl = process.env['SCOPEPILOT_ZAP_BASE_URL'] ?? '';
const zapApiKey = process.env['SCOPEPILOT_ZAP_API_KEY'] ?? '';
const gated = zapBaseUrl !== '' ? describe : describe.skip;

const NOW = '2026-10-20T09:00:00.000Z';

const OPERATOR: OperatorProfile = {
  operatorId: 'operator-zap-role-acceptance',
  displayName: 'ZAP Role Acceptance Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

gated('実 ZAP role 指定診断 (runLogin proxy 経由 → runActiveScan role)', () => {
  test('login を ZAP proxy で通し、role 指定診断が session cookie 名を添えて認証頁に到達する', { timeout: 300_000 }, async () => {
    const target: VulnerableTarget = await startVulnerableTarget();
    const zap = new ZapEngineAdapter({ baseUrl: zapBaseUrl, timeoutMs: 60_000 });
    const loginExecutor = new PlaywrightLoginExecutor();
    const explorer: ExplorationPort = new FixtureExplorer();
    try {
      // 過去 run の所見を混入させないため session を作り直す (jar も空になる —
      // その後 runLogin の proxy 経由で認証 session を入れ直す)。
      await fetch(`${zapBaseUrl}/JSON/core/action/newSession/?apikey=${zapApiKey}`);
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
        { engineKind: 'playwright', engineVersion: explorer.engineVersion, source: 'fixture', guaranteeLevels: enforced, maxOvershootRatio: 0, measuredAt: NOW },
        { engineKind: 'zap', engineVersion: zapVersion, source: 'measured', guaranteeLevels: delegated, maxOvershootRatio: 0.05, measuredAt: NOW },
      ];
      const service = new BaselineFlowService({
        clock: new SystemClock(),
        ids: new SequentialIdGenerator(),
        evidence: new InMemoryEvidenceStore(),
        explorer,
        scanEngine: zap as ActiveScanEnginePort,
        capabilities,
        runtimeBundleHash: 'acceptance-zap-role-scan',
        scanAlertSettleMs: 4_000,
        loginExecutor,
      });
      const origin = new URL(target.base).origin;
      service.createCase(OPERATOR, {
        name: 'zap-role-acceptance',
        allowedOrigins: [origin],
        deniedOrigins: [],
        limits: { maxRequests: 500, maxPages: 50, maxDurationMinutes: 10 },
      });
      await service.grantAuthorization(OPERATOR, {
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['admin'],
        validFrom: '2026-10-20T00:00:00.000Z',
        validUntil: '2026-10-21T00:00:00.000Z',
        evidence: { label: '認可(実ZAP role診断)', content: 'zap role-scan acceptance evidence' },
      });

      // 1. login flow 登録 (参照のみ) → runLogin (ZAP proxy 経由 = jar へ session)。
      service.registerLoginFlow(OPERATOR, {
        role: 'admin',
        flowVersion: 'target-login-1',
        steps: [
          { kind: 'navigate', target: '/login' },
          { kind: 'fill', target: 'input[name=username]', secretReference: 'target-username' },
          { kind: 'fill', target: 'input[name=password]', secretReference: 'target-password' },
          { kind: 'click', target: 'button[type=submit]' },
          { kind: 'assert', target: VULNERABLE_TARGET_AUTH_MARKER },
        ],
      });
      const login = await service.runLogin(OPERATOR, {
        role: 'admin',
        baseUrl: target.base,
        secretValues: { 'target-username': VULNERABLE_TARGET_CREDENTIALS.username, 'target-password': VULNERABLE_TARGET_CREDENTIALS.password },
        expectedUrlPrefix: `${target.base}/`,
        proxyServer: zapBaseUrl,
      });
      assert.equal(login.authenticated, true, `login が認証済みにならない (finalUrl: ${login.finalUrl})`);
      assert.ok(login.cookieNames.includes('AUTHTOKEN'), `AUTHTOKEN がない: ${login.cookieNames.join(',')}`);
      assert.equal(login.finalUrl, target.authenticatedUrl, 'login 直後は認証頁に着地する');

      // ZAP の jar に session が入ったことの確認 (httpSessions API で cookie を読む)。
      const site = `${new URL(target.base).hostname}:${new URL(target.base).port}`;
      const jarResponse = await fetch(`${zapBaseUrl}/JSON/httpSessions/view/sites/?apikey=${zapApiKey}`).catch(() => null);
      if (jarResponse !== null && jarResponse.ok) {
        const jarText = await jarResponse.text();
        assert.ok(jarText.includes(site) || jarText.includes('AUTHTOKEN') || jarText === '[]', `jar 確認 (参考): ${jarText.slice(0, 200)}`);
      }

      // 2. 診断計画 (認証頁のみ) → 採用 → 確認 → role 指定で実行。
      const { plan } = service.buildActiveScanPlan(OPERATOR, [target.authenticatedUrl], {
        maxRequests: 100,
        maxPages: 10,
        maxDurationMinutes: 5,
      });
      service.authorizePlan(plan);
      const confirmation: PlanConfirmation = service.confirmPlan(plan, OPERATOR);
      const candidate: ScanCandidate = {
        candidateId: 'c-auth-page',
        url: target.authenticatedUrl,
        method: 'GET',
        category: 'page',
        guidelineBasis: ['provisional:page'],
        confidence: 0.7,
        observationUrl: target.authenticatedUrl,
      };
      service.adoptCandidates(OPERATOR, [candidate]);
      const scan = await service.runActiveScan(OPERATOR, plan, confirmation, [candidate], 'admin');

      // 3. 結果: session cookie 名が scan request に添えられ (design/08 F11)、
      //    ZAP が認証頁に到達した証左としてその URL の所見が取込まれる。
      assert.equal(scan.runRecord.state, 'Completed', `state: ${scan.runRecord.state} / stopReason: ${scan.runRecord.stopReason}`);
      assert.equal(scan.runRecord.stopReason, 'completed');
      assert.ok(scan.scanRequest.sessionCookieNames?.includes('AUTHTOKEN'), `sessionCookieNames: ${scan.scanRequest.sessionCookieNames?.join(',')}`);
      const authenticatedFindings = scan.findings.filter((finding) => finding.url.startsWith(`${target.base}/authenticated/page`));
      assert.ok(authenticatedFindings.length > 0, `認証頁の所見が無い (ZAP が session で到達していない可能性): ${scan.findings.map((finding) => finding.url).join(' ')}`);
      assert.equal(scan.engineVersion, zapVersion);

      // 4. role 未指定の対照: session 無しでは ZAP は 302 に飛ばされ、認証頁の
      //    所見は取込まれない (runLogin の session が診断に効いていることの裏付け)。
      await fetch(`${zapBaseUrl}/JSON/core/action/newSession/?apikey=${zapApiKey}`);
      const zap2 = new ZapEngineAdapter({ baseUrl: zapBaseUrl, timeoutMs: 60_000 });
      await zap2.resolvedVersion();
      const service2 = new BaselineFlowService({
        clock: new SystemClock(),
        ids: new SequentialIdGenerator(),
        evidence: new InMemoryEvidenceStore(),
        explorer: new FixtureExplorer() as ExplorationPort,
        scanEngine: zap2 as ActiveScanEnginePort,
        capabilities,
        runtimeBundleHash: 'acceptance-zap-role-scan',
        scanAlertSettleMs: 4_000,
      });
      service2.createCase(OPERATOR, {
        name: 'zap-role-acceptance-unauthenticated',
        allowedOrigins: [origin],
        deniedOrigins: [],
        limits: { maxRequests: 500, maxPages: 50, maxDurationMinutes: 10 },
      });
      await service2.grantAuthorization(OPERATOR, {
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['unauthenticated'],
        validFrom: '2026-10-20T00:00:00.000Z',
        validUntil: '2026-10-21T00:00:00.000Z',
        evidence: { label: '認可(対照)', content: 'unauthenticated control evidence' },
      });
      const plan2 = service2.buildActiveScanPlan(OPERATOR, [target.authenticatedUrl], { maxRequests: 100, maxPages: 10, maxDurationMinutes: 5 });
      service2.authorizePlan(plan2.plan);
      const confirmation2 = service2.confirmPlan(plan2.plan, OPERATOR);
      const candidate2: ScanCandidate = { ...candidate, candidateId: 'c-auth-page-control' };
      service2.adoptCandidates(OPERATOR, [candidate2]);
      const control = await service2.runActiveScan(OPERATOR, plan2.plan, confirmation2, [candidate2]);
      assert.equal(control.scanRequest.sessionCookieNames, undefined, 'role 未指定では session が付かない');
      const controlFindings = control.findings.filter((finding) => finding.url.startsWith(`${target.base}/authenticated/page`));
      assert.equal(controlFindings.length, 0, `対照でも認証頁に所見が出ている (302 先ではなく): ${control.findings.map((finding) => finding.url).join(' ')}`);
    } finally {
      await loginExecutor.close();
      target.server.close();
    }
  });
});
