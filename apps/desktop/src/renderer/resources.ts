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
