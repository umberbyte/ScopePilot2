/**
 * ZAP 非対応テーマ (テーマ2以降) の代替検証実行フォームの入力 schema。
 * JSX を含まない純データとして分離し、unit test から Core 側の実装済みテーマ一覧
 * (packages/core/src/domain/zap-unsupported.ts) と直接突き合わせる。
 *
 * schema は Core (baseline-flow.ts runZapUnsupportedCheck) の入力検証と対応する:
 * - required: Core が NeedsInput / ValidationFailed を出す必須 param。空欄なら実行不可。
 * - secret:   秘密値扱いの入力欄 (伏せ字表示。値は送信のみに使い保存しない)。
 * - boolean:  'true' のときのみ有効な旗 (Checkbox。未選択なら param を送らない)。
 * - select:   Core が受理する候補だけを選ばせる (自由入力の転記ミス防止)。
 */
import type { StringKey } from './resources.ts';

/** 実装済みテーマ (packages/core/src/domain/zap-unsupported.ts の一覧と同期。test で検証)。 */
export const IMPLEMENTED_THEME_NOS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '9', '10', '11', '13', '14', '15', '16', '18', '20', '21', '22', '23', '24', '25', '26', '27', '29', '30'];
/** 既存 workflow が自動実行するテーマ (実行フォームは持たない)。 */
export const WORKFLOW_THEME_NOS: readonly string[] = ['8', '12', '19', '28'];

export interface ThemeFieldDef {
  readonly key: string;
  readonly kind?: 'text' | 'boolean' | 'select';
  readonly options?: readonly string[];
  readonly multiline?: boolean;
  /** 空欄なら実行できない必須入力 (Core 側の必須 param 検査と対応)。 */
  readonly required?: boolean;
  /** 秘密値扱い (伏せ字表示。値は送信のみに使い evidence へ保存しない)。 */
  readonly secret?: boolean;
}

/** target URL の順番に意味があるテーマ向けの名前付き対象入力 (上から順に targetUrls へ)。 */
export interface NamedTargetDef {
  readonly key: string;
  readonly labelKey: StringKey;
}

export interface ThemeSchema {
  readonly roleMode: 'required' | 'optional' | 'none';
  readonly needsTargets: boolean;
  /** needsTargets かつ順序が意味を持つ場合の名前付き入力。未設定なら従来の改行区切り一覧。 */
  readonly namedTargets?: readonly NamedTargetDef[];
  readonly fields: readonly ThemeFieldDef[];
}

export interface PartitionedThemeFieldValues {
  readonly params: Readonly<Record<string, string>>;
  readonly secretValues: Readonly<Record<string, string>>;
}

/** UI schema の値を Core API の通常パラメーターと秘密値へ分離する。 */
export function partitionThemeFieldValues(
  schema: ThemeSchema,
  values: Readonly<Record<string, string>>,
): PartitionedThemeFieldValues {
  const params: Record<string, string> = {};
  const secretValues: Record<string, string> = {};
  for (const field of schema.fields) {
    const value = field.kind === 'select' ? values[field.key] ?? field.options?.[0] ?? '' : values[field.key] ?? '';
    if (value.trim() === '') continue;
    if (field.secret === true) {
      secretValues[field.key] = value;
    } else {
      params[field.key] = value;
    }
  }
  return { params, secretValues };
}

