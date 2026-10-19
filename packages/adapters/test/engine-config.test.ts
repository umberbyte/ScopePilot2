import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createScanEngine, resolveEngineSelection } from '../src/engine-config.ts';
import { FixtureZapEngine } from '@scopepilot2/simulation';
import { ZapEngineAdapter } from '../src/zap-engine.ts';

describe('engine selection (env)', () => {
  test('既定は fixture。SCOPEPILOT_ZAP_BASE_URL があるときだけ実 ZAP', () => {
    assert.deepEqual(resolveEngineSelection({}), { mode: 'fixture' });
    const selected = resolveEngineSelection({ SCOPEPILOT_ZAP_BASE_URL: 'http://127.0.0.1:8080' });
    assert.equal(selected.mode, 'zap');
    assert.equal(selected.zapBaseUrl, 'http://127.0.0.1:8080');

    assert.ok(createScanEngine({ mode: 'fixture' }) instanceof FixtureZapEngine);
    assert.ok(createScanEngine({ mode: 'zap', zapBaseUrl: 'http://127.0.0.1:8080' }) instanceof ZapEngineAdapter);
  });
});
