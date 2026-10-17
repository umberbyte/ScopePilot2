# 02 案件・スコープ・認可モデル 概要設計

対応要件: 仕様書 F01・6.1（計画と通信の制御）・10.1（受入基準の認可系）

## 1. 目的

現行の案件モデル（許可Origin・禁止操作・上限・ロール）を、**認可（Authorization）の記録と
ライフサイクル**を中心に拡張する。認可の記録が既定で能動診断を含む自動実行を許可する
（仕様書6.1）ため、認可の正確さが全系の安全の要になる。

## 2. 再利用する現行資産

- `Domain/Models.cs`（EngagementProject: AllowedOrigins / ForbiddenActions / MaxPages /
  MaxMinutes / MaxRequests / Roles / ActiveRole / Guidelines）
- `Services/ApiRequestFormatter.EnsureAllowed`（許可Origin検査）
- `Services/ProjectStore` / `ProjectPaths`（案件の保存・証跡パス管理）
- `zap-active-authorization.json` の出力構造（ZapCliRunner）→ 全汎用の承認証跡へ一般化

## 3. コンポーネント構成

```text
Domain:
  AuthorizationRecord {
    Id, 案件Id, 認可者, 認可日時, 有効期限(任意), 対象Origin一覧, 許可操作区分
    (Passive/Active/Fuzzer/Browse/FormSubmit/Upload...), 状態(Active/Expired/Revoked),
    失効日時・失効理由, 添付参照(診断依頼書等の証跡), SHA-256 }
Services:
  AuthorizationService: 記録の作成・検証・失効・一覧。実行計画への付与
  PlanBuilder: 認可+スコープ+上限から実行計画(Orchestrator用)を生成。範囲外は計画時点で除外
```

- 許可操作区分は案件の「禁止操作」リストの逆写像ではなく、**肯定的な許可集合**として持つ
  （例: ActiveScan=F05含む、FormSubmit=有、Upload=無）。未 listed の区分は既定拒否。
- 有効期限・失効を必ず扱う。期限切れ・失効済み認可での実行は計画生成と実行の両方で拒否する
  （10.1受入基準）。期限未設定の常設認可は作成時に明示警告する。
- GET による削除などメソッドだけで読み取りと決めない（仕様書6.1）。操作区分は
  「実行するジョブ種別」単位で計画に載せ、URL・メソッド・本文の禁止語彙検査と二重にかける。

## 4. データモデル

- 案件ファイル内 `authorizations[]`（JSON）に永続化。実行ごとに計画へ認可Idとhashを写す。
- 承認証跡 `runs/<id>/authorization-<時刻>.json`: 認可の写し＋計画hash＋実行ジョブ一覧。
  現行の `zap-active-authorization.json` をこの形式へ発展させる。

## 5. 安全制御と証跡

- スコープ検査は scheme/host/port/パス/操作/接続先（リダイレクト先・DNS解決結果・IPv6・
  別ホストへの認証情報転送）まで拡張する。現行EnsureAllowedはOrigin一致のみなので
  `ScopeRule` として拡張点を独立させる（F15のHost/SNI検討と接続）。
- 認証用外部IdPは「認証専用ポリシー」として診断対象Originとは別管理。

## 6. UI / CLI

- 案件画面に認可パネル（一覧・新規・失効・有効期限・添付）。実行開始時に使う認可を表示。
- CLI: `scopepilot auth list|revoke|create`（19参照）。

## 7. 未解決事項（A0）

1. 許可操作区分の初期辞書（ジョブ種別との対応表）
2. 禁止語彙検査の精度と「保証しない」表示の文言
3. 認可添付（診断依頼書）の証跡取り扱い（原本は案件外に置くか）
