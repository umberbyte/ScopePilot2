import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertNoSecretValue, presentSecretReference } from '../../../src/presenters/secret.ts';

describe('secret presenter', () => {
  test('[UI-UT-008] secret reference は値ではなく保存先・状態のみを表示する', () => {
    const view = presentSecretReference({
      referenceId: 'os-keychain:diag-account/password',
      store: 'Windows Credential Manager',
      resolved: true,
    });
    assert.deepEqual(view, {
      referenceId: 'os-keychain:diag-account/password',
      store: 'Windows Credential Manager',
      status: 'available',
    });
    assert.ok(!('value' in view));
    assert.doesNotThrow(() => assertNoSecretValue(view));

    const missing = presentSecretReference({ referenceId: 'ref-2', store: 'macOS Keychain', resolved: false });
    assert.equal(missing.status, 'missing');
  });
});
