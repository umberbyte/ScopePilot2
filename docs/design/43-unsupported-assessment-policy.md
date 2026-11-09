# GO-23 検査不能項目の最終方針と報告契約

2026-11-10。設計41 §4.1・§4.2と設計42を具体化する。テーマ6の実adapterは本変更の対象に含めない。

## 現行bundleの決定

| 対象 | 最終方針 | 理由コード | 再開gate |
|---|---|---|---|
| テーマ17 request smuggling / parser差異 | 検査不能・スキップを明示 | RAW_TRANSPORT_AND_DUAL_PARSER_ORACLE_MISSING | 隔離frontend/backend二段parser、byte列保持専用transport、一意tokenの誤配送oracle、connection reuse/timeout上限、停止・証跡方針、固定bundle実測・公開review |
| ASVS 10.2.3 scope最小化 | 検査不能・スキップを明示 | OAUTH_SCOPE_POLICY_AND_COMPARISON_PRINCIPAL_MISSING | 承認済みOAuthScopePolicy、認可要求・grant/token scopeの観測、比較経路の実装・検証・review |

限定的probeで合否を作らず、対象外（not-applicable）にも変更しない。未判定のままcoverageに残す。
ASVS 10.2.3をテーマ17へ対応付けない。JWTの受動検査やOAuth通信の観測だけでscope最小性を認定しない。
必要なpolicyはclient ID、flow、必要scope、禁止scope、resource、比較主体、根拠文書を含む。
将来の評価はmanual-reviewまたはconditional-automaticであり、policy値の入力だけで現行bundleが実行可能になるとは表示しない。

## 正本とsnapshot

- テーマ17の分類・非送信はGO-21の `guideline-automation.ts` を維持する。実装済みテーマ集合、予算予約、送信loopへ追加しない。
- GO-23のコード正本は `packages/core/src/domain/unsupported-assessment.ts`。方針版を固定し、理由、再開条件、対象IDを解決する。
- 契約は `packages/contracts/src/report/report.ts` の `UnsupportedAssessment`。`routeKind=unsupported`、`guarantee=Unsupported`、`assessment=not-assessed` を独立して持ち、checkStatusを持たない。
- scan結果と `guideline-routes` 証跡に `unsupportedAssessments` を保存し、report coverageへ同じsnapshotを渡す。報告生成で既存snapshotへ現在の方針を再適用しない。
- scan前の新規報告は、選択ガイドラインについて現行方針だけを掲載する。過去の保存済みReportModelへ項目を補完しない。
- テーマ17はHTTPガイドライン選択時の製品能力制約。項目ID別mappingの主張ではない。ASVS 10.2.3はASVS選択時のみ掲載する。全項目coverage routeの整備はGO-22に委ねる。

## 利用者への表現

Markdownとassurance report（HTML/DOCXの共通モデル）に「検査不能・スキップ」「not-assessed」「Unsupported」、対象名、理由コード、再開条件、方針版を掲載する。JSONには同じ構造化値を残す。検出0件や他の経路のpassを使って合否や完全実施へ集約しない。

GO-21の既存 `guidelineRoutes` は互換のためテーマ17を `status=unavailable / automationClass=unsupported` のまま保持する。新しい検査不能明細がある場合、報告では同じroute IDの二重掲載・二重集計を避ける。新明細がないGO-21モデルもautomationClassからスキップと表示する。
入力を補えば既存経路を実行できる `needs-input` と、予算・runtime能力による一時的な `unavailable` は既存の意味を保つ。新明細はそれらと別の製品方針であり、全通常経路が実行済みでもスキップが残るガイドラインを「実施済み」としない。

## 検証

方針対象・重複排除、ASVS限定、テーマ17実行拒否・予約0、既存送信数不変、scan→証跡→report snapshot、Markdownとassurance coverage表示、誤った完全実施の防止をunitで確認する。実対象や脆弱性検出率のbenchmarkは実施しない。
