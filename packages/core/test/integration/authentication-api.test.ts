import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCoreApiServer } from '../../src/application/api-server.ts';
import { bootstrapFlow } from '../unit/support/test-flow.ts';

test('authentication API exposes capabilities, rejects credentials in metadata and guards context revisions', async () => {
  const { service, operator } = await bootstrapFlow();
  const server = createCoreApiServer({ service, operator });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TCP address expected');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const user = { role: 'alice', displayName: 'Alice', authorizationRole: 'admin', method: 'Form', enabled: true };
  try {
    assert.equal((await post('/api/authentication/users', { ...user, secretValue: 'do-not-store' })).status, 400);
    assert.equal((await post('/api/authentication/users', { ...user, enabled: 'yes' })).status, 400);
    assert.equal((await post('/api/authentication/users', { ...user, method: 'Unknown' })).status, 400);
    assert.equal((await post('/api/authentication/users', user)).status, 200);
    const configuration = await (await fetch(`${base}/api/authentication`)).json();
    assert.deepEqual(configuration.users, [user]);
    assert.equal(configuration.capabilities.refresh, 'fixture');
    assert.equal(configuration.capabilities.verification, 'unavailable');
    assert.equal(configuration.capabilities.configurationStorage, 'memory');
    assert.ok(!JSON.stringify(configuration).includes('do-not-store'));
    assert.equal((await post('/api/sessions/verify', { role: 'alice' })).status, 409);
    const record = service.currentCase();
    assert.equal((await post('/api/case/scope', { expectedRevision: record.revision + 1, ...record.scope })).status, 409);
    assert.equal(service.currentCase().revision, record.revision);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
