/**
 * Core API の経路一覧 (OpenAPI 文書と実装の parity 検査に使う)。
 * `packages/contracts/openapi/core-api.json` の paths と一致させる。
 */
export const CORE_API_ROUTE_METHODS: readonly { readonly method: string; readonly path: string; readonly operationId: string }[] = [
  { method: 'GET', path: '/api/health', operationId: 'getHealth' },
  { method: 'GET', path: '/api/case', operationId: 'getCurrentCase' },
  { method: 'POST', path: '/api/case', operationId: 'createCase' },
  { method: 'POST', path: '/api/case/scope', operationId: 'updateCaseScope' },
  { method: 'GET', path: '/api/authorization', operationId: 'getCurrentAuthorization' },
  { method: 'POST', path: '/api/authorization', operationId: 'grantAuthorization' },
  { method: 'POST', path: '/api/plan/explore', operationId: 'buildExplorePlan' },
  { method: 'POST', path: '/api/plan/scan', operationId: 'buildActiveScanPlan' },
  { method: 'POST', path: '/api/plan/confirm', operationId: 'confirmPlan' },
  { method: 'POST', path: '/api/candidates/adopt', operationId: 'adoptScanCandidates' },
  { method: 'POST', path: '/api/run/explore', operationId: 'runExploration' },
  { method: 'POST', path: '/api/run/scan', operationId: 'runActiveScan' },
  { method: 'POST', path: '/api/import/nuclei', operationId: 'importNucleiResults' },
  { method: 'POST', path: '/api/report', operationId: 'generateReport' },
  { method: 'GET', path: '/api/capabilities', operationId: 'listCapabilities' },
  { method: 'GET', path: '/api/runs/interrupted', operationId: 'listInterruptedRuns' },
  { method: 'GET', path: '/api/events', operationId: 'listEvents' },
];
