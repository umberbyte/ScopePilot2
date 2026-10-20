import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DOM_INSTRUMENTATION_SCRIPT, PlaywrightDomObserver, type DomObservationRunnerInput } from '../src/dom-observer.ts';

describe('PlaywrightDomObserver (runner contract)', () => {
  test('passes bounded init-script settings only for an in-scope target', async () => {
    const calls: DomObservationRunnerInput[] = [];
    const observer = new PlaywrightDomObserver({
      maxEvents: 25,
      settleMs: 10,
      runner: async (input) => {
        calls.push(input);
        return {
          observations: [
            { api: 'location.search', marker: 'marker-1' },
            { api: 'innerHTML', marker: 'marker-1' },
          ],
          nodes: [],
        };
      },
    });
    const scope = { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] };
    const result = await observer.observe({
      targetUrl: 'http://fixture.target.test/app?x=1',
      scope,
      sessionCookies: [{ name: 'APP_SESSION', value: 'runner-secret', domain: 'fixture.target.test', path: '/app' }],
    });
    assert.equal(result.observations.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.maxEvents, 25);
    assert.equal(calls[0]?.settleMs, 10);
    assert.equal(calls[0]?.instrumentationScript, DOM_INSTRUMENTATION_SCRIPT);
    assert.deepEqual(calls[0]?.sessionCookies, [{ name: 'APP_SESSION', value: 'runner-secret', domain: 'fixture.target.test', path: '/app' }]);
    assert.match(DOM_INSTRUMENTATION_SCRIPT, /innerHTML/);
    assert.match(DOM_INSTRUMENTATION_SCRIPT, /postMessage\.data/);

    await assert.rejects(
      () => observer.observe({ targetUrl: 'http://elsewhere.example/app', scope }),
      /out of scope/,
    );
    assert.equal(calls.length, 1, 'out-of-scope target is rejected before browser startup');
  });

  test('rejects unbounded configuration', () => {
    assert.throws(() => new PlaywrightDomObserver({ maxEvents: 1001 }), /maxEvents/);
    assert.throws(() => new PlaywrightDomObserver({ settleMs: 10_001 }), /settleMs/);
  });
});
