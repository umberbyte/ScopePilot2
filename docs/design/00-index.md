# ScopePilot2 概要設計一覧

本ディレクトリは [Burp Suite Professional 代替仕様案](../burp-professional-replacement-spec.md) を実装へ落とす概要設計である。言語・配布対象・旧版の扱いはリポジトリ直下の [AGENTS.md](../../AGENTS.md) を正本とし、本文書群は TypeScript、Electron、Windows/macOS を前提とする。

## 設計の読み方

| 文書 | 対応範囲 | 主な段階 |
|---|---|---|
| [01 共通アーキテクチャ](01-architecture.md) | プロセス、パッケージ、依存方向、信頼境界 | 全段階 |
| [02 案件・スコープ・認可](02-case-scope-authorization.md) | F01、6.1 | A0–A1 |
| [03 Proxy・Intercept・Logger](03-proxy-intercept-logger.md) | F02、F03 | A2 |
| [04 Repeater](04-repeater.md) | F04 | A2 |
| [05 Fuzzer](05-intruder-fuzzer.md) | F05 | A0–A1 |
| [06 Decoder・Comparer・Sequencer](06-decoder-comparer-sequencer.md) | F06、F07 | A2–A3 |
| [07 自動探索・ブラウザ](07-exploration-browser.md) | F08 | A1 |
| [08 認証・セッション](08-authentication-session.md) | F09 | A1 |
| [09 受動診断](09-passive-scan.md) | F10 | A1 |
| [10 能動診断](10-active-scan.md) | F11 | A0–A1 |
| [11 API 診断](11-api-scanning.md) | F12 | A1–A3 |
| [12 OAST](12-oast.md) | F13 | A3 |
| [13 WebSocket・HTTP/2](13-websocket-http2.md) | F14、F15 | A0、A3 |
| [14 DOM 調査](14-dom-investigation.md) | F16 | A3 |
| [15 認可・業務ロジック](15-authorization-business-logic.md) | F17 | A2–A3 |
| [16 Nuclei 統合](16-known-vulns-nuclei.md) | F18 | A2 |
| [17 整理・報告](17-organizer-reporting.md) | F19 | A1–A2 |
| [18 拡張 API](18-extension-api.md) | F20、UI–コア契約 | A3 |
| [19 CLI・自動処理](19-cli-automation.md) | F21 | A0–A1 |
| [20 保存モデル・証拠](20-storage-evidence.md) | 6.3、6.5 | A1 |
| [21 更新管理](21-update-management.md) | 5章、配布物の版固定 | A0–A2 |
| [22 実行制御](22-execution-control.md) | 6.1、6.2、6.5 | A0–A1 |
| [23 UI 2モード・移行](23-ui-and-migration.md) | 8章、Windows/macOS | A1–A4 |
| [24 証明書・秘密情報](24-certificate-secrets.md) | 6.2、6.4 | A0–A1 |
| [25 文書ヒント・全作業AI支援](25-document-hints-ai.md) | 7章 | A1 |
| [26 要求トレーサビリティ](26-requirements-traceability.md) | F01–F21、横断要件 | 全段階 |
| [27 ガイドライン参照・候補選定](27-security-guidelines.md) | F03、F08、F19、6.3、5.1 | A1 |

## 全文書に適用する規則

1. コアは UI 非依存の TypeScript とし、Electron renderer、Electron main、CLI、外部 API を契約で分離する。
2. 送信を伴う処理は `ExecutionPlan` と有効な認可を必要とし、[22](22-execution-control.md) の実行制御を迂回しない。
3. 外部エンジン（ZAP・Nuclei）の内部挙動は制御せず、我々の権限外（版更新で変化しうる）として扱う。scope を入力として与え、起動・停止を握り、出力から挙動を推測する（Delegated、[22](22-execution-control.md)）。送信前拒否を保証するのは ScopePilot 自身が発する通信（Enforced）だけで、外部エンジン由来の通信は入力 scope・事後検知・停止・版ごとの実測・開示で扱う。入力 scope もライフサイクル停止も保証できない能力は公開しない。
4. 通信原本、表示用マスク、共有用派生物を別の証拠として扱う。観測、エンジンの判定、人の確認、文書の記載を混同しない。
5. 外部バイナリ、ルール、ペイロード、npm 依存、実行時ランタイムは版とハッシュを固定し、実行記録へ残す。
6. 旧 ScopePilot のソースは実装の依存先にしない。安全制御や ZAP 運用上の知見だけを、テストと契約に置き換えて継承する。
7. UI は Simple / Advanced の2モードを持つ。モードは表示と編集可能範囲を変えるが、利用者権限、対象認可、
   scope、実行上限を付与・緩和しない。対象サイトの role と ScopePilot 操作者の権限を別モデルにする。
8. 利用者が選択した AI は全作業を支援できるが、出力は提案として扱う。AI は認可、計画、権限、実行制御を
   変更できず、AIなしでも必須workflowを完走できる。

## 設計上の決定と検証課題

各機能文書の「確定事項」は実装時の自由選択ではない。外部エンジンの版に依存する事項は、設計を
保留するのではなく、製品既定、能力を公開するための fixture、未達時の無効化条件を記録する。
[26](26-requirements-traceability.md) を決定台帳とし、A0 では特に次を実測する。

- ZAP の Safe/standard 境界、`sendRequest`、Spider、Active Scan、停止処理、`URL Does not Exist` 回避。
- Playwright、ZAP、Nuclei を含む通信範囲と共有上限の、経路別の保証等級（Enforced/Delegated/Unsupported）と、固定版での実測・開示方法。
- HTTP/2、Host、接続先、SNI を別々に扱える送信経路。
- TypeScript シミュレーションハーネスによる「探索→能動診断→所見」の自動完走。
- 10万件の通信索引、本文遅延読込、異常終了後の復旧。
- Simple / Advanced が同じ契約・計画を使い、Simpleから非公開操作へ到達できないこと。
- 診断項目Excelから生成した版付きcatalogのsource座標、hash、権限、実行route、復元要件の完全性。
