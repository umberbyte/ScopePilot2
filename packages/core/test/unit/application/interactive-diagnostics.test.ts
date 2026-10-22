import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { InteractiveBrowserPort } from '../../../src/ports/engines.ts';
import { bootstrapFlow } from '../support/test-flow.ts';

describe('interactive diagnostics', () => {
  test('confirmed allow-listed browser plan executes and stores evidence', async () => {
    const calls: Parameters<InteractiveBrowserPort['execute']>[0][] = [];
    const interactiveBrowser: InteractiveBrowserPort = {
      engineVersion: 'fake-interactive-1',
      execute: async (input) => {
        calls.push(input);
        return { finalUrl: input.targetUrl, status: 200, bodyHash: 'body-hash', bodyText: 'saved', headers: [], elapsedMs: 10, assertions: [{ kind: 'assert', target: 'saved', passed: true }] };
      },
    };
    const { service, operator } = await bootstrapFlow({ interactiveBrowser });
    const result = await service.runInteractiveDiagnostics(operator, {
      confirmed: true,
      files: [],
      apiDocuments: [],
      items: [{
        itemId: 'interactive-1',
        track: 'workflow-state',
        targetUrl: 'http://fixture.target.test/form',
        role: 'unauthenticated',
        roles: [],
        summary: 'submit and verify',
        steps: [
          { kind: 'navigate', target: 'http://fixture.target.test/form' },
          { kind: 'fill', target: 'input[name="message"]', value: 'scopepilot-marker' },
          { kind: 'click', target: 'button[type="submit"]' },
          { kind: 'assert', target: 'saved' },
        ],
        samples: 100,
        tokenSource: 'body',
        tokenName: '',
        expectation: 'different',
        requiredInputs: [],
      }],
    });
    assert.equal(calls.length, 1);
    assert.equal(result.results[0]?.status, 'passed');
    assert.match(result.results[0]?.evidenceId ?? '', /^evidence-/u);
  });

  test('unconfirmed plan is rejected before browser execution', async () => {
    const interactiveBrowser: InteractiveBrowserPort = {
      engineVersion: 'fake-interactive-1',
      execute: async () => { throw new Error('must not execute'); },
    };
    const { service, operator } = await bootstrapFlow({ interactiveBrowser });
    await assert.rejects(service.runInteractiveDiagnostics(operator, { confirmed: false, items: [], files: [], apiDocuments: [] }), /confirmation/u);
  });
});
