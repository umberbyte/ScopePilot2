/**
 * 機能画面の宣言的定義 (FeatureSpec・FieldSpec)。`docs/design/40-advanced-mode-redesign.md` §4.3。
 * 画面の説明と入力定義をコードに散らさず、宣言として置く。renderer はこれから見出し・
 * 使い方パネル・Field・検証を生成し、unit test で全画面の宣言漏れを検出する。
 */
import type { OperatorPermission } from '@scopepilot2/contracts';
import type { UiRoute } from '../app/mode-policy.ts';

/** i18n リソースキー (例: 'feature.repeater.title', 'field.role.description')。 */
export type StringKey = string;

/**
 * ナビグループ識別子 (設計 40 §3.2 の 9 グループ)。
 * TODO: 将来的に 'recon' | 'manual' | 'automated' | ... に具体化。現時点は placeholder。
 */
export type NavGroupId = string;

/**
 * ジョブ種別 (設計 40 §5.2)。
 * TODO: contracts に JobKind が追加されたら置き換え。
 */
export type JobKind =
  | 'crawl'
  | 'active-scan'
  | 'fuzz'
  | 'repeater-send'
  | 'template-check'
  | 'login'
  | 'sequencer'
  | 'ws-send'
  | 'oast-poll'
  | 'dom-observe'
  | 'interactive-diagnostics'
  | 'proxy-session'
  | 'report';

/** 安全保証等級 (設計 40 §4.1)。 */
export type GuaranteeLevel = 'Enforced' | 'Delegated' | 'Mixed';

/** Field の種別。 */
export type FieldKind =
  | 'text'
  | 'url'
  | 'url-list'
  | 'integer'
  | 'select'
  | 'multi-select'
  | 'boolean'
  | 'role'
  | 'request'
  | 'secret-ref';

/** Field の単位。 */
export type FieldUnit = 'requests' | 'pages' | 'minutes' | 'rps' | 'depth' | 'ms';

/** 宣言的検証規則。最終判断は Core の validation。 */
export type FieldRule = 'in-scope-origin' | 'http-url' | 'regex' | 'range';

/** 既定値の取得元。 */
export type DefaultValueSource =
  | 'case.startUrl'
  | 'case.limits.maxRequests'
  | 'case.limits.maxPages'
  | 'case.limits.maxDurationMinutes'
  | 'workspace.role';

/** Field の上限値の取得元。 */
export type MaxValueSource =
  | 'case.limits.maxRequests'
  | 'case.limits.maxPages'
  | 'case.limits.maxDurationMinutes';

/** Field の選択肢。 */
export interface FieldOption {
  readonly value: string;
  readonly labelKey: StringKey;
  readonly descriptionKey?: StringKey;
}

/** 入力 Field の定義。 */
export interface FieldSpec {
  /** Field の識別子 (例: 'engine', 'startUrls', 'maxDepth')。 */
  readonly key: string;
  /** Field のラベル (i18n キー)。 */
  readonly labelKey: StringKey;
  /** Field の説明・意味 (hint として表示。i18n キー)。 */
  readonly descriptionKey: StringKey;
  /** Field の種別。 */
  readonly kind: FieldKind;
  /** 必須かどうか。 */
  readonly required: boolean;
  /** 既定値。固定値または取得元。 */
  readonly defaultValue?: unknown | { readonly from: DefaultValueSource };
  /** 単位。 */
  readonly unit?: FieldUnit;
  /** 最小値 (integer の場合)。 */
  readonly min?: number;
  /** 最大値。固定値または取得元。 */
  readonly max?: number | { readonly from: MaxValueSource };
  /** 選択肢 (select / multi-select の場合)。 */
  readonly options?: readonly FieldOption[];
  /** 詳細設定に折りたたむかどうか。 */
  readonly advanced?: boolean;
  /** 宣言的検証規則。 */
  readonly validate?: readonly FieldRule[];
}

/** 機能画面の定義。 */
export interface FeatureSpec {
  /** 設計文書の画面番号 (例: 'A22', 'A31', 'A40')。 */
  readonly screenId: string;
  /** UI route。 */
  readonly route: UiRoute;
  /** ナビグループ。 */
  readonly group: NavGroupId;
  /** 画面のタイトル (i18n キー)。 */
  readonly titleKey: StringKey;
  /** 画面の目的 (見出し直下の 1〜2 文。i18n キー)。 */
  readonly purposeKey: StringKey;
  /** 送信を伴うかどうか (⇅ アイコン表示)。 */
  readonly sendsTraffic: boolean;
  /** 安全保証等級 (送信を伴う画面の場合)。 */
  readonly guarantee?: GuaranteeLevel;
  /** 実行するジョブの種類 (送信を伴う画面の場合)。 */
  readonly jobKind?: JobKind;
  /** 必要な操作者権限。 */
  readonly permission: OperatorPermission;
  /** Burp/ZAP での相当機能。 */
  readonly equivalents: {
    readonly zap?: string;
    readonly burp?: string;
  };
  /** 使い方パネルのヘルプ内容 (i18n キー)。 */
  readonly help: {
    /** 何をする機能か。 */
    readonly whatKey: StringKey;
    /** 何を入力するか。 */
    readonly inputsKey: StringKey;
    /** 結果の見方。 */
    readonly resultsKey: StringKey;
    /** よくある失敗。 */
    readonly pitfallsKey?: StringKey;
  };
  /** 入力 Field の定義一覧。 */
  readonly fields: readonly FieldSpec[];
}
