# F01 案件・Scope・認可

## 1. 対象

案件作成、対象 Origin、除外、禁止操作、期間、認可証跡、操作者権限を管理し、全ての実行計画の前提を提供する。上位は `design/02`, `22`, `24`。

## 2. UI/CLI

- Simple: 既存案件を開き、認可状態と対象を確認する。編集は管理権限時のみ別導線。
- Advanced: A01/A02 で案件、scope、role、禁止操作、証跡を編集する。
- CLI: `case show`, `case validate`, `authorization status`。変更系は permission と revision 必須。

## 3. モジュール

| モジュール | 責務 |
|---|---|
| `CaseAggregate` | 案件 revision と lifecycle |
| `ScopePolicy` | URL/Origin/IP/port/path の正規化と判定 |
| `AuthorizationPolicy` | 期間、OperationClass、対象 role、証跡の判定 |
| `OperatorPolicy` | 操作者権限と対象 role の分離 |
| `AuthorizationEvidence` | 契約書等の参照、hash、期限。秘密値は保持しない |

実装は `packages/core/src/features/case-authorization/`、契約は `packages/contracts/src/schemas/case/`。

## 4. 契約と処理

`CaseScope` は allow origin、任意の path/IP/port 制約、deny rule を持ち、deny を優先する。Unicode host、既定 port、末尾 dot、IPv6 を canonicalize 後に比較する。認可判定結果は `Allowed | Denied(reason) | NeedsInput(reason)`。

更新は `expectedRevision` を比較し、認可期間や scope が狭くなった場合、未開始 plan を再検証し既存 confirmation を無効化する。進行中 job は停止要求を発行し、結果を監査記録へ残す。

## 5. 安全・証跡

対象 role は診断対象アカウント、operator は ScopePilot 操作者であり混同しない。認可証跡の原本は file evidence として hash 参照し、秘密値を派生成果物へ複写しない。scope 未確定は許可扱いにしない。

## 6. 失敗

不正 URL は `ValidationFailed`、scope 外は `OutOfScope`、期限切れは `PermissionDenied`、更新競合は `Conflict`。認可原本が読めない場合は既存 hash を消さず `NeedsInput`。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F01-UT-001 | `core/test/unit/case-authorization/scope-policy.test.ts` | allow と deny が重なる | deny 優先 |
| F01-UT-002 | 同上 | Unicode/既定port/末尾dot | canonical origin が一致 |
| F01-UT-003 | `authorization-policy.test.ts` | OperationClass 非許可 | `PermissionDenied` |
| F01-UT-004 | 同上 | 認可期限境界 | 終了時刻以上を拒否 |
| F01-UT-005 | `operator-policy.test.ts` | operator と target role が同名 | 独立した権限として判定 |
| F01-UT-006 | `case-aggregate.test.ts` | scope 縮小 | confirmation 無効化 event |
| F01-UT-007 | 同上 | stale revision | state を変えず `Conflict` |
| F01-UT-008 | `authorization-evidence.test.ts` | 秘密値を含む metadata | 許可 field 以外を保存しない |

## 8. 非単体テスト

URL parser の共通 fixture を CT、SQLite revision transaction を IT、認可変更中の job 停止を FT で検証する。
