/** Reviewed, item-ID mappings only. Never infer runtime coverage from prose or ranges. */
import { hashStable, type GuidelineCoverageRoute } from '@scopepilot2/contracts';
import { WORKFLOW_SCAN_CHECK_IDS } from '../../../packages/core/src/domain/guideline-assertions.ts';

interface Guideline {
  readonly sheet: string;
  readonly version: string;
  readonly checks: readonly { readonly itemId: string }[];
}
// Broad categories intentionally share limited generic assertions. They do not prove the whole requirement.
const MAPPINGS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'OWASP Top 10-2025': {
    A01: ['cors-policy', 'path-traversal'], A02: ['security-headers', 'cookie-security'],
    A05: ['sql-error', 'reflected-input', 'dom-source-sink'], A10: ['error-disclosure'],
  },
  'OWASP ASVS 5.0': {
    '1.2.4': ['sql-error'], '3.3.1': ['cookie-security'], '3.3.2': ['cookie-security'],
    '3.3.4': ['cookie-security'], '3.4.2': ['cors-policy'],
  },
  'OWASP WSTG 4.2': {
    'WSTG-ATHZ-01': ['path-traversal'], 'WSTG-SESS-02': ['cookie-security'],
    'WSTG-INPV-01': ['reflected-input'], 'WSTG-INPV-05': ['sql-error'],
    'WSTG-ERRH-01': ['error-disclosure'], 'WSTG-CLNT-01': ['dom-source-sink'],
    'WSTG-CLNT-07': ['cors-policy'],
  },
  'デジタル庁 DS-221': {
    '4-2 #1': ['sql-error'], '4-2 #3': ['reflected-input', 'dom-source-sink'],
    '4-2 #8': ['path-traversal'], '4-2 #17': ['open-redirect'],
  },
  'WebAppPentestGuidelines v1.2': {
    'WAPG-1.2-001': ['sql-error'], 'WAPG-1.2-018': ['reflected-input'],
    'WAPG-1.2-029': ['path-traversal'], 'WAPG-1.2-053': ['open-redirect'],
    'WAPG-1.2-062': ['security-headers'], 'WAPG-1.2-076': ['cookie-security'],
    'WAPG-1.2-085': ['error-disclosure'],
  },
};

export function buildCoverageRoutes(guidelines: readonly Guideline[], catalogSha256: string): readonly GuidelineCoverageRoute[] {
  const routes = guidelines.flatMap((guideline) => [...new Set(guideline.checks.map((check) => check.itemId))].map((itemId): GuidelineCoverageRoute => {
    const assertionIds = MAPPINGS[guideline.sheet]?.[itemId] ?? [];
    const unsupported = assertionIds.length === 0;
    const rawTransport = guideline.sheet === 'OWASP ASVS 5.0' && itemId === '10.2.3';
    return {
      routeId: hashStable('scopepilot2.guideline-route-id.v1', [guideline.sheet, itemId, 'http-workflow-v1']),
      catalog: { catalogId: 'scopepilot2.guidelines', version: '3', sha256: catalogSha256 },
      guidelineId: guideline.sheet, itemId,
      routeKind: unsupported ? 'unsupported' : 'workflow', assertionIds,
      inputSchemaRefs: unsupported ? [] : ['scopepilot2.observed-http-targets.v1'],
      targetSelectorId: 'observed-in-scope-http-targets.v1',
      evidenceRequirements: unsupported ? [] : ['assertion-result', 'request-response'],
      guarantee: unsupported ? 'Unsupported' : 'Enforced', completionPolicy: 'all',
      applicabilityRuleId: 'http-observable.v1',
      limitationCodes: unsupported
        ? [rawTransport ? 'RAW_TRANSPORT_AND_DUAL_PARSER_ORACLE_MISSING' : 'ITEM_ASSERTION_MAPPING_NOT_REVIEWED']
        : ['SHARED_GENERIC_ASSERTION', 'LIMITED_HTTP_CHECK_NOT_FULL_ITEM_VERIFICATION'],
      reviewedBy: 'ScopePilot2/GO-22', reviewedAt: '2026-11-10T00:00:00.000Z',
    };
  }));
  validateCoverageRoutes(guidelines, routes, WORKFLOW_SCAN_CHECK_IDS);
  return routes;
}

export function validateCoverageRoutes(guidelines: readonly Guideline[], routes: readonly GuidelineCoverageRoute[], registry: readonly string[]): void {
  const keys = new Set(guidelines.flatMap((g) => g.checks.map((c) => JSON.stringify([g.sheet, c.itemId]))));
  const covered = new Set<string>();
  const ids = new Set<string>();
  const used = new Set<string>();
  const shared = new Map<string, GuidelineCoverageRoute[]>();
  for (const route of routes) {
    if (!route.routeId || !route.reviewedBy || !Number.isFinite(Date.parse(route.reviewedAt)) || !/^[a-f0-9]{64}$/u.test(route.catalog.sha256)) throw new Error('coverage: invalid version/review metadata');
    if (new Set(route.assertionIds).size !== route.assertionIds.length) throw new Error('coverage: duplicate assertion');
    if ((route.routeKind === 'zap-rule' || route.routeKind === 'nuclei-template') && route.guarantee !== 'Delegated') throw new Error('coverage: external engine must be Delegated');
    const key = JSON.stringify([route.guidelineId, route.itemId]);
    if (!keys.has(key)) throw new Error(`coverage: unknown item ${key}`);
    if (ids.has(route.routeId)) throw new Error(`coverage: duplicate route ${route.routeId}`);
    ids.add(route.routeId); covered.add(key);
    if (route.routeKind === 'unsupported') {
      if (route.guarantee !== 'Unsupported' || route.assertionIds.length !== 0 || route.limitationCodes.length === 0) throw new Error('coverage: invalid unsupported route');
    } else if (route.assertionIds.length === 0 || route.guarantee === 'Unsupported') throw new Error('coverage: executable route needs assertions and guarantee');
    for (const id of route.assertionIds) {
      if (!registry.includes(id)) throw new Error(`coverage: unknown assertion ${id}`);
      used.add(id);
      shared.set(id, [...(shared.get(id) ?? []), route]);
    }
  }
  for (const [id, references] of shared) {
    if (new Set(references.map((r) => JSON.stringify([r.guidelineId, r.itemId]))).size > 1
      && references.some((r) => !r.limitationCodes.includes('SHARED_GENERIC_ASSERTION'))) throw new Error(`coverage: shared assertion ${id} must be disclosed`);
  }
  for (const key of keys) if (!covered.has(key)) throw new Error(`coverage: missing route ${key}`);
  for (const id of registry) if (!used.has(id)) throw new Error(`coverage: unreferenced assertion ${id}`);
}
