import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { CORE_API_ROUTE_METHODS } from '../../src/openapi-routes.ts';

const SPEC_PATH = fileURLToPath(new URL('../../openapi/core-api.json', import.meta.url));

interface OpenApiSpec {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, Readonly<Record<string, { readonly operationId?: string }>>>>;
}

// CT: OpenAPI 文書と経路表の一致検査 (docs/detailed-design/03 §2)。
describe('Core API OpenAPI 契約', () => {
  const spec: OpenApiSpec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));

  test('spec は OpenAPI 3.1 で、契約 version を info に持つ', () => {
    assert.equal(spec.openapi, '3.1.0');
    assert.equal(spec.info.title, 'ScopePilot2 Core API');
    assert.equal(spec.info.version, 'scopepilot2.api.v1');
  });

  test('spec の paths×methods は経路表 (CORE_API_ROUTE_METHODS) と過不足なく一致する', () => {
    const specRoutes = new Set<string>();
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const method of Object.keys(operations)) {
        if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
          specRoutes.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    const tableRoutes = new Set(CORE_API_ROUTE_METHODS.map((route) => `${route.method} ${route.path}`));
    assert.deepEqual([...specRoutes].sort(), [...tableRoutes].sort());
  });

  test('全 operation が operationId を持ち、経路表の operationId と一致する', () => {
    for (const route of CORE_API_ROUTE_METHODS) {
      const operation = spec.paths[route.path]?.[route.method.toLowerCase()];
      assert.ok(operation !== undefined, `${route.method} ${route.path} が spec に無い`);
      assert.equal(operation.operationId, route.operationId);
    }
    const specOperationIds = new Set<string>();
    for (const operations of Object.values(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (['get', 'post', 'put', 'delete', 'patch'].includes(method) && operation.operationId !== undefined) {
          specOperationIds.add(operation.operationId);
        }
      }
    }
    assert.equal(specOperationIds.size, CORE_API_ROUTE_METHODS.length, 'operationId の重複なし');
  });
});
