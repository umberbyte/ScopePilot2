/**
 * UI 文字列資源。`docs/design/28` §8.1 MUST 10 (コンポーネントに直書きしない・文の連結をしない)。
 * 現時点は ja 1 語語 resource。{name} 形式の置換だけをサポートし、文は資源側で完結させる。
 * 今後 多言語化する場合はこの表を locale 別に分ける (呼び出し側は変更しない)。
 */
export const strings = {
  'app.mode.label': 'モード:',
  'app.mode.simple': 'シンプル',
  'app.mode.advanced': 'アドバンスド',
  'app.status.connecting': '接続中…',
  'app.status.apiOk': 'Core API: {status} ({schemaVersion})',
  'app.status.apiUnreachable': 'Core API へ接続できません',
  'app.status.bridgeMissing': 'API 橋渡しが見つかりません (preload 未構成)',
  'app.harnessLabel': 'fixture harness',

  'wizard.s01.openCase': '案件を開く (fixture)',
  'wizard.s01.opened': '案件「{caseName}」を開きました。',
  'wizard.s02.title': 'S02 ガイドライン選択',
  'wizard.s03.title': 'S03 認証準備・探索開始',
  'wizard.s03.defaultLimits': '上限 (既定・表示専用): 500 ページ / 2 req/s / 30 分 / 深さ 5',
  'wizard.s03.explore': '探索を開始する',
  'wizard.s03.done': '探索完了: {observations} 件を観測、診断候補 {candidates} 件を生成',
  'wizard.s04.title': 'S04 探索結果から対象選定',
  'wizard.s04.hint': '観測された候補から診断対象を選んでください (全選択可)。',
  'wizard.s04.adopt': '選択を採用する ({count} 件)',
  'wizard.s05.title': 'S05 実行計画の最終確認',
  'wizard.s05.purpose': '送信目的: 探索結果に対する能動診断 (ZAP 委譲)。',
  'wizard.s05.targets': '対象: {targets} 件 / 概算通信数上限: {maxRequests} 件',
  'wizard.s05.forbidden': '禁止操作: 本案件では破壊的操作・認証情報変更を禁止します。',
  'wizard.s05.finalNote': 'この確認が、送信前の最終操作です。',
  'wizard.s05.build': '計画を作成して確認する',
  'wizard.s06.title': 'S06 実行状況',
  'wizard.s06.run': '診断を実行する',
  'wizard.s06.done': '診断完了 (engine {engineVersion}・overshoot 予約 {overshoot} 件分): 所見 {findings} 件',
  'wizard.s06.finding': '[{severity}] {title} — {url} (観測 {occurrences} 回){unverified}',
  'wizard.s06.unverified': ' ・実影響未確認',
  'wizard.s07.title': 'S07 結果レビュー・報告',
  'wizard.s07.generate': '報告書を生成する',
  'wizard.nav.back': '戻る',
  'wizard.nav.next': '次へ',
  'wizard.nav.nextBlocked': '(要件未達)',

  'common.targetUrlInScope': '対象 URL (scope 内)',
  'common.error': 'Error: {message}',

  'a13.title': '外部 engine (能力・版・開示)',
  'a13.guaranteeLegend':
    '保証等級 — Enforced: ScopePilot が送信前に保証 / Delegated: 外部 engine への委譲 (入力制限・事後検知・停止で担保、送信前拒否は保証しない) / Unsupported: 当該機能を公開しない',
  'a13.table.aria': 'engine 能力詳細',
  'a13.col.version': '版',
  'a13.col.source': '由来',
  'a13.col.overshoot': 'overshoot 上限比',
  'a13.col.measuredAt': '測定時刻',
  'a13.col.fixtureHash': 'fixture hash',
  'a13.sourceFixture': 'fixture (実測ではない)',
  'a13.certificates.title': '証明書',
  'a13.certificates.note': '診断用 CA 証明書の発行と信頼設定は実 engine 接続 (HTTPS 解析) と共に後続増分で提供します (design/24)。',
  'a13.ai.title': 'AI 支援',
  'a13.ai.note':
    'AI provider は未設定です。提案 (CaseSetup・RequestDraft・FindingDraft 等) は drawer 経由で出典・model・生成時刻・差分付きで提示し、明示採用まで状態を変更しません (design/02 §5)。',

  'a06.intro':
    'draft は tab として最大 20 件。編集のたびに revision と計画 hash が進み、画面に表示した hash と一致するときだけ送信します (編集後の古い hash では送信されません)。応答は summary のみ (binary は text 化しません)。',
  'a06.create': '新規 draft を作る',
  'a06.headersLabel': 'headers (1行1件・Name: Value)',
  'a06.bodyLabel': 'body',
  'a06.apply': '編集を適用する',
  'a06.requestPreview': '要求 (canonical):\n{requestBytes}',
  'a06.planHash': '計画 hash: {planHash}',
  'a06.send': 'この hash を確認して送信する',
  'a06.sent': '送信しました ({outcome})。応答: {status} {contentType} ({bodyBytes} bytes)',
  'a06.notSent': '送信しませんでした: {reason}',

  'a07.intro':
    '組合せ総数が上限 (案件上限と 200 の小さい方) を超えると送信前に拒否されます。応答は (status・長さ・hash) ごとに cluster 集約し、全体の一覧は表示しません。rate は 2 req/s 既定 (仮想時計で進めます)。',
  'a07.payloadTitle': 'payload 集合 (供給元・版・license が必須)',
  'a07.field.name': '名前',
  'a07.field.source': '供給元 (source)',
  'a07.field.version': '版',
  'a07.field.license': 'license',
  'a07.field.values': '値 (1行1件)',
  'a07.register': 'payload 集合を登録する',
  'a07.registered': '登録済み: {sets}',
  'a07.setSummary': '{name} ({source} {version}・{license}・{count} 件)',
  'a07.runTitle': 'fuzz 実行',
  'a07.positionsLabel': 'positions (1行1件・name: 値, 値, …)',
  'a07.run': 'fuzz を実行する',
  'a07.result': '{runId}: 組合せ {total} 件中 {sent} 件送信 → {clusters} cluster',
  'a07.table.aria': '応答 cluster',
  'a07.col.key': 'cluster (status|bytes|hash)',
  'a07.col.count': '応答数',
  'a07.col.representative': '代表組合せ',
} as const;

export type StringKey = keyof typeof strings;

/** 文字列資源の引き出し。{name} placeholder を params で置換する (文の連結はしない)。 */
export function t(key: StringKey, params: Readonly<Record<string, string | number>> = {}): string {
  let text: string = strings[key];
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}
