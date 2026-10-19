import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createCoreApiServer } from '@scopepilot2/core';
import { createHarness, FIXTURE_OPERATOR } from '@scopepilot2/simulation';
import { parseCli, UsageError } from '../../src/cli-parser.ts';
import { runCaseStatus } from '../../src/case-status.ts';
import { runFuzz } from '../../src/fuzz.ts';

interface TestWriters {
  readonly stdoutLines: string[];
  readonly stderrLines: string[];
  stdout(line: string): void;
  stderr(line: string): void;
}

function writers(): TestWriters {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: (line: string) => stdoutLines.push(line),
    stderr: (line: string) => stderrLines.push(line),
  };
}

async function startServer(): Promise<{ base: string; close: () => void }> {
  const harness = createHarness();
  const server = createCoreApiServer({ service: harness.service, operator: FIXTURE_OPERATOR });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected TCP address');
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}

describe('case status / fuzz commands (design/19 §2)', () => {
  test('parser: case status は --api 必須・fuzz は --target/--position 必須', () => {
    assert.throws(() => parseCli(['case', 'status']), /requires --api/);
    assert.throws(() => parseCli(['case', 'open']), /unknown subcommand/);
    assert.throws(() => parseCli(['fuzz', '--api', 'http://127.0.0.1:1']), /requires --target/);
    assert.throws(() => parseCli(['fuzz', '--target', 'http://a.test/']), /--position/);
    assert.throws(() => parseCli(['fuzz', '--target', 'http://a.test/', '--position', 'novalue']), /name:v1,v2/);

    const parsed = parseCli(['case', 'status', '--api', 'http://127.0.0.1:8787']);
    assert.equal(parsed.command, 'case-status');
    assert.equal(parsed.apiUrl, 'http://127.0.0.1:8787');

    const fuzz = parseCli(['fuzz', '--target', 'http://a.test/f', '--position', 'user:admin,guest', '--position', 'id:1,2']);
    assert.equal(fuzz.command, 'fuzz');
    assert.deepEqual(fuzz.fuzzPositions, [
      { name: 'user', values: ['admin', 'guest'] },
      { name: 'id', values: ['1', '2'] },
    ]);
  });

  test('case status: 案件が無い API では exit 2、案件ありなら record を返す', async () => {
    const server = await startServer();
    try {
      const before = writers();
      assert.equal(await runCaseStatus({ apiUrl: server.base }, before), 2);
      assert.match(before.stderrLines[0] ?? '', /case has not been created yet/);

      await fetch(`${server.base}/api/case`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'cli-it', allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [], limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 } }),
      });
      const after = writers();
      assert.equal(await runCaseStatus({ apiUrl: server.base }, after), 0);
      const parsed = JSON.parse(after.stdoutLines.join('\n')) as { schemaVersion: string; case: { name: string; revision: number } };
      assert.equal(parsed.schemaVersion, 'scopepilot2.case.v1');
      assert.equal(parsed.case.name, 'cli-it');
      assert.equal(parsed.case.revision, 1);
    } finally {
      server.close();
    }
  });

  test('case status: 到達不能は exit 7', async () => {
    const w = writers();
    assert.equal(await runCaseStatus({ apiUrl: 'http://127.0.0.1:1' }, w), 7);
  });

  test('fuzz: in-process で案件まで bootstrap して実行し cluster 集約を返す', async () => {
    const w = writers();
    const code = await runFuzz({ target: 'http://fixture.target.test/fuzz', positions: [{ name: 'user', values: ['admin', 'guest'] }] }, w);
    assert.equal(code, 0);
    const parsed = JSON.parse(w.stdoutLines.join('\n')) as {
      schemaVersion: string;
      total: number;
      sent: number;
      clusters: readonly { count: number; representative: readonly string[] }[];
    };
    assert.equal(parsed.schemaVersion, 'scopepilot2.fuzz.v1');
    assert.equal(parsed.total, 2);
    assert.equal(parsed.sent, 2);
    assert.equal(parsed.clusters.length, 2, 'fixture 応答は先頭 position の値で 2 cluster');
  });

  test('fuzz: 不正な position 指定は usage error', () => {
    assert.throws(() => parseCli(['fuzz', '--target', 'http://fixture.target.test/f', '--position', ':']), UsageError);
    assert.throws(() => parseCli(['fuzz', '--target', 'http://fixture.target.test/f', '--position', 'name:']), UsageError);
  });
});
