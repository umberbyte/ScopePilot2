import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { testRuntimeConnections } from '../../src/main/runtime-connections.ts';
import { normalizeRuntimeEnvironment, runtimeEnvironment, RuntimeSettingsStore } from '../../src/main/runtime-settings.ts';
import { EMPTY_RUNTIME_ENVIRONMENT } from '../../src/shared/runtime-settings.ts';

test('environment settings round-trip, inherit blanks and preserve AI selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scopepilot-settings-'));
  try {
    const filePath = join(root, 'runtime-tools.json');
    const config = join(root, 'interactsh.yaml');
    await writeFile(config, 'secret: never-copy-this');
    const store = new RuntimeSettingsStore({ filePath, applicationDirectory: root, pathValue: '', environment: {} });
    const initial = await store.load();
    const environment = { ...EMPTY_RUNTIME_ENVIRONMENT, SCOPEPILOT_API_PORT: '8787', SCOPEPILOT_ZAP_BASE_URL: 'http://127.0.0.1:8081', SCOPEPILOT_OAST_SERVER_URL: 'https://oast.example', SCOPEPILOT_INTERACTSH_CONFIG: config };
    await store.save({ ...initial, environment });
    await store.saveAiSelection({ provider: 'codex', model: 'test' });
    const reopened = await new RuntimeSettingsStore({ filePath, applicationDirectory: root, pathValue: '', environment: {} }).load();
    assert.deepEqual(reopened.environment, environment);
    assert.equal(reopened.aiSelection.model, 'test');
    assert.ok(!(await readFile(filePath, 'utf8')).includes('never-copy-this'));
    assert.equal(runtimeEnvironment(initial, { SCOPEPILOT_API_PORT: '1234' }).SCOPEPILOT_API_PORT, '1234');
    assert.equal(runtimeEnvironment(reopened, { SCOPEPILOT_API_PORT: '1234' }).SCOPEPILOT_API_PORT, '8787');
    await assert.rejects(store.save({ ...initial, environment: { ...environment, SCOPEPILOT_API_PORT: '65536' } }));
    assert.deepEqual(store.current().environment, environment);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reject invalid ports, credential URLs, unsafe protocols and relative config paths', () => {
  for (const port of ['-1', '1.5', '0x10', '65536']) assert.throws(() => normalizeRuntimeEnvironment({ SCOPEPILOT_API_PORT: port }));
  for (const url of ['file:///tmp', 'http://user:secret@localhost', 'http://localhost/path', 'http://localhost/?secret=1']) assert.throws(() => normalizeRuntimeEnvironment({ SCOPEPILOT_ZAP_BASE_URL: url }));
  assert.throws(() => normalizeRuntimeEnvironment({ SCOPEPILOT_OAST_SERVER_URL: 'http://oast.example' }));
  assert.throws(() => normalizeRuntimeEnvironment({ SCOPEPILOT_INTERACTSH_CONFIG: 'relative.yaml' }));
  assert.equal(normalizeRuntimeEnvironment({ SCOPEPILOT_API_PORT: '0' }).SCOPEPILOT_API_PORT, '0');
});

test('saved paths override inherited paths and Nuclei disable wins over both', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scopepilot-precedence-'));
  try {
    const tool = join(root, 'tool.exe');
    await writeFile(tool, 'not executable');
    const store = new RuntimeSettingsStore({ filePath: join(root, 'settings.json'), applicationDirectory: root, pathValue: '', environment: { SCOPEPILOT_NUCLEI_EXECUTABLE: tool } });
    const initial = await store.load();
    assert.equal(initial.tools.find((item) => item.id === 'nucleiExecutable')?.source, 'environment');
    assert.equal(runtimeEnvironment(initial, { SCOPEPILOT_NUCLEI_EXECUTABLE: 'other' }).SCOPEPILOT_NUCLEI_EXECUTABLE, tool);
    const disabled = runtimeEnvironment(initial, { SCOPEPILOT_DISABLE_NUCLEI: '1', SCOPEPILOT_NUCLEI_EXECUTABLE: tool });
    assert.equal(disabled.SCOPEPILOT_NUCLEI_EXECUTABLE, undefined);
    const checks = await testRuntimeConnections({ ...initial, environment: { ...EMPTY_RUNTIME_ENVIRONMENT, SCOPEPILOT_ZAP_BASE_URL: 'http://127.0.0.1:1' } }, {});
    assert.equal(checks.find((item) => item.id === 'nuclei')?.state, 'unavailable');
    assert.ok(!JSON.stringify(checks).includes('not executable'));
    await assert.rejects(store.save({ ...initial, environment: { ...EMPTY_RUNTIME_ENVIRONMENT, SCOPEPILOT_OAST_SERVER_URL: 'https://oast.example' } }), /Interactsh/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checks real ZAP version and pinned template content, reports missing tools without fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scopepilot-connection-'));
  const server = createServer((request, response) => {
    assert.equal(request.url, '/JSON/core/view/version/');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ version: '2.17.0' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const template = 'id: test\nhttp:\n  - method: GET\n    path: ["{{BaseURL}}/"]\n';
    await writeFile(join(root, 'test.yaml'), template);
    const manifest = join(root, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ schemaVersion: 'scopepilot2.nuclei-template-bundle.v1', templates: [{ id: 'test', path: 'test.yaml', sha256: createHash('sha256').update(template).digest('hex'), protocol: 'http' }] }));
    const store = new RuntimeSettingsStore({ filePath: join(root, 'runtime-tools.json'), applicationDirectory: root, pathValue: '', environment: {} });
    const initial = await store.load();
    const snapshot = await store.save({ ...initial, paths: { ...initial.paths, nucleiTemplateManifest: manifest }, environment: { ...EMPTY_RUNTIME_ENVIRONMENT, SCOPEPILOT_ZAP_BASE_URL: `http://127.0.0.1:${address.port}` } });
    const checks = await testRuntimeConnections(snapshot, {});
    assert.equal(checks.find((item) => item.id === 'zap')?.state, 'available');
    assert.equal(checks.find((item) => item.id === 'templates')?.state, 'available');
    assert.equal(checks.find((item) => item.id === 'nuclei')?.state, 'unconfigured');
    assert.equal(checks.find((item) => item.id === 'oast')?.state, 'unconfigured');
    await writeFile(join(root, 'test.yaml'), 'tampered');
    assert.equal((await testRuntimeConnections(snapshot, {})).find((item) => item.id === 'templates')?.state, 'unavailable');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
