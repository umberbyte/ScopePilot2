import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { composeEngines, createCapabilitySnapshots, createExplorerEngine, createScanEngine, resolveEngineSelection } from '../src/engine-config.ts';
import { FixtureExplorer, FixtureZapEngine } from '@scopepilot2/simulation';
import { PlaywrightExplorerAdapter } from '../src/playwright-explorer.ts';
import { ZapEngineAdapter } from '../src/zap-engine.ts';

/**
 * engine 選択・組立の契約検証。実 ZAP・実 browser は使わない
 * (実 ZAP は版解決のみ stub server で確認。実 browser の起動は gated IT 側)。
 */
describe('engine selection (env)', () => {
  test('既定は fixture。SCOPEPILOT_ZAP_BASE_URL があるときだけ実 ZAP', () => {
    const fixture = resolveEngineSelection({});
    assert.equal(fixture.mode, 'fixture');
    assert.equal(fixture.explorer, 'fixture');
    const selected = resolveEngineSelection({ SCOPEPILOT_ZAP_BASE_URL: 'http://127.0.0.1:8080' });
    assert.equal(selected.mode, 'zap');
    assert.equal(selected.zapBaseUrl, 'http://127.0.0.1:8080');
    assert.equal(selected.explorer, 'fixture');

    assert.ok(createScanEngine({ mode: 'fixture', explorer: 'fixture' }) instanceof FixtureZapEngine);
    assert.ok(createScanEngine({ mode: 'zap', zapBaseUrl: 'http://127.0.0.1:8080', explorer: 'fixture' }) instanceof ZapEngineAdapter);
    assert.ok(createExplorerEngine({ mode: 'fixture', explorer: 'fixture' }) instanceof FixtureExplorer);
  });

  test('SCOPEPILOT_EXPLORER=playwright は許可 origin の明示を要求する (Enforced の入口)', () => {
    assert.throws(() => resolveEngineSelection({ SCOPEPILOT_EXPLORER: 'playwright' }), /ALLOWED_ORIGINS/);
    assert.throws(
      () => resolveEngineSelection({ SCOPEPILOT_EXPLORER: 'playwright', SCOPEPILOT_EXPLORER_ALLOWED_ORIGINS: 'http://a.test/path' }),
      /http\(s\) origins/,
    );
    const selection = resolveEngineSelection({
      SCOPEPILOT_EXPLORER: 'playwright',
      SCOPEPILOT_EXPLORER_ALLOWED_ORIGINS: 'http://a.test, http://b.test',
    });
    assert.deepEqual(selection.explorerAllowedOrigins, ['http://a.test', 'http://b.test']);
    const explorer = createExplorerEngine(selection);
    assert.ok(explorer instanceof PlaywrightExplorerAdapter);
  });

  test('composeEngines: fixture 既定は fixture engine と能力表 source=fixture', async () => {
    const engines = await composeEngines({});
    assert.equal(engines.mode, 'fixture');
    assert.ok(engines.explorer instanceof FixtureExplorer);
    assert.ok(engines.scanEngine instanceof FixtureZapEngine);
    assert.equal(engines.runtimeBundleHash, undefined);
    assert.equal(engines.capabilities.find((capability) => capability.engineKind === 'zap')?.source, 'fixture');
    await engines.close();
  });

  test('composeEngines: 実 ZAP 指定時は版を解決してから能力表を作る (measured・混在可)', async () => {
    const server: Server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ version: '2.17.0' }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    try {
      if (address === null || typeof address === 'string') {
        throw new Error('expected TCP address');
      }
      const engines = await composeEngines({ SCOPEPILOT_ZAP_BASE_URL: `http://127.0.0.1:${address.port}` });
      assert.equal(engines.mode, 'real');
      assert.ok(engines.scanEngine instanceof ZapEngineAdapter);
      // 版が未解決のままだと runActiveScan の能力表一致検査に落ちるため、
      // compose 時点で解決済みであることを検証する。
      assert.equal(engines.scanEngine.engineVersion, 'zap 2.17.0');
      const zapCapability = engines.capabilities.find((capability) => capability.engineKind === 'zap');
      assert.equal(zapCapability?.engineVersion, 'zap 2.17.0');
      assert.equal(zapCapability?.source, 'measured');
      // explorer 未指定なら探索は fixture のまま混在できる。
      assert.ok(engines.explorer instanceof FixtureExplorer);
      await engines.close();
    } finally {
      server.close();
    }
  });

  test('createCapabilitySnapshots: 保証等級は playwright=Enforced・zap=Delegated', () => {
    const snapshots = createCapabilitySnapshots({
      zap: { engineVersion: 'zap 2.17.0', real: true },
      explorer: { engineVersion: 'playwright (未起動)', real: true },
      measuredAt: '2026-10-19T00:00:00.000Z',
    });
    const playwright = snapshots.find((snapshot) => snapshot.engineKind === 'playwright');
    const zap = snapshots.find((snapshot) => snapshot.engineKind === 'zap');
    assert.equal(playwright?.guaranteeLevels.preSendScopeEnforcement, 'Enforced');
    assert.equal(zap?.guaranteeLevels.preSendScopeEnforcement, 'Delegated');
    assert.equal(zap?.maxOvershootRatio, 0.05);
  });
});
