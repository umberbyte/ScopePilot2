import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isSessionControlUrl } from '../../../src/application/baseline-flow.ts';

describe('active scan safety URL classification', () => {
  test('製品固有の画面名を仮定せず、セッション終了と導入画面だけを除外する', () => {
    for (const url of [
      'https://app.example.test/logout',
      'https://app.example.test/setup.php',
      'https://app.example.test/install/',
    ]) assert.equal(isSessionControlUrl(url), true, url);
    assert.equal(isSessionControlUrl('https://app.example.test/security.php'), false);
    assert.equal(isSessionControlUrl('https://app.example.test/products?id=1'), false);
  });
});
