# 08 認証とセッション 概要設計

対応要件: 仕様書 F09・6.2（認証と OAST の認証部分）

## 1. 目的

ロール別の自動ログイン・セッション維持・再認証を標準機能とする。SSO/MFA は自動化できない
範囲だけ人手に切り替える。ScopePilot は認証情報の保持・注入を管理するが、対象外への
認証情報転送は拒否する。

## 2. 旧版から継承する知見

- 認証後URLとログイン済み指標の両方で到達状態を確認する。
- 保存済み Cookie を使う前に有効性を検査し、認証切れを実行停止理由へ接続する。
- role ごとに Playwright BrowserContext、Cookie、token、証拠を分離する。
- 人手ログインが必要な場合は介入要求を保存し、同じ run を明示的に再開する。

## 3. コンポーネント構成

```text
Domain:
  AuthMethod { 種別(Form/Bearer/Basic/ApiKey/Cookie), ロール, 入力欄対応, トークン更新方法,
               有効期限目安, 保存区分(Vault/都度入力/記録HARのみ) }
Services:
  SecretStore（24）: Windows DPAPI/Credential Manager、macOS Keychain。
    利用不可時は平文へ降格せず都度入力
  AutoLoginService: フォーム仕様（セレクタ or 記録）に従い BrowserAdapter 経由で
    ログイン→認証状態の指標確認（_loggedInIndicator 相当）→セッション抽出
  SessionManager: ロール別セッション（Cookie/トークン）の保持・有効性監視・再認証。
    F04/F05/F11 の実行時にヘッダ/Cookie として適用（04の再送セッションと共通）
  RefreshFlow: CSRFトークン・ワンタイム値の再取得を宣言的な要求テンプレート列で定義
```

- 認証情報は案件・ロール・対象範囲に紐付く。別Originへの認証ヘッダ送信は ScopeRule（02）で拒否。
- 外部IdP（SSO）へのアクセスは「認証専用ポリシー」（02）で許可した接続先に限る。

## 4. データモデル

- 案件内には認証方式の定義（AuthMethod）と Vault 参照（鍵ストアのキー名）のみを保存。
  秘密値は Vault へ。案件の移行では再認証または暗号化エクスポート（4.3）。
- セッション有効性の監視結果（最終確認・失効検知）を実行記録に残す（22の停止条件へ接続）。

## 5. 安全制御と証跡

- 認証通信の原本は暗号化し、表示・共有派生物をマスクする。password入力値はブラウザ操作証拠や
  traceへ複写せず、SecretRef と注入成否だけを記録する（20・24）。
- 自動ログイン失敗のリトライは回数上限（ロックアウトを誘発しない）。失敗は介入へ切り替え。

## 6. UI / CLI

- 案件のロール設定に認証方式を関連付け（方式ごとの入力フォーム・Vault登録・到達テスト）。
- 実行画面にロール別セッション状態（有効/期限/再認証ボタン）。

## 7. 確定事項

1. フォーム仕様は版付き `LoginFlow` とし、記録から自動生成した候補を利用者が保存して確定する。
   locator優先順位はARIA role+accessible name、label、安定したtest id、CSSの順とし、DOM位置依存selectorと
   XPathはfallbackに限定する。password値を記録せず`SecretRef`へ置換する。再記録しても過去runのflowを
   書き換えず新versionを作る。
2. `RefreshFlow` は最大10 stepの宣言的DAGとし、`HttpRequest`、`BrowserNavigate`、`Extract`、`Assert`、
   `AssignSecret`を持つ。抽出はheader/Cookie/JSON Pointer/HTML form fieldのみに限定し、任意JavaScriptを
   実行しない。各requestはEgressPolicyとbudgetを通り、最大redirect 5、最大実行60秒、retry 1回とする。
   更新失敗は古いtokenで続行せず`AuthenticationExpired`で停止する。
3. mTLSはoriginごとのclient certificate `SecretRef`とfingerprint、企業proxyはscheme/host/port、認証
   `SecretRef`、bypass allowlistを案件設定に持つ。Playwright、管理HTTP client、ZAPごとにfixtureを通った
   組合せだけをcapability manifestで公開する。proxy経由でも最終origin、CONNECT先、SNIを検査し、
   secretをcommand lineへ渡す必要があるadapterや検証不能な組合せは`Unsupported`として実行を拒否する。
