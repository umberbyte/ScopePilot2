import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  INITIAL_RENDERER_REPORT_PROFILE,
  normalizeRendererReportProfile,
} from '../../src/renderer/report-profile.ts';

describe('renderer report profile', () => {
  test('IPC 応答に reportProfile がなくても S07 用の既定値を返す', () => {
    assert.deepEqual(normalizeRendererReportProfile(undefined), INITIAL_RENDERER_REPORT_PROFILE);
  });

  test('保存済みの部分値を保ち、欠落項目を既定値で補う', () => {
    const profile = normalizeRendererReportProfile({ systemName: '診断対象システム' });
    assert.equal(profile.systemName, '診断対象システム');
    assert.equal(profile.version, '0.1');
    assert.equal(profile.documentStatus, 'ドラフト');
    assert.equal(profile.evidenceBodyMode, 'relevant');
    assert.equal(profile.highlightEvidence, true);
  });

  test('HTTP証跡の本文モードとハイライト設定を復元し、不正値は安全な既定値へ戻す', () => {
    assert.equal(normalizeRendererReportProfile({ evidenceBodyMode: 'omit', highlightEvidence: false }).evidenceBodyMode, 'omit');
    assert.equal(normalizeRendererReportProfile({ evidenceBodyMode: 'omit', highlightEvidence: false }).highlightEvidence, false);
    assert.equal(normalizeRendererReportProfile({ evidenceBodyMode: 'invalid' as never }).evidenceBodyMode, 'relevant');
  });
});
