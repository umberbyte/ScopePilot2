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

## 3. 旧版から継承する知見

- ZAP `sendRequest` は standard モード専用の再送セッションから呼ぶ。
- HAR と保存済み通信から編集可能な要求表現を作り、送信前に scope を再検査する。
- Safe モード拒否、API endpoint、ZAP履歴への記録を起動時 probe で確認する。

## 4. コンポーネント構成

```text
ResendSession: 案件 runs/resend-<時刻>/zap-home。UIで明示開閉。開く時に認可（02）を要求
ResendService:
  SendAsync(project, rawRequest, followRedirects, themeNo, token)
    1) EgressPolicy  2) 禁止語彙警告（保証しない旨を表示）  3) 案件予算lease取得
    4) sendRequest  5) 元要求（必要時再送）との差分生成  6) 証跡追記・観測取込
DiffRenderer: ステータス行・ヘッダ・本文・RTT の差分表示（06のComparerと共通部品を使う）
```

## 5. データモデル

- 証跡 `runs/resend-<時刻>-<id>/`: `raw-request.txt` / `response.txt` / `diff.txt` /
  `engagement.json`（送信者・日時・テーマNo・followRedirects・認可Id）
- 取込: `DiagnosticObservation`（RuleId=`manual-resend`、State=実影響未確認、Evidence=再送ラン参照）

## 6. 安全制御と証跡

- 送信は1件ずつ・利用者の操作による（ボタン）。一括送信は本機能の範囲外（05が担う）。
- 編集欄の Cookie 等は既定マスク表示とする。マスク文字列を送信値として扱わず、変更されていない
  secret token は SecretStore または暗号化原本から送信直前に復元する。送受信原本は暗号化保存し、
  表示・共有用派生物で `Cookie` / `Set-Cookie` / `Authorization` 等をマスクする（20・24）。
- [15](15-authorization-business-logic.md)のreview済み診断templateを選ぶと手順・「注意（安全制御・事前合意）」を表示し、
  記録にテーマNo.を残す。

## 7. UI

- 診断タブ内「再送ワークベンチ」: 元要求選択（観測/候補代表/selected.har）→ 生要求編集 →
  送信 → 差分 → 記録。タブは案件ごとに最大20個とし、未保存編集があるタブを閉じる際は確認する。

## 8. 確定事項

1. `sendRequest` の返却値を製品内の安定schemaとみなさない。adapterは固定版fixtureで返却HAR、ZAP履歴、
   `network` addon有無を比較し、**実際に送信した要求と最終応答をZAP履歴からmessage IDで回収**して
   `Exchange` へ正規化する。API返却は即時表示用、履歴回収結果は証拠の正本とする。両者が一致しない、
   または完全なrequest/responseを回収できないbundleでは再送能力を無効化する。
2. 生要求エディタの正準形式はHTTP/1.1 bytes（CRLF、request-target、header順、body）とする。
   HAR由来のHTTP/1.xはlossless byte列があればそれを使い、なければ再構成したことを表示する。
   HTTP/2はHTTP/1.1文字列へ可逆変換せず、[13](13-websocket-http2.md) の構造化editor
   （pseudo-header、通常header、body、接続情報）で扱う。
3. ZAP `sendRequest` は `followRedirects=false` を固定する。redirect追跡は管理HTTP clientが1 hopずつ
   `EgressPolicy` を通して実行し、各hopを1通信として共有予算から減算する。既定最大5 hop、loop検出、
   別originへのcredential除去を必須とする。ZAPにredirect追跡を委譲するモードは公開しない。

根拠: [ZAP API Reference](https://www.zaproxy.org/docs/api/) は `sendRequest` がmodeを適用し、要求、応答、
redirect結果を返すことを記載する。返却形式と履歴相関はbundleごとの実測を優先する。
