# P0–P2 実装コードレビューと実行経路接続

日付: 2026-10-31
対象: `docs/work-logs/2026-10-31-p0-p2-implementation.md` に記録されたUI schema、OTP、SAML実装

## 結論

P0–P2のドメイン判定、Core port、Theme 6への統合、UI schema、V/F単体テストは概ね設計どおりだった。
ただし、レビュー開始時点ではOTP/SAMLのportがDesktopの実行時依存へ注入されておらず、製品起動経路では常に
理由付きskipとなっていた。また、Theme 9のJWT入力はUI上で秘密値表示になっていたものの、API payloadでは
通常paramへ混入し、Core側も通常paramから読んでいた。

本レビューで両方を修正し、次の製品経路へ接続した。

```text
A03 ThemeRunner
  -> POST /api/zap-unsupported/checks
  -> BaselineFlowService.runZapUnsupportedCheck()
  -> Theme 6 OTP/SAML sub-check
  -> OtpInboxPort / SamlFixturePort
  -> loopback security fixture controller
```

## レビュー指摘と対応

### High: OTP/SAMLが製品起動経路へ未接続

- 状態: `BaselineFlowDeps`とfake testにはportが存在したが、`composeEngines()`とDesktop mainの
  `engineOptions`に実装・注入がなかった。
- 影響: UIへ入力しても `otpInbox` / `samlFixture` が常に未構成で、sub-checkは実行されない。
- 対応:
  - `HttpSecurityFixtureOtpInbox`と`HttpSecurityFixtureSaml`を追加。
  - `composeEngines()`で明示設定時だけ生成。
  - Desktop mainから`BaselineFlowService`へ注入。
  - runtime bundle hashへfixture adapterの有無を反映。
- 安全境界:
  - controller接続先は明示したloopbackだけ。
  - redirect禁止。
  - OTPはメモリ内だけで保持。
  - SAML assertion本文は受け取らず、隔離実行の明示とSHA-256 hashだけを受け取る。
  - 未設定時は従来どおりskipし、一般のmailbox/IdPへfallbackしない。

### High: Theme 9の秘密値経路がschemaと不一致

- 状態: `validToken`には`secret: true`が指定されていたが、ThemeRunnerは全fieldを`params`へ格納していた。
- 影響: 秘密値境界が形骸化し、Coreを秘密値経路へ直した場合はUI実行が`NeedsInput`になる。
- 対応:
  - `partitionThemeFieldValues()`を追加し、secret fieldを`secretValues`だけへ格納。
  - Coreは`secretValues.validToken`を優先して読む。旧API client向けに`params.validToken`は互換fallbackのみ残す。
  - UI schema testとCore実行testで秘密値経路を固定。

### Medium: MFA正常対照がHTTP 302を不成立扱い

- 状態: 一次認証後のpending-session cookieがあっても、statusが2xx以外なら正常対照を不成立としていた。
- 影響: 一般的な302遷移型MFAで段階スキップ検証を開始できない。
- 対応: cookie発行を必須にしたまま、非errorの2xx/3xxを正常対照として許可。302の回帰testを追加。

### Medium: 誤OTP候補が偶然正規OTPと一致し得る

- 状態: `000001`～`000005`を固定送信しており、正規OTPが同値の場合に試行上限probeの前提が崩れる。
- 対応: 正規OTPの桁数に合わせ、候補が一致した場合は別候補へ切り替える。

## fixture controller契約

設定:

- `SCOPEPILOT_SECURITY_FIXTURE_BASE_URL=http://127.0.0.1:<port>[/base-path]`
- 任意: `SCOPEPILOT_SECURITY_FIXTURE_TOKEN=<bearer token>`

固定endpoint:

- `GET {base}/v1/otp?mailboxRef=...&issuedAfter=...`
  - 未着: HTTP 204
  - 着信: HTTP 200、`{"otp":"...","receivedAt":"ISO-8601"}`
- `POST {base}/v1/saml/issue-and-replay`
  - 入力: `idpStartUrl`、`acsUrl`、`role`
  - 出力: `fixtureIsolated: true`、control/replay成否とstatus、64桁の`assertionHash`

controllerそのものは対象環境ごとに用意する隔離fixtureであり、リポジトリへ汎用mailbox資格情報や
IdP固有処理を埋め込まない。

## 検証

- `npm run typecheck`: 成功
- `npm test`: 全workspace成功、fail 0（外部環境が必要なgated/real integrationは通常どおりskip）
- `npm run build --workspace @scopepilot2/desktop`: main/preload/rendererのbundle成功
- `git diff --check`: エラーなし（既存ファイルのLF/CRLF警告のみ）
- 追加・更新した重点test:
  - UI fieldのparam/secret分離
  - OTP controllerのopt-in・loopback制限・polling・freshness
  - SAML controllerの隔離表明・hash-only応答
  - `composeEngines()`によるadapter生成
  - Theme 6のOTP/SAML V/F境界と302正常対照
  - Theme 9の`secretValues`実行経路

## 残件

- 実案件で使うOTP mailboxと試験IdP/SPのcontroller実体は、対象環境の資格情報・fixture構成が必要。
  今回はその製品接続契約とadapterを実装した。controller未設定時は安全にskipする。
- Theme 17 request smuggling/parser差異は、専用raw transportと隔離proxy fixtureが未実装のため対象外のまま。
- 標準項目IDごとの`GuidelineCoverageRoute`明示mappingはP0–P2とは別の残件であり、本変更では生成していない。
