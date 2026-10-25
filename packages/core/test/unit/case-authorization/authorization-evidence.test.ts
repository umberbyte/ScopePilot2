import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { filterAuthorizationEvidenceMetadata, InMemoryEvidenceStore } from '@scopepilot2/core';

describe('AuthorizationEvidence metadata', () => {
  test('[F01-UT-008] 秘密値を含む metadata は許可 field 以外を保存しない', async () => {
    const metadata = {
      contractName: '診断契約書-2026',
      authorizedBy: 'mallory-lead',
      password: 'hunter2-example',
      apiKey: 'sk-test-example',
      sessionCookie: 'SID=example',
      note: '第2四半期定期診断',
    };
    const filtered = filterAuthorizationEvidenceMetadata(metadata);
    assert.deepEqual(Object.keys(filtered).sort(), ['authorizedBy', 'contractName', 'note']);
    assert.ok(!('password' in filtered));
    assert.ok(!('apiKey' in filtered));
    assert.ok(!('sessionCookie' in filtered));

    // store も許可 field だけを保持する。
    const store = new InMemoryEvidenceStore();
    const stored = await store.saveText('認可証跡', 'evidence content', filtered);
    assert.deepEqual(Object.keys(stored.metadata ?? {}).sort(), ['authorizedBy', 'contractName', 'note']);
    assert.ok(!JSON.stringify(store.list()).includes('hunter2-example'));
  });
});
