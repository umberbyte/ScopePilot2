import { getLocale } from "./resources.ts";

/** P6 result screens share the application locale. English keys are also the English text. */
const ja = {
  "Evidence browser": "証拠ブラウザ",
  "Originals stay in local storage. The API exposes hashes and display derivatives only. Bodies and header values are omitted; shared artifacts are not generated here.":
    "原本はローカルに保存されます。API は hash と表示用の派生情報のみを返します。本文・ヘッダー値は省略し、共有用成果物はここでは生成しません。",
  "Search evidence": "証拠を検索",
  Loading: "読込中",
  "No evidence": "証拠はありません",
  "Evidence details": "証拠詳細",
  "Original reference / display derivative / shared copy not generated":
    "原本参照 / 表示用派生 / 共有用未生成",
  Source: "出典",
  "Source job / run: linkage not recorded": "出典ジョブ・run: 関連付け未記録",
  "Open finding": "所見を開く",
  "Observed request (display)": "観測リクエスト（表示用）",
  "No captured HTTP request is available. Reproduction is not inferred.":
    "取得できる HTTP リクエストはありません。再現内容を推測しません。",
  "Observed response (display)": "観測レスポンス（表示用）",
  "No captured HTTP response is available":
    "取得できる HTTP レスポンスはありません",
  "Bodies, query values and header values omitted. This view sends no replay requests.":
    "本文・クエリ値・ヘッダー値を省略。再送は行いません。",
  "Verification record saved": "検証記録を保存しました",
  "Alerts are unverified engine candidates imported into the Findings ledger with repeated observations deduplicated. Human confirmation or rejection requires evidence review and a verification record, separate from the engine judgment.":
    "Alerts はエンジン由来の未検証候補です。同じ所見台帳へ取り込み、重複観測を集約します。Findings の確定・棄却は人の証拠確認と検証記録に基づき、エンジン判定とは区別します。",
  "Search findings": "所見を検索",
  Status: "状態",
  Severity: "重要度",
  "Group by": "グループ",
  Refresh: "再読込",
  "Visible findings": "表示件数",
  "No matching findings": "該当する所見はありません",
  "Finding details": "所見詳細",
  "Method not recorded": "メソッド未記録",
  Parameter: "パラメータ",
  "Engine impact verification": "エンジンによる実影響確認",
  Unverified: "未確認",
  Verified: "確認済み",
  "No evidence: confirmation unavailable": "証拠なし: 確定できません",
  "Open evidence": "証拠を開く",
  "Saved verification record": "保存済み検証記録",
  "Merged into": "統合先",
  "Duplicates are never merged automatically. Merging preserves evidence and reviews without confirming the destination.":
    "重複候補は自動統合しません。統合は元の証拠・検証記録を保持し、統合先を確定しません。",
  "Merge destination": "統合先の所見",
  "Merge reason": "統合理由",
  "Merge recorded": "統合を記録しました",
  "Merge with recorded reason": "理由を記録して統合",
  "Reproduction result": "再現結果",
  "Not reproduced": "未再現",
  Reproduced: "再現した",
  "Verification notes (this finding only)": "検証メモ（この所見のみ）",
  "Severity rationale": "重要度の根拠",
  "Supply CVSS version, vector and score (0–10) together":
    "CVSS は版・ベクトル・0〜10 のスコアをすべて指定してください",
  "Confirm and save review": "確定して検証記録を保存",
  "Reject and save review": "棄却して検証記録を保存",
  Report: "報告",
  "Export an assurance report and technical annex from the canonical API report model, including scope, evidence, coverage and limitations. Candidates remain candidates; coverage does not prove safety.":
    "正規レポートモデルを正本に、保証レポート（対象・証拠・実施範囲・限界）と技術付録を保存します。候補は候補として表示され、coverage は安全性の証明ではありません。",
  Guidelines: "ガイドライン",
  "Exclude low / info": "Low / Info を除外",
  "Generate canonical preview": "正規モデルからプレビュー生成",
  "Snapshot generated": "生成時点",
  "Canonical report": "正規レポート",
  "Canonical report (without AI text)": "正規レポート（AI 未反映）",
  "Save DOCX / Markdown assurance report":
    "DOCX / Markdown・保証レポートを保存",
  "Generate separate AI draft": "AI 文章案を別枠で生成",
  "AI draft": "AI 文章案",
  "AI draft — unverified (excluded from canonical exports)":
    "AI 文章案・未検証（保存する正規レポートには含めません）",
  "System name": "システム名",
  "Client name": "顧客名",
  Author: "作成者",
  Reviewer: "確認者",
  Markdown: "Markdown",
  DOCX: "DOCX",
  "Technical annex": "技術付録",
  "Structured JSON": "構造化 JSON",
  "Artifact manifest": "成果物一覧・hash",
  "Report file": "報告ファイル",
} as const;
export type ResultTextKey = keyof typeof ja;
export function resultText(key: ResultTextKey): string {
  return getLocale() === "ja" ? ja[key] : key;
}
