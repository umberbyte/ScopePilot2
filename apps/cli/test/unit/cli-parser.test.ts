import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCli, UsageError } from '../../src/cli-parser.ts';

describe('CliParser', () => {
  test('[F21-UT-001] 未知 option と競合 option は usage error になる', () => {
    assert.throws(() => parseCli(['simulate', '--nope']), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /unknown option: --nope/);
      return true;
    });

    assert.throws(() => parseCli(['simulate', '--json', '--human']), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /--json and --human cannot be combined/);
      return true;
    });

    assert.throws(() => parseCli(['simulate', '--events']), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /--events requires a file path value/);
      return true;
    });

    assert.throws(() => parseCli(['simulate', '--api']), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /--api requires a base URL/);
      return true;
    });
    assert.throws(() => parseCli(['simulate', '--api', 'ftp://x']), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /http\(s\) base URL/);
      return true;
    });

    assert.throws(() => parseCli(['status']), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /unknown command/);
      return true;
    });

    assert.deepEqual(parseCli(['simulate']), {
      command: 'simulate',
      json: false,
      injectUnknownScanTarget: false,
    });
    assert.equal(parseCli(['simulate', '--json', '--events', 'events.ndjson']).json, true);
    assert.equal(parseCli(['simulate', '--events', 'events.ndjson']).eventsFile, 'events.ndjson');
    assert.equal(parseCli(['simulate', '--api', 'http://127.0.0.1:8787']).apiUrl, 'http://127.0.0.1:8787');
  });
});
