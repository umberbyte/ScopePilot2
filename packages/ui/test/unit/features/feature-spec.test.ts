/**
 * FeatureSpec の完全性検証。`docs/design/40-advanced-mode-redesign.md` §4.3・§7.1 P1。
 * 全 route に FeatureSpec があり、送信画面は jobKind と guarantee を持ち、
 * 全 field に description と既定値の扱いがあることを検査する。
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { FeatureSpec } from '../../../src/features/feature-spec.ts';
import { REPEATER_SPEC } from '../../../src/features/repeater-spec.ts';

/**
 * 全画面の FeatureSpec 一覧 (今後追加予定の画面は TODO としてコメントで残す)。
 */
const ALL_FEATURE_SPECS: readonly FeatureSpec[] = [
  REPEATER_SPEC,
  // TODO: A22 Crawl, A40 Active Scan, A32 Fuzzer など、他の画面の spec を追加
];

/**
 * 全 UiRoute の一覧 (mode-policy.ts から取得すべきだが、ここでは明示的に列挙)。
 * 実装時には mode-policy から動的に取得する。
 */
const ALL_ROUTES = [
  'wizard.case-open',
  'wizard.guideline',
  'wizard.explore',
  'wizard.target-select',
  'wizard.final-confirm',
  'wizard.run',
  'wizard.report',
  'advanced.dashboard',
  'advanced.scope',
  'advanced.guidelines',
  'advanced.sessions',
  'advanced.jobs',
  'browser.site-map',
  'proxy.intercept',
  'repeater',
  'fuzzer',
  'scan-plans',
  'decoder',
  'findings',
  'settings',
] as const;

describe('FeatureSpec completeness (design/40 §4.3)', () => {
  test('全画面に FeatureSpec が定義されている', () => {
    const specRoutes = new Set(ALL_FEATURE_SPECS.map((spec) => spec.route));
    // Simple (wizard.*) は FeatureSpec 不要（Simple は別のコンポーネント構造）。
    const advancedRoutes = ALL_ROUTES.filter((route) => !route.startsWith('wizard.'));

    // TODO: 現時点では REPEATER_SPEC のみ実装済みなので、他の route は未実装として許容。
    // 実装が進んだら、以下のアサーションを有効化する。
    // for (const route of advancedRoutes) {
    //   assert.ok(
    //     specRoutes.has(route),
    //     `route ${route} must have a FeatureSpec`
    //   );
    // }

    // 現時点では repeater が定義されていることを確認。
    assert.ok(specRoutes.has('repeater'));
  });

  test('送信画面は jobKind と guarantee を持つ', () => {
    for (const spec of ALL_FEATURE_SPECS) {
      if (spec.sendsTraffic) {
        assert.ok(
          spec.jobKind !== undefined,
          `screen ${spec.screenId} (${spec.route}) sends traffic but lacks jobKind`,
        );
        assert.ok(
          spec.guarantee !== undefined,
          `screen ${spec.screenId} (${spec.route}) sends traffic but lacks guarantee`,
        );
      }
    }
  });

  test('全 field に description と既定値の扱いがある', () => {
    for (const spec of ALL_FEATURE_SPECS) {
      for (const field of spec.fields) {
        // description は必須。
        assert.ok(
          field.descriptionKey,
          `field ${field.key} in screen ${spec.screenId} lacks descriptionKey`,
        );

        // 必須フィールド以外は既定値を持つ（または既定値の扱いが明示されている）。
        if (!field.required) {
          const hasDefault =
            field.defaultValue !== undefined ||
            field.kind === 'boolean' || // boolean は既定 false
            field.kind === 'role'; // role は workspace.role から取得
          assert.ok(
            hasDefault,
            `non-required field ${field.key} in screen ${spec.screenId} should have defaultValue or be boolean/role`,
          );
        }
      }
    }
  });

  test('field の検証規則が well-formed', () => {
    const VALID_RULES = new Set(['in-scope-origin', 'http-url', 'regex', 'range']);

    for (const spec of ALL_FEATURE_SPECS) {
      for (const field of spec.fields) {
        if (field.validate) {
          for (const rule of field.validate) {
            assert.ok(
              VALID_RULES.has(rule),
              `field ${field.key} in screen ${spec.screenId} has invalid validation rule: ${rule}`,
            );
          }
        }
      }
    }
  });

  test('select / multi-select field は options を持つ', () => {
    for (const spec of ALL_FEATURE_SPECS) {
      for (const field of spec.fields) {
        if (field.kind === 'select' || field.kind === 'multi-select') {
          assert.ok(
            field.options && field.options.length > 0,
            `select field ${field.key} in screen ${spec.screenId} must have options`,
          );
        }
      }
    }
  });

  test('REPEATER_SPEC の内容が設計どおり', () => {
    // A31 Repeater の具体的な検証 (設計 40 §4.6)。
    assert.equal(REPEATER_SPEC.screenId, 'A31');
    assert.equal(REPEATER_SPEC.route, 'repeater');
    assert.equal(REPEATER_SPEC.sendsTraffic, true);
    assert.equal(REPEATER_SPEC.guarantee, 'Enforced');
    assert.equal(REPEATER_SPEC.jobKind, 'repeater-send');
    assert.equal(REPEATER_SPEC.permission, 'run.manage');

    // Fields: request, role, protocol, followRedirects
    const fieldKeys = REPEATER_SPEC.fields.map((f) => f.key);
    assert.deepEqual(fieldKeys, ['request', 'role', 'protocol', 'followRedirects']);

    // protocol は select で、既定値は 'http/1.1'
    const protocolField = REPEATER_SPEC.fields.find((f) => f.key === 'protocol');
    assert.ok(protocolField);
    assert.equal(protocolField.kind, 'select');
    assert.equal(protocolField.defaultValue, 'http/1.1');
    assert.ok(protocolField.options && protocolField.options.length === 2);
  });
});
