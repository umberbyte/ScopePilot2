# F20 製品 API・拡張

## 1. 対象

UI/CLI/外部クライアント共通の REST、SSE、schema、認証、extension trust と互換性を扱う。上位は `design/18`, `21`, `24`。

## 2. UI/CLI

- Desktop UI/CLI は loopback Core API の first-party client。
- 外部 extension は明示有効化、最小 permission、versioned token を要求。
- 任意 script/plugin の製品内実行は初期版 `Unsupported`。

## 3. モジュール

`ApiRouter`, `SchemaValidator`, `ClientAuthenticator`, `PermissionMapper`, `IdempotencyStore`, `SseEventLog`, `ExtensionManifestVerifier`, `CompatibilityPolicy`。契約は `packages/contracts` から生成する。

## 4. 処理

変更 API は command ID と idempotency key を受け、同じ key/同じ body は同じ結果、異なる body は conflict。SSE は event ID で resume し、権限変更後に stream を再評価する。extension package は Ed25519 signature、publisher trust、permission manifest、API range を検証する。

## 5. 安全・証跡

loopback でも origin/token を検証し、wildcard CORS を許可しない。extension は core port を迂回できず、全 command が通常の認可/計画/evidence pipeline を通る。秘密値 read permission は提供せず参照 ID だけを扱う。

## 6. 失敗

未知 field は契約方針に従い拒否、version 不一致は migration 情報付き error。SSE gap は snapshot 再取得を要求する。signature/trust 失敗 extension を load しない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F20-UT-001 | `core/test/unit/product-api/idempotency.test.ts` | 同 key/同 body | 同 result |
| F20-UT-002 | 同上 | 同 key/別 body | `Conflict` |
| F20-UT-003 | `permission-mapper.test.ts` | permission 不足 | handler 前に拒否 |
| F20-UT-004 | `sse-event-log.test.ts` | Last-Event-ID | 次 event から返す |
| F20-UT-005 | 同上 | retention gap | snapshot required |
| F20-UT-006 | `extension-manifest.test.ts` | signature 不一致 | load 拒否 |
| F20-UT-007 | `compatibility-policy.test.ts` | API range 外 | unsupported version |
| F20-UT-008 | `secret-contract.test.ts` | secret read 要求 | 値を返さない |

## 8. 非単体テスト

OpenAPI/JSON Schema の生成差分 CT、loopback auth/CORS/SSE reconnect IT、署名 extension fixture と desktop/CLI の同値操作 FT を行う。
