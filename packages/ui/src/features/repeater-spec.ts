/**
 * Repeater 画面の FeatureSpec (A31)。`docs/design/40-advanced-mode-redesign.md` §4.6。
 * 他の画面の FeatureSpec のテンプレートとして参照。
 */
import type { FeatureSpec } from './feature-spec.ts';

/**
 * Repeater (A31) の FeatureSpec。
 * 設計 40 §4.6 A31 Repeater の定義に基づく。
 */
export const REPEATER_SPEC: FeatureSpec = {
  screenId: 'A31',
  route: 'repeater',
  group: 'manual', // TODO: 将来的に具体的な NavGroupId に置き換え
  titleKey: 'feature.repeater.title',
  purposeKey: 'feature.repeater.purpose',
  sendsTraffic: true,
  guarantee: 'Enforced',
  jobKind: 'repeater-send',
  permission: 'run.manage',
  equivalents: {
    burp: 'Repeater',
    zap: 'Manual Request Editor / Resend',
  },
  help: {
    whatKey: 'feature.repeater.help.what',
    inputsKey: 'feature.repeater.help.inputs',
    resultsKey: 'feature.repeater.help.results',
    pitfallsKey: 'feature.repeater.help.pitfalls',
  },
  fields: [
    {
      key: 'request',
      labelKey: 'field.request.label',
      descriptionKey: 'field.request.description',
      kind: 'request',
      required: true,
      // 既定値は「〜に送る」元の request、または空の GET
    },
    {
      key: 'role',
      labelKey: 'field.role.label',
      descriptionKey: 'field.role.description.session',
      kind: 'role',
      required: false,
      defaultValue: { from: 'workspace.role' },
    },
    {
      key: 'protocol',
      labelKey: 'field.protocol.label',
      descriptionKey: 'field.protocol.description',
      kind: 'select',
      required: true,
      defaultValue: 'http/1.1',
      options: [
        {
          value: 'http/1.1',
          labelKey: 'field.protocol.option.http1.label',
        },
        {
          value: 'http/2',
          labelKey: 'field.protocol.option.http2.label',
          descriptionKey: 'field.protocol.option.http2.description',
        },
      ],
    },
    {
      key: 'followRedirects',
      labelKey: 'field.followRedirects.label',
      descriptionKey: 'field.followRedirects.description',
      kind: 'select',
      required: true,
      defaultValue: 'none',
      options: [
        {
          value: 'none',
          labelKey: 'field.followRedirects.option.none.label',
        },
        {
          value: 'manual',
          labelKey: 'field.followRedirects.option.manual.label',
          descriptionKey: 'field.followRedirects.option.manual.description',
        },
      ],
    },
  ],
};

/**
 * i18n リソースのサンプル (実際は renderer/resources.ts に配置)。
 * FeatureSpec の検証時に欠落を検出するためのリファレンス。
 */
export const REPEATER_RESOURCE_KEYS = {
  'feature.repeater.title': 'Repeater',
  'feature.repeater.purpose': 'HTTP 要求を編集・送信して、応答を確認します。送信先は許可 Origin 内に制限されます。',
  'feature.repeater.help.what':
    'HTTP 要求を手動で編集・送信するツールです。通信履歴や所見から「Repeater に送る」で request を複製し、パラメーター・ヘッダー・本文を変更して何度も送信できます。送信先は案件の許可 Origin に制限され、scope 外への送信は拒否されます。',
  'feature.repeater.help.inputs':
    '【request】method・URL・header・body を raw テキストで編集します。秘密値（Cookie・Authorization）は参照として表示され、送信時に解決されます。\n【ロール】セッションを適用する role を選びます。空欄は未認証です。\n【プロトコル】HTTP/1.1 または HTTP/2 を選びます（HTTP/2 は能力が有効なときのみ）。\n【リダイレクト】3xx 応答を追従するかどうかを選びます。',
  'feature.repeater.help.results':
    '送信後、応答の status・header・body・所要時間・サイズを表示します。同じタブ内の過去送信を一覧で表示し、2 件を選んで差分を確認できます。',
  'feature.repeater.help.pitfalls':
    '【送信先が scope 外】許可 Origin 外への送信は拒否されます。A02 で scope を確認してください。\n【Host と接続先の不一致】Host ヘッダーと実際の接続先が異なる場合は警告が表示されます。',
  'field.request.label': 'Request',
  'field.request.description': 'method・URL・header・body を raw テキストで編集します。',
  'field.role.label': 'ロール',
  'field.role.description.session': 'このロールのセッションでクロールします。空欄は未認証です。',
  'field.protocol.label': 'プロトコル',
  'field.protocol.description': 'HTTP/1.1 または HTTP/2 を選びます。',
  'field.protocol.option.http1.label': 'HTTP/1.1',
  'field.protocol.option.http2.label': 'HTTP/2',
  'field.protocol.option.http2.description': '能力が有効なときのみ選択できます。',
  'field.followRedirects.label': 'リダイレクト',
  'field.followRedirects.description': '3xx 応答を追従するかどうかを選びます。',
  'field.followRedirects.option.none.label': '追従しない',
  'field.followRedirects.option.manual.label': '1 段ずつ確認して追従',
  'field.followRedirects.option.manual.description': '3xx 応答ごとに確認ダイアログを表示します。',
} as const;
