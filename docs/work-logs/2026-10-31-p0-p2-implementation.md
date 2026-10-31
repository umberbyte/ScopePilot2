# 2026-10-31 ハンドオフ P0〜P2 実装 (zcode セッション)

## 1. 経緯と入力

- 前セッション (codex) が `docs/work-logs/2026-10-31-agent-handoff.md` を作成し、
  「Daybreakで対応できなかった残タスク」を P0〜P3 の優先度付きで引き継いだ。
- 利用者指示「引き継ぎ資料を参照して、あなたが実装してください」により、本セッションで
  P0〜P2 を実装し、P3 は資料の規定どおり実行対象外を維持した。
- branch: `main`、handoff作成時HEAD: `f3d5a86`。
- 作業開始時点で dirty worktree に前セッションの未commit変更が多数あり、
  `git reset --hard` 等は行わず既存変更を保全した (本セッションの変更は下記5章のみ)。

## 2. P0: 実行フォーム未接続の解消

### 問題

`IMPLEMENTED_THEME_NOS` は24テーマを実装済み表示するが、`THEME_SCHEMA` に
`6,9,14,15,16,24,25,26,27` の9テーマがなく、実行ボタンが表示されるのに
`ThemeRunner` が `null` を返しUIから実行できない状態だった (handoff §5.2)。

### 実装

- テーマ入力schemaを `apps/desktop/src/renderer/theme-schema.ts` へ分離した。
  Node の型ストリッピングは JSX を処理できないため、JSXを含まない純データモジュールに
  分離することで unit test から直接 import できるようにした。
- 9テーマのschemaを追加し、24実装テーマすべて (テーマ1は専用フォーム) に実行フォームを紐付けた。
- schema表現を拡張した (handoff §5.2 の推奨に沿う):
  - `required`: Core が NeedsInput/ValidationFailed を出す必須param。空欄なら実行ボタンを
    無効化し、不足欄のラベルを表示する (`missingRequiredInputs`)。
  - `secret`: 伏せ字入力 (テーマ9 `validToken` = 正規JWT)。値は送信のみに使う。
  - `kind: 'boolean'`: Checkbox。チェック時のみ `'true'` をparamへ送る
    (テーマ24 `sensitivePage`、テーマ25 `allowStateChangingMethods`、テーマ27 `requireWss`)。
  - `kind: 'select'`: 候補だけを選ばせる (テーマ15 `method` = POST/PUT/PATCH)。
- テーマ6の対象URLは順序 (1番目=サインイン、2番目=保護対象) が判定前提のため、
  単一Textareaではなく名前付き入力 (`namedTargets`) にした。
- テーマ17 (request smuggling) は実装完了まで実行ボタンを表示しない — 従来どおり
  `IMPLEMENTED_THEME_NOS` に含めず、testで機械検証して回帰を防いだ。

### 新test: `apps/desktop/test/unit/theme-schema.test.ts` (8 test)

- 実装済み一覧と Core `ZAP_UNSUPPORTED_IMPLEMENTED_THEMES` の完全一致、テーマ17不在。
- テーマ1以外の全実装テーマがschemaを持つ (行き場のない実行ボタンの回帰防止)。
- 全入力欄のラベルがja/en両方に存在、orphanラベルなし。
- 名前付き対象のラベル存在とテーマ6の順序 (signInUrl, protectedUrl)。
- Core必須param (`9.validToken`, `15.baselineJson`, `15.variantJson`, `16.baselineJson`,
  `16.probeUrl`, `26.deepQuery`) が schema でも required。
- select/boolean/secret の組み合わせ制約。
- `missingRequiredInputs` の挙動。
- テーマ6のOTP/SAML入力が Core の param key と一致。

### 検証の限界 (正直な記録)

Electronアプリの実起動・実画面操作は本セッションでは行っていない。UI変更の検証は
unit test・typecheck・esbuild bundle 成功までであり、実画面でのテーマ6実行は
次回の実機確認項目とする。

## 3. P1: テーマ6 OTP sub-check (寿命・再利用・試行制限・宛先変更)

### 設計

handoff §6 P1 のprobe設計に従い、テーマ6をsub-check構造にした。

- 正常対照: 新規OTPを発行し、期限内に1回だけ提出して受理を確認 (以後の判定の前提)。
- 再利用: 同一使用済みOTPを同一sessionで再送。
- 寿命: 未使用の新規OTPを、fixture宣言の有効期限 + 猶予5秒の待機後に1回だけ提出。
  待機は上限120秒 (超えるfixtureではsub-check自体を行わない)。
