import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hashStable, GuidelineAssessments, GuidelineExecutionStatuses } from '@scopepilot2/contracts';
import { buildCatalog } from '../../src/generate.ts';
import { validateCoverageRoutes } from '../../src/coverage.ts';
import { readWorkbook } from '../../src/xlsx.ts';
import { WORKFLOW_SCAN_CHECK_IDS } from '../../../../packages/core/src/domain/guideline-assertions.ts';

const root = new URL('../../../../', import.meta.url);
const golden = JSON.parse(readFileSync(new URL('docs/generated/guideline-catalog.json', root), 'utf8')) as ReturnType<typeof buildCatalog>;
const rebuilt = buildCatalog(readWorkbook(readFileSync(new URL(golden.source.workbookPath, root))), golden.source);

test('catalog v3 golden: generator emits complete deterministic item-level routes in the same artifact', () => {
  assert.deepEqual(rebuilt, golden);
  assert.equal(golden.catalogHash, '5601e47caf230adbd1aa8e848e6175c743ecd42b48219e2eb8a97313bcf34092');
  assert.equal(golden.coverageRoutes.length, 819);
  assert.equal(golden.counts.guidelineChecks, 871); // repeated rows for a single item share its route
  validateCoverageRoutes(golden.guidelines, golden.coverageRoutes, WORKFLOW_SCAN_CHECK_IDS);
  const { catalogHash, ...body } = golden;
  assert.equal(hashStable('scopepilot2.catalog', body), catalogHash);
  const { coverageRoutes, catalogContentHash, ...content } = body;
  assert.equal(hashStable('scopepilot2.catalog-content.v3', content), catalogContentHash);
  assert.ok(coverageRoutes.every((r) => r.catalog.sha256 === catalogContentHash));
});

test('Top10, ASVS, WSTG, DS-221, WAPG fixtures distinguish limited shared assertions and unsupported items', () => {
  for (const prefix of ['OWASP Top', 'OWASP ASVS', 'OWASP WSTG', 'DS-221', 'WebAppPentest']) {
    const routes = golden.coverageRoutes.filter((r) => r.guidelineId.includes(prefix));
    assert.ok(routes.some((r) => r.guarantee === 'Enforced' && r.limitationCodes.includes('SHARED_GENERIC_ASSERTION')), prefix);
    assert.ok(routes.some((r) => r.routeKind === 'unsupported' && r.guarantee === 'Unsupported' && r.limitationCodes.length > 0), prefix);
  }
  assert.ok(golden.coverageRoutes.every((r) => !r.assertionIds.some((id) => /[:/].*\.ts|line:/u.test(id))));
});

test('build validation rejects missing item routes, unknown assertions, orphan registry IDs, duplicate routes', () => {
  const active = golden.coverageRoutes.find((r) => r.routeKind !== 'unsupported')!;
  assert.throws(() => validateCoverageRoutes(golden.guidelines, golden.coverageRoutes.slice(1), WORKFLOW_SCAN_CHECK_IDS), /missing route/);
  assert.throws(() => validateCoverageRoutes(golden.guidelines, golden.coverageRoutes.map((r) => r === active ? { ...r, assertionIds: ['does-not-exist'] } : r), WORKFLOW_SCAN_CHECK_IDS), /unknown assertion/);
  assert.throws(() => validateCoverageRoutes(golden.guidelines, golden.coverageRoutes, [...WORKFLOW_SCAN_CHECK_IDS, 'unreferenced-implementation']), /unreferenced assertion/);
  assert.throws(() => validateCoverageRoutes(golden.guidelines, [...golden.coverageRoutes, active], WORKFLOW_SCAN_CHECK_IDS), /duplicate route/);
  const unsupported = golden.coverageRoutes.find((r) => r.routeKind === 'unsupported')!;
  assert.throws(() => validateCoverageRoutes(golden.guidelines, golden.coverageRoutes.map((r) => r === unsupported ? { ...r, limitationCodes: [] } : r), WORKFLOW_SCAN_CHECK_IDS), /invalid unsupported/);
});

test('OpenAPI exposes execution and assessment as separate contract enums and shares report coverage type', () => {
  const spec = JSON.parse(readFileSync(new URL('packages/contracts/openapi/core-api.json', root), 'utf8'));
  const schemas = spec.components.schemas;
  assert.deepEqual(schemas.GuidelineItemExecution.properties.executionStatus.enum, GuidelineExecutionStatuses);
  assert.deepEqual(schemas.GuidelineItemExecution.properties.assessment.enum, GuidelineAssessments);
  assert.deepEqual(schemas.ReportCoverage.properties.guidelineCoverage, { $ref: '#/components/schemas/GuidelineRunCoverage' });
  assert.equal(spec.paths['/api/runs/{runId}/guideline-coverage'].get.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/GuidelineRunCoverage');
});