export const THEME_SCHEMA: Readonly<Record<string, ThemeSchema>> = {
  '2': { roleMode: 'required', needsTargets: false, fields: [{ key: 'defaultPairs', multiline: true }, { key: 'expectedUrlPrefix' }] },
  '3': { roleMode: 'none', needsTargets: true, fields: [{ key: 'steps', multiline: true }, { key: 'fieldReference' }, { key: 'usernameReference' }] },
  '4': { roleMode: 'none', needsTargets: true, fields: [{ key: 'steps', multiline: true }, { key: 'fieldReference' }] },
  '5': { roleMode: 'required', needsTargets: false, fields: [{ key: 'failureCount' }, { key: 'baseUrl' }] },
  // テーマ6: MFA段階スキップ + OTP sub-check (再利用・寿命・試行制限・宛先変更)。
  // 対象URLの順番 (1番目=サインイン, 2番目=保護対象) が判定の前提のため、単一
  // Textarea ではなく名前付き入力にする。OTP param は任意で、未指定の sub-check は Core が理由付きで skip する。
  '6': {
    roleMode: 'optional',
    needsTargets: true,
    namedTargets: [
      { key: 'signInUrl', labelKey: 'a03.theme.f.6.signInUrl' },
      { key: 'protectedUrl', labelKey: 'a03.theme.f.6.protectedUrl' },
    ],
    fields: [
      { key: 'usernameReference' },
      { key: 'passwordReference' },
      { key: 'otpIssueUrl' },
      { key: 'otpVerifyUrl' },
      { key: 'otpVerifyField' },
      { key: 'otpSuccessMarker' },
      { key: 'otpMailboxRef' },
      { key: 'otpWrongAttempts' },
      { key: 'otpExpirySeconds' },
      { key: 'otpDestinationChangeUrl' },
      { key: 'otpDestinationChangeBodyJson', multiline: true },
      { key: 'otpDestinationChangeMarker' },
      { key: 'samlIdpStartUrl' },
      { key: 'samlAcsUrl' },
    ],
  },
  '7': { roleMode: 'required', needsTargets: false, fields: [{ key: 'nonexistentUsername' }, { key: 'baseUrl' }, { key: 'sampleCount' }, { key: 'timingThresholdMs' }] },
  // テーマ9: 正規 JWT は秘密値 (Bearer 資格)。伏せ字入力にして evidence へ保存しない。
  '9': { roleMode: 'none', needsTargets: true, fields: [{ key: 'validToken', required: true, secret: true }] },
  '10': { roleMode: 'required', needsTargets: true, fields: [{ key: 'otherRole' }, { key: 'objectParam' }, { key: 'ownValue' }, { key: 'otherValues' }] },
  '11': { roleMode: 'optional', needsTargets: true, fields: [{ key: 'method' }, { key: 'jsonBody', multiline: true }, { key: 'extraFieldsJson' }, { key: 'successMarker' }] },
  '13': { roleMode: 'optional', needsTargets: true, fields: [{ key: 'evilOrigins' }, { key: 'requestMethod' }] },
  '14': { roleMode: 'optional', needsTargets: true, fields: [{ key: 'fieldName' }, { key: 'baselineValue' }, { key: 'injectedValue', multiline: true }] },
  '15': {
    roleMode: 'optional',
    needsTargets: true,
    fields: [
      { key: 'method', kind: 'select', options: ['POST', 'PUT', 'PATCH'] },
      { key: 'baselineJson', required: true, multiline: true },
      { key: 'variantJson', required: true, multiline: true },
      { key: 'pattern' },
      { key: 'successMarker' },
      { key: 'elapsedThresholdMs' },
    ],
  },
  '16': {
    roleMode: 'optional',
    needsTargets: true,
    fields: [
      { key: 'fieldName' },
      { key: 'baselineJson', required: true, multiline: true },
      { key: 'probeUrl', required: true },
      { key: 'successMarker' },
    ],
  },
  '18': { roleMode: 'none', needsTargets: false, fields: [{ key: 'requestSamples', multiline: true }] },
  '20': { roleMode: 'optional', needsTargets: true, fields: [{ key: 'method' }, { key: 'body', multiline: true }, { key: 'repeatCount' }, { key: 'successMarker' }] },
  '21': { roleMode: 'optional', needsTargets: true, fields: [{ key: 'paramName' }] },
  '22': { roleMode: 'none', needsTargets: true, fields: [{ key: 'templateIds' }] },
  '23': { roleMode: 'optional', needsTargets: true, fields: [] },
  '24': { roleMode: 'optional', needsTargets: true, fields: [{ key: 'sensitivePage', kind: 'boolean' }] },
  '25': {
    roleMode: 'optional',
    needsTargets: true,
    fields: [
      { key: 'methods' },
      { key: 'allowStateChangingMethods', kind: 'boolean' },
    ],
  },
  '26': {
    roleMode: 'optional',
    needsTargets: true,
    fields: [
      { key: 'baselineQuery', multiline: true },
      { key: 'deepQuery', required: true, multiline: true },
    ],
  },
  '27': {
    roleMode: 'optional',
    needsTargets: true,
    fields: [
      { key: 'evilOrigins' },
      { key: 'message', multiline: true },
      { key: 'requireWss', kind: 'boolean' },
    ],
  },
  '29': { roleMode: 'optional', needsTargets: true, fields: [] },
  '30': { roleMode: 'optional', needsTargets: true, fields: [] },
};

