# 11 API診断 概要設計

対応要件: 仕様書 F12・3.1 F12行（未観測要求の自動送信）・F03（API一覧）

## 1. 目的

OpenAPI・Postman・GraphQL の定義から要求を生成し、未観測の要求も許可範囲内で自動送信・診断する。
バイナリ等の現行の未対応を解消する。

## 2. 再利用する現行資産

- `Services/ApiDocumentService`（API文書の解析・結果検証）と `ApiDocumentAiRunner`（AI抽出）
- `Domain` の `ApiRequest`（下書きモデル）と `Services/ApiRequestFormatter`（.http 形式化・検査）
- `Services/ApiRequestExportService`（requests/*.http 出力）

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
  実行経路は05と同じ2案（requestor計画 / sendRequestループ）を共用。送信前に許可Origin検査・
  禁止語彙検査。応答は HttpExchange（20）へ。以降は受動（09）・能動（10）と同一経路
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

## 8. 未解決事項（A1〜A3）

1. Postman Collection の変数・環境の扱い（認証変数は08のVaultへ接続）
2. GraphQL の introspection 不可環境でのSDL単独運用
3. バイナリ要求（ファイル添付）の代表値生成の方針（アップロード禁止との両立）
4. OpenAPI定義自体の検証（无効な定義・巨大定義の上限）
