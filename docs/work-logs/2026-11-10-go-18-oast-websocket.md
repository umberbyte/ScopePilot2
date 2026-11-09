# 2026-11-10 GO-18 OAST / WebSocket

## 対象

- design/40 P4 の A33 WebSocket と A34 OAST を独立画面として追加する。
- WebSocket の connection/frame 履歴と、self-host Interactsh callback 一覧を表示する。
- 実 transport、許可済みラボ fixture、未構成を Core 応答と画面で明示する。
- GO-13 の scan policy / active scan、および GO-17 の Decoder / Comparer / Sequencer 実装は変更しない。

## 実装

- OAST/WebSocket port に `adapterKind: real | fixture | unavailable` を追加し、Interactsh、Node WebSocket、未構成 OAST composition が自己申告するようにした。
- OAST callback を event ID、attempt 相関、protocol、発信元、受信時刻、raw hash、transport とともに一覧化した。token と raw provider payload は一覧・監査へ返さない。
- WebSocket 送信ごとに `connectionId` と `logicalSessionId` を作成し、接続状態、送受信 frame 数、選択 subprotocol、transport を保持する。frame 履歴には connection、対象 URL、時刻、方向、text 表現、raw hash、transport を含めた。
- `GET /api/oast/attempts` と `GET /api/websocket/frames` の OpenAPI 応答を拡張した。既存 route は維持した。
- Advanced nav に `adv.manual.websocket` (A33) と `adv.manual.oast` (A34) を追加した。
- A33 は text message の手動送信、接続一覧、接続別 frame 履歴を表示する。A34 は payload 発行・コピー、待機 session、5 秒更新の Interactsh callback 一覧を表示する。手動 callback 取込は新画面へ露出しない。
- fixture は画面上で「対象への実通信結果ではない」「許可済みラボ専用」と明示し、未構成 OAST は実行ボタンを無効化する。

## テスト

- `npm run typecheck`: pass
- `npm run build --workspace @scopepilot2/desktop`: pass
- `npm run test --workspace @scopepilot2/core`: pass
- `npm run test --workspace @scopepilot2/adapters`: pass (74 pass / 1 gated skip)
- `npm run test --workspace @scopepilot2/contracts`: pass (8 pass)
- `npm run test --workspace @scopepilot2/ui`: pass (14 pass)
- `npm run test --workspace @scopepilot2/desktop`: pass (43 pass)
- `npm run test:integration --workspace @scopepilot2/core`: GO-18 の WebSocket/OAST ケースは pass。全体では非対象の既存シナリオ 3 件 (`documents/hints`, `business-logic check`, `findings/status`) が失敗したため command 全体は fail。
- `git diff --check`: pass

Electron app test は production engine composition の起動待ちで window 作成前に timeout したため、GO-18 専用 spec は採用しなかった。renderer bundle と画面の型整合は desktop build/typecheck、route/権限は UI unit で確認した。
