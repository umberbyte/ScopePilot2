# 03 プロキシ・インターセプト・サイトマップ・ロガー 概要設計

対応要件: 仕様書 F02（Proxy と Intercept）・F03（Target と Logger）

## 1. 目的

Burp の Proxy/Intercept/Target/Logger 相当の中継と横断表示を、ZAP を中継エンジンとして
統合UIで提供する。「探索用ZAPプロキシ（Safe・記録）」と「診断実行（standard）」を
用途別セッションとして分離し、手動診断向けのプロキシセッションを設ける。

## 2. 旧版から継承する知見

- ZAP API は loopback 限定、API key は起動ごとに生成し、案件専用 home を使う。
- 起動後の mode を検証し、Explore は Safe、送信系は standard に分ける。
- ZAP履歴、HAR、message count を相関し、通信を代表URLパターンへ正規化する。

## 3. コンポーネント構成

```text
ProxySession（ZapAdapter）:
  用途別セッション: Explore(Safe) / Manual(standard・手動診断用) / Resend(04)
  同一の起動引数管理・APIキー生成・ライフサイクル（UIで明示的に開閉）
InterceptController（新規）:
  ZAP Break API の停止中message取得・編集・step/continue/drop操作を型付きadapterで扱う
  ※ A0で要求/応答それぞれの停止、編集、破棄、timeout、同時到着を版固定した実機で検証する。
     必要操作を満たさない場合は不足を能力表へ明示し、その操作をUIに公開しない。
     Intercept は ZAP 提供機能であり ZAP 更新で挙動が変わりうる（Delegated、22§3）。
     安全制御（範囲・上限）の土台にはせず、能力表に版依存である旨を明示する
HttpMessageStore（20参照）: 中継した通信の保存・検索（status/url/method/ロール/元ツール）
SiteMapQuery: サイトツリー＋API一覧＋パラメータ一覧。保存済み通信を正本とする
```

- 手動プロキシ（Manual）は standard モードで起動し、F04/F05 と同じ承認境界に置く。
  認可（02）が無いと開けない。通信はすべて案件の通信上限へカウントする。
- 置換（Replacer）: 認証Cookie等の計画済み注入に限定し、インターセプトでの編集とは別機能にする。

## 4. データモデル

- `Exchange`（20の保存モデル）: 元ツール（Explore/Manual/Resend/Fuzzer/Scan/API生成）、
  ロール、日時、要求・応答原文、加工有無、関連ジョブId。
- サイトマップは `Exchange` からの集計ビュー（実態は保存層に置き、ツリー状態をZAPに依存しない）。

## 5. 安全制御と証跡

- 手動プロキシは ZAP が中継する（Delegated）。範囲は ZAP の scope 設定で与え、保存時に許可Origin で
  分類する。範囲外通信は記録するが、ZAP が中継すること自体は送信前に拒否できない（保証でない旨を表示）。
  Enforced な遮断が要る経路は ScopePilot の管理 proxy を使う。上限は案件共有カウンタで管理（22）。
- 証明書: 案件・用途別 profile の ZAP ルートCAを [24](24-certificate-secrets.md) の手順で管理する。

## 6. UI / CLI

- 「ブラウザと通信」画面: 履歴グリッド（ページング・仮想化・本文遅延読込、6.5）＋
  サイトツリー＋フィルタ（ロール・元ツール・ステータス）。
- CLI: 通信のJSONL/ndjson出力（19）。インターセプトはGUI限定。

## 7. 未解決事項（A0）

1. ZAP Break API の要求/応答別操作、同時到着、timeout時の挙動
2. 手動プロキシと診断実行のZAPプロセスを共用するか別立てか（共用ならモード切替の排他）
3. 大量通信時の `core/view/messages` 取得方式（差分取得・HAR一括の選択）
