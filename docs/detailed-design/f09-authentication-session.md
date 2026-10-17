# F09 認証・セッション

## 1. 対象

LoginFlow、RefreshFlow、cookie/token、複数 role、mTLS、認証状態判定を扱う。上位は `design/08`, `24`, `25`。

## 2. UI/CLI

- Simple: S03 で資格情報の安全な入力、対話 login、成功/失敗を案内。
- Advanced: A09/A13 で flow step、判定式、role、certificate reference を編集。
- CLI: secret reference を受け、対話が必要なら明示 failure。値の command line 直書きを警告/拒否する。

## 3. モジュール

`LoginFlow`, `RefreshFlow`, `AuthStateDetector`, `SessionVault`, `RoleSessionRegistry`, `MtlsBinding`, `SessionCoordinator`。flow は最大10 step、60秒、retry 1。

## 4. 処理

step は navigate、fill(secret reference)、click、wait、extract、assert に allowlist する。成功は URL だけでなく、明示 detector の response/DOM/cookie 条件で判定する。refresh は同 role の single-flight とし、成功時に session revision を進める。

## 5. 安全・証跡

secret 値は OS key store/安全な参照から実行時だけ取得し、log、AI prompt、report、renderer 永続 store に置かない。証跡は secret reference、flow version、成功条件、masked observation を保持する。

## 6. 失敗

秘密値なしは `NeedsInput`、capability 不足は `CapabilityUnavailable`。lockout の兆候や retry 上限で停止し、無限再認証しない。role 間で cookie jar を共有しない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F09-UT-001 | `core/test/unit/authentication-session/login-flow.test.ts` | 11 step | validation error |
| F09-UT-002 | `auth-state-detector.test.ts` | URL一致・assert不一致 | 未認証 |
| F09-UT-003 | `session-coordinator.test.ts` | 同時 refresh | adapter 呼出し1回 |
| F09-UT-004 | 同上 | retry 2回目 | lockout 回避のため停止 |
| F09-UT-005 | `role-session-registry.test.ts` | role A/B | cookie jar 非共有 |
| F09-UT-006 | `session-vault.test.ts` | evidence projection | secret 値を含まない |
| F09-UT-007 | `mtls-binding.test.ts` | certificate 不在 | `NeedsInput` |
| F09-UT-008 | `flow-deadline.test.ts` | virtual 60秒超 | timeout |

## 8. 非単体テスト

OS key store と certificate store は OS 別 IT、Playwright/ZAP の session 同期は fixture、秘密値 redaction は artifact scan で検証する。
