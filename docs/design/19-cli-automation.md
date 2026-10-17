# 19 CLI・自動処理 概要設計

対応要件: 仕様書 F21（自動処理）・2.1（GUI専用ロジックの分離）

## 1. 目的

同一コアのCLIを提供し、JSON結果出力・CI・ジョブ待ち・終了理由を扱えるようにする。
「GUIでしかできない診断」をなくすことが系列Aの一貫目標。

## 2. 再利用する現行資産

- `scripts/simulation/ScopePilot.Simulation`（実績: open/explore/candidates/zap の各フェーズで
  GUIと同一のViewModelコマンドをヘッドレス実行。進捗ログの整列を同期コンテキストで解決済み）
- MainViewModel/Services（GUIとCLIで同一コードパス）

## 3. コンポーネント構成

```text
ScopePilot.Cli（新規プロジェクト・コンソール）:
  コマンド: auth(02) / explore(07) / candidates / scan --passive|--active(09,10) /
    api import+run(11) / fuzz(05) / resend(04・対話以外は計画ファイルから) /
    oast poll(12) / report(17) / rule(18) / run(全自動パイプライン) / auth/status
  実装: MainViewModelをコンソールで駆動（シミュレーションハーネスの正式化）。
    進捗は行ログ＋--json でイベントストリーム
  出力: 結果JSON（観測・所見・実行記録の要約＋証跡パス）をstdoutまたはファイル。
    終了コード: 0=完了 2=警告あり 3=上限停止 4=範囲違反 5=認証失敗 6=エンジン失敗（10.1と整合）
JobRunner: 複数フェーズの連続実行（AutoPlanComposerの計画に従う）とジョブ待ち・中断再開
```

- CI利用: `scopepilot run --project <dir> --authorization <id> --report out/ --json`。
  更新確認はオフライン指定可（21）。

## 4. データモデル

- CLIの入出力スキーマをOpenAPI/JSON Schemaとしてdocsに同梱し、拡張API（18）と整合させる。

## 5. 安全制御と証跡

- CLIも認可（02）・上限（22）の内側。無認可での送信系コマンドは拒否し、その旨と終了コードを返す。
- すべての実行はGUIと同じ runs/ 証跡を残す（ログは simulation/logs 方式＝ファイル＋stdout）。

## 6. UI / CLI

- GUIはCLIを内包する関係（同一ViewModel）。GUI専用になるのはインターセプト（03）と
  手動編集（04のエディタ）のみで、その旨を能力表に明示。

## 7. 未解決事項（A1）

1. コマンド体系の最終形（エイリアス・--dry-run の共通オプション）
2. 進捗イベントの形式（NDJSON）と、CIでの中断（SIGINT相当）の扱い
3. シミュレーションハーネスのビルドを本プロジェクトへ正式に組み込む方法
