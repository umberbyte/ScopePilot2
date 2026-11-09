# GO-21 ガイドラインテーマ自動化方針

2026-11-10。設計正本は別worktree `spec-gap-resolution/docs/design/41-spec-gap-resolution.md` §2、§13段階8。本書はその実装範囲と後続接続条件を記録する。設計41は変更しない。

## 製品正本と現在の接続

`packages/core/src/domain/guideline-automation.ts` の `GUIDELINE_THEME_AUTOMATION_POLICIES` を全30テーマの分類正本とする。版は `GUIDELINE_AUTOMATION_POLICY_VERSION`。各entryは目標クラス、現在の接続状態、route ID、入力コード、入力解決計画、assertion計画、利用者向け保留理由、制約コードを持つ。assertion計画は将来のassertion registryへの接続仕様であり、実装済みassertion IDではない。

| 目標クラス | テーマ |
|---|---|
| automatic | 8, 12, 13, 18, 19, 23, 24, 25, 28, 30 |
| conditional-automatic | 1, 2, 7, 9, 10, 21, 22, 26, 27, 29 |
| operator-workflow | 3, 5, 11, 15, 20 |
| external-fixture | 4, 6, 14, 16 |
| unsupported | 17 |

現在 `active-scan` 接続を持つのは13/24/25/30だけ。選択ガイドラインの既存適用範囲を維持し、分類と送信予約数はこのレジストリから解決する。上限5 URL、共有予算の事前予約、確認hash、既存停止経路を維持する。予約不足はunavailableであり、passを生成しない。新しいtransportやfixture fallbackは追加しない。

テーマ8/12/19/28は汎用workflowが存在しても、項目mappingと実施・skipの投影が完成するまではテーマ完了にしない。18は受動署名分類、23はbrowser観測だけという目標だが、現状のrequest corpusは本文を持たず、browser resource/redirect chainも判定入力へ未接続のため自動送信へ昇格させない。全30テーマ分類はガイドライン項目ID単位のcoverageを表さない。既存profileにないテーマを推定で項目へ対応付けない。

テーマ17は、HTTPガイドラインが選ばれたscan結果に方針上の除外として `theme:17:unsupported` を残す。既存statusではunavailable、automationClassはunsupported、制約は `smuggling-send-prohibited` と `not-assessed`。実行APIの実装済みテーマ集合には追加せず、予算予約も送信stepも作らない。再開条件は専用raw transport、二段parser、誤配送oracleの整備と方針reviewである。

## GO-28への表示契約

contractsの `GuidelineAutomationDisclosure` をscan結果・reportのguidelineRoutesへ追加する。既存status/checkStatusの意味は維持する。

- `automationClass` は到達設計。現在の実施状態はstatus、判定はcheckStatusで別に表示する。
- `automationPolicyVersion` は当該結果で参照した方針版。過去reportに現在の方針を再適用しない。
- `missingInputCodes` は現在の自動入力解決が供給できない必要入力。値、資格情報、token、本文を含めない。後続resolverが一部解決した場合は未解決分だけへ絞る。
- `limitationCodes` は成立判定の境界。未接続routeは `automatic-route-not-connected` を併記する。このコードはoperator/external routeの自動接続がない場合も使う。
- `detail` はテーマ固有の必要事項または未実施理由。未接続のautomaticもneeds-inputを維持する。入力欄への値追加だけで実行可能になるとは表示しない。
- needs-input/unavailableにcheckStatusを付けず、検出0件、共有workflowの実行、URLの存在だけでpassへ集約しない。unsupportedは入力不足とは別表示する。

## 段階8の接続計画

前提は項目route/assertion registry、planのroute snapshot/hash、実capability、GuidelineExecution/Session/Explorationの境界である。本変更はplan schemaやGO-29のadapter配線へ広げない。

| 順序 | 入力解決とassertion/route | 接続gate |
|---|---|---|
| 18/23/29 | 18:観測requestの直列化signature受動分類。23:HTTPS browserのresource scheme/redirect chain受動判定。29:公開応答/assetと版固定pattern、形式確認済み候補をmasked fingerprint化 | 観測原本への証跡参照・scope・サイズ上限。本文/秘密値をsnapshotへ複写しない。18の実害実証は別route、23はURLのみでpassにしない、29は外部照会しない |
| 9/21/26/27 | 9:login観測JWTの受動検査。21:安全な観測入力点と版固定低回数payload。26:endpoint/正常queryからintrospectionと上限付きquery。27:観測接続と実transport/roleでOrigin比較 | memory-only session、Origin固定、正常対照、共有budgetと停止。state/nonce/PKCEはflowなしで未実施。21の状態変更/秘密入力は除外。27のfixture台帳は実行証拠にしない |
| 1/2/7/10 | 1:認証前後session/URL/marker。2:出典付き既定資格と専用login、最大10組。7:診断用ユーザーと不存在確認済み名。10:複数role/所有主体/観測ID/正常対照の差分 | 候補が一意でなければ送信せずneeds-input。一般辞書、推測ID・推測主体を使用しない。認証用egressを分離 |
| 22 | 審査済みTLS adapter/manifestを照合しengine結果を取り込む | runtime bundle/capabilityに依存。Delegatedを維持 |

各resolverは入力の値ではなく、入力コード、観測/文書の出典参照、解決件数、scope/session revision、policy/catalog/assertion版、route hashをplan snapshotへ残す。document hintは未確認の文書記載として扱い、観測済み資格や正常対照へ昇格させない。複数候補・正常対照なし・能力なしでは送信stepを作らず、未解決コードと再開条件を返す。接続後は解決根拠の変化で確認hashを無効化する。

operator-workflowはreview済み子計画、期待結果、復元を先に整備する。external-fixtureは許可済みmailbox/IdP/OAST、実adapter、認証専用egress、cleanupが揃うまで保留し、fixture成功を製品での実施済みに置き換えない。

## 検証

全30分類と一意性、未接続/条件不足の送信抑止、予約数、テーマ17の非送信、scan結果の理由コード、既存report互換をunitで確認する。実対象への送信や検出率benchmarkは実施しない。
