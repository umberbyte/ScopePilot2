import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isSessionControlUrl } from '../../../src/application/baseline-flow.ts';

describe('active scan safety URL classification', () => {
  test('セッション終了と環境・セキュリティ設定画面を能動診断から除外する', () => {
    for (const url of [
      'https://app.example.test/logout',
      'https://app.example.test/setup.php',
      'https://app.example.test/install/',
      'https://app.example.test/security.php',
    ]) assert.equal(isSessionControlUrl(url), true, url);
    assert.equal(isSessionControlUrl('https://app.example.test/products?id=1'), false);
  });
});
