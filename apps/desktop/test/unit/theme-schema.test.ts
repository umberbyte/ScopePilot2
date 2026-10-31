import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ZAP_UNSUPPORTED_IMPLEMENTED_THEMES } from '@scopepilot2/core';
import {
  FIELD_LABEL_KEYS,
  IMPLEMENTED_THEME_NOS,
  missingRequiredInputs,
  partitionThemeFieldValues,
  THEME_SCHEMA,
  WORKFLOW_THEME_NOS,
} from '../../src/renderer/theme-schema.ts';
import { jaStrings } from '../../src/renderer/resources.ja.ts';
import { enStrings } from '../../src/renderer/resources.en.ts';

/**
 * A03 テーマ実行フォームの入力 schema と Core (runZapUnsupportedCheck) の整合。
 * 実装済みテーマに schema がないと「実行ボタンがあるのにフォームが出ない」状態
 * (handoff 2026-10-31 P0) に戻るため、ここで機械的に検証する。
 */
describe('zap-unsupported theme runner schema', () => {
  test('実装済みテーマ一覧は Core の ZAP_UNSUPPORTED_IMPLEMENTED_THEMES と一致する', () => {
    assert.deepEqual([...IMPLEMENTED_THEME_NOS].sort(), [...ZAP_UNSUPPORTED_IMPLEMENTED_THEMES].sort());
    // テーマ17 (request smuggling) は専用 raw transport と fixture が揃うまで実行対象にしない。
    assert.ok(!IMPLEMENTED_THEME_NOS.includes('17'));
  });

  test('テーマ1 (専用フォーム) 以外の全実装済みテーマが入力 schema を持つ', () => {
    for (const no of ZAP_UNSUPPORTED_IMPLEMENTED_THEMES) {
      if (no === '1') continue;
      assert.ok(THEME_SCHEMA[no] !== undefined, `theme ${no} has no THEME_SCHEMA (run button renders but ThemeRunner returns null)`);
    }
    for (const no of Object.keys(THEME_SCHEMA)) {
      assert.ok((IMPLEMENTED_THEME_NOS as readonly string[]).includes(no), `THEME_SCHEMA[${no}] is not an implemented theme`);
      assert.ok(!WORKFLOW_THEME_NOS.includes(no), `THEME_SCHEMA[${no}] must not overlap the automatic workflow themes`);
    }
  });

  test('schema の全入力欄のラベルが ja/en 両方に存在し、orphan ラベルがない', () => {
    const fieldIds = Object.entries(THEME_SCHEMA).flatMap(([no, schema]) => schema.fields.map((field) => `${no}.${field.key}`));
    for (const fieldId of fieldIds) {
      const labelKey = FIELD_LABEL_KEYS[fieldId];
      assert.ok(labelKey !== undefined, `${fieldId} has no label key`);
      assert.ok(jaStrings[labelKey] !== undefined, `${fieldId} label missing in ja`);
      assert.ok(enStrings[labelKey] !== undefined, `${fieldId} label missing in en`);
    }
    const schemaFieldIds = new Set(fieldIds);
    for (const fieldId of Object.keys(FIELD_LABEL_KEYS)) {
      assert.ok(schemaFieldIds.has(fieldId), `label for ${fieldId} is orphan`);
    }
  });

  test('名前付き対象入力のラベルが存在し、テーマ6は (サインイン, 保護対象) の順', () => {
    for (const [no, schema] of Object.entries(THEME_SCHEMA)) {
      for (const target of schema.namedTargets ?? []) {
        assert.ok(jaStrings[target.labelKey] !== undefined, `theme ${no} target ${target.key} label missing in ja`);
        assert.ok(enStrings[target.labelKey] !== undefined, `theme ${no} target ${target.key} label missing in en`);
      }
      if ((schema.namedTargets ?? []).length > 0) {
        assert.equal(schema.needsTargets, true, `theme ${no} namedTargets requires needsTargets`);
      }
    }
    // Core は targetUrls[0]=サインイン, [1]=保護対象 の順序で判定する (baseline-flow.ts case '6')。
    assert.deepEqual(THEME_SCHEMA['6']?.namedTargets?.map((target) => target.key), ['signInUrl', 'protectedUrl']);
  });

  test('Core が必須検証する param は schema でも required になっている', () => {
    const coreRequired: readonly string[] = ['9.validToken', '15.baselineJson', '15.variantJson', '16.baselineJson', '16.probeUrl', '26.deepQuery'];
    for (const fieldId of coreRequired) {
      const separator = fieldId.indexOf('.');
      const no = fieldId.slice(0, separator);
      const key = fieldId.slice(separator + 1);
      const field = THEME_SCHEMA[no]?.fields.find((candidate) => candidate.key === key);
      assert.ok(field !== undefined, `${fieldId} is not in THEME_SCHEMA`);
      assert.equal(field.required, true, `${fieldId} must be required`);
    }
  });

  test('select は候補を持ち、boolean・secret の組み合わせ制約を守る', () => {
    for (const [no, schema] of Object.entries(THEME_SCHEMA)) {
      for (const field of schema.fields) {
        if (field.kind === 'select') {
          assert.ok((field.options ?? []).length > 0, `theme ${no}.${field.key} select needs options`);
        }
        if (field.kind === 'boolean') {
          assert.ok(field.required !== true, `theme ${no}.${field.key} boolean cannot be required`);
          assert.ok(field.multiline !== true && field.secret !== true, `theme ${no}.${field.key} boolean cannot be multiline/secret`);
        }
        if (field.secret === true && field.multiline === true) {
          assert.fail(`theme ${no}.${field.key} secret field cannot be multiline (masking impossible)`);
        }
      }
    }
  });

  test('テーマ6のOTP/SAML sub-check入力が schema に揃っている (Core の param key と一致)', () => {
    const otpKeys: readonly string[] = [
      'otpIssueUrl', 'otpVerifyUrl', 'otpVerifyField', 'otpSuccessMarker', 'otpMailboxRef',
      'otpWrongAttempts', 'otpExpirySeconds',
      'otpDestinationChangeUrl', 'otpDestinationChangeBodyJson', 'otpDestinationChangeMarker',
      'samlIdpStartUrl', 'samlAcsUrl',
    ];
    const fields = new Set((THEME_SCHEMA['6']?.fields ?? []).map((field) => field.key));
    for (const key of otpKeys) {
      assert.ok(fields.has(key), `theme 6 field ${key} is missing from THEME_SCHEMA`);
      assert.ok(FIELD_LABEL_KEYS[`6.${key}`] !== undefined, `theme 6 field ${key} has no label key`);
    }
    // 宛先変更は認証済み role session が必要なため、テーマ6 は role を任意選択できる。
    assert.equal(THEME_SCHEMA['6']?.roleMode, 'optional');
  });

  test('missingRequiredInputs は必須 param・名前付き対象の不足だけを報告する', () => {
    const theme9 = THEME_SCHEMA['9']!;
    assert.deepEqual(missingRequiredInputs('9', theme9, {}, {}), ['a03.theme.f.9.validToken']);
    assert.deepEqual(missingRequiredInputs('9', theme9, { validToken: 'header.claim.sig' }, {}), []);
    const theme6 = THEME_SCHEMA['6']!;
    assert.deepEqual(missingRequiredInputs('6', theme6, {}, {}), ['a03.theme.f.6.signInUrl', 'a03.theme.f.6.protectedUrl']);
    assert.deepEqual(missingRequiredInputs('6', theme6, {}, { signInUrl: 'https://fixture.invalid/signin', protectedUrl: 'https://fixture.invalid/mfa' }), []);
  });

  test('secret field is sent only through secretValues', () => {
    assert.deepEqual(partitionThemeFieldValues(THEME_SCHEMA['9']!, { validToken: 'header.claim.signature' }), {
      params: {},
      secretValues: { validToken: 'header.claim.signature' },
    });
    assert.deepEqual(partitionThemeFieldValues(THEME_SCHEMA['15']!, { baselineJson: '{}', variantJson: '{"a":1}' }), {
      params: { method: 'POST', baselineJson: '{}', variantJson: '{"a":1}' },
      secretValues: {},
    });
  });
});
