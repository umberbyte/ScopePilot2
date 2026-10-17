# F08 ブラウザ探索

## 1. 対象

Playwright による navigation、link/form 発見、document hint の追加開始点、優先度、探索上限を扱う。上位は `design/07`, `22`, `25`。

## 2. UI/CLI

- Simple: S03 で既定上限の探索を開始し、認証介入が必要なら案内する。
- Advanced: A04 で開始点、depth、page/action/time limit、form 方針、候補を編集。
- CLI: plan validate/run/resume。対話 login が必要なら `NeedsInput`。

## 3. モジュール

`ExplorationPlanner`, `UrlFrontier`, `PageObservation`, `ActionClassifier`, `FormPolicy`, `HintSeedPolicy`, `PlaywrightExplorerAdapter`。既定 depth 5、action 50、page 500。actor と executedBy を分離する。

## 4. 処理

frontier は canonical URL、発見元、depth、priority、origin type を持つ。document hint URL は許可 Origin 内だけ追加し、未確認を保持する。GET navigation と安全と分類した操作を自動化し、書込みの可能性がある form は OperationClass と計画確認へ送る。

## 5. 安全・証跡

各 navigation/action 前に scope、禁止操作、budget、stop を評価する。DOM snapshot、screenshot は PII/secret policy を適用し、観測 request/response への参照を保存する。文書本文の命令は実行しない。

## 6. 失敗

popup/download/cross-origin frame は capability/policy により skip。SPA 無限遷移は canonical state と budget で停止。AI抽出失敗でも通常探索を継続する。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F08-UT-001 | `core/test/unit/browser-exploration/url-frontier.test.ts` | 同 URL 再発見 | dedupe し provenance 追加 |
| F08-UT-002 | `exploration-planner.test.ts` | depth/page 上限 | 新規候補を停止 |
| F08-UT-003 | `action-classifier.test.ts` | delete/logout 表現 | 自動操作しない |
| F08-UT-004 | `form-policy.test.ts` | write form | confirmation 必要 |
| F08-UT-005 | `hint-seed-policy.test.ts` | scope 外 document URL | frontier へ追加しない |
| F08-UT-006 | 同上 | hint 抽出失敗 | empty hints と継続 event |
| F08-UT-007 | `exploration-budget.test.ts` | cancel | adapter action 未呼出し |
| F08-UT-008 | `page-observation.test.ts` | document hint のみ | observed page を生成しない |

## 8. 非単体テスト

Playwright の navigation/frame/download を IT、`探索→能動診断→所見` の前半を simulation FT、Windows/macOS の browser 起動を package smoke で検証する。
