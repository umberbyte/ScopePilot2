# F12 API scanning

## 1. 対象

OpenAPI、Postman Collection、GraphQL SDL を安全に取込み、endpoint/parameter 候補と実行計画を生成する。上位は `design/11`, `22`, `25`。

## 2. UI/CLI

- Simple: 入力文書を補助情報として取込み、候補選択と最終確認のみ。
- Advanced: A08 で server、変数、operation、example、mutation 方針を編集。
- CLI: `api import/plan/run`。未解決変数は `NeedsInput`。

## 3. モジュール

`ApiDocumentImporter`, `OpenApiNormalizer`, `PostmanNormalizer`, `GraphqlNormalizer`, `VariableResolver`, `ApiCandidatePlanner`, `ApiRequestBuilder`。Postman script は実行せず、GraphQL は SDL を基準とする。

## 4. 処理

文書原本を hash 保存し、parser version と warning を記録する。server URL は scope 判定後に候補化する。変数解決順は案件設定、環境参照、文書既定、未解決。binary body、独自 auth、動的 script が必須なら `NeedsInput` または `Unsupported`。

## 5. 安全・証跡

文書内の instruction/script は実行しない。operation の read/write 推定は確認材料であり認可を代替しない。生成 request は必ず ExecutionPlan に入り、原文 pointer と変数 provenance を持つ。

## 6. 失敗

サイズ、参照深度、循環参照、operation 数に上限を設ける。parse できた一部を全体成功とせず warning/coverage を返す。認証秘密値は文書派生成果物へ複写しない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F12-UT-001 | `core/test/unit/api-scanning/openapi-normalizer.test.ts` | 複数 server | scope 内だけ候補化 |
| F12-UT-002 | `postman-normalizer.test.ts` | pre-request script | 実行せず unsupported warning |
| F12-UT-003 | `graphql-normalizer.test.ts` | mutation | write candidate と分類 |
| F12-UT-004 | `variable-resolver.test.ts` | 値の優先順位 | 定義順で provenance 付き解決 |
| F12-UT-005 | 同上 | secret 未解決 | 値を推測せず `NeedsInput` |
| F12-UT-006 | `api-request-builder.test.ts` | binary schema | 自動本文を作らず `NeedsInput` |
| F12-UT-007 | `api-document-importer.test.ts` | 循環参照 | bounded error |
| F12-UT-008 | `api-candidate-planner.test.ts` | document only | observed=false を保持 |

## 8. 非単体テスト

公式仕様 corpus による parser CT、ZAP OpenAPI import の版別 IT、API fixture への read/write 計画確認 FT を行う。
