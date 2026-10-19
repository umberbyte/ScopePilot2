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
import type { EngineCapabilitySnapshot, ExecutionPlan, OperatorProfile, PlanConfirmation } from '@scopepilot2/contracts';
import { ZapEngineAdapter } from '../src/zap-engine.ts';
import { PlaywrightExplorerAdapter } from '../src/playwright-explorer.ts';
import { startVulnerableTarget } from './vulnerable-target.ts';

/**
 * フル縦断 (実 ZAP + 実 playwright chromium): 案件→認可→探索→採用→能動診断→所見取込
 * (旧版 SIMULATION-GUIDE 相当の「探索→能動診断→所見」自動完走、実 engine 版)。
 * 既定では skip。SCOPEPILOT_ZAP_BASE_URL と SCOPEPILOT_PLAYWRIGHT_IT=1 の両方で実行。
 *
 * runActiveScan 内の ScanMonitor は poll 間隔を空けて完了を待つ (実 engine は分単位)。
 * ZAP の session は scan 前に作り直し、過去 run の alert が混入しないようにする
 * (engine 状態の管理はテスト harness の権限 — design/22)。
 */
const zapBaseUrl = process.env['SCOPEPILOT_ZAP_BASE_URL'] ?? '';
const playwrightIt = process.env['SCOPEPILOT_PLAYWRIGHT_IT'] === '1';
const gated = zapBaseUrl !== '' && playwrightIt ? describe : describe.skip;

const NOW = '2026-10-19T09:00:00.000Z';

const IT_OPERATOR: OperatorProfile = {
  operatorId: 'operator-it-real',
  displayName: 'Real Engine IT Operator',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

gated('BaselineFlowService 縦断 (実 ZAP + 実 playwright)', () => {
  test(
    '案件→認可→探索 (chromium)→採用→能動診断 (ZAP)→所見取込まで自動完走する',
    { timeout: 600_000 },
    async () => {
      const target = await startVulnerableTarget();
      const zap = new ZapEngineAdapter({ baseUrl: zapBaseUrl, timeoutMs: 60_000 });
      const explorer = new PlaywrightExplorerAdapter({
        scope: { allowedOrigins: [target.base], deniedOrigins: [] },
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
          runtimeBundleHash: 'it-real-engines',
        });

        // 1. 案件と認可。
        service.createCase(IT_OPERATOR, {
          name: 'real-engine-vertical-slice',
          allowedOrigins: [target.base],
          deniedOrigins: [],
          limits: { maxRequests: 500, maxPages: 50, maxDurationMinutes: 10 },
        });
        await service.grantAuthorization(IT_OPERATOR, {
          allowedOperationClasses: ['Browse', 'ActiveScan'],
          targetRoles: ['unauthenticated'],
          validFrom: '2026-10-19T00:00:00.000Z',
          validUntil: '2026-10-21T00:00:00.000Z',
          evidence: { label: '認可(実engine IT)', content: 'real engine it authorization evidence' },
        });

        // 2. 探索計画 → 検証 → 確認 → 実行 (plan confirmation hash 経由 — 旧版知見)。
        const exploration = service.buildExplorationPlan(IT_OPERATOR, [target.indexUrl], {
          maxRequests: 50,
          maxPages: 20,
          maxDurationMinutes: 3,
        });
        service.authorizePlan(exploration.plan);
        const explorationConfirmation: PlanConfirmation = service.confirmPlan(exploration.plan, IT_OPERATOR);
        const explorationResult = await service.runExploration(IT_OPERATOR, exploration.plan, explorationConfirmation, { maxDepth: 1 });

        assert.equal(explorationResult.runRecord.state, 'Completed');
        assert.equal(explorationResult.runRecord.stopReason, 'completed');
        const urls = explorationResult.observations.map((observation) => observation.url);
        assert.ok(urls.includes(target.indexUrl), `index が観測されていない: ${urls.join(' ')}`);
        assert.ok(urls.includes(target.echoUrl), `echo が観測されていない: ${urls.join(' ')}`);
        assert.ok(urls.includes(target.plainUrl), `plain が観測されていない: ${urls.join(' ')}`);
        // scope 外へは出ていない (Enforced + core の入口評価)。
        assert.ok(explorationResult.observations.every((observation) => observation.url.startsWith(target.base)));

        // 3. 候補を採用し、canonical URL を対象として能動診断計画。
        const adopted = service.adoptCandidates(IT_OPERATOR, explorationResult.candidates);
        assert.ok(adopted.length >= 3);
        const targets = adopted.map((candidate) => ScopePolicy.canonicalUrl(candidate.url));
        const scanPlanBundle = service.buildActiveScanPlan(IT_OPERATOR, targets, {
          maxRequests: 300,
          maxPages: 10,
          maxDurationMinutes: 8,
        });
        service.authorizePlan(scanPlanBundle.plan);
        const scanConfirmation: PlanConfirmation = service.confirmPlan(scanPlanBundle.plan, IT_OPERATOR);

        // 4. 実 ZAP で診断。過去 alert が混入しないよう session を作り直す。
        const zapApiKey = process.env['SCOPEPILOT_ZAP_API_KEY'] ?? '';
        await fetch(`${zapBaseUrl}/JSON/core/action/newSession/?apikey=${zapApiKey}`);

        const scanResult = await service.runActiveScan(IT_OPERATOR, scanPlanBundle.plan, scanConfirmation, adopted);

        // 5. 所見取込まで完了 (URL Does not Exist 等の engine 失敗は EngineFailure として失敗する)。
        assert.equal(scanResult.runRecord.state, 'Completed');
        assert.equal(scanResult.runRecord.stopReason, 'completed');
        assert.equal(scanResult.engineVersion, zapVersion);
        assert.ok(scanResult.findings.length > 0, '所見が 1 件も取込まれていない');
        for (const finding of scanResult.findings) {
          assert.match(finding.findingId, /^finding-/);
          assert.ok(finding.title.length > 0);
          assert.ok(finding.url.startsWith(target.base) || finding.url === '', `scope 外 URL の所見: ${finding.url}`);
          assert.ok(finding.evidenceRefs.length > 0, '証跡参照がない所見がある');
        }
      } finally {
        await explorer.close();
        target.server.close();
      }
    },
  );
});
