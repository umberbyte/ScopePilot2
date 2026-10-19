import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BaselineFlowService,
  FixedClock,
  InMemoryEvidenceStore,
  ScopePolicy,
  SequentialIdGenerator,
  type ActiveScanEnginePort,
  type ExplorationPort,
} from '@scopepilot2/core';
import type { EngineCapabilitySnapshot, OperatorProfile, PlanConfirmation } from '@scopepilot2/contracts';
import { ZapEngineAdapter } from '../src/zap-engine.ts';
import { PlaywrightExplorerAdapter } from '../src/playwright-explorer.ts';

/**
 * DVWA を用いたワークフロー確認 (AGENTS.md「開発完了後、DVWA を用いてテストを行う」
  * および「探索・証拠保存・診断ツール連携・結果取込のワークフロー確認目的」)。
 * 検出率の benchmark ではない (既定の受け入れ基準にしない方針どおり)。
 *
 * 既定では skip。SCOPEPILOT_DVWA_BASE_URL (例: http://192.168.0.27) と
 * SCOPEPILOT_ZAP_BASE_URL の両方で実行する (実 ZAP daemon と実 chromium が必要)。
 *   SCOPEPILOT_DVWA_BASE_URL=http://192.168.0.27 \
 *   SCOPEPILOT_ZAP_BASE_URL=http://127.0.0.1:8090 \
 *   SCOPEPILOT_ZAP_API_KEY=... npm test -w @scopepilot2/adapters
 *
 * 探索は未認証 (login 前提の画面構成)。session cookie を用いた認証後探索は
 * core の login flow / cookie 割当 (design/f09) の接続が後続対象。
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
