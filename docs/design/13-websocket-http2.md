# 13 WebSocket・HTTP/2・高度な通信 概要設計

対応要件: 仕様書 F14（WebSocket）・F15（HTTP/2 と高度な通信）・3.1 F14行

## 1. 目的

WebSocket 通信の記録・編集・自動再送・検索・診断と、HTTP/2 を含むプロトコル選択・
Host/接続先/SNI 等の扱い・正規化を伴わない編集経路を提供する。A3。

## 2. 前提（ZAP 2.17.0）

- ZAP WebSocket API は message 一覧と text message 送信を提供する。binary、編集、停止、方向指定、
  connection選択を含む必要操作を版固定した実機で検証し、能力表へ記録する。
- 記録ブラウザーで WebSocket を許可し、対象Origin、connection数、message数、byte数、時間上限を適用する。

## 3. コンポーネント構成

```text
WebSocketSupport:
  記録: 手動プロキシ（03）経由で WS フレームを Exchange と同じ保存モデルへ（種別=WS）
  再送: 検証済みの ZAP API 操作を再送ワークベンチ（04）へ統合。未対応操作は能力表へ明示
  診断: WS メッセージへのペイロード再送（05と同じジョブ体系でトランスポートだけ拡張）
Http2Support:
  プロトコル選択: requestor/実行系の httpVersion 指定（HTTP/1.1/HTTP/2）を計画・再送で指定可能に
  Host/SNI/接続先: 生要求、authority、実接続先、TLS SNI を別フィールドで計画する。
    ZAP sendRequest や Node の通常HTTP APIがこれらを独立制御できるとは仮定しない。
    header順、大文字小文字、重複header、pseudo-header、connection reuseを保持できる専用経路を
    A0で比較し、保持できない操作は能力表で未対応とする
```

- 対応するだけで完全互換とは扱わない。HTTP/3 は必要な業務シナリオが確定した時点で互換性表へ追加。

## 4. データモデル

- `Exchange` は protocol（HTTP/1.1、HTTP/2、WS）、connection、stream、frame/messageを区別する。
  HTTP/2 を HTTP/1.1 の start-line/header text に可逆変換できるとは扱わない。wire情報が取得できない
  部分は `Unavailable` とし、推測で補わない。

## 5. 安全制御と証跡

- WS の自動再送・診断も認可の許可操作区分（`WebSocketSend`）と案件上限の内側。
- WS の接続先（wss://）は許可Origin検査の対象。upgrade要求の確認も同じ検査でカバー。
- 帯域・フレーム数の上限（DoSにならない）を WS 診断の速度制御に含める。

## 6. UI / CLI

- 通信一覧に WS ペイン（フレーム列・方向・時刻）。フレームの再送・Fuzzer送出は要求ペインと
  同じ操作体系。

## 7. 未解決事項（A0/A3）

1. ZAP WebSocket API の binary/方向/connection/停止操作の対応範囲
2. ZAP、Node、専用transportの正規化と Host/connect/SNI 分離能力の実測
3. WS の KeepAlive/再接続時のセッション扱い
