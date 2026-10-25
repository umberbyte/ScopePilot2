# F21 CLI・自動化

## 1. 対象

Core API を利用する headless CLI、出力契約、exit code、AutomationGrant、simulation harness を扱う。上位は `design/19`, `22`, `25`。

## 2. UI/CLI

Desktop UI と CLI は同じ Core API 契約を使う。CLI は対話端末と non-TTY を判別し、次のコマンド構成を提供する。

```text
scopepilot case ...
scopepilot plan validate|show|confirm|run|stop|resume ...
scopepilot jobs ...
scopepilot findings ...
scopepilot report ...
scopepilot capabilities ...
scopepilot simulate ...
```

対話端末では confirmation summary を表示できる。CI/non-TTY は plan hash と範囲・期限・operation class を固定した `AutomationGrant` がなければ送信系 command を実行しない。

## 3. モジュール

`CliParser`, `CommandDispatcher`, `OutputFormatter`, `ExitCodeMapper`, `ConfirmationPrompt`, `AutomationGrantVerifier`, `ProgressSubscriber`, `SimulationHarness`。CLI は core domain を直接 import せず生成 API client を使う。

## 4. 入出力

既定 human output と `--json` NDJSON を分離し、progress は stderr、machine result は stdout。secret 値を argv option として受けず、stdin secret channel、environment reference、OS store reference を使用する。exit code は success、validation、permission、partial、engine、cancel を固定する。

## 5. 安全・証跡

grant は署名/issuer/subject/case/plan hash/operation class/expiry/max limits を検証する。CLI option で scope や上限を grant より拡張できない。simulation は固定 engine/tool version、fixture hash、capability snapshot を保存する。

## 6. 失敗

non-TTY で prompt が必要なら即 `ConfirmationRequired`。SSE 切断は cursor から再開し、最終状態を API で照合する。SIGINT は stop request 後に期限まで待ち、未確認なら interrupted exit。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F21-UT-001 | `apps/cli/test/unit/cli-parser.test.ts` | 未知/競合 option | usage error |
| F21-UT-002 | `automation-grant.test.ts` | plan hash/期限不一致 | 実行拒否 |
| F21-UT-003 | 同上 | CLIで上限拡張 | 実行拒否 |
| F21-UT-004 | `output-formatter.test.ts` | `--json` progress | stdout を汚さず stderr へ |
| F21-UT-005 | `exit-code-mapper.test.ts` | partial/cancel/engine | 固定 code |
| F21-UT-006 | `progress-subscriber.test.ts` | SSE reconnect | cursor から重複なく再開 |
| F21-UT-007 | `secret-input-policy.test.ts` | argv secret | 拒否し値を log しない |
| F21-UT-008 | `signal-controller.test.ts` | SIGINT 二回 | stop は冪等、期限後 interrupted |
| F21-UT-009 | `simulation-harness.test.ts` | fixture 完走 | 探索→診断→所見と版情報を記録 |

## 8. 非単体テスト

CLI/OpenAPI CT、TTY/non-TTY と signal IT、固定 fixture で「探索→能動診断→所見」を完走する FT を本体実装より先に構築する。DVWA は既定で検出率ではなく workflow の成立を確認する。
