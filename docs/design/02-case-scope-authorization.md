# 02 案件・スコープ・認可モデル 概要設計

対応要件: 仕様書 F01・6.1（計画と通信の制御）・10.1（受入基準の認可系）

## 1. 目的

案件モデル（許可Origin・禁止操作・上限・ロール）を、**認可（Authorization）の記録と
ライフサイクル**を中心に拡張する。認可の記録が既定で能動診断を含む自動実行を許可する
（仕様書6.1）ため、認可の正確さが全系の安全の要になる。

## 2. 旧版から継承する知見

- 許可Origin、禁止操作、ページ・時間・通信数上限、ロール、ガイドライン選択（`GuidelineSelection`、[27](27-security-guidelines.md)）を案件単位で持つ。
- 許可Originの検査を計画時と実行直前の両方で行う。
- ZAP用だった承認証跡を全エンジン共通の認可スナップショットへ一般化する。

## 3. コンポーネント構成

```text
Domain:
  OperatorProfile {
    Id, 表示名, Permission集合, 既定UiMode, 状態, 作成・更新日時
  }
  AuthorizationRecord {
    Id, 案件Id, 認可者, 認可日時, 有効期限(任意), 対象Origin一覧, 許可操作区分(OperationClass集合),
    状態(Active/Expired/Revoked), 失効日時・失効理由, 添付参照(診断依頼書等の証跡), SHA-256 }
Services:
  AuthorizationService: 記録の作成・検証・失効・一覧。実行計画への付与
  PlanService([01]): 認可+スコープ+上限から ExecutionPlan を生成・正規化・hash 化する
    （本書では認可とスコープの入力を定義し、生成の正本は [01](01-architecture.md)・[22](22-execution-control.md)）。
    範囲外入力はvalidation errorとし、除外して続行する場合は除外対象と理由を計画へ明記
```

- **OperationClass（許可操作区分）の正本は本書**とし、他文書はここを参照する。初期集合は次とする:
  `Passive`（受動解析）・`Browse`（探索巡回）・`FormSubmit`・`Upload`・`ActiveCrawl`（Spider 等の能動クロール）・
  `ActiveScan`（ZAP 能動診断）・`Fuzz`（反復送信）・`ApiSend`（定義由来 API 送信）・`WebSocketSend`・
  `NucleiScan`・`CrossRoleTest`（他ロール/他者 ID 切替）。OAST の受信相関は専用区分を持たず、発端ジョブの区分の内側で扱う。
- 許可操作区分は案件の「禁止操作」リストの逆写像ではなく、**肯定的な許可集合**として持つ
  （例: ActiveScan=有、Fuzz=有、FormSubmit=有、Upload=無）。未 listed の区分は既定拒否。
- 有効期限・失効を必ず扱う。期限切れ・失効済み認可での実行は計画生成と実行の両方で拒否する
  （10.1受入基準）。期限未設定の常設認可は作成時に明示警告する。
- GET による削除などメソッドだけで読み取りと決めない（仕様書6.1）。操作区分は
  「実行するジョブ種別」単位で計画に載せ、URL・メソッド・本文の禁止語彙検査と二重にかける。
- 対象アプリ上の権限は`TargetRole`、ScopePilot利用者の権限は`OperatorPermission`として分離する。
  `UiMode=Advanced`へ切り替えてもPermissionを増やさず、権限外commandはcoreで拒否する。

## 4. データモデル

- SQLite の `authorizations` と不変の証拠オブジェクトに永続化する。実行ごとに計画へ認可Idとhashを写す。
- 承認証跡 `runs/<id>/authorization-<時刻>.json`: 認可の写し＋計画hash＋実行ジョブ一覧。
  特定エンジンの形式を正本にしない。

## 5. 安全制御と証跡

- スコープ検査は scheme/host/port/パス/操作/接続先（リダイレクト先・DNS解決結果・IPv6・
  別ホストへの認証情報転送）まで扱う。`ScopeRule` は [22](22-execution-control.md) の
  `EgressPolicy` が送信時に強制する（F15のHost/SNI能力表と接続）。
