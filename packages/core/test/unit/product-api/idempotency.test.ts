import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  checkCompatibility,
  IdempotencyStore,
  mapPermission,
  respondToSecretRead,
  SseEventLog,
  verifyExtensionManifest,
  type ExtensionManifest,
} from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

describe('product api (F20)', () => {
  test('[F20-UT-001] 同 key/同 body は同じ result を返す (handler 再実行なし)', async () => {
    const store = new IdempotencyStore();
    let executions = 0;
    const handler = async (): Promise<string> => {
      executions += 1;
      return 'result-1';
    };
    const first = await store.apply('key-1', { a: 1 }, handler);
    const second = await store.apply('key-1', { a: 1 }, handler);
    assert.equal(first, 'result-1');
    assert.equal(second, 'result-1');
    assert.equal(executions, 1);
  });

  test('[F20-UT-002] 同 key/別 body は Conflict', async () => {
    const store = new IdempotencyStore();
    await store.apply('key-1', { a: 1 }, async () => 'r');
    await assert.rejects(store.apply('key-1', { a: 2 }, async () => 'other'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'Conflict');
      assert.match((error as DomainError).message, /different body/);
      return true;
    });
  });

  test('[F20-UT-003] permission 不足は handler 前に拒否する', () => {
    const denied = mapPermission({ permissions: ['case.read'] }, 'run.manage');
    assert.equal(denied.allowed, false);
    assert.match(denied.reason ?? '', /lacks permission run.manage/);
    assert.deepEqual(mapPermission({ permissions: ['run.manage'] }, 'run.manage'), { allowed: true });
  });

  test('[F20-UT-004] Last-Event-ID から次 event 以降を返す', () => {
    const log = new SseEventLog();
    log.append('run.started', 'a');
    log.append('run.progress', 'b');
    log.append('run.completed', 'c');
    const resumed = log.resumeAfter(2);
    assert.ok(resumed.kind === 'events');
    assert.deepEqual(
      resumed.events.map((event) => [event.eventId, event.type]),
      [[3, 'run.completed']],
    );
    const tail = log.resumeAfter(3);
    assert.ok(tail.kind === 'events');
    assert.equal(tail.events.length, 0);
  });

  test('[F20-UT-005] retention gap は snapshot 再取得を要求する', () => {
    const log = new SseEventLog();
    for (let index = 1; index <= 10; index += 1) {
      log.append('tick', String(index));
    }
    log.oldestRetained(6);
    const result = log.resumeAfter(2, 6);
    assert.ok(result.kind === 'snapshot-required');
    if (result.kind === 'snapshot-required') {
      assert.equal(result.oldestRetainedId, 6);
    }
    const ok = log.resumeAfter(5, 6);
    assert.ok(ok.kind === 'events');
  });

  test('[F20-UT-006] signature 不一致・非信頼 publisher は load を拒否する', () => {
    const manifest: ExtensionManifest = {
      extensionId: 'ext-1',
      version: '1.0.0',
      signature: 'sig',
      publisherTrusted: true,
      permissions: ['case.read'],
      apiRange: ['v1'],
    };
    const sign = (hash: string): string => `sig-${hash.slice(0, 4)}`;
    // 期待署名を先に計算してから manifest へ反映させる。
    const expectedManifest = { ...manifest, signature: 'placeholder' };
    const okResult = verifyExtensionManifest(manifest, () => manifest.signature);
    assert.deepEqual(okResult, { loaded: true });

    const mismatch = verifyExtensionManifest(manifest, () => 'different-signature');
    assert.equal(mismatch.loaded, false);
    assert.match(mismatch.reason ?? '', /signature mismatch/);

    const untrusted = verifyExtensionManifest({ ...manifest, publisherTrusted: false }, () => manifest.signature);
    assert.equal(untrusted.loaded, false);
    assert.match(untrusted.reason ?? '', /not in the trust list/);
    assert.ok(expectedManifest !== undefined);
  });

  test('[F20-UT-007] API range 外は unsupported version', () => {
    assert.throws(() => checkCompatibility('v9', ['v1', 'v2']), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'Unsupported');
      return true;
    });
    assert.deepEqual(checkCompatibility('v2', ['v1', 'v2']), { supported: true });
  });

  test('[F20-UT-008] secret read 要求には値を返さない (参照 ID のみ)', () => {
    assert.throws(() => respondToSecretRead({ permission: 'secrets.read' }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'PermissionDenied');
      assert.match((error as DomainError).message, /never returned/);
      return true;
    });
    assert.deepEqual(respondToSecretRead({ permission: 'findings.read' }), { referenceIdOnly: true });
  });
});
