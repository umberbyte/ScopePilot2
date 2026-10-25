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
import type { EngineCapabilitySnapshot, OperatorProfile, ScanCandidate } from '@scopepilot2/contracts';
import { PlaywrightLoginExecutor } from '../src/login-executor.ts';
import { PlaywrightExplorerAdapter } from '../src/playwright-explorer.ts';
import { ZapEngineAdapter } from '../src/zap-engine.ts';

const dvwaBase = process.env['SCOPEPILOT_DVWA_BASE_URL'] ?? '';
const zapBaseUrl = process.env['SCOPEPILOT_ZAP_BASE_URL'] ?? '';
const username = process.env['SCOPEPILOT_DVWA_USERNAME'] ?? '';
const password = process.env['SCOPEPILOT_DVWA_PASSWORD'] ?? '';
const gated = dvwaBase !== '' && zapBaseUrl !== '' && username !== '' && password !== '' ? describe : describe.skip;

const OPERATOR: OperatorProfile = {
  operatorId: 'operator-dvwa-product-path',
  displayName: 'DVWA Product Path',
  permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
};

gated('DVWA product path', () => {
  test('login, set Low, and complete an authenticated ZAP scan without visiting session-control URLs', { timeout: 600_000 }, async () => {
    await fetch(`${zapBaseUrl.replace(/\/$/, '')}/JSON/core/action/newSession/`);
    const zap = new ZapEngineAdapter({ baseUrl: zapBaseUrl, timeoutMs: 60_000 });
    const loginExecutor = new PlaywrightLoginExecutor();
    const explorer = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: [new URL(dvwaBase).origin], deniedOrigins: [] },
      proxyServer: zapBaseUrl,
    });
    try {
      const zapVersion = await zap.resolvedVersion();
      const now = new Date();
      const capabilities: readonly EngineCapabilitySnapshot[] = [{
        engineKind: 'zap',
        engineVersion: zapVersion,
        source: 'measured',
        guaranteeLevels: {
          preSendScopeEnforcement: 'Delegated',
          stopControl: 'Delegated',
          budgetLease: 'Delegated',
          rateLimit: 'Delegated',
        },
        maxOvershootRatio: 0.05,
        measuredAt: now.toISOString(),
      }, {
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
        explorer: explorer as ExplorationPort,
        scanEngine: zap as ActiveScanEnginePort,
        capabilities,
        runtimeBundleHash: 'dvwa-product-path',
        scanAlertSettleMs: 2_000,
        loginExecutor,
      });
      service.createCase(OPERATOR, {
        name: 'DVWA product path',
        allowedOrigins: [new URL(dvwaBase).origin],
        deniedOrigins: [],
        limits: { maxRequests: 500, maxPages: 50, maxDurationMinutes: 10 },
      });
      await service.grantAuthorization(OPERATOR, {
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['admin'],
        validFrom: new Date(now.getTime() - 60_000).toISOString(),
        validUntil: new Date(now.getTime() + 60 * 60_000).toISOString(),
        evidence: { label: 'DVWA authorized test', content: 'Owned DVWA product-path acceptance test' },
      });
      service.registerLoginFlow(OPERATOR, {
        role: 'admin',
        flowVersion: 'dvwa-low-v1',
        steps: [
          // Match the Simple-mode UI: the configured site root redirects to
          // DVWA's login page before the credential fields are filled.
          { kind: 'navigate', target: `${dvwaBase}/` },
          { kind: 'fill', target: 'input[name="username"]', secretReference: 'dvwa-username' },
          { kind: 'fill', target: 'input[name="password"]', secretReference: 'dvwa-password' },
          { kind: 'click', target: 'input[name="Login"]' },
          { kind: 'assert', target: 'logout' },
          { kind: 'navigate', target: `${dvwaBase}/security.php` },
          { kind: 'select', target: 'select[name="security"]', value: 'low' },
          { kind: 'click', target: 'input[name="seclev_submit"]' },
          { kind: 'assertValue', target: 'select[name="security"]', value: 'low' },
        ],
      });
      const login = await service.runLogin(OPERATOR, {
        role: 'admin',
        baseUrl: dvwaBase,
        secretValues: { 'dvwa-username': username, 'dvwa-password': password },
        expectedUrlPrefix: `${dvwaBase}/`,
      });
      assert.equal(login.authenticated, true, `authentication failed at ${login.finalUrl}; cookies=${login.cookieNames.join(',')}`);
      assert.ok(login.cookieNames.includes('PHPSESSID'));
      assert.ok(login.cookieNames.includes('security'));

      const { plan: explorationPlan } = service.buildExplorationPlan(OPERATOR, [`${dvwaBase}/`]);
      service.authorizePlan(explorationPlan);
      const explorationConfirmation = service.confirmPlan(explorationPlan, OPERATOR);
      const exploration = await service.runExploration(OPERATOR, explorationPlan, explorationConfirmation, { maxDepth: 1, role: 'admin' });
      assert.ok(exploration.deniedUrls.some((entry) => new URL(entry.url).pathname.toLowerCase() === '/logout.php'));
      const reloginAfterExploration = await service.runLogin(OPERATOR, {
        role: 'admin',
        baseUrl: dvwaBase,
        secretValues: { 'dvwa-username': username, 'dvwa-password': password },
        expectedUrlPrefix: `${dvwaBase}/`,
      });
      assert.equal(reloginAfterExploration.authenticated, true, 'authenticated exploration must not invalidate the supplied account credentials');

      const target = `${dvwaBase}/vulnerabilities/sqli/?id=1&Submit=Submit`;
      const candidate: ScanCandidate = {
        candidateId: 'dvwa-sqli',
        url: target,
        method: 'GET',
        category: 'page',
        guidelineBasis: ['OWASP-TOP-10'],
        confidence: 1,
        observationUrl: `${dvwaBase}/vulnerabilities/sqli/`,
        dynamic: true,
        inputPoints: [{ name: 'id', location: 'query', type: 'text' }],
        diagnosticTracks: ['zap-active'],
      };
      const cryptographyTarget = `${dvwaBase}/vulnerabilities/cryptography/index.php`;
      const cryptographyCandidate: ScanCandidate = {
        candidateId: 'dvwa-cryptography-post',
        url: cryptographyTarget,
        method: 'POST',
        category: 'form',
        guidelineBasis: ['OWASP-TOP-10'],
        confidence: 1,
        observationUrl: cryptographyTarget,
        dynamic: true,
        contentType: 'application/x-www-form-urlencoded',
        inputPoints: [
          { name: 'message', location: 'body', type: 'text' },
          { name: 'direction', location: 'body', type: 'text' },
          { name: 'direction', location: 'body', type: 'text' },
        ],
        diagnosticTracks: ['zap-active'],
      };
      service.adoptCandidates(OPERATOR, [candidate, cryptographyCandidate]);
      const { plan } = service.buildActiveScanPlan(OPERATOR, [target, cryptographyTarget], {
        maxRequests: 500,
        maxPages: 20,
        maxDurationMinutes: 8,
      });
      service.authorizePlan(plan);
      const confirmation = service.confirmPlan(plan, OPERATOR);
      const scan = await service.runActiveScan(OPERATOR, plan, confirmation, [candidate, cryptographyCandidate], 'admin');
      assert.equal(scan.runRecord.state, 'Completed');
      assert.equal(scan.runRecord.stopReason, 'completed');
      assert.ok(scan.scanRequest.sessionCookieNames?.includes('PHPSESSID'));

      const relogin = await service.runLogin(OPERATOR, {
        role: 'admin',
        baseUrl: dvwaBase,
        secretValues: { 'dvwa-username': username, 'dvwa-password': password },
        expectedUrlPrefix: `${dvwaBase}/`,
      });
      assert.equal(relogin.authenticated, true, 'the bounded scan must not invalidate the supplied account credentials');

      const report = service.generateReport(OPERATOR, { guidelines: ['OWASP TOP 10'], excludeLowAndInfo: true });
      assert.match(report.content, /Low \/ Info/);
    } finally {
      await explorer.close();
      await loginExecutor.close();
    }
  });
});
