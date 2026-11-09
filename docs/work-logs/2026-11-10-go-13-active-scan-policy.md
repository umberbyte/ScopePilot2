# 2026-11-10 GO-13 Active Scan / Scan Policy

## 対象

- `docs/design/40-advanced-mode-redesign.md` §2–3、A40、A43、P2/P5 を実装した。
- owner decision Q6 に従い、ZAP 個別 rule/plugin ID 単位の強度・閾値は契約・Core・UIへ導入していない。
- OAST / WebSocket (GO-18)、Decoder / Comparer / Sequencer (GO-17) は変更していない。

## 実装

- 案件単位の名前付き scan policy 契約を追加した。ポリシーは経路単位の有効化、ZAP 全体の strength / threshold、汎用 HTTP 9 観点、審査済み Nuclei template 条件だけを持つ。
- policy revision と安定 content hash を追加した。保存時は revision guard を検証し、内容変更時だけ active confirmation を失効する。plan に policy hash を含め、表示後または確認後にポリシーが変わった旧 plan は実行できない。
- A40 用に候補・ポリシー API、経路選択、role / guideline / limit、plan 作成・確認・非同期実行・停止・経路進捗を接続した。利用不能な ZAP / Nuclei 経路は UI で無効化する。
- A43 用にポリシー一覧・新規作成・revision 付き保存、ZAP 全体設定、汎用 HTTP 観点、Nuclei template 条件を編集する画面を追加した。
- ZAP adapter は active scan 開始前に scan policy 全体の strength / threshold を設定する。scanner/plugin rule API は呼ばない。
- OpenAPI、route table、日英 UI resource、Advanced navigation を更新した。renderer 向け契約 entry point は Node 専用 hash 実装を含まないよう分離した。

## テスト

- `npm run typecheck`: 成功。
- GO-13 Core unit: 5/5 成功。
- A43 API integration（単独）: 1/1 成功。
- Core unit 全体: 363/363 成功。
- Contracts: 8/8 成功。
- Adapters: 74 成功、1 skip、失敗 0。
- UI: 14/14 成功。
- Desktop unit: 43/43 成功。
- Desktop renderer build: 成功。
- Core integration 全体: 40 件中 37 成功、3 失敗。変更前 commit `c86e452` の一時 worktree でも同じ 3 シナリオ（document hints、business logic、findings）が 39 件中 36 成功・3 失敗となることを確認し、GO-13 による追加回帰ではない。

## 補足

- 実 ZAP 結合試験は環境依存の gated test のため未実行。adapter の fake API テストで policy 全体設定と per-rule API 非使用を検証した。
- push、PR 作成、Linear 更新は行っていない。
