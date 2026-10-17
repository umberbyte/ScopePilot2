# 26 要求トレーサビリティと設計レビュー

## 1. 目的

仕様書、AGENTS.md、概要設計、受け入れ試験を一対一で追跡し、「画面がある」ことを機能完成と誤認しないための台帳を定める。本書は設計レビューで見つかった横断課題と、その解消先も記録する。

## 2. 要求マトリクス

| 要求 | 主設計 | 完成を示す証拠 |
|---|---|---|
| F01 | [02](02-case-scope-authorization.md) | scope/operation/期限を外した拒否 fixture |
| F02–F03 | [03](03-proxy-intercept-logger.md) | 中継、停止、編集、破棄、10万件検索 |
| F04 | [04](04-repeater.md) | standard 送信、Safe 拒否、redirect 制御 |
| F05 | [05](05-intruder-fuzzer.md) | 自動反復、版固定、共有上限停止 |
| F06–F07 | [06](06-decoder-comparer-sequencer.md) | codec/diff fixture、採取計画と限界表示 |
| F08 | [07](07-exploration-browser.md) | 認証・form・SPA を含む探索証拠 |
| F09 | [08](08-authentication-session.md) | role 分離、期限切れ、再認証、secret 非漏えい |
| F10 | [09](09-passive-scan.md) | 対象への追加通信がゼロ |
| F11 | [10](10-active-scan.md) | Spider→履歴登録→scan→finding の完走（ZAP は Delegated として保証範囲を開示） |
| F12 | [11](11-api-scanning.md) | 未観測 operation の許可内生成と送信 |
| F13 | [12](12-oast.md) | request/callback correlation と待機上限 |
| F14–F15 | [13](13-websocket-http2.md) | message 上限、H2/Host/connect/SNI 能力表 |
| F16 | [14](14-dom-investigation.md) | source/sink trace と未確認表示 |
| F17 | [15](15-authorization-business-logic.md) | role/owner 差分、期待結果、人の確認 |
| F18 | [16](16-known-vulns-nuclei.md) | 固定 template、禁止能力、JSONL 取込 |
| F19 | [17](17-organizer-reporting.md) | 重複、確認状態、coverage、masked export |
| F20 | [18](18-extension-api.md) | schema 互換性、worker 隔離、能力拒否 |
| F21 | [19](19-cli-automation.md) | UI なしの自動完走、終了理由 |
| 6.1/6.5 | [22](22-execution-control.md) | Enforced 経路の送信前拒否、Delegated 経路の実測・停止・開示、共有上限、crash fixture |
| 6.3 | [20](20-storage-evidence.md) | 原本 hash、派生関係、復旧、性能 |
| 6.4 | [24](24-certificate-secrets.md) | CA/secret の Windows/macOS lifecycle |
| 5章/9章 | [21](21-update-management.md) | bundle 検証、atomic 切替、rollback |
| 7章 | [25](25-document-hints-ai.md) | hint/observation 分離、prompt injection fixture |
| F03/F08/F19・6.3（ガイドライン対応） | [27](27-security-guidelines.md) | 案件ごとの有効ガイドライン、分類と参照項目、参照基準の報告、triage/所見の分離 |

## 3. 今回のレビューで解消した設計不整合

| 問題 | 決定 |
|---|---|
| C#/WPF/Avalonia と削除済み class の再利用が前提 | TypeScript/Electron の新規 package と依存方向へ置換 |
| UI と CLI が ViewModel を共有 | UI 非依存 ApplicationService と contracts を共有 |
| 内部 IPC を作らない記述と local API の要求が衝突 | 型付き Electron IPC、direct CLI、opt-in Product API に分離 |
| 外部 engine の通信上限が監視だけ | capability 等級と予算 lease、強制不能時の無効化を定義 |
| 証拠を保存時にマスクすると原本性を失う | 暗号化原本、表示派生、共有派生を分離 |
| A1 の版固定が A2 の更新機能に依存 | release 同梱 runtime bundle を A1 に前倒し |
| Active Scan が新規発見 URL を扱えない | 発見→scope 判定→履歴/context 登録→scan の順を採用 |
| 文書記載から観測・所見が作られ得る | DocumentHint を独立した未確認情報として定義 |
| 証明書と秘密値の lifecycle が未定 | OS secret store、CA trust、server 証明書例外を設計 |
| 外部 engine の scope を ScopePilot が強制する前提（ZAP 前段 proxy 案を含む） | ZAP/Nuclei は内部挙動を制御できず更新も権限外。送信前拒否は ScopePilot 由来通信（Enforced）のみ保証し、外部 engine は Delegated（入力 scope＋推測＋停止＋版ごと実測＋開示）として保証範囲を経路別に線引き |
| 旧版のセキュリティガイドライン参照・候補選定（`GuidelineContext`/`GuidelineSelectionPolicy`/`GuidelineBasis`）が新設計から欠落 | [27](27-security-guidelines.md) を新設。案件ごとの有効ガイドライン、観測の分類と項目参照、候補の guidelineBasis、報告の参照ガイドライン/参照基準を定義。triage 根拠と所見の実影響を分離 |
| OperationClass（許可操作区分）が各文書で命名ばらつき・散在 | [02](02-case-scope-authorization.md) を正本とし初期集合を固定（Passive/Browse/FormSubmit/Upload/ActiveCrawl/ActiveScan/Fuzz/ApiSend/WebSocketSend/NucleiScan/CrossRoleTest） |
| `PlanBuilder`(02) と `PlanService`(01) の二重名 | `PlanService` に統一し、生成の正本を [01](01-architecture.md)・[22](22-execution-control.md) に置く |
| AI provider 送信が案件 egress と未区別 | 外部 egress チャネルとして明示・記録、local-only 可（[25](25-document-hints-ai.md)） |

## 4. 設計ゲート

- **A0 gate**: 基準シナリオ、engine capability、通信制御、HTTP/2 制約、性能基準を実測して記録する。
- **A1 gate**: 認可済み自動診断、証拠、CLI、固定 runtime bundle、rollback が揃う。
- **A2 gate**: 手動 proxy/repeater、Nuclei、報告が同じ制約と証拠モデルで動く。
- **A3 gate**: OAST、WebSocket、DOM、拡張 worker の不足を能力表へ反映し、未保証機能を公開しない。
- **A4 gate**: 必須業務シナリオ、移行、Windows/macOS 配布・署名・復旧を検証する。

脆弱アプリケーションでの検出件数や全脆弱性の再現は、明示的に依頼されない限り gate に含めない。fixture は workflow、安全制御、証拠、取込を検証するために使う。
