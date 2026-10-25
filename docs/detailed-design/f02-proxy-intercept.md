# F02 Proxy・Intercept

## 1. 対象

ZAP proxy session、CA 案内、break queue、forward/drop/edit、通信証跡を扱う。上位は `design/03`, `22`, `24`。

## 2. UI/CLI

- Simple: browser 探索の内部機能として利用し、個別 intercept は公開しない。
- Advanced: A05 で intercept on/off、queue、raw/structured editor、forward/drop を提供する。
- CLI: session の start/status/stop のみ。対話 break 操作は `Unsupported`。

## 3. モジュール

`ProxySessionService`, `BreakQueue`, `InterceptDecisionPolicy`, `ZapProxyAdapter`, `CertificatePresenter`。core は queue と判断を持ち、ZAP API 呼出しは `packages/adapters/src/zap/proxy/` に隔離する。

## 4. 状態と処理

session は `Starting → Ready → Stopping → Stopped|Failed`。break item は `Held → Forwarded|Dropped|Expired`。item は message reference、方向、受信時刻、deadline、元 request hash、編集後 hash を持つ。

forward 時は編集 request を schema 検証し、ScopePilot 自身が送信する経路なら EgressPolicy を再評価する。ZAP が既に保持した通信は delegated control として表示する。

## 5. 安全・証跡

CA private key を renderer へ渡さない。queue 上限と deadline を超えた item は既定で drop し、暗黙 forward しない。認証 header/cookie は画面と log で mask するが、暗号化原本の参照は保持する。

## 6. 失敗

ZAP API 切断は session を `Failed`、未解決 item を `Expired` にする。既に確定した item の再操作は `Conflict`。外部 engine が発した実通信の完全な送信前拒否は保証しない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F02-UT-001 | `core/test/unit/proxy-intercept/break-queue.test.ts` | queue 上限超過 | 新規 item を拒否 |
| F02-UT-002 | 同上 | deadline 経過 | drop/expired event |
| F02-UT-003 | `intercept-decision.test.ts` | request 編集後 forward | 新 hash と decision を記録 |
| F02-UT-004 | 同上 | scope 外へ URL 編集 | forward せず `OutOfScope` |
| F02-UT-005 | `proxy-session.test.ts` | start 中の stop | 一度だけ adapter stop |
| F02-UT-006 | `certificate-presenter.test.ts` | CA 情報表示 | private key material を含まない |
| F02-UT-007 | `redaction.test.ts` | Cookie/Authorization | 表示値を mask |

## 8. 非単体テスト

ZAP break API の版別 CT、CA 導入と HTTPS proxy の IT、forward/drop/stop の実測 FT を固定 ZAP 版で行う。
