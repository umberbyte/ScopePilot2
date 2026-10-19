import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { CORE_API_ROUTE_METHODS } from '../../src/openapi-routes.ts';
import {
  CandidateCategories,
  ControlAspects,
  DomainErrorCodes,
  EngineKinds,
  FindingSeverities,
  FindingSourceKinds,
  FindingStatuses,
  FormClassifications,
  GuaranteeLevels,
  OperationClasses,
  PlanStepKinds,
  RunStates,
  ScanAttackStrengths,
  StopReasons,
} from '../../src/index.ts';

const SPEC_PATH = fileURLToPath(new URL('../../openapi/core-api.json', import.meta.url));

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json };

interface OpenApiSpec {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly paths: Readonly<Record<string, Readonly<Record<string, { readonly operationId?: string }>>>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, Json>>;
  };
}

// BaselineFlowEvent (src/events/events.ts) の type 判別子と 1:1 に対応させること。
const EXPECTED_EVENT_TYPES = [
  'CaseCreated',
  'CaseScopeUpdated',
  'ConfirmationsInvalidated',
  'AuthorizationGranted',
  'PlanValidated',
  'PlanAuthorized',
  'PlanConfirmed',
  'RunStarted',
  'RunCompleted',
  'EgressDenied',
  'CandidatesAdopted',
  'FindingsImported',
  'FindingStatusChanged',
  'FuzzRunCompleted',
  'BusinessLogicCheckCompleted',
  'LoginCompleted',
  'DocumentHintsRegistered',
  'DocumentAuthHintsRegistered',
  'SequencerSessionCompleted',
  'ApiSpecImported',
  'OastAttemptStarted',
  'OastCallbacksRecorded',
  'WsFramesImported',
  'WsMessagesSent',
  'TransportNegotiated',
  'ExtensionInstalled',
  'ReportGenerated',
];

// CT: OpenAPI 文書と経路表・contracts 型の一致検査 (docs/detailed-design/03 §2)。
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

  test('文書内の全 $ref は components 内の実在 node を指す', () => {
    const refs: string[] = [];
    collectRefs(spec as unknown as Json, refs);
    for (const ref of refs) {
      assert.ok(ref.startsWith('#/'), `外部 ref は許可しない: ${ref}`);
      assert.ok(resolveRef(spec, ref) !== undefined, `解決できない $ref: ${ref}`);
    }
  });

  test('schema は実体化されている (object schema が properties/additionalProperties を持つ)', () => {
    const problems: string[] = [];
    const visited = new Set<string>();
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      visitSchema(spec, schema, `#/components/schemas/${name}`, visited, problems);
    }
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const record = operation as unknown as Record<string, Json>;
        visitSchema(spec, record.requestBody, `paths.${path}.${method}.requestBody`, visited, problems);
        const responses = record.responses;
        if (typeof responses === 'object' && responses !== null) {
          for (const [status, response] of Object.entries(responses as Record<string, Json>)) {
            visitSchema(spec, response, `paths.${path}.${method}.responses.${status}`, visited, problems);
          }
        }
      }
    }
    assert.deepEqual(problems, [], 'loose な object schema が残っている');
  });

  test('spec の enum 値は contracts の契約配列と一致する', () => {
    assert.deepEqual(schemaEnum(spec, 'OperationClass'), [...OperationClasses]);
    assert.deepEqual(schemaEnum(spec, 'RunState'), [...RunStates]);
    assert.deepEqual(schemaEnum(spec, 'StopReason'), [...StopReasons]);
    assert.deepEqual(schemaEnum(spec, 'PlanStepKind'), [...PlanStepKinds]);
    assert.deepEqual(schemaEnum(spec, 'EngineKind'), [...EngineKinds]);
    assert.deepEqual(schemaEnum(spec, 'GuaranteeLevel'), [...GuaranteeLevels]);
    assert.deepEqual(schemaEnum(spec, 'FindingSourceKind'), [...FindingSourceKinds]);
    assert.deepEqual(schemaEnum(spec, 'FindingSeverity'), [...FindingSeverities]);
    assert.deepEqual(schemaEnum(spec, 'FindingStatus'), [...FindingStatuses]);
    assert.deepEqual(schemaEnum(spec, 'CandidateCategory'), [...CandidateCategories]);
    assert.deepEqual(schemaEnum(spec, 'FormClassification'), [...FormClassifications]);
    assert.deepEqual(schemaEnum(spec, 'ScanAttackStrength'), [...ScanAttackStrengths]);
    assert.deepEqual(schemaEnum(spec, 'ControlAspect'), [...ControlAspects]);
    assert.deepEqual(schemaEnum(spec, 'ApiErrorCode'), [
      ...DomainErrorCodes,
      'InternalError',
      'NotFound',
      'MethodNotAllowed',
    ]);
  });

  test('AuditEventLine は BaselineFlowEvent の全種を oneOf で網羅する', () => {
    const line = spec.components.schemas.AuditEventLine as { readonly oneOf?: Json };
    assert.ok(Array.isArray(line.oneOf), 'AuditEventLine に oneOf が必要');
    const discriminants: string[] = [];
    for (const entry of line.oneOf as Json[]) {
      const ref = (entry as Record<string, Json>).$ref;
      assert.ok(typeof ref === 'string', 'oneOf の各要素は $ref で参照する');
      const target = resolveRef(spec, ref) as Record<string, Json> | undefined;
      assert.ok(target !== undefined, `解決できない $ref: ${ref}`);
      const typeConst = (target.properties as Record<string, Json> | undefined)?.type as Record<string, Json> | undefined;
      assert.ok(typeConst !== undefined && typeof typeConst.const === 'string', `${ref} が type 判別子を持つ`);
      discriminants.push(typeConst.const);
    }
    assert.deepEqual([...discriminants].sort(), [...EXPECTED_EVENT_TYPES].sort());
  });
});

