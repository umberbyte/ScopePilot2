# F10 Passive scan

## 1. 対象

観測通信を追加送信なしで分析し、ZAP passive alert と ScopePilot analyzer の所見候補へ正規化する。上位は `design/09`, `17`, `20`。

## 2. UI/CLI

- Simple: 探索中に自動実行し、結果レビューで候補を表示。
- Advanced: A08 で queue、analyzer、除外、再解析を操作。
- CLI: `passive status/run/import`。新規通信を発生させない。

## 3. モジュール

`PassiveQueue`, `PassiveBatchPlanner`, `PassiveObservationAnalyzer`, `ZapAlertImporter`, `FindingNormalizer`, `CoverageSummary`。batch 既定1,000件または25 MiB。

## 4. 処理

exchange evidence ID を queue に一意登録し、analyzer version ごとに processing key を作る。ZAP queue drain と alert cursor は別管理する。alert は source rule ID、source instance、message reference で重複排除する。

## 5. 安全・証跡

Passive analyzer は network port を持たない。所見は観測 evidence を最低1件参照し、document hint だけから生成しない。source severity と正規化 severity を両方保持する。

## 6. 失敗

analyzer failure は item を retryable failure にし、全 queue を成功扱いしない。ZAP cursor 異常は範囲再取込＋dedupe。body 不在は coverage limitation として表示する。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F10-UT-001 | `core/test/unit/passive-scan/passive-queue.test.ts` | 同 exchange 再登録 | 1 item のみ |
| F10-UT-002 | `batch-planner.test.ts` | 1000件/25MiB 境界 | 超過前で分割 |
| F10-UT-003 | `zap-alert-importer.test.ts` | alert 重複 | 既存 finding candidate を参照 |
| F10-UT-004 | `finding-normalizer.test.ts` | source severity 不明 | Unknown を保持し推測しない |
| F10-UT-005 | `observation-analyzer.test.ts` | evidence なし | finding 生成拒否 |
| F10-UT-006 | `coverage-summary.test.ts` | body truncate | limitation を表示 |
| F10-UT-007 | `passive-queue.test.ts` | analyzer failure | retryable failure、未完了 |

## 8. 非単体テスト

固定 ZAP 版の passive queue/alert CT、SQLite queue IT、探索中の queue drain と cursor 復旧を simulation FT で行う。
