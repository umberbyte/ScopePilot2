# 概要設計 一覧（ScopePilot2）

`docs/burp-professional-replacement-spec.md`（以下「仕様書」）の必須機能 F01〜F21 と横断要件に対する概要設計。
各文書は概要設計（コンポーネント構成・データ・安全制御・証跡・未解決事項）までを定め、
詳細設計・実装は段階計画（仕様書10章）の順で行う。段階表記 A0〜A4 は仕様書10章に対応する。

| 文書 | 対応要件 | 主な段階 |
|---|---|---|
| [01-architecture.md](01-architecture.md) | 2章・4章（共通アーキテクチャ・移植分離） | 全段階 |
| [02-case-scope-authorization.md](02-case-scope-authorization.md) | F01＋6.1（案件・スコープ・認可モデル） | A0〜A1 |
| [03-proxy-intercept-logger.md](03-proxy-intercept-logger.md) | F02＋F03（プロキシ・インターセプト・サイトマップ・ロガー） | A2 |
| [04-repeater.md](04-repeater.md) | F04（再送ワークベンチ） | A2 |
| [05-intruder-fuzzer.md](05-intruder-fuzzer.md) | F05（Fuzzer相当・ペイロード集合管理） | A0〜A1 |
| [06-decoder-comparer-sequencer.md](06-decoder-comparer-sequencer.md) | F06＋F07（変換・差分・トークン解析） | A2〜A3 |
| [07-exploration-browser.md](07-exploration-browser.md) | F08（自動探索・ブラウザ） | A1 |
| [08-authentication-session.md](08-authentication-session.md) | F09（認証とセッション） | A1 |
| [09-passive-scan.md](09-passive-scan.md) | F10（受動診断） | A1 |
| [10-active-scan.md](10-active-scan.md) | F11（能動診断の自動実行） | A0〜A1 |
| [11-api-scanning.md](11-api-scanning.md) | F12（API診断） | A1〜A3 |
| [12-oast.md](12-oast.md) | F13（OAST・コールバック検知） | A3 |
| [13-websocket-http2.md](13-websocket-http2.md) | F14＋F15（WebSocket・HTTP/2） | A3 |
| [14-dom-investigation.md](14-dom-investigation.md) | F16（DOM調査） | A3 |
| [15-authorization-business-logic.md](15-authorization-business-logic.md) | F17（認可と業務ロジック） | A2〜A3 |
| [16-known-vulns-nuclei.md](16-known-vulns-nuclei.md) | F18（既知脆弱性・Nuclei） | A2 |
| [17-organizer-reporting.md](17-organizer-reporting.md) | F19（整理と報告） | A1〜A2 |
| [18-extension-api.md](18-extension-api.md) | F20（拡張と独自検査） | A3 |
| [19-cli-automation.md](19-cli-automation.md) | F21（CLI・自動処理） | A1 |
| [20-storage-evidence.md](20-storage-evidence.md) | 6.3（保存モデル・証拠） | A1 |
| [21-update-management.md](21-update-management.md) | 5章（更新管理） | A1〜A2 |
| [22-execution-control.md](22-execution-control.md) | 6.1・6.2・6.5（実行制御・上限・障害復旧） | A0〜A1 |
| [23-ui-and-migration.md](23-ui-and-migration.md) | 8章（UI構成・移行） | A2〜B1 |

## 共通テンプレート

各概要設計は次の節で構成する。

1. 目的と対応要件（仕様書の該当機能・段階）
2. 再利用する現行資産（ScopePilot からの複製対象と変更方針）
3. コンポーネント構成（新規サービス・アダプター・ViewModel）
4. データモデル（Domain の拡張）
5. 安全制御と証跡（許可範囲・認可・上限・証拠・秘密値）
6. UI / CLI
7. 未解決事項と A0 検証項目

## 用語の確認事項（実装時の混乱防止）

- ZAP対応表の「Requester」（ZAP画面の手動再送機能）と、Automation Framework の `requestor` ジョブ
  （計画ファイルから要求を送るジョブ）は別物。本設計では F04 を「再送（Repeater相当）」、
  F05 の実行経路候補を「requestorジョブ」と呼び分ける（仕様書119行目の注意を踏襲）。
