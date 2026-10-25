import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveApiBinding } from '../../src/main/config.ts';

describe('desktop api binding config', () => {
  test('PORT 未指定は ephemeral (0)、指定は検証して採用する (loopback 固定)', () => {
    assert.deepEqual(resolveApiBinding({}), { host: '127.0.0.1', port: 0 });
    assert.deepEqual(resolveApiBinding({ SCOPEPILOT_API_PORT: '' }), { host: '127.0.0.1', port: 0 });
    assert.deepEqual(resolveApiBinding({ SCOPEPILOT_API_PORT: '8787' }), { host: '127.0.0.1', port: 8787 });
    assert.deepEqual(resolveApiBinding({ SCOPEPILOT_API_PORT: '0' }), { host: '127.0.0.1', port: 0 });
    for (const invalid of ['-1', '65536', 'abc', '80.5']) {
      assert.throws(() => resolveApiBinding({ SCOPEPILOT_API_PORT: invalid }), /between 0 and 65535/);
    }
  });
});
