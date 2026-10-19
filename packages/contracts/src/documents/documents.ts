/**
 * 入力文書由来の document hints 契約 (AGENTS.md 入力ドキュメントの活用・design/08)。
 * 文書の記載は観測事実ではないため、出典を保持し未確認として表示・記録する。
 * 秘密値そのものは派生成果物へ複写しない (所在のみ扱う)。
 */

/** design/08 AuthMethod の種別。 */
export const DocumentAuthMethods = ['Form', 'Bearer', 'Basic', 'ApiKey', 'Cookie'] as const;

export type DocumentAuthMethod = (typeof DocumentAuthMethods)[number];

/** 文書に記載されていた認証情報の所在 (ロール・方式・文書内の所在)。値は持たない。 */
export interface DocumentAuthHint {
  readonly role: string;
  readonly authMethod: DocumentAuthMethod;
  readonly documentLocation: string;
}

/** 登録済みの認証情報 hint (文書 label 付き)。 */
export interface DocumentAuthHintEntry {
  readonly documentLabel: string;
  readonly entries: readonly DocumentAuthHint[];
}
