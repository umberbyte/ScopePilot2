import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { combinationAt, LeaseAllocator, PayloadCatalog, planCombinations, RateGovernor, runFuzz, type FuzzSendAdapter } from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

describe('CombinationPlanner', () => {
  test('[F05-UT-001] cartesian 件数が plan 上限を超えたら送信前に拒否する', () => {
    const positions = [
      { name: 'user', values: Array.from({ length: 30 }, (_, i) => `u${i}`) },
      { name: 'role', values: Array.from({ length: 30 }, (_, i) => `r${i}`) },
    ];
    assert.throws(() => planCombinations(positions, 500), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /exceeds plan limit 500/);
      return true;
    });
    const ok = planCombinations(positions, 900);
    assert.equal(ok.total, 900);
    // index 生成は全体を materialize しない。
    assert.deepEqual(combinationAt(positions, 0), ['u0', 'r0']);
    assert.deepEqual(combinationAt(positions, 899), ['u29', 'r29']);

    assert.throws(() => planCombinations([{ name: '', values: ['x'] }], 1), /position name is required/);
    assert.throws(
      () => planCombinations([{ name: 'user', values: ['a'] }, { name: 'user', values: ['b'] }], 2),
      /duplicate fuzz position name/,
    );
  });
});

describe('RateGovernor', () => {
  test('[F05-UT-002] 2 RPS 既定で token 間隔 (500ms) を遵守する (virtual clock)', () => {
    const governor = new RateGovernor(2);
    // 1 送信目は即時、2 送信目は前回送信から 500ms 進むまで待機を要求する。
    assert.equal(governor.tryAcquire(0), 0);
    assert.equal(governor.tryAcquire(0), 500);
    assert.equal(governor.tryAcquire(999), 1);
    assert.equal(governor.tryAcquire(1000), 500);
    assert.equal(governor.tryAcquire(2000), 0);
  });
});

describe('LeaseAllocator', () => {
  test('[F05-UT-003] lease 25 で重複なく上限内を払い出す', () => {
    const allocator = new LeaseAllocator(60, 25);
    const leases = allocator.leases();
    assert.deepEqual(
      leases.map((lease) => [lease[0] ?? -1, lease.length]),
      [[0, 25], [25, 25], [50, 10]],
    );
    const flat = leases.flat();
    assert.equal(new Set(flat).size, 60);
  });

  test('[F05-UT-004] worker crash 後の resume は完了 index を再送しない', () => {
    const allocator = new LeaseAllocator(60, 25);
    const completed = new Set([0, 1, 2, 25, 26]);
    const leases = allocator.leases(completed);
    // 完了 index は読み飛ばし、各 lease は window 25 内に収める。
    assert.deepEqual(
      leases.map((lease) => [lease[0] ?? -1, lease.length]),
      [[3, 25], [30, 25], [55, 5]],
    );
    const flat = leases.flat();
    assert.ok(flat.every((index) => !completed.has(index)), '完了 index を再送しない');
    assert.equal(new Set(flat).size, 55, '欠落・重複なしで全未完了 index を払い出す');
  });
});

describe('runFuzz (FuzzRunner)', () => {
  test('[F05-UT-005] cancel 中は adapter への追加呼出しを行わない', async () => {
    const calls: number[] = [];
    const adapter: FuzzSendAdapter = {
      async send(index: number): Promise<void> {
        calls.push(index);
      },
    };
    let clockMs = 0;
    let cancelled = false;
    const result = await runFuzz(adapter, [{ name: 'p', values: ['a', 'b', 'c'] }], 3, {
      isCancelled: () => cancelled,
      now: () => clockMs,
      sleep: async (ms: number) => {
        clockMs += ms;
      },
    });
    assert.deepEqual(result, { sent: 3, cancelledAt: null });

    cancelled = true;
    const second = await runFuzz(adapter, [{ name: 'p', values: ['a', 'b', 'c'] }], 3, {
      isCancelled: () => cancelled,
      now: () => clockMs,
      sleep: async (ms: number) => {
        clockMs += ms;
      },
    });
    assert.deepEqual(second, { sent: 0, cancelledAt: 0 });
    assert.equal(calls.length, 3, 'cancel 後の追加送信なし');
  });
});

describe('PayloadCatalog', () => {
  test('[F05-UT-006] source/version/license 欠落は catalog 登録を拒否する', () => {
    const catalog = new PayloadCatalog();
    assert.throws(
      () =>
        catalog.register({
          name: 'set-a',
          source: '',
          version: '1',
          license: 'MIT',
          sha256: 'ab'.repeat(32),
          values: ['x'],
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'ValidationFailed');
        assert.match((error as DomainError).message, /source/);
        return true;
      },
    );
    catalog.register({ name: 'set-a', source: 'zap-addon', version: '83', license: 'Apache-2.0', sha256: 'ab'.repeat(32), values: ['a', 'b'] });
    assert.deepEqual(catalog.get('set-a'), ['a', 'b']);
  });
});
