# F04 Repeater

## 1. 対象

観測 request から draft を作り、編集、送信、redirect、response 比較、証跡保存を行う。上位は `design/04`, `13`, `22`。

## 2. UI/CLI

- Simple: 非公開。
- Advanced: A06 で最大20 tab、raw/structured editor、送信履歴、差分を提供。
- CLI: 承認済み request file の `repeater send`。AutomationGrant または confirmation 必須。

## 3. モジュール

`RepeaterDraft`, `RequestEditor`, `SendCommandBuilder`, `RedirectRunner`, `ResponseSummary`, `ManagedHttpAdapter`。HTTP/1.1 と HTTP/2 editor model は混在させない。

## 4. 処理

draft は base exchange ID、revision、protocol、request bytes、target、secret references を持つ。送信時に plan hash を作り、confirmation の hash と一致した場合だけ adapter へ渡す。redirect は各 hop で scope と上限を再評価し、method rewrite は policy として表示する。

## 5. 安全・証跡

既定 redirect は手動、許可時も最大10 hop。Content-Length/Host 等の再計算は editor option として明示する。raw request、response、timing、TLS/transport metadata を evidence chain へ保存する。

## 6. 失敗

曖昧な request framing、scope 外 target、hash 不一致を送信前拒否する。timeout は response なしの attempt として保存し、成功 response を捏造しない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F04-UT-001 | `core/test/unit/repeater/draft.test.ts` | 21 tab 目 | 作成拒否 |
| F04-UT-002 | `request-editor.test.ts` | header/body 編集 | canonical bytes と新 revision |
| F04-UT-003 | `send-command.test.ts` | confirmation hash 不一致 | adapter 未呼出し |
| F04-UT-004 | `redirect-runner.test.ts` | scope 外 Location | hop 前に停止 |
| F04-UT-005 | 同上 | 11 hop | limit error |
| F04-UT-006 | `response-summary.test.ts` | binary body | text 化せず metadata のみ |
| F04-UT-007 | `send-attempt.test.ts` | timeout | failed attempt evidence |

## 8. 非単体テスト

HTTP/1.1 framing、HTTP/2 semantic request、TLS proxy の adapter IT と、同じ request の ZAP/Node 経路差を fixture で検証する。
