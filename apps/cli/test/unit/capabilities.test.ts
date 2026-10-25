import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runCapabilities } from '../../src/capabilities.ts';

describe('scopepilot capabilities', () => {
  test('in-process (fixture) の能力表を schemaVersion 付きで返す', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCapabilities({}, {
      stdout: (line) => { stdout.push(line); },
      stderr: (line) => { stderr.push(line); },
    });
    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    const parsed = JSON.parse(stdout.join('\n')) as {
      schemaVersion: string;
      source: string;
      capabilities: readonly { engineKind: string; source: string; guaranteeLevels: Record<string, string> }[];
    };
    assert.equal(parsed.schemaVersion, 'scopepilot2.capabilities.v1');
    assert.equal(parsed.source, 'in-process (fixture)');
    const zap = parsed.capabilities.find((capability) => capability.engineKind === 'zap');
    assert.equal(zap?.source, 'fixture');
    assert.equal(zap?.guaranteeLevels.preSendScopeEnforcement, 'Delegated');
  });

  test('接続できない --api は exit 7 で error 行を返す', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCapabilities({ apiUrl: 'http://127.0.0.1:9' }, {
      stdout: (line) => { stdout.push(line); },
      stderr: (line) => { stderr.push(line); },
    });
    assert.equal(exitCode, 7);
    assert.equal(stdout.length, 0);
    assert.match(stderr[0] ?? '', /unreachable/);
  });
});