- 試行制限: 事前合意した1..5回の誤OTP送信後、正規OTPが受理されるかだけ観察。
- 宛先変更: 認証済みrole sessionで再認証なしの宛先変更要求が受理されるか。
  変更bodyに再認証情報を含めないことを `detail: reauth=not-performed` で記録。

### 実装

- `packages/core/src/ports/engines.ts` に `OtpInboxPort` を追加。
  - `mailboxRef` は許可済みfixture設定の参照であり秘密値ではない。
  - OTP値はCoreとadapterの呼び出し中だけ保持し、probe結果・証跡・API応答へ出さない。
- `packages/core/src/domain/zap-unsupported.ts` に判定関数を追加:
  - `judgeOtpSubmission`: HTTP status + 受理marker による提出結果判定。
    marker未設定は `unknown`、401/403/4xx/5xx は `rejected`。
    (HTTP 2xxだけでは受理としない)
  - `judgeOtpBoundary`: 正常対照が `accepted` のときのみ、action の受理を exposed、
    拒否を denied とする。対照不成立・marker不明は inconclusive。
  - `planOtpWrongAttempts` (1..5)、`planOtpExpiryWaitMs` (0..600秒宣言、待機上限120秒)、
    定数 `OTP_WRONG_ATTEMPTS_MAX` / `OTP_EXPIRY_WAIT_MAX_MS` / `OTP_INBOX_TIMEOUT_MS` (30秒)。
- `packages/core/src/application/baseline-flow.ts` のテーマ6:
  - sub-checkごとの実行条件: `otpIssueUrl` / `otpVerifyUrl` / `otpSuccessMarker` /
    `otpMailboxRef` + `OtpInboxPort` 構成で reuse・expiry・attempt-limit、
    `otpDestinationChangeUrl` / `otpDestinationChangeMarker` + role session で
    destination-change。未実施sub-checkは理由付きで `skipped` へ。
  - OTP endpoint URL は `businessTargetInScope` で案件scope検証、
    予定送信数は `requestBudget` で案件上限と照合 (mfa 2 + sub-check別の計上)。
  - `sleep` は `BaselineFlowDeps.sleep` で差し替え可能とし、fixtureでは即時解決にできる。
  - OTP値はprobeのpattern/detail/bodyHashに出さない (bodyHashは応答本文のhash)。
- UI: テーマ6フォームにOTP入力群 (任意) を追加、role選択を `optional` に変更
  (宛先変更にrole sessionが必要なため)。

### V/F確認 (unit test, fake repeater + fake inbox + 即時解決sleep)

| ケース | 期待 | 結果 |
|---|---|---|
| 再送受理 (V) | `otp-reuse:resubmit` = exposed、OTP値が結果に不出 | 合格 |
| 再送拒否 (F) | denied、ただし未実施sub-check残留でテーマ全体は inconclusive | 合格 |
| inbox未受領 | 対照 inconclusive、再送probeなし | 合格 |
| 期限・試行・宛先 (V=全受理) | 各 exposed、待機呼出 = 期限秒+5000ms | 合格 |
| 期限・試行・宛先 (F=全拒否) | 各 denied、SAML未実施のため全体 inconclusive | 合格 |

## 4. P2: テーマ6 SAML assertion replay sub-check

### 実装

- `SamlFixturePort` を `engines.ts` に追加 (handoff §6 P2 の推奨契約)。
  - 隔離された試験IdP/SPをfixture adapterが駆動する。Coreは直接送信しない。
  - 返り値は `controlAccepted` / `replayAccepted (boolean|null)` / 各status /
    `assertionHash` のみ。assertion本文・署名・NameIDは返さない。
  - `replayAccepted` は「同一assertion再送が新しいsessionとして受理された」観測。
    既存session継続との区別不能は `null`。
- `judgeSamlAssertionReplay`: 対照ログイン成立 + 再送新規session受理だけが exposed。
  対照不成立・区別不能は inconclusive。assertionの生成・改ざんは行わない。
- baseline-flow のテーマ6: `samlIdpStartUrl` / `samlAcsUrl` + `SamlFixturePort` 構成で
  sub-check `saml-assertion-replay` が走る。未構成は理由付きskip。
- UI: テーマ6フォームに `samlIdpStartUrl` / `samlAcsUrl` (任意) を追加。