function collectRefs(node: Json, refs: string[]): void {
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectRefs(entry, refs);
    }
    return;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        refs.push(value);
      } else {
        collectRefs(value, refs);
      }
    }
  }
}

function resolveRef(spec: OpenApiSpec, ref: string): Json | undefined {
  if (!ref.startsWith('#/')) {
    return undefined;
  }
  let node: Json = spec as unknown as Json;
  for (const segment of ref.slice(2).split('/')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      return undefined;
    }
    node = (node as { readonly [key: string]: Json | undefined })[segment.replace(/~1/g, '/').replace(/~0/g, '~')] ?? null;
  }
  return node === null ? undefined : node;
}

/** object schema が properties/additionalProperties を持つ (loose object でない) ことを再帰検査する。 */
function visitSchema(spec: OpenApiSpec, node: Json | undefined, path: string, visited: Set<string>, problems: string[]): void {
  if (node === undefined || node === null) {
    return;
  }
  if (Array.isArray(node)) {
    for (const [index, entry] of node.entries()) {
      visitSchema(spec, entry, `${path}[${index}]`, visited, problems);
    }
    return;
  }
  if (typeof node !== 'object') {
    return;
  }
  const record = node as { readonly [key: string]: Json | undefined };
  if (typeof record.$ref === 'string') {
    if (visited.has(record.$ref)) {
      return;
    }
    visited.add(record.$ref);
    const target = resolveRef(spec, record.$ref);
    assert.ok(target !== undefined, `解決できない $ref: ${record.$ref} (${path})`);
    visitSchema(spec, target, record.$ref, visited, problems);
    return;
  }
  const type = record.type;
  const types = typeof type === 'string' ? [type] : Array.isArray(type) ? type.filter((entry): entry is string => typeof entry === 'string') : [];
  if (types.includes('object')) {
    const properties = record.properties;
    const hasProperties =
      typeof properties === 'object' && properties !== null && !Array.isArray(properties) && Object.keys(properties).length > 0;
    if (!hasProperties && record.additionalProperties === undefined) {
      problems.push(`${path}: object schema に properties がない`);
    }
  }
  for (const key of ['properties', 'additionalProperties', 'items', 'allOf', 'oneOf', 'anyOf', 'not'] as const) {
    const value = record[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (key === 'properties' || key === 'additionalProperties') {
      if (typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, child] of Object.entries(value)) {
          visitSchema(spec, child, `${path}.${key}.${name}`, visited, problems);
        }
      }
      continue;
    }
    visitSchema(spec, value, `${path}.${key}`, visited, problems);
  }
}

function schemaEnum(spec: OpenApiSpec, name: string): Json[] {
  const node = spec.components.schemas[name] as Record<string, Json> | undefined;
  assert.ok(node !== undefined, `schema ${name} が components に無い`);
  assert.ok(Array.isArray(node.enum), `schema ${name} が enum を持たない`);
  return node.enum as Json[];
}
