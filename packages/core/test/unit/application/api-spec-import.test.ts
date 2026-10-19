import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * API 仕様取込の service 経路 (design/f12)。server は許可 Origin 内だけ候補化し、
 * 文書内の instruction/script は実行しない。endpoint は計画確認を経由して使う。
 */
describe('api spec import (service)', () => {
  const spec = {
    openapi: '3.1.0',
    servers: [{ url: 'http://fixture.target.test/api' }, { url: 'http://elsewhere.example/api' }],
    paths: {
      '/users': { get: { responses: {} }, post: { responses: {} } },
      '/users/{id}': { get: { responses: {} } },
    },
  };

  test('OpenAPI 文書を parse し、許可内 server と endpoint 一覧を返す', async () => {
    const { service, operator } = await bootstrapFlow();
    const result = service.importApiSpec(operator, { documentLabel: 'API 仕様書 v1', document: spec });
    assert.deepEqual(result.servers, ['http://fixture.target.test/api'], 'basePath を保持する');
    assert.deepEqual(result.excludedServers, ['http://elsewhere.example/api']);
    assert.equal(result.endpoints.length, 3, '許可内 server 1 × 操作 3 (GET/POST /users・GET /users/{id})');
    assert.ok(result.endpoints.every((endpoint) => endpoint.url.startsWith('http://fixture.target.test/api')));
    assert.ok(result.endpoints.some((endpoint) => endpoint.method === 'POST' && endpoint.path === '/users'));
    assert.deepEqual(result.warnings, ['path template /users/{id} needs explicit values']);
    assert.equal(service.listApiSpecImports().length, 1);

    const eventsText = JSON.stringify(service.events());
    assert.ok(eventsText.includes('ApiSpecImported'));
  });

  test('Swagger 2 形式 (host+schemes) も扱う。不正な文書・scope 外 server は拒否', async () => {
    const { service, operator } = await bootstrapFlow();
    const swagger = { swagger: '2.0', host: 'fixture.target.test', schemes: ['http'], basePath: '/v2', paths: { '/health': { get: {} } } };
    const result = service.importApiSpec(operator, { documentLabel: 'swagger doc', document: swagger });
    assert.deepEqual(result.servers, ['http://fixture.target.test/v2']);
    assert.deepEqual(result.endpoints.map((endpoint) => endpoint.url), ['http://fixture.target.test/v2/health']);

    assert.throws(
      () => service.importApiSpec(operator, { documentLabel: 'x', document: { paths: {} } }),
      /openapi or swagger version/,
    );
    assert.throws(
      () => service.importApiSpec(operator, { documentLabel: 'x', document: { openapi: '3.1.0', servers: [{ url: 'http://fixture.target.test' }], paths: {} } }),
      /no endpoint operations/,
    );
    assert.throws(
      () => service.importApiSpec(operator, { documentLabel: 'x', document: { openapi: '3.1.0', servers: [{ url: 'http://elsewhere.example' }], paths: { '/a': { get: {} } } } }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        return true;
      },
    );
  });
});