### V/F確認 (unit test, fake SamlFixturePort)

対照成立+再送受理=exposed / 再送拒否=denied / 対照不成立 (再送受理でも) =inconclusive /
区別不能 (null) =inconclusive / fixture未構成=理由付きskip。すべて合格。

## 5. 本セッションの変更ファイル

### 新規

- `apps/desktop/src/renderer/theme-schema.ts` — テーマ入力schema (JSXを含まない純データ)
- `apps/desktop/test/unit/theme-schema.test.ts` — schema/Core整合 test (8 test)
- `docs/work-logs/2026-10-31-p0-p2-implementation.md` — 本記録

### 修正

- `apps/desktop/src/renderer/guidelines-catalog.tsx` — schema分離import、ThemeRunner拡張
  (名前付き対象・boolean/select/secret入力・必須チェック)
- `apps/desktop/src/renderer/resources.ja.ts` / `resources.en.ts` — 新ラベル (ja/en同数)
- `packages/core/src/ports/engines.ts` — `OtpInboxPort`、`SamlFixturePort`
- `packages/core/src/domain/zap-unsupported.ts` — OTP/SAML判定関数と定数
- `packages/core/src/application/baseline-flow.ts` — deps (`otpInbox`/`samlFixture`/`sleep`)、
  テーマ6 sub-check構造
- `packages/core/test/unit/application/zap-unsupported-check.test.ts` — OTP/SAML test 追加
  (`otpFixtureFlow` helper、`flowWithSession` 拡張)
- `packages/core/test/unit/support/test-flow.ts` — `otpInbox`/`samlFixture`/`sleep` option
- `docs/ZAP-UNSUPPORTED-THEME-DIAGNOSTICS.md` — テーマ6をsub-check構成の説明へ改訂
- `docs/work-logs/2026-10-31.md` — 「引き継ぎ後の実装」節へ概要を追記
- `docs/work-logs/2026-10-31-agent-handoff.md` — 冒頭に実装状況の付記

## 6. テーマ17 (P3) の扱い

実装しなかった。理由はhandoff §6 P3のとおり、成立判定には専用raw transport
(`net`/`tls` によるreview済みbytes送信)、frontend/backendで異なるparserを持つ
二段構成fixture、誤配送を一意に確認するoracleが必要で、現在の実行環境に
これらを検証できる資産がないため。theme-schema test がテーマ17の実行対象外を
機械検証するため、意図せず実行ボタンが復活することはない。

## 7. 検証コマンドと結果 (すべて成功)

```powershell
Set-Location -LiteralPath 'C:\Users\GoSugawara\src\ScopePilot2'
npm test              # 全workspace 493 test、fail 0 (env-gated skip 1件は従来どおり)
npm run typecheck     # error なし
npm run build --workspace @scopepilot2/desktop
node tools/report-tools/generate-guideline-conformance-evidence.mjs
node tools/report-tools/verify-guideline-conformance-evidence.mjs
git diff --check
```

focused tests:

```text
node --test packages/core/test/unit/application/zap-unsupported-check.test.ts  # 32 pass
node --test packages/core/test/unit/business-logic/zap-unsupported.test.ts     # 11 pass
npm test --workspace @scopepilot2/desktop   # 40 pass (theme-schema 8 test 含む)
npm test --workspace @scopepilot2/core      # 327 pass (OTP/SAML追加6 test 含む)
```

## 8. 残件 (次の作業者へ)

1. **OTP mailbox adapter**: `OtpInboxPort` の実adapter。許可済み私有fixture inboxだけを
   接続先とする設定 (env変数等) と、実fixtureでのV/F確認が残る。
2. **SAML fixture adapter**: `SamlFixturePort` の実adapter。隔離試験IdP/SP (例: Keycloak等の
   ローカル構成) での対照ログイン・session reset・同一assertion再送の実装とV/F確認が残る。
3. **Electron実機確認**: テーマ6フォーム (名前付き対象・OTP/SAML入力) の実画面表示と、
   mfa-stage-skip がUIから実行できることの確認。
4. **テーマ17**: 専用transport・二段parser fixture・oracleの整備後に着手。
   完了前はimplemented listへ追加しない。
5. **ガイドラインcoverage mapping** (handoff §5.1): 標準項目ID→runtime check の明示mapping
   (`GuidelineCoverageRoute`) は本セッションの範囲外。引き続き別件として残る。
