# 08 認証とセッション 概要設計

対応要件: 仕様書 F09・6.2（認証と OAST の認証部分）

## 1. 目的

ロール別の自動ログイン・セッション維持・再認証を標準機能とする。SSO/MFA は自動化できない
範囲だけ人手に切り替える。ScopePilot は認証情報の保持・注入を管理するが、対象外への
認証情報転送は拒否する。

## 2. 再利用する現行資産

- `Services/AuthenticationFlow` / `ViewModels/AuthenticationViewModel`: 認証後URL到達確認の考え方
- `Services/ZapAuthenticationVerifier`: 記録済みCookieでの到達事前確認
- `ZapHandoffService` の replacer によるCookie注入（認証付き診断）
- `tools/fast-crawl.js` の human-intervention / resume.signal（人手ログイン→再開）
- Bruno/Playwright 記録のロール分離（BrowserContext・Cookieの分離）

## 3. コンポーネント構成

```text
Domain:
  AuthMethod { 種別(Form/Bearer/Basic/ApiKey/Cookie), ロール, 入力欄対応, トークン更新方法,
               有効期限目安, 保存区分(Vault/都度入力/記録HARのみ) }
Services:
  CredentialVault（Platform Services）: ISecretStore（Windows: DPAPI / macOS: Keychain / Linux:
    Secret Service。4.3の規定。利用不可時は平文へ降格せず都度入力）
  AutoLoginService（新規）: フォーム仕様（セレクタ or 記録）に従い BrowserAdapter 経由で
    ログイン→認証状態の指標確認（_loggedInIndicator 相当）→セッション抽出
  SessionManager（新規）: ロール別セッション（Cookie/トークン）の保持・有効性監視・再認証。
    F04/F05/F11 の実行時にヘッダ/Cookie として適用（04の再送セッションと共通）
  RefreshFlow（後段）: CSRFトークン・ワンタイム値の再取得マクロ（要求テンプレート列で定義）
```

- 認証情報は案件・ロール・対象範囲に紐付く。別Originへの認証ヘッダ送信は ScopeRule（02）で拒否。
- 外部IdP（SSO）へのアクセスは「認証専用ポリシー」（02）で許可した接続先に限る。

## 4. データモデル

- 案件内には認証方式の定義（AuthMethod）と Vault 参照（鍵ストアのキー名）のみを保存。
  秘密値は Vault へ。案件の移行では再認証または暗号化エクスポート（4.3）。
- セッション有効性の監視結果（最終確認・失効検知）を実行記録に残す（22の停止条件へ接続）。

## 5. 安全制御と証跡

- 記録・送信される通信に秘密値が含まれる場合、保存時マスク（04と同一）。認証ログイン操作自体は
  観測として残すがパスワード欄は必ずマスク。
- 自動ログイン失敗のリトライは回数上限（ロックアウトを誘発しない）。失敗は介入へ切り替え。

## 6. UI / CLI

- 案件のロール設定に認証方式を関連付け（方式ごとの入力フォーム・Vault登録・到達テスト）。
- 実行画面にロール別セッション状態（有効/期限/再認証ボタン）。

## 7. 未解決事項（A0〜A1）

1. フォーム仕様の記述形式（セレクタ直書き vs 記録からの自動生成）
2. Bearer/ApiKey の更新フローの一般化（RefreshFlow の初期構文）
3. mTLS・企業プロキシは「必要な案件で再現シナリオを定める」（6.2）の具体化は後段
