# 11 API診断 概要設計

対応要件: 仕様書 F12・3.1 F12行（未観測要求の自動送信）・F03（API一覧）

## 1. 目的

OpenAPI・Postman・GraphQL の定義から要求を生成し、未観測の要求も許可範囲内で自動送信・診断する。
JSON/XML/multipart/binaryを型と容量上限付きで扱う。

## 2. 旧版から継承する知見

- API 文書の parser と AI 抽出を分け、抽出結果を schema validation する。
- 生成した要求は `.http` へ export できるが、export と送信を別操作にする。
- 文書の記載、定義からの生成、実際の通信観測を別の provenance として保持する。

## 3. 方針の切り替え（現行からの差分）

| 現行 | 本実装 |
|---|---|
| API下書きは観測応答が無いと診断開始不可 | 定義から生成した要求を「API送信ジョブ」として認可・上限の内側で自動送信し、応答を観測として記録してから受動・能動診断へ接続 |
| 未観測の要求を送らない | 定義内の全エンドポイント×パラメータバリエーションを計画化。通信数の事前試算を必ず表示 |

## 4. コンポーネント構成

```text
ApiDefinitionImporter（新規）:
  OpenAPI 3.x（JSON/YAML）・Postman Collection v2・GraphQL introspection/SDL を読み込み
  → ApiEndpointOperation（メソッド・パス・パラメータ・要求body型・認証要件）へ正規化
RequestGenerator（新規）:
  操作ごとに要求を生成: 必須パラメータの代表値（型に応じ自動＋文書のexample優先）・
  認証（08のSessionManager）・Content-Type（JSON/XML/multipart/binary）
  組合せが爆発する場合は代表値1件＋探索でのバリエーション（document hints の apiVariations 併用）
ApiSendJob（Orchestrator配下）:
  管理HTTP clientまたは検証済みZAP sendRequestを使い、1件ごとに予算lease・許可Origin・
  禁止語彙を検査。応答は Exchange（20）へ保存し、ZAP診断時は履歴への登録を確認してから
  受動（09）・能動（10）と同一経路へ渡す
```

## 5. データモデル

- `ApiDefinition`（取り込んだ定義の証跡: 出典・版・hash）と `ApiEndpointOperation`（正規化結果）。
- 生成要求の記録: 生成根拠（定義のどの部分から作ったか）をジョブ記録に残す。

## 6. 安全制御と証跡

- 生成要求は全件が計画に載る（事前試算・上限確認・認可の許可操作区分 `ApiSend`）。
- 破壊的操作（delete系等）はメソッド・operationId・パスの語彙検査で警告し、既定で計画から除外。
  含める場合は認可の許可操作区分で明示許可（02）。
- multipart/binary の要求生成は型・サイズ上限を表示して実行。

## 7. UI / CLI

- API診断画面: 定義の取り込み→エンドポイント一覧（F03のAPI一覧と共通）→生成プレビュー→実行。
- CLI: `scopepilot api import <file>` / `scopepilot run --api`。

## 8. 確定事項

1. Postman Collection v2.xはcollectionと、利用者が明示選択したenvironmentだけを取り込む。
   変数解決順位はrequest/local、data、environment、collection、globalの順とし、ScopePilotが保持しない
   scopeは空として扱う。pre-request/test script、動的関数、外部file読込は実行しない。auth fieldと
   secret名辞書に一致する値は`SecretRef`へ移し、未解決必須変数があるrequestは`NeedsInput`で送信しない。
2. GraphQLはSDL file単独でoperation catalogを作れる。introspectionを自動で試行せず、Queryは必須引数に
   sampleまたはscalar既定があるものだけ生成する。Mutation/Subscriptionは既定除外し、operation個別allowlist、
   `ApiSend`、必要に応じ`FormSubmit`がある場合だけ計画へ入れる。custom scalarに値mappingがなければ
   `NeedsInput`とする。
3. binary/file値を推測生成しない。optional partは省略し、required partは利用者が指定したfixture file、
   media type、hash、長さを計画へ固定するまで`NeedsInput`とする。送信には`Upload`を追加要求し、既定上限
   1 MiB、案件上限最大25 MiBとする。対象アプリから取得した実データを代表値として自動再利用しない。
4. 定義入力は最大10 MiB、展開後10,000 operation、schema node 100,000、参照深度64、parse 30秒とする。
   YAML alias expansionを禁止し、外部/network `$ref`を解決しない。同じ取込root内のlocal fileだけを
   hash付きで許可する。OpenAPI 3.0/3.1 schema validationに失敗した定義は部分実行せず、source span付きの
   errorを返す。上限超過は`DefinitionTooLarge`として証拠に残す。

参照: [Postman Collection schema](https://schema.postman.com/) と
[GraphQL specification](https://spec.graphql.org/) は入力形式の基準として版をruntime bundleへ固定する。
