# ScopePilot2 詳細設計索引

## 1. 目的と権威

本ディレクトリは、概要設計を実装可能な単位へ分解し、各振る舞いを単体テストと一対一に追跡できるようにする。詳細設計は `AGENTS.md`、`docs/burp-professional-replacement-spec.md`、`docs/design/**` を具体化するものであり、矛盾時はこの順序で上位文書を優先する。

詳細設計でいう「完了」は、ソースコードだけでなく、対応する単体テスト、必要な契約テスト、外部エンジンを使う実測テスト、証跡項目が揃った状態を指す。ZAP・Nuclei・ブラウザ・OS の内部挙動をモックの成功だけで保証しない。

## 2. 文書構成

| 文書 | 対象 | 主な実装領域 |
|---|---|---|
| [01-system-components.md](01-system-components.md) | 全体機能構成、依存方向、配置 | `apps/**`, `packages/**`, `tools/**` |
| [02-ui-information-architecture.md](02-ui-information-architecture.md) | Simple/Advanced の画面構成 | `apps/desktop`, `packages/ui` |
| [03-unit-test-strategy.md](03-unit-test-strategy.md) | 単体テスト規約、境界、完了条件 | 全パッケージ |
| [f01-case-scope-authorization.md](f01-case-scope-authorization.md) | 案件・scope・認可 | `case-authorization` |
| [f02-proxy-intercept.md](f02-proxy-intercept.md) | Proxy・Intercept | `proxy-intercept` |
| [f03-target-logger.md](f03-target-logger.md) | HTTP 履歴・Site map | `target-logger` |
| [f04-repeater.md](f04-repeater.md) | Repeater | `repeater` |
| [f05-intruder-fuzzer.md](f05-intruder-fuzzer.md) | Fuzzer | `fuzzer` |
| [f06-decoder-comparer.md](f06-decoder-comparer.md) | Decoder・Comparer | `decoder-comparer` |
| [f07-sequencer.md](f07-sequencer.md) | Sequencer | `sequencer` |
| [f08-browser-exploration.md](f08-browser-exploration.md) | ブラウザ探索 | `browser-exploration` |
| [f09-authentication-session.md](f09-authentication-session.md) | 認証・セッション | `authentication-session` |
| [f10-passive-scan.md](f10-passive-scan.md) | Passive scan | `passive-scan` |
| [f11-active-scan.md](f11-active-scan.md) | Active scan | `active-scan` |
| [f12-api-scanning.md](f12-api-scanning.md) | OpenAPI・GraphQL | `api-scanning` |
| [f13-oast.md](f13-oast.md) | OAST | `oast` |
| [f14-websocket.md](f14-websocket.md) | WebSocket | `websocket` |
| [f15-http2-advanced-transport.md](f15-http2-advanced-transport.md) | HTTP/2・高度通信 | `advanced-transport` |
| [f16-dom-investigation.md](f16-dom-investigation.md) | DOM 調査 | `dom-investigation` |
| [f17-authorization-business-logic.md](f17-authorization-business-logic.md) | 認可・業務ロジック | `business-logic` |
| [f18-known-vulnerabilities-nuclei.md](f18-known-vulnerabilities-nuclei.md) | 既知脆弱性・Nuclei | `known-vulnerabilities` |
| [f19-organizer-reporting.md](f19-organizer-reporting.md) | Organizer・報告 | `reporting` |
| [f20-extension-api.md](f20-extension-api.md) | 製品 API・拡張 | `product-api` |
| [f21-cli-automation.md](f21-cli-automation.md) | CLI・自動化 | `cli-automation` |

## 3. 追跡規約

追跡鎖は `仕様要件 → F番号 → 詳細設計の振る舞い → UT/CT/IT/FT ID → 実行証跡` とする。

- 単体テスト ID は `Fnn-UT-nnn`、共通設計は `SYS-UT-nnn` または `UI-UT-nnn` とする。
- 契約テストは `CT`、アダプター統合テストは `IT`、シミュレーション実測は `FT` を用いる。
- テスト名の先頭に ID を含め、同じ ID を複数テストへ割り当てない。
- 設計変更時は、同じコミットで対応表・テスト・契約 schema の影響を更新する。
- 外部エンジンの版差は `EngineCapabilitySnapshot` と実測結果で管理し、単体テストの fake に隠さない。

## 4. 実装開始ゲート

機能の実装を開始できる条件は次のとおり。

1. 対象 F 文書に入力、出力、状態遷移、失敗、証跡が定義されている。
2. 各重要分岐に単体テスト ID があり、テスト対象モジュールが特定されている。
3. ScopePilot が強制できる制御と、外部エンジンへ委譲する制御が区別されている。
4. Simple/Advanced/CLI の公開範囲が定義されている。
5. 外部通信を伴う場合、認可、確認、上限、停止、再開の扱いが定義されている。

## 5. 保留の扱い

利用者入力や実環境が必要な事項は、設計自体を止めず `NeedsInput` または `Unsupported` として明示する。秘密値、実対象の認可証跡、署名鍵、外部サービス資格情報はリポジトリへ置かない。
