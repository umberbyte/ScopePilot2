# 19 CLI・自動処理 概要設計

対応要件: 仕様書 F21、A0/A1

## 1. 目的

UI に依存しない TypeScript CLI で、計画作成、実行、待機、停止、JSON 出力、CI 利用を提供する。CLI と desktop は同じ `ApplicationService` と core を使い、画面状態や Electron IPC を経由しない。

## 2. 構成

`apps/cli` は Node の薄い entry point とし、引数解析、標準入出力、OS signal の変換だけを担う。ユースケースは `packages/core`、外部エンジンは `packages/adapters`、保存は `packages/storage` が実行する。

主要コマンドは次とする。

```text
scopepilot case create|open|status
scopepilot auth create|list|revoke
scopepilot plan create|show|validate
scopepilot run start|status|wait|cancel|resume
scopepilot explore
scopepilot scan --passive|--active|--nuclei
scopepilot fuzz
scopepilot report --format markdown|docx|json
scopepilot db check|migrate|export
scopepilot runtime verify
```

送信系の簡易コマンドも内部では plan を生成し、`--dry-run` で正規化済み対象、操作、想定通信数、上限、ランタイム版、計画ハッシュを表示する。

## 3. 機械可読出力

`--json` は最終結果を stdout に一つだけ出す。進捗は `--events ndjson` で stderr または指定ファイルへ出し、通常ログと混ぜない。すべての出力に `schemaVersion`、`runId`、`status`、`stopReason`、証拠参照を含める。

終了コードは最低限、完了、所見あり、上限停止、範囲違反、認証失敗、エンジン失敗、入力不正、中断を区別する。所見の有無と実行成否を同じ終了コードに押し込めず、CI ポリシーがどちらを失敗とするか選べる。

## 4. 中断と再開

Ctrl+C/SIGINT は第一段階で協調停止を要求し、猶予後の二回目で子プロセスツリーを強制停止する。終了前に run state と証拠の flush 結果を記録する。再開可能なのは、計画ハッシュ、認可、runtime bundle、入力証拠が一致し、ジョブが冪等または明示的な resume point を持つ場合だけである。

## 5. シミュレーションハーネス

`tools/simulation` は ZAP API、Playwright 対象、Nuclei JSONL の固定 fixture を提供する。A0 の基準シナリオは「案件作成→認可→探索→候補採用→能動診断→取込→所見→報告」である。実サービスへの検出率ベンチマークは既定の受け入れ条件にしない。

## 6. 安全制御

CLI に安全制御を無効化する隠し option を設けない。無認可、期限切れ、計画差分、範囲外、保証不足の engine capability は実行前に拒否する。CI 用 token や秘密値はコマンドライン引数で受けず、OS secret store の参照または標準入力の secret channel を使う。

## 7. A0/A1 受け入れ条件

1. 基準シナリオが UI なしで自動完走し、同じ入力から安定した計画ハッシュを作る。
2. 中断、上限停止、認証切れ、エンジン異常を別の終了理由と証拠で再現できる。
3. JSON/NDJSON が [18](18-extension-api.md) の schema validation を通る。
4. Windows と macOS で子プロセスが残らず、案件ロックを回収できる。
