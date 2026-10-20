# 13 WebSocket・HTTP/2・高度な通信 概要設計

対応要件: 仕様書 F14（WebSocket）・F15（HTTP/2 と高度な通信）・3.1 F14行

## 1. 目的

WebSocket 通信の記録・編集・自動再送・検索・診断と、HTTP/2 を含むプロトコル選択・
Host/接続先/SNI 等の扱い・正規化を伴わない編集経路を提供する。A3。

## 2. 前提（ZAP 2.17.0）

- ZAP WebSocket API は message 一覧と方向・channelを指定する text message 送信を提供する。
  初期公開能力はこの文書の7節に固定し、版固定した実機fixtureに合格したruntimeだけで有効化する。
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
    Node `http2` adapterは有効なHTTP/2 messageの意味的編集に使う。header順、大文字小文字、
    不正pseudo-header、connection reuseなどwire忠実性を要求する操作は専用経路を追加するまで未対応とする
```

- 対応するだけで完全互換とは扱わない。HTTP/3 は初期範囲外として能力表へ`Unsupported`を明記する。

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

## 7. 確定事項

1. ZAP経路の初期公開能力はchannel/messageのpaged記録と、channel ID・方向を指定した**text message送信**
   に限定する。binaryは記録・表示だけとし、binary送信、停止中frame編集、個別channel close/openは
   `Unsupported`とする。停止はjobまたはZAP process単位で行う。能力を追加する場合はruntime bundleごとに
   direction、channel選択、message byte一致、停止overshootのfixtureを要求する。
2. transport能力を次のように固定する。

   | 経路 | 保証する編集 | 保証しない編集 |
   |---|---|---|
   | ZAP | 通常のHTTP/1.xとZAPが正規化したHTTP/2 | header順/case、無効header、connect先とSNIの独立指定 |
   | Node `http`/`https` | URL、method、header、body、connect先/SNIの検査 | wire上のheader順/caseの完全保持 |
   | Node `http2` | `:method`/`:scheme`/`:authority`/`:path`、通常header、body、TLS servername | 無効pseudo-header、HPACK表現、frame分割、wire順序 |

   Host/`:authority`、TCP connect先、TLS SNIは計画モデルで分離し、adapterが独立指定できない組合せを拒否する。
   request smuggling等のwire忠実性が必要な機能は、専用transportとfixtureが追加されるまで公開しない。
3. 各handshakeを独立`connectionId`とし、同じplan、role、origin、subprotocolによる再接続は
   `logicalSessionId`で関連付ける。ping/pongはbyte/time budgetへ数えるが診断message数から分離する。
   切断後にapplication messageを自動再送せず、未送信queueは`ConnectionLost`で停止する。再開は新しい
   子計画とconnectionを作り、利用者または冪等性を宣言したruleだけが再送できる。

根拠: [ZAP WebSocket API](https://www.zaproxy.org/docs/desktop/addons/websockets/api/) はmessage pagingと
channel・方向を指定したtext送信を公開する。binary送信等は文書から推測して有効化しない。

## 8. 現行 WebSocket 実経路

- `NodeWebSocketTransport` はCoreでscope確認済みのHTTP(S) URLをadapter内だけで
  WS(S)へ写像し、Node組込みclientで新規connectionを開いてtext messageを送受信する。
  送信は既定10 message/s、送受信textは1 message 1 MiB上限である。
- binary受信はtextへ暗黙変換せず取り込まない。binary送信、fragmentation、extension、
  ping/pong証跡、既存ZAP channelの再利用、role cookie/subprotocol、切断後再送は未対応。
  現行経路をZAP message paging/resendの完全実装とは表示しない。

## 9. 現行 HTTP/2 実プローブ経路

- `NodeHttp2Transport` はscope確認済みURLへbounded `GET`を送り、平文h2cまたはTLS ALPNの
  実測結果とNode runtimeを返す。HTTP/2 response headerを受信するまで成功扱いにしない。
- HTTP/1.1 fallbackは明示許可時だけ別requestを送る。redirect非追従、response 1 MiB、timeout 30秒である。
- これはtransport capabilityの確認経路であり、任意のpseudo-header/body、stream metadata、settings/timing、
  connect先・authority・SNIの独立編集、connection reuse、wire表現は未対応である。
