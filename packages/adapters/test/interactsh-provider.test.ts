import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { InteractshCliProvider } from '../src/interactsh-provider.ts';

const STUB_SCRIPT = String.raw`
const args = process.argv.slice(2);
for (const required of ['-server', '-config', '-poll-interval', '-number', '-json', '-silent']) {
  if (!args.includes(required)) process.exit(9);
}
process.stdout.write('abc123.stub.oast.example\n');
setTimeout(() => {
  process.stdout.write(JSON.stringify({ protocol: 'http', 'full-id': 'abc123', 'raw-request': 'GET /callback' }) + '\n');
}, 20);
setInterval(() => {}, 1000);
`;

describe('InteractshCliProvider (公式 CLI subprocess 契約)', () => {
  test('明示 server/config で payload を発行し JSONL callback を逐次渡す', { timeout: 10_000 }, async () => {
    const stubPath = join(tmpdir(), `scopepilot2-interactsh-stub-${process.pid}-${Date.now()}.mjs`);
    await writeFile(stubPath, STUB_SCRIPT, 'utf8');
    const provider = new InteractshCliProvider({
      serverUrl: 'https://self-host.oast.example',
      configPath: 'C:/managed/interactsh-config.yaml',
      command: process.execPath,
      argsPrefix: [stubPath],
      pollIntervalSeconds: 10,
      startupTimeoutMs: 2_000,
    });
    try {
      let receiveEvents: ((events: readonly { eventId: string; token: string; payload: string }[]) => void) | undefined;
      const eventPromise = new Promise<readonly { eventId: string; token: string; payload: string }[]>((resolve) => {
        receiveEvents = resolve;
      });
      const session = await provider.startSession({
        attemptId: 'attempt-1',
        protocol: 'http',
        onEvents: (events) => receiveEvents?.(events),
      });
      assert.equal(session.token, 'abc123.stub.oast.example');
      const events = await eventPromise;
      assert.equal(events.length, 1);
      assert.match(events[0]?.eventId ?? '', /^interactsh-[0-9a-f]{64}$/);
      assert.equal(events[0]?.token, 'abc123.stub.oast.example');
      assert.match(events[0]?.payload ?? '', /"protocol":"http"/);
      assert.equal((events[0]?.payload ?? '').includes('managed/interactsh-config'), false, 'config path を callback payload に混ぜない');
    } finally {
      await provider.close();
      await rm(stubPath, { force: true });
    }
  });

  test('https と config file の明示を必須にする', () => {
    assert.throws(
      () => new InteractshCliProvider({ serverUrl: 'http://oast.example', configPath: 'config.yaml' }),
      /must use https/,
    );
    assert.throws(
      () => new InteractshCliProvider({ serverUrl: 'https://oast.example', configPath: '' }),
      /configPath is required/,
    );
  });
});
