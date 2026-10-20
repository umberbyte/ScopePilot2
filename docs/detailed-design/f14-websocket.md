# F14 WebSocket

## 1. 対象

WebSocket connection/message の観測、履歴、手動 resend、ZAP 能力範囲の scan を扱う。上位は `design/13`, `22`。

## 2. UI/CLI

- Simple: 観測結果と limitation の表示のみ。
- Advanced: A04/A08 で connection、direction、text message、resend を操作。
- CLI: history export と承認済み text resend。binary active operation は初期 `Unsupported`。

## 3. モジュール

`WebSocketConversation`, `WsMessageImporter`, `WsSendPlan`, `WsTextEditor`, `ZapWebSocketAdapter`, `WsEvidenceProjector`。connection ID、direction、opcode、timestamp、payload hash を標準化する。

## 4. 処理

observed message は append-only。resend は元 message から新 plan を作り、connection/URL/scope/role/session revision を固定する。初期公開は text frame のみで、fragmentation、extension、binary 攻撃は capability unavailable とする。

## 5. 安全・証跡

送信は `WebSocketSend` 認可、confirmation、message byte 上限、rate limit を要求する。ZAP 由来通信は delegated と表示する。原本 frame と UI text representation を区別する。

## 6. 失敗

切断済み connection、session revision 変更、binary/invalid UTF-8 を自動変換せず拒否する。late response は attempt に関連付けつつ完了状態を巻き戻さない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F14-UT-001 | `core/test/unit/websocket/message-importer.test.ts` | 同 frame 再取込 | dedupe |
| F14-UT-002 | `ws-send-plan.test.ts` | text message | hash 付き plan |
| F14-UT-003 | 同上 | binary message | `Unsupported` |
| F14-UT-004 | 同上 | session revision 変更 | confirmation 無効 |
| F14-UT-005 | `ws-text-editor.test.ts` | invalid UTF-8 | 暗黙置換せず error |
| F14-UT-006 | `ws-send-policy.test.ts` | rate/size 超過 | adapter 未呼出し |
| F14-UT-007 | `ws-evidence.test.ts` | 表示生成 | raw hash と text を区別 |

## 8. 非単体テスト

ZAP WebSocket API CT、echo fixture で send/receive/stop IT、proxy 観測から resend までを FT で検証する。

### 現行 adapter

`NodeWebSocketTransport` はscope確認済みのHTTP(S) URLをWS(S)へ写像し、新規connectionで
text messageを逐次送信する。既定10 message/s、text 1 MiB上限、接続timeout、短い受信待機を
持ち、受信textをCoreのframe台帳へ返す。常時ITは所有raw WebSocket echo serverでhandshake、
mask解除、送信間隔、echo受信を検証する。

任意role指定時はrunLogin成功済みsessionを要求し、Coreがhandshake URLのdomain/pathへ
適用可能なcookieだけを選ぶ。transportはupgrade requestへCookie headerを付けるが、値を
結果・frame台帳・監査へ返さない。結果には適用cookie名だけを残す。

任意subprotocolは最大16個・各128文字以下のRFC tokenとしてCoreで検証し、提示順をplan hashへ
含める。Node clientはupgrade requestで提示し、serverが選んだsubprotocolを実測結果へ返す。

binary、fragmentation、extension、ping/pong証跡、ZAP channel paging/reuse、
長寿命connection管理は後続増分である。
