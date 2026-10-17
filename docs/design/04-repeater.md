# 04 再送ワークベンチ（Repeater相当） 概要設計

対応要件: 仕様書 F04・3.1（手動編集・再送として残す）・出典: docs/ZAP-RESEND-WORKBENCH-PROPOSAL.md

## 1. 目的

観測済み・採用済み・記録済みの任意の要求を生リクエスト（手動リクエストエディタと同じ書式）で
書き換え、ZAP `core/action/sendRequest` で送信し、元応答との差分比較と証跡記録を行う。
自動診断の所見を人が検証する用途（仕様書3.1 F04行）。

## 2. 検証済み前提（ZAP 2.17.0実機）

- `sendRequest` は手動リクエストエディタの送信と同一機能。RTT・応答全文を返す。
- 送受信は ZAP 履歴に記録される（numberOfMessages が増加）。
- **Safe モードでは `mode_violation` で拒否**。standard モードが必要。
- `-config api.port` は別ポートを開かない。API URL は実行時に既定リスナーで確認する。

## 3. 再利用する現行資産

- `Services/ZapProxyApi`（API呼出の土台）→ `SendRequestAsync` を追加
- `Services/ManagedZapProxy`（セッション起動引数）→ standard モードの「再送セッション」
- `Services/ApiRequestFormatter`（許可Origin検査）
- HARエントリ→生リクエスト文字列化（`ApiRequestFormatter.Format` の逆変換）

## 4. コンポーネント構成

```text
ResendSession: 案件 runs/resend-<時刻>/zap-home。UIで明示開閉。開く時に認可（02）を要求
ZapResendService:
  SendAsync(project, rawRequest, followRedirects, themeNo, token)
    1) EnsureAllowed  2) 禁止語彙警告（保証しない旨を表示）  3) 案件の通信上限カウント
    4) sendRequest  5) 元要求（必要時再送）との差分生成  6) 証跡追記・観測取込
DiffRenderer: ステータス行・ヘッダ・本文・RTT の差分表示（06のComparerと共通部品を使う）
```

## 5. データモデル

- 証跡 `runs/resend-<時刻>-<id>/`: `raw-request.txt` / `response.txt` / `diff.txt` /
  `engagement.json`（送信者・日時・テーマNo・followRedirects・認可Id）
- 取込: `DiagnosticObservation`（RuleId=`manual-resend`、State=実影響未確認、Evidence=再送ラン参照）

## 6. 安全制御と証跡

- 送信は1件ずつ・利用者の操作による（ボタン）。一括送信は本機能の範囲外（05が担う）。
- 編集欄の Cookie 等の秘密値は既定マスク表示。保存時に `Cookie` / `Set-Cookie` / `Authorization` 等をマスク。
- テーマ（元資料ZAP非対応33テーマ）を選ぶと手順・「注意（安全制御・事前合意）」を表示し、
  記録にテーマNo.を残す。

## 7. UI

- 診断タブ内「再送ワークベンチ」: 元要求選択（観測/候補代表/selected.har）→ 生要求編集 →
  送信 → 差分 → 記録。タブ複数（BurpのRepeaterタブ相当）は A2 後半で検討。

## 8. 未解決事項（A0）

1. `sendRequest` 応答JSONの完全スキーマ（生レスポンス全体の取得方法。`network` コンポーネントの
   有無比較）
2. HAR→生要求文字列化の書式確定（HTTP/2由来エントリの扱いは13と接続）
3. followRedirects 有効時の後続通信の上限カウント方法