- 認証用外部IdPは「認証専用ポリシー」として診断対象Originとは別管理。

## 6. UI / CLI

- 案件画面に認可パネル（一覧・新規・失効・有効期限・添付）。実行開始時に使う認可を表示。
- 画面上は操作者と対象roleを別ラベルで常時表示し、監査eventに両方を記録する。
- CLI: `scopepilot auth list|revoke|create`（19参照）。

## 7. 確定事項

### 7.1 OperationClass とジョブの対応

| OperationClass | 許可するジョブ | 追加条件 |
|---|---|---|
| `Passive` | HAR取込、保存済み通信の受動解析 | 対象への追加通信ゼロ |
| `Browse` | GET/HEAD巡回、SPA遷移 | 状態変更フォームを含まない |
| `FormSubmit` | 検索、ログイン、更新フォーム送信 | [07](07-exploration-browser.md) の分類と送信戦略に従う |
| `Upload` | multipart/file送信 | `FormSubmit` も必要。明示fixture以外を送らない |
| `ActiveCrawl` | ZAP Spider等 | Delegated能力表と対象URL上限が必要 |
| `ActiveScan` | ZAP能動診断 | Delegated能力表と固定rule setが必要 |
| `Fuzz` | Fuzzer、Sequencer採取 | 組合せ数と速度を計画へ固定 |
| `ApiSend` | 定義から生成したAPI要求 | 破壊的operationは個別allowlistも必要 |
| `WebSocketSend` | WS text再送・fuzz | connection/message/byte予算が必要 |
| `NucleiScan` | 審査済みHTTP template実行 | [16](16-known-vulns-nuclei.md) の静的検査に合格した集合のみ |
| `CrossRoleTest` | role/owner切替、業務ロジック差分 | 状態復元可能または使い捨て環境であること |

複数区分に該当するジョブはすべてを要求する。たとえばファイル添付APIは `ApiSend`、
`FormSubmit`、`Upload` のすべてを必要とする。分類不能なジョブは未listedとして拒否する。

### 7.2 禁止語彙検査

語彙検査は method、NFKC正規化したURL path/query key、form field名、JSON key、operationId、
button labelを対象にし、辞書項目ごとに `Block` または `Review` を持つ。二重URL decodeや本文全体の
意味推定は行わない。`Block` は個別allowlistがない限り計画から除外し、`Review` は根拠を計画へ残す。
画面と報告では次の固定文言を使う。

> 禁止操作の語彙検査は補助的な判定であり、安全性や非破壊性を保証しません。許可操作区分、
> scope、上限、実行経路の制御を優先し、分類できない操作は送信しません。

fixtureは既知の同義語、Unicode表記、誤検出、未知語を含める。検出率を安全保証として表示しない。

### 7.3 認可添付

添付は取得時のbyte列を暗号化証拠へコピーし、SHA-256、媒体名、取得日時、外部参照元URIを記録する。
外部ファイルへのpathだけを認可根拠にせず、外部原本を変更・削除しない。共有exportには添付を既定で
含めず、明示選択時もマスク済み派生物と出典情報だけを含める。

### 7.4 操作者権限

初期Permissionは`CaseAdmin`、`ScopeEdit`、`AuthorizationManage`、`GuidelineSelect`、`CrawlConfigure`、
`CandidateSelect`、`PlanEdit`、`TemplateUse`、`TemplateEdit`、`Execute`、`EvidenceReveal`、`Export`とする。
Simple modeは`GuidelineSelect`、`CandidateSelect`、`Execute`の許可された操作だけをUIに露出する。
Advanced modeは保持するPermissionの範囲で設定・テンプレート・計画編集を露出する。認可の操作区分と
OperatorPermissionの両方が揃わなければcommandを拒否し、mode切替を権限昇格として扱わない。
