# 03 プロキシ・インターセプト・サイトマップ・ロガー 概要設計

対応要件: 仕様書 F02（Proxy と Intercept）・F03（Target と Logger）

## 1. 目的

Burp の Proxy/Intercept/Target/Logger 相当の中継と横断表示を、ZAP を中継エンジンとして
統合UIで提供する。現行の「探索用ZAPプロキシ（Safe・記録）」と「診断実行（standard）」の
二分化はそのまま活かし、手動診断向けの常設プロキシセッションを新設する。

## 2. 再利用する現行資産

- `Services/ManagedZapProxy` / `ExplorationProxyService` / `ExplorationProxySession`:
  ZAPデーモン起動（127.0.0.1限定・APIキー都度生成・案件専用ホーム）と Safe化（起動後 setMode）
- `Services/ZapProxyApi`: `core/view/messages`・HAR取得・`numberOfMessages` 等の取得系API
- 観測モデル（ObservedRequest）と代表パターン化（`UrlPatternNormalizer` / `CandidateSelector`）

## 3. コンポーネント構成

```text
ProxySession（新規・Services）:
  用途別セッション: Explore(既存・Safe) / Manual(新規・standard・手動診断用) / Resend(04)
  同一の起動引数管理・APIキー生成・ライフサイクル（UIで明示的に開閉）
InterceptController（新規）:
  ZAPのブレークポイント API（core/action/breakpoint 系）を叩いて要求/応答の停止・編集・破棄
  ※ ZAP APIのブレーク機能は対話UI前提の面があるため、A0で「APIから停止・編集・再開が可能か」を検証。
     不可な場合は Intercept は「外部UIで対応」と能力表へ明示（仕様書4.1の規定どおり）
HttpMessageStore（20参照）: 中継した通信の保存・検索（status/url/method/ロール/元ツール）
SiteMapView（ViewModel）: サイトツリー＋API一覧＋パラメータ一覧。ZAPの core/view/sitesTree 相当
```

- 手動プロキシ（Manual）は standard モードで起動し、F04/F05 と同じ承認境界に置く。
  認可（02）が無いと開けない。通信はすべて案件の通信上限へカウントする。
- 置換（Replacer）: 既存のと同等（診断設定のCookie注入）。インターセプトでの編集とは別機能として維持。

## 4. データモデル

- `HttpExchange`（20の保存モデル）: 元ツール（Explore/Manual/Resend/Fuzzer/Scan/API生成）、
  ロール、日時、要求・応答原文、加工有無、関連ジョブId。
- サイトマップは `HttpExchange` からの集計ビュー（実態は保存層に置き、ツリー状態をZAPに依存しない）。

## 5. 安全制御と証跡

- プロキシ経由の全通信を許可Origin検査で通す。範囲外は既定で破棄し、ログに残す（検査の保証でない
  旨は表示）。上限は案件共有カウンタで管理（22）。
- 証明書: `ManagedZapProxy` の案件専用ホームのZAPルートCAをそのまま使い、6.4の管理手順に接続。

## 6. UI / CLI

- 「ブラウザと通信」画面: 履歴グリッド（ページング・仮想化・本文遅延読込、6.5）＋
  サイトツリー＋フィルタ（ロール・元ツール・ステータス）。
- CLI: 通信のJSONL/ndjson出力（19）。インターセプトはGUI限定。

## 7. 未解決事項（A0）

1. ZAPブレークポイント系APIの網羅性（停止中メッセージの読み書き・再開・破棄）
2. 手動プロキシと診断実行のZAPプロセスを共用するか別立てか（共用ならモード切替の排他）
3. 大量通信時の `core/view/messages` 取得方式（差分取得・HAR一括の選択）
