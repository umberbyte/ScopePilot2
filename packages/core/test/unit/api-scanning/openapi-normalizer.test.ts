import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildApiRequestBody,
  classifyGraphqlOperation,
  normalizeOpenApiServers,
  normalizePostmanCollection,
  planApiCandidates,
  requireSecretVariable,
  resolveSchemaReference,
  resolveVariable,
} from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

const scope = { allowedOrigins: ['http://api.fixture.test'], deniedOrigins: [] };

describe('api-scanning (F12)', () => {
  test('[F12-UT-001] 複数 server は scope 内だけ候補化する', () => {
    const result = normalizeOpenApiServers(['http://api.fixture.test/v1', 'https://partner.example/v2'], scope);
    assert.deepEqual(result.candidates, ['http://api.fixture.test']);
    assert.deepEqual(result.excluded, ['https://partner.example/v2']);
  });

  test('[F12-UT-002] pre-request script は実行せず unsupported warning を出す', () => {
    const result = normalizePostmanCollection({ name: 'collection-a', hasPreRequestScript: true });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /never executed/);
    assert.equal(normalizePostmanCollection({ name: 'collection-b', hasPreRequestScript: false }).warnings.length, 0);
  });

  test('[F12-UT-003] GraphQL mutation は write candidate と分類する', () => {
    assert.deepEqual(classifyGraphqlOperation({ name: 'updateProfile', type: 'mutation' }), { category: 'write' });
    assert.deepEqual(classifyGraphqlOperation({ name: 'profile', type: 'query' }), { category: 'read' });
  });

  test('[F12-UT-004] 変数は定義順 (案件設定 > 環境参照 > 文書既定) で provenance 付き解決する', () => {
    const layers = {
      caseSettings: { baseUrl: 'http://case.test' },
      environmentReferences: { baseUrl: 'http://env.test', token: 'env-token' },
      documentDefaults: { baseUrl: 'http://doc.test', pageSize: '50' },
    };
    assert.deepEqual(resolveVariable('baseUrl', layers), { resolved: true, value: 'http://case.test', provenance: 'case-setting' });
    assert.deepEqual(resolveVariable('token', layers), { resolved: true, value: 'env-token', provenance: 'environment-reference' });
    assert.deepEqual(resolveVariable('pageSize', layers), { resolved: true, value: '50', provenance: 'document-default' });
    assert.deepEqual(resolveVariable('unknown', layers), { resolved: false });
  });

  test('[F12-UT-005] secret 変数が未解決なら値を推測せず NeedsInput', () => {
    assert.throws(() => requireSecretVariable('adminToken', { resolved: false }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'NeedsInput');
      assert.match((error as DomainError).message, /adminToken/);
      return true;
    });
    assert.throws(() => requireSecretVariable('adminToken', { resolved: true, value: '' }), /NeedsInput|adminToken/);
    assert.deepEqual(requireSecretVariable('adminToken', { resolved: true, value: 'from-store' }), { value: 'from-store' });
  });

  test('[F12-UT-006] binary schema は自動本文を作らず NeedsInput', () => {
    assert.throws(() => buildApiRequestBody({ format: 'binary' }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'NeedsInput');
      return true;
    });
    assert.deepEqual(buildApiRequestBody({ format: 'json' }), { kind: 'json' });
    assert.deepEqual(buildApiRequestBody(null), { kind: 'json' });
  });

  test('[F12-UT-007] 循環参照は bounded error にする', () => {
    const components: Record<string, unknown> = {
      A: { $ref: '#/components/schemas/B' },
      B: { $ref: '#/components/schemas/A' },
      C: { type: 'object' },
    };
    assert.throws(
      () => resolveSchemaReference({ components: () => components }, 'A'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'ValidationFailed');
        assert.match((error as DomainError).message, /cyclic/);
        return true;
      },
    );
    assert.deepEqual(resolveSchemaReference({ components: () => components }, 'C'), { ref: 'C' });
    assert.throws(() => resolveSchemaReference({ components: () => components }, 'X'), /unknown schema reference/);
  });

  test('[F12-UT-008] document only の候補は observed=false を保持する', () => {
    const candidates = planApiCandidates([
      { method: 'GET', path: '/users', source: 'document' },
      { method: 'GET', path: '/items', source: 'observation' },
    ]);
    assert.equal(candidates[0]?.observed, false);
    assert.equal(candidates[1]?.observed, true);
  });
});
