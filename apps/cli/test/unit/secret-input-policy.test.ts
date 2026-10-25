import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCli, UsageError } from '../../src/cli-parser.ts';

describe('secret input policy (CliParser)', () => {
  test('[F21-UT-007] argv の secret 値は拒否し、error に値を出さない', () => {
    assert.throws(() => parseCli(['simulate', '--token', 'abc123']), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.match(error.message, /secret values must not be passed as command-line options/);
      assert.match(error.message, /--token/);
      // 値そのものは log へ出さない。
      assert.ok(!error.message.includes('abc123'));
      assert.ok(!String(error).includes('abc123'));
      return true;
    });

    assert.throws(() => parseCli(['simulate', '--api-key=supersecret']), (error: unknown) => {
      assert.ok(error instanceof UsageError);
      assert.ok(!String(error).includes('supersecret'));
      return true;
    });
  });
});
