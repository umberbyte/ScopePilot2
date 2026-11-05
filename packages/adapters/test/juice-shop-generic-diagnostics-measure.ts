/**
 * Juice Shop 汎用 HTTP 診断の実測ハーネス (ベンチマーク測定専用)。
 *
 * 使用法: env JUICE_SHOP_BASE_URL=... node test/juice-shop-generic-diagnostics-measure.ts
 *
 * ScopePilot 自己完結の汎用 HTTP 診断 (workflow scan 9 チェック + ZAP 非対応
 * テーマの対象 URLのみで動くもの) を実対象へ実行し、challenge の解決差分と
 * 診断結果 (findings) を記録する。ZAP は使わない (別ハーネスで測定)。
 * Juice Shop 固有の知識は本測定スクリプトにだけ存在する。
 */
import assert from 'node:assert/strict';
import { resolveWorkflowScanCheckIds, runWorkflowScan } from '@scopepilot2/core';
import { NodeWorkflowScanTransport } from '../src/workflow-scan-transport.ts';
import { NodeRepeaterTransport } from '../src/repeater-transport.ts';
import { bootstrapFlow } from '../../core/test/unit/support/test-flow.ts';

const baseUrl = process.env.JUICE_SHOP_BASE_URL ?? '';
assert.notEqual(baseUrl, '', 'JUICE_SHOP_BASE_URL is required');
const origin = new URL(baseUrl).origin;

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

const before = await challenges();
const solvedBefore = new Set(before.filter((entry) => entry.solved).map((entry) => entry.key));
console.log(`challenges before: ${before.length} total, ${solvedBefore.size} solved`);

const { service, operator } = await bootstrapFlow({
  allowedOrigins: [origin],
  allowedOperationClasses: ['Browse', 'ActiveScan'],
  caseLimits: { maxRequests: 3000, maxPages: 300, maxDurationMinutes: 60 },
  repeaterTransport: new NodeRepeaterTransport({ timeoutMs: 10_000 }),
});

// 診断対象: 実測クロールで観測した主要な公開経路 (測定スクリプト内での選定)。
const pageTargets = [
  `${baseUrl}/`,
  `${baseUrl}/#/login`,
  `${baseUrl}/#/contact`,
  `${baseUrl}/#/search?q=`,
];
const apiTargets = [
  { url: `${baseUrl}/rest/products/search?q=`, method: 'GET' as const },
  { url: `${baseUrl}/rest/user/whoami`, method: 'GET' as const },
  { url: `${baseUrl}/rest/captcha/`, method: 'GET' as const },
  { url: `${baseUrl}/rest/languages`, method: 'GET' as const },
  { url: `${baseUrl}/rest/memories/`, method: 'GET' as const },
];

console.log('--- workflow scan (generic 9 checks) ---');
const checkIds = resolveWorkflowScanCheckIds([]);
const workflowResult = await runWorkflowScan(
  {
    baseUrl: origin,
    targets: [
      ...pageTargets.map((url) => ({ url, method: 'GET' as const })),
      ...apiTargets,
    ],
    maxRequests: 2000,
    checkIds,
  },
  new NodeWorkflowScanTransport({ baseUrl: origin, maxRequests: 2000 }),
);
for (const check of workflowResult.checks) {
  console.log(`  ${check.checkId} (${check.severity}) @ ${check.url} param=${check.param} evidence=${check.evidence.slice(0, 90)}`);
}
if (workflowResult.checks.length === 0) {
  console.log('  (検出なし)');
}
console.log(`  requestCount: ${workflowResult.requestCount}/${2000}`);

console.log('--- zap-unsupported themes (targetUrls only) ---');
for (const themeNo of ['24', '25', '30']) {
  const summary = await service.runZapUnsupportedCheck(operator, {
    themeNo,
    targetUrls: [`${baseUrl}/`, `${baseUrl}/#/login`, `${baseUrl}/rest/products/search?q=`],
  });
  const outcomes = new Map<string, number>();
  for (const probe of summary.results) {
    const outcome = probe.outcome ?? 'unresolved';
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  }
  console.log(`  theme ${themeNo}: probes=${summary.results.length} outcomes=${JSON.stringify([...outcomes.entries()])}`);
}

const after = await challenges();
const newly = after.filter((entry) => entry.solved && !solvedBefore.has(entry.key));
console.log('--- challenge diff ---');
console.log(`solved after: ${after.filter((entry) => entry.solved).length} (newly solved: ${newly.length})`);
for (const entry of newly) {
  console.log(`  + [${entry.category}] ${entry.name} (${entry.key})`);
}
