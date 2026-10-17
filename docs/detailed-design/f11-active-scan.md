# F11 Active scan

## 1. 対象

ZAP spider/active scan と ScopePilot 管理テンプレート実行の計画、起動、監視、停止、結果取込を扱う。上位は `design/10`, `22`, `27`。

## 2. UI/CLI

- Simple: S04 で対象を選び、S05 で概算通信数と委譲範囲を最終確認。
- Advanced: A08 で policy、対象、上限、テンプレート、除外を編集。
- CLI: validate/estimate/run/status/stop/resume。AutomationGrant 必須。

## 3. モジュール

`ActiveScanPlanner`, `TargetSelector`, `ZapScanPolicyBuilder`, `ManagedTemplateRunner`, `ScanMonitor`, `ScanResultImporter`, `CoverageRecorder`。既定 spider depth 5、concurrency 2、2 RPS、30分、URL 5,000、attack strength Low。

## 4. 処理

plan は target snapshot と hash を固定する。ZAP step は input context/policy/URL と delegated limit を記録し、ScopePilot template step は各送信を EgressPolicy で拒否可能にする。monitor は progress、last activity、alert cursor を poll し停止要求を冪等に送る。

## 5. 安全・証跡

禁止操作、scope、認可、engine capability、plan confirmation を開始前に検証する。外部 engine の個々の送信を保証できないことを確認画面と report に表示する。入力、版、観測出力から実行内容を推測した記録を残す。

## 6. 失敗

ZAP `URL Does not Exist` は target import/context 準備を再確認し、無制限 retry しない。停止未確認は `Interrupted` として明示。能力実測に失敗した engine version では該当機能を公開しない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F11-UT-001 | `core/test/unit/active-scan/scan-planner.test.ts` | 既定値 | 固定した安全既定を設定 |
| F11-UT-002 | 同上 | 5001 URL | plan validation 失敗 |
| F11-UT-003 | `target-selector.test.ts` | scope 外候補 | target snapshot から除外 |
| F11-UT-004 | `scan-start-policy.test.ts` | confirmation hash 不一致 | engine 未起動 |
| F11-UT-005 | `scan-monitor.test.ts` | stop 二重要求 | adapter stop は冪等 |
| F11-UT-006 | `scan-result-importer.test.ts` | alert 再取込 | dedupe |
| F11-UT-007 | `coverage-recorder.test.ts` | delegated step | 強制保証と誤表示しない |
| F11-UT-008 | `managed-template-runner.test.ts` | scope 外へ変形 | 送信前拒否 |

## 8. 非単体テスト

ZAP API CT、Safe/standard 境界・`URL Does not Exist`・stop・alert cursor を固定版 simulation FT、管理テンプレートの request fixture を IT で検証する。
