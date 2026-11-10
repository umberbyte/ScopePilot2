import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoreApiServer } from '../../src/application/api-server.ts';
import { createTestService, TEST_OPERATOR } from '../unit/support/test-flow.ts';

test('analysis APIs work without a case, scope, authorization or target transport', async () => {
  const { service } = createTestService();
  const server = createCoreApiServer({ service, operator: { ...TEST_OPERATOR, permissions: ['case.read'] } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const hash = await post('/api/tools/hash', { inputText: 'abc' });
    assert.equal(hash.status, 200);
    assert.equal((await hash.json()).md5, '900150983cd24fb0d6963f7d28e17f72');
    const binary = await post('/api/tools/compare-binary', { left: 'ff', right: 'ff00' });
    assert.equal(binary.status, 200);
    assert.equal((await binary.json()).firstDifferenceOffset, 1);
    assert.equal((await post('/api/tools/compare-binary', { left: 'f', right: 'ff' })).status, 400);
    const decode = await post('/api/tools/decode', { inputText: 'aGVsbG8=', codecs: ['base64'] });
    assert.equal((await decode.json()).outputText, 'hello');
    const text = await post('/api/tools/compare-text', { left: '', right: '\n' });
    assert.equal((await text.json()).equal, false);
    assert.deepEqual(service.events(), [], 'local tools do not create target activity');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('analysis APIs reject operators without case.read', async () => {
  const { service } = createTestService();
  const server = createCoreApiServer({ service, operator: { ...TEST_OPERATOR, permissions: [] } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    for (const path of ['/api/tools/hash', '/api/tools/compare-binary']) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 403);
      await response.body?.cancel();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
