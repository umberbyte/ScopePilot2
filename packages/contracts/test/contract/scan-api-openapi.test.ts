import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CORE_API_ROUTE_METHODS } from '../../src/openapi-routes.ts';

const spec = JSON.parse(readFileSync(new URL('../../openapi/core-api.json', import.meta.url), 'utf8'));
const schemas = spec.components.schemas;

test('OpenAPI, route table and server route branches have bidirectional parity', () => {
  // Literal `route === 'METHOD path'` remains the common form, including combined
  // `|| route === ...` branches. Job and run-coverage routes also match pathname
  // prefixes/templates; require those paths to appear with their HTTP method.
  const source = readFileSync(new URL('../../../core/src/application/api-server.ts', import.meta.url), 'utf8');
  const handlers = [...source.matchAll(/route === '(GET|POST|PUT|DELETE|PATCH) ([^']+)'/g)]
    .map((match) => `${match[1]} ${match[2]}`);
  const routes = CORE_API_ROUTE_METHODS.map(({ method, path }) => `${method} ${path}`);
  const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.keys(methods as object).filter((method) => ['get', 'post', 'put', 'delete', 'patch'].includes(method))
      .map((method) => `${method.toUpperCase()} ${path}`));
  assert.equal(new Set(handlers).size, handlers.length, 'duplicate server handler');
  const missingHandlers = routes.filter((route) => {
    if (handlers.includes(route)) return false;
    const [method, path] = route.split(' ');
    const literal = path!.includes('{') ? path!.slice(0, path!.indexOf('{')) : path!;
    return !(source.includes(literal) && (source.includes(`'${method} ${path}'`) || source.includes(`method === '${method}'`)));
  });
  assert.deepEqual(missingHandlers, []);
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
  assert.deepEqual(schemas.ScanStopAccepted.required, ['executionId', 'state', 'runState', 'dispatchState']);
  assert.ok(stop.responses['400']);
  assert.ok(stop.responses['404']);
});

test('scan snapshot describes live progress and optional terminal result/error', () => {
  const scanState = schemas.ScanExecutionState.$ref === '#/components/schemas/RunState' ? schemas.RunState : schemas.ScanExecutionState;
  assert.deepEqual(scanState.enum, ['Draft', 'Validated', 'Authorized', 'Confirmed', 'Running', 'Stopping', 'Completed', 'Stopped', 'Failed', 'Interrupted']);
  const snapshot = schemas.ScanExecutionSnapshot;
  assert.deepEqual(snapshot.required, ['executionId', 'state', 'currentEngine', 'currentCommand', 'progress', 'logs', 'runState', 'dispatchState']);
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