export const FIELD_LABEL_KEYS: Readonly<Record<string, StringKey>> = {
  '2.defaultPairs': 'a03.theme.f.2.defaultPairs',
  '2.expectedUrlPrefix': 'a03.theme.f.2.expectedUrlPrefix',
  '3.steps': 'a03.theme.f.3.steps',
  '3.fieldReference': 'a03.theme.f.3.fieldReference',
  '3.usernameReference': 'a03.theme.f.3.usernameReference',
  '4.steps': 'a03.theme.f.4.steps',
  '4.fieldReference': 'a03.theme.f.4.fieldReference',
  '5.failureCount': 'a03.theme.f.5.failureCount',
  '5.baseUrl': 'a03.theme.f.5.baseUrl',
  '6.usernameReference': 'a03.theme.f.6.usernameReference',
  '6.passwordReference': 'a03.theme.f.6.passwordReference',
  '6.otpIssueUrl': 'a03.theme.f.6.otpIssueUrl',
  '6.otpVerifyUrl': 'a03.theme.f.6.otpVerifyUrl',
  '6.otpVerifyField': 'a03.theme.f.6.otpVerifyField',
  '6.otpSuccessMarker': 'a03.theme.f.6.otpSuccessMarker',
  '6.otpMailboxRef': 'a03.theme.f.6.otpMailboxRef',
  '6.otpWrongAttempts': 'a03.theme.f.6.otpWrongAttempts',
  '6.otpExpirySeconds': 'a03.theme.f.6.otpExpirySeconds',
  '6.otpDestinationChangeUrl': 'a03.theme.f.6.otpDestinationChangeUrl',
  '6.otpDestinationChangeBodyJson': 'a03.theme.f.6.otpDestinationChangeBodyJson',
  '6.otpDestinationChangeMarker': 'a03.theme.f.6.otpDestinationChangeMarker',
  '6.samlIdpStartUrl': 'a03.theme.f.6.samlIdpStartUrl',
  '6.samlAcsUrl': 'a03.theme.f.6.samlAcsUrl',
  '7.nonexistentUsername': 'a03.theme.f.7.nonexistentUsername',
  '7.baseUrl': 'a03.theme.f.7.baseUrl',
  '7.sampleCount': 'a03.theme.f.7.sampleCount',
  '7.timingThresholdMs': 'a03.theme.f.7.timingThresholdMs',
  '9.validToken': 'a03.theme.f.9.validToken',
  '10.otherRole': 'a03.theme.f.10.otherRole',
  '10.objectParam': 'a03.theme.f.10.objectParam',
  '10.ownValue': 'a03.theme.f.10.ownValue',
  '10.otherValues': 'a03.theme.f.10.otherValues',
  '11.method': 'a03.theme.f.11.method',
  '11.jsonBody': 'a03.theme.f.11.jsonBody',
  '11.extraFieldsJson': 'a03.theme.f.11.extraFieldsJson',
  '11.successMarker': 'a03.theme.f.11.successMarker',
  '13.evilOrigins': 'a03.theme.f.13.evilOrigins',
  '13.requestMethod': 'a03.theme.f.13.requestMethod',
  '14.fieldName': 'a03.theme.f.14.fieldName',
  '14.baselineValue': 'a03.theme.f.14.baselineValue',
  '14.injectedValue': 'a03.theme.f.14.injectedValue',
  '15.method': 'a03.theme.f.15.method',
  '15.baselineJson': 'a03.theme.f.15.baselineJson',
  '15.variantJson': 'a03.theme.f.15.variantJson',
  '15.pattern': 'a03.theme.f.15.pattern',
  '15.successMarker': 'a03.theme.f.15.successMarker',
  '15.elapsedThresholdMs': 'a03.theme.f.15.elapsedThresholdMs',
  '16.fieldName': 'a03.theme.f.16.fieldName',
  '16.baselineJson': 'a03.theme.f.16.baselineJson',
  '16.probeUrl': 'a03.theme.f.16.probeUrl',
  '16.successMarker': 'a03.theme.f.16.successMarker',
  '18.requestSamples': 'a03.theme.f.18.requestSamples',
  '20.method': 'a03.theme.f.20.method',
  '20.body': 'a03.theme.f.20.body',
  '20.repeatCount': 'a03.theme.f.20.repeatCount',
  '20.successMarker': 'a03.theme.f.20.successMarker',
  '21.paramName': 'a03.theme.f.21.paramName',
  '22.templateIds': 'a03.theme.f.22.templateIds',
  '24.sensitivePage': 'a03.theme.f.24.sensitivePage',
  '25.methods': 'a03.theme.f.25.methods',
  '25.allowStateChangingMethods': 'a03.theme.f.25.allowStateChangingMethods',
  '26.baselineQuery': 'a03.theme.f.26.baselineQuery',
  '26.deepQuery': 'a03.theme.f.26.deepQuery',
  '27.evilOrigins': 'a03.theme.f.27.evilOrigins',
  '27.message': 'a03.theme.f.27.message',
  '27.requireWss': 'a03.theme.f.27.requireWss',
};

/** 必須入力 (param・名前付き対象) が揃っていなければ、不足項目のラベル key を返す。 */
export function missingRequiredInputs(
  themeNo: string,
  schema: ThemeSchema,
  values: Readonly<Record<string, string>>,
  targetValues: Readonly<Record<string, string>>,
): readonly StringKey[] {
  const missing: StringKey[] = [];
  for (const target of schema.namedTargets ?? []) {
    if ((targetValues[target.key] ?? '').trim() === '') {
      missing.push(target.labelKey);
    }
  }
  for (const field of schema.fields) {
    if (field.required === true && field.kind !== 'boolean' && (values[field.key] ?? '').trim() === '') {
      const labelKey = FIELD_LABEL_KEYS[`${themeNo}.${field.key}`];
      if (labelKey !== undefined) {
        missing.push(labelKey);
      }
    }
  }
  return missing;
}
