import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CORE_API_ROUTE_METHODS } from '../../src/openapi-routes.ts';

const spec = JSON.parse(readFileSync(new URL('../../openapi/core-api.json', import.meta.url), 'utf8'));
const schemas = spec.components.schemas;

test('OpenAPI, route table and server route branches have bidirectional parity', () => {
  // The server currently dispatches literal method/path branches. Keep this check
  // until dispatch is backed by a registry; do not refactor production routing here.
  const source = readFileSync(new URL('../../../core/src/application/api-server.ts', import.meta.url), 'utf8');
  const handlers = [...source.matchAll(/if \(route === '(GET|POST|PUT|DELETE|PATCH) ([^']+)'\)/g)]
    .map((match) => `${match[1]} ${match[2]}`);
  const routes = CORE_API_ROUTE_METHODS.map(({ method, path }) => `${method} ${path}`);
  const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.keys(methods as object).filter((method) => ['get', 'post', 'put', 'delete', 'patch'].includes(method))
      .map((method) => `${method.toUpperCase()} ${path}`));
  assert.equal(new Set(handlers).size, handlers.length, 'duplicate server handler');
  assert.deepEqual(handlers.sort(), [...routes].sort());
  assert.deepEqual(operations.sort(), [...routes].sort());
});

test('scan async operations preserve current request, success and error contracts', () => {
  const start = spec.paths['/api/run/scan/start'].post;
  const status = spec.paths['/api/run/scan/status'].get;
  const stop = spec.paths['/api/run/scan/stop'].post;
  assert.deepEqual(start.requestBody, spec.paths['/api/run/scan'].post.requestBody);
  assert.equal(start.responses['202'].content['application/json'].schema.$ref, '#/components/schemas/ScanExecutionAccepted');
  assert.deepEqual(schemas.ScanExecutionAccepted.required, ['executionId']);
  assert.deepEqual(status.parameters, [{ name: 'executionId', in: 'query', required: true, schema: { type: 'string' } }]);
  assert.equal(status.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/ScanExecutionSnapshot');
  assert.ok(status.responses['404']);
  assert.equal(stop.requestBody.content['application/json'].schema.$ref, '#/components/schemas/ScanStopRequest');
  assert.deepEqual(schemas.ScanStopRequest.required, ['executionId']);
  assert.equal(stop.responses['202'].content['application/json'].schema.$ref, '#/components/schemas/ScanStopAccepted');
  assert.deepEqual(schemas.ScanStopAccepted.required, ['executionId', 'state']);
  assert.ok(stop.responses['400']);
  assert.ok(stop.responses['404']);
});

test('scan snapshot describes live progress and optional terminal result/error', () => {
  assert.deepEqual(schemas.ScanExecutionState.enum, ['queued', 'running', 'stopping', 'stopped', 'completed', 'failed']);
  const snapshot = schemas.ScanExecutionSnapshot;
  assert.deepEqual(snapshot.required, ['executionId', 'state', 'currentEngine', 'currentCommand', 'progress', 'logs']);
  assert.deepEqual(snapshot.properties.currentEngine.enum, ['zap', 'nuclei', 'scopepilot']);
  assert.equal(snapshot.properties.logs.type, 'array');
  assert.equal(snapshot.properties.logs.items.type, 'string');
  assert.equal(snapshot.properties.error.type, 'string');
  assert.equal(snapshot.properties.result.$ref, '#/components/schemas/ScanExecutionResult');
  const result = schemas.ScanExecutionResult;
  for (const name of ['runRecord', 'planHash', 'scanRequest', 'overshootReservation', 'engineVersion', 'findings']) {
    assert.deepEqual(result.properties[name], schemas.ActiveScanRunResult.properties[name]);
    assert.ok(result.required.includes(name));
  }
  for (const name of ['requestCorpusEvidenceRef', 'diagnosticRoutes', 'guidelineRoutes']) {
    assert.ok(result.required.includes(name));
    assert.ok(result.properties[name]);
  }
  for (const name of ['workflow', 'nuclei']) {
    assert.ok(result.properties[name]);
    assert.ok(!result.required.includes(name));
  }
  // The HTTP projection currently omits payloadVerifications, unlike the service result.
  assert.equal(result.properties.payloadVerifications, undefined);
});
