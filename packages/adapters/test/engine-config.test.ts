import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, test } from 'node:test';
import { composeEngines, createCapabilitySnapshots, createExplorerEngine, createScanEngine, resolveEngineSelection, resolveOwnedZapBaseUrl } from '../src/engine-config.ts';
import { PlaywrightExplorerAdapter } from '../src/playwright-explorer.ts';
import { HttpSecurityFixtureOtpInbox, HttpSecurityFixtureSaml } from '../src/security-fixture.ts';
import { ZapEngineAdapter } from '../src/zap-engine.ts';

describe('production engine composition', () => {
  test('既定も Playwright + ZAP であり、fixture selection は存在しない', () => {
    const selected = resolveEngineSelection({}, ['http://a.test/', 'http://a.test']);
    assert.equal(selected.zapBaseUrl, 'http://127.0.0.1:8080');
    assert.deepEqual(selected.explorerAllowedOrigins, ['http://a.test']);
    assert.ok(createScanEngine(selected) instanceof ZapEngineAdapter);
    assert.ok(createExplorerEngine(selected) instanceof PlaywrightExplorerAdapter);
  });

  test('探索 scope は URL path を受け付けない', () => {
    assert.throws(() => resolveEngineSelection({}, ['http://a.test/path']), /origins, not URLs/);
  });

  test('OAST は server と config の両方を要求する', () => {
    assert.throws(() => resolveEngineSelection({ SCOPEPILOT_OAST_SERVER_URL: 'https://oast.example' }), /INTERACTSH_CONFIG/);
  });

  test('所有ZAPは対象アプリとの起動順にかかわらず一時ポートを選ぶ', async () => {
    const occupied: Server = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    try {
      if (address === null || typeof address === 'string') throw new Error('expected TCP address');
      const preferred = `http://127.0.0.1:${String(address.port)}`;
      const selected = await resolveOwnedZapBaseUrl(preferred);
      assert.notEqual(selected, preferred);
      assert.equal(new URL(selected).hostname, '127.0.0.1');
    } finally {
      occupied.close();
    }
  });

  test('明示した実 ZAP の版を測定し、実 transport 群を構成する', async () => {
    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/JSON/core/view/alerts') {
        setTimeout(() => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ alerts: [] }));
        }, 1_700);
        return;
      }
      if (url.pathname === '/JSON/core/view/messages') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ messages: [] }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ version: '2.17.0' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
      if (address === null || typeof address === 'string') throw new Error('expected TCP address');
      const engines = await composeEngines({
        SCOPEPILOT_ZAP_BASE_URL: `http://127.0.0.1:${address.port}`,
        SCOPEPILOT_SECURITY_FIXTURE_BASE_URL: 'http://127.0.0.1:4317',
      }, ['http://a.test']);
      assert.equal(engines.mode, 'real');
      assert.ok(engines.explorer instanceof PlaywrightExplorerAdapter);
      assert.ok(engines.scanEngine instanceof ZapEngineAdapter);
      assert.equal(engines.scanEngine.engineVersion, 'zap 2.17.0');
      assert.equal(engines.capabilities.find((item) => item.engineKind === 'zap')?.source, 'measured');
      assert.ok(engines.otpInbox instanceof HttpSecurityFixtureOtpInbox);
      assert.ok(engines.samlFixture instanceof HttpSecurityFixtureSaml);
      assert.deepEqual(await engines.recoverHttpExchanges?.([{
        url: 'http://a.test/x', method: 'GET', pluginId: 'test', title: 'test finding',
      }]), [null], 'runtime ZAP API calls must not retain the 1.5 second startup probe timeout');
      engines.updateExplorationScope({ allowedOrigins: ['http://b.test'], deniedOrigins: [] });
      await engines.close();
    } finally {
      server.close();
    }
  });

  test('利用不能な ZAP は Unsupported として表現し、fixture 扱いしない', () => {
    const snapshots = createCapabilitySnapshots({
      zap: { engineVersion: 'zap (unavailable)', real: false },
      explorer: { engineVersion: 'playwright-chromium', real: true },
      measuredAt: '2026-10-20T00:00:00.000Z',
    });
    const zap = snapshots.find((item) => item.engineKind === 'zap');
    assert.equal(zap?.source, 'measured');
    assert.equal(zap?.guaranteeLevels.preSendScopeEnforcement, 'Unsupported');
  });
});

test('local component database rejects missing pins, tampering and unapproved rollback', async () => {
  const { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { assetHash } = await import('@scopepilot2/core');
  const { canonicalJson } = await import('@scopepilot2/contracts');
  const directory = mkdtempSync(join(tmpdir(), 'scopepilot-owned-db-'));
  const path = join(directory, 'database.json');
  try {
    const entries = [{ id: 'OWNED-DB', name: 'example', introduced: '1.0.0', fixed: '2.0.0' }];
    const sha256 = assetHash(canonicalJson(entries));
    writeFileSync(path, JSON.stringify({ source: 'owned-fixture', version: '2026-11-10', sha256, entries }));
    assert.throws(() => resolveEngineSelection({ SCOPEPILOT_COMPONENT_DB_PATH: path }), /pins/);
    const env = { SCOPEPILOT_COMPONENT_DB_PATH: path, SCOPEPILOT_COMPONENT_DB_SHA256: sha256, SCOPEPILOT_COMPONENT_DB_VERSION: '2026-11-10' };
    assert.equal(resolveEngineSelection(env).componentDatabase?.version, '2026-11-10');
    assert.throws(() => resolveEngineSelection({ ...env, SCOPEPILOT_COMPONENT_DB_VERSION: '2026-11-11' }), /rollback/);
    writeFileSync(path, JSON.stringify({ source: 'owned-fixture', version: '2026-11-10', sha256, entries: [] }));
    assert.throws(() => resolveEngineSelection(env), /snapshot/);
  } finally { unlinkSync(path); rmdirSync(directory); }
});
