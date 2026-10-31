# ガイドライン診断・Daybreak未完了実装 引き継ぎ

> **後続実装による更新 (2026-10-31)**: 本文は作成時点の履歴である。後続作業でテーマ30
> （公開情報・構成情報）とガイドライン別実行profileを実装し、独自handlerは25テーマになった。
> 利用者の最新指示により、テーマ17のrequest smuggling / parser差異6項目と、対象固有の許可scope・比較主体がない
> ASVS 10.2.3の1項目は「検査不能・スキップ」とする。合否を推測せず、他スレッドでも同じ分類を用いる。
> 現行の件数・検証結果は `docs/work-logs/2026-10-31.md` と
> `docs/guideline-conformance-evidence.html` を正とする。

> **実装状況 (2026-10-31、zcode による引き継ぎ後)**: P0〜P2を実装済み。
> - P0: 9テーマのUI入力schema欠落を解消 (`apps/desktop/src/renderer/theme-schema.ts` +
>   `apps/desktop/test/unit/theme-schema.test.ts`)。テーマ17は引き続き実行対象外。
> - P1: `OtpInboxPort`、OTP判定関数、テーマ6の reuse/expiry/attempt-limit/destination-change
>   sub-check、V/F unit test、UI入力を実装。実mailbox adapterは許可済みfixtureの用意待ち。
> - P2: `SamlFixturePort`、`judgeSamlAssertionReplay`、テーマ6への統合、V/F unit testを実装。
>   実IdP/SP fixture adapterは用意待ち。
> - P3: 専用transportと二段parser fixtureが整備されるまで着手しない (本資料の規定どおり)。
> - 作業記録: `docs/work-logs/2026-10-31-p0-p2-implementation.md`、
>   経緯概要は `docs/work-logs/2026-10-31.md` 「引き継ぎ後の実装」節。

## 1. 引き継ぎ先が最初に把握すること

- repository: `C:\Users\GoSugawara\src\ScopePilot2`
- branch: `main`
- handoff作成時HEAD: `f3d5a869a8843149afc36d4507192fb861ec0bdb`
- Orca worktree: `18f3b6d5-3005-4987-bfc9-cab7b3df9664::C:/Users/GoSugawara/src/ScopePilot2`
- 正式な起動対象: TypeScript / Electron版
- 起動コマンド: `npm run start --workspace @scopepilot2/desktop`
- 現在のworktreeには本作業の未commit変更が多数ある。利用者の作業を含む可能性があるため、
  `git reset --hard`、`git checkout --`、一括削除を行わないこと。
- 本資料でいう「Daybreakで対応できなかった」は、モデルがコードを書けないという意味ではない。
  現在のfixture、権威ある入力、安全に取得できる証拠だけでは合否境界を実証できなかったものを指す。

## 2. 依頼の経緯

1. ガイドラインを選択して診断計画へ固定し、Simple / Advanced UIから実行できるようにする作業を開始した。
2. ZAPだけでは実行できない項目はScopePilot独自のHTTP検査または補助engineで実装した。
3. 利用者から「現在実行中のDaybreak Blueで対応できないタスクだけを一覧化し、後回しにする」と条件が修正された。
4. 公式WebAppPentestGuidelines repositoryが提示され、第1.2版をcommitとSHA-256で固定した。
5. 各ガイドラインについて、ソースコードを引用して理論上の診断能力を説明するHTMLを作成した。
6. HTMLは最終的に OWASP Top 10、ASVS、WSTG、DS-221、WebAppPentestGuidelines の5標準へ限定し、
   HTTP要求・応答、HTTPSハンドシェイク、HTTP配信されたブラウザ動作から判定できる441項目だけを掲載した。

## 3. 現在実装済みの範囲

### 3.1 ガイドラインカタログ

- catalog schema: `scopepilot2.catalog.v2`
- catalog hash: `cf38c2b82971e2e1f6dec8ae09f2dc0045c37d9e1ab801531ddc342839461a09`
- 全7標準・871項目
  - OWASP Top 10-2025: 46
  - OWASP ASVS 5.0: 345
  - OWASP WSTG 4.2: 97
  - OWASP AISVS 1.01: 213
  - OWASP CNAS Top 10: 26
  - デジタル庁 DS-221: 42
  - WebAppPentestGuidelines v1.2: 102
- WAPG公式source:
  - commit: `bcc4df46a7371ea0860e0d0900a22f89286ce5b8`
  - Excel SHA-256: `bc25519a2b270e5c244cebdf26a08dd1387de7e08143f3ffbd71f2e8e5306dd8`
  - ID: `WAPG-1.2-001`～`WAPG-1.2-102`
  - 本文とpayloadは複製せず、公式URL、原本行、coverage routeだけを保持する。

### 3.2 計画と実行

- 選択したガイドラインは `ExecutionPlan.guidelineIds`、plan hash、利用者確認へ含まれる。
- OWASP Top 10、ASVS、WSTG、WAPG等は共通21 workflow checkへ解決される。
- DS-221はworkbook上で直接対応を確認できた9 workflow checkへ解決される。
- 実行経路:

```text
UI guideline selection
  -> ExecutionPlan.guidelineIds
  -> plan hash / PlanConfirmation
  -> resolveWorkflowScanCheckIds()
  -> ScopePilot workflow / ZAP / Nuclei / ZAP非対応テーマ
  -> request log / response hash / finding / run evidence
```

- ScopePilot自身が送る通信はscope、Origin、request budget、秘密値伏せ字を送信経路で強制する。
- ZAP / Nucleiは外部engineなので、scope入力、起動停止、出力観測によるDelegated保証として扱う。
  個々の送信をScopePilotが完全制御したとは表示しない。

### 3.3 ZAP非対応テーマ

- 独自handler実装済み24テーマ:
  `1,2,3,4,5,6,7,9,10,11,13,14,15,16,18,20,21,22,23,24,25,26,27,29`
- 既存workflowで自動実行する4テーマ: `8,12,19,28`
- 技術的に未実装: テーマ17（request smuggling / parser差異）
- `summarizeThemeOutcomes()` は、未実施観点、入力不足、inconclusiveがあればpassにしない。
- テーマ6はMFA段階スキップだけ実装済み。OTPとSAMLの残りを段階スキップ結果から推測しない。

### 3.4 実測済みfixture

- 実DVWA:
  - ASVS選択時に21 checkを検出または理由付きskipとして記録
  - DS-221選択時に9 checkへ切替
  - password等が要求証跡へ残らないことを確認
  - テーマ24と25の実HTTP通信を確認
- vulnerabilitiesBox V/F境界:
  - GraphQL深さ制限
  - WebSocket Origin / CSWSH
  - JWT `alg=none`
  - mail header CRLF
  - LDAP filter injection
  - SSRF
  - MFA段階スキップ

## 4. 現行設計の重要な境界

### 4.1 レイヤー境界

- contracts: API、plan、event、共有型
- core: 案件、scope、認可、plan、診断判定、証跡方針
- adapters: HTTP、WebSocket、ZAP、Nuclei、Playwright等の実送信
- desktop main: adapterの組み立てとlocal API
- renderer: Fluent UIによる入力・表示

Coreはadapterの具体実装へ依存せず、`packages/core/src/ports/engines.ts` のportだけを参照する。
OTP inboxやrequest smuggling transportを追加する場合も、この境界を維持する。

### 4.2 証跡方針

- password、OTP、Cookie値、SAML assertion本文は監査、API応答、HTML報告へ保存しない。
- 保存してよいのは、実行時刻、対象、probe種別、HTTP status、body hash、件数、判定、skip理由、
  engine / fixture version等の非秘密情報だけとする。
- 「HTTP 2xxだった」だけでは脆弱性成立としない。正常対照、期待結果、markerまたはoracleが必要。
- 材料不足は `inconclusive` とし、`pass`へ倒さない。

### 4.3 安全制御

- 全対象URLを案件scopeで検証する。
- request budgetを送信前に検査する。
- redirectは自動追従せず、必要なら各段を再検証する。
- OTP、SAML、smugglingは対象固有のfixtureなしで一般Webサイトへ試行しない。
- DoS、負荷、長時間待機を通常診断へ混ぜない。

## 5. コードレビューで判明している構造上の不足

### 5.1 標準項目IDとruntime checkの対応

- Top10・ASVS・WSTGは標準項目IDごとのruntime mappingを持たず、選択すると共通21 checkを実行する。
- DS-221は9 checkのみを明示選択する。
- WAPGはNo.1～102にcoverage routeがあるが、No範囲単位のmappingであり、各No専用assertionではない。
- HTMLコードレビューではHTTP観測対象441項目を次のように集計した。
  - ScopePilotコード経路: 328
  - 外部engine経路: 61
  - 個別接続未確認または未実装: 52
- 52件すべてがDaybreak制限ではない。多くはitem IDから実行関数への明示mappingがないことを表す。

推奨改善:

```ts
interface GuidelineCoverageRoute {
  guidelineId: string;
  itemId: string;
  routeId: string;
  routeKind: 'workflow' | 'zap' | 'nuclei' | 'theme' | 'manual-http';
  assertionId: string;
  evidenceRequirements: readonly string[];
}
```

catalog生成時に全HTTP項目へこれを付与し、計画、実行結果、assurance reportが同じmappingを参照する。
報告用generatorだけの推定mappingをruntimeの証明として扱わないこと。

### 5.2 UIの実行フォーム未接続

`IMPLEMENTED_THEME_NOS` は24テーマを実装済みとして表示するが、`THEME_SCHEMA` に次の9テーマがない。

`6,9,14,15,16,24,25,26,27`

このため実行ボタンは表示されるが、`ThemeRunner` はschema未定義時に `null` を返し、UIから入力・実行できない。
Core APIとunit / integration testは存在する。次のagentはまずこの不整合を修正すること。

推奨:

- themeごとの入力を単なる文字列field配列ではなく、型、secret扱い、必須、説明、候補を持つschemaへ拡張する。
- target URLの順番に意味があるtheme 6等は、単一Textareaではなく名前付き入力へする。
- UI schemaとCore validationがずれないテストを追加する。

## 6. 実装として残るタスク

優先順位は P0 → P1 → P2 → P3 とする。

### P0: 現行変更の保全とUI不整合の修正

1. dirty worktreeを壊さず、現在のテスト基準を再確認する。
2. 上記9テーマの `THEME_SCHEMA`、日本語・英語resource、renderer testを追加する。
3. テーマ6の既存MFA段階スキップをUIから実行できることを確認する。
4. テーマ17は実装完了まで実行ボタンを表示しない。

### P1: OTP寿命・再利用・試行制限・宛先変更

#### 必要な前提

- 許可済みの私有OTP inbox fixture
- 診断専用アカウント
- OTP発行、検証、宛先変更endpointと期待結果
- fixture clockまたは短いテスト用有効期限

#### 推奨port

`packages/core/src/ports/engines.ts` に、OTP値を永続化しない専用portを追加する。

```ts
interface OtpInboxPort {
  readonly engineVersion: string;
  waitForOtp(input: {
    mailboxRef: string;
    issuedAfter: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ otp: string; receivedAt: string } | null>;
}
```

- `mailboxRef` はsecret値そのものではなく、許可済みfixture設定の参照にする。
- OTPはCoreとadapterの呼出中だけ保持し、probe resultには値を入れない。
- 実adapterは許可されたfixtureだけを接続先とし、任意の外部mailboxへ接続しない。

#### probe設計

1. 正常対照: 新規OTPを発行し、期限内に1回だけ受理されることを確認。
2. 再利用: 正常使用済みOTPを同一session / 同一challengeで再送。受理なら `fail`、拒否なら当該probeは `pass`候補。
3. 寿命: fixture clockを進めるか、短期fixtureで期限後に再送。長い実sleepを製品経路に入れない。
4. 試行制限: 事前合意した少数回だけ誤OTPを送る。アカウントロック等の副作用を明示する。
5. 宛先変更: 認証済みsessionで再認証なしの宛先変更が成立するか比較。変更後の通知だけで安全とみなさない。

各probeは正常対照が成立しない場合 `inconclusive`。HTTP statusだけでなく、対象固有markerまたはfixture stateで判定する。

#### Theme 6への統合

- 既存 `runZapUnsupportedCheck()` のtheme 6を、次のsub-checkへ分割する。
  - `mfa-stage-skip`
  - `otp-reuse`
  - `otp-expiry`
  - `otp-attempt-limit`
  - `otp-destination-change`
  - `saml-assertion-replay`
- sub-checkごとに必要入力がなければ、そのsub-checkだけskipし全体を `inconclusive` にする。
- 全sub-checkを同じ結果から推測しない。

### P2: SAML assertion replay

#### 必要な前提

- 隔離された試験IdP / SP
- 診断専用ユーザー
- entity ID、ACS URL、正常ログインmarker、ログアウト / session reset手段
- replay前後の期待結果

#### 推奨port

Playwright login flowまたは専用 `SamlFixturePort` を使い、正常ログイン時のSAMLResponseを一時的に取得する。

```ts
interface SamlFixturePort {
  readonly engineVersion: string;
  issueAndReplay(input: {
    idpStartUrl: string;
    acsUrl: string;
    role: string;
    signal?: AbortSignal;
  }): Promise<{
    controlAccepted: boolean;
    replayAccepted: boolean | null;
    controlStatus: number | null;
    replayStatus: number | null;
    assertionHash: string;
  }>;
}
```

- assertion本文、署名、NameIDを保存しない。
- 新しいassertionを生成・改ざんせず、試験IdPが正規発行した1件を同一条件で再送する。
- 正常対照が成功し、同一assertionの再送が新しいsessionとして受理された場合だけ `fail`。
- IdP / SPのsession状態を区別し、単なる既存session継続をreplay成立と誤認しない。

### P3: テーマ17 request smuggling / parser差異

#### 現行設計との関係

`docs/design/13-websocket-http2.md` は、request smugglingのようなwire忠実性が必要な機能を、
専用transportとfixtureが追加されるまで公開しないと規定している。
通常の `NodeRepeaterTransport`、ZAP、Node `http` / `https` はheader正規化を行うため流用しない。

#### 必要なfixture

```text
ScopePilot raw client
  -> isolated frontend proxy/parser
  -> isolated backend parser
  -> oracle endpoint / request queue
```

- frontendとbackendで異なるparserを使うV fixtureと、同一解釈をするF fixtureを用意する。
- canaryを付け、後続要求の誤配送をoracleで一意に確認できること。
- localhostまたは隔離networkだけで実行する。一般の許可Originであることだけを実行条件にしない。

#### 推奨port

```ts
interface RequestSmugglingTransportPort {
  readonly engineVersion: string;
  probe(input: {
    target: string;
    variant: 'cl-te' | 'te-cl';
    canary: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{
    controlComplete: boolean;
    oracleObserved: boolean | null;
    responseStatus: number | null;
    responseHash: string;
    bytesSent: number;
  }>;
}
```

- adapterは `net` / `tls` 等でreview済みraw bytesを送る。任意raw payload入力をUIへ公開しない。
- Coreが許可した定型variantだけを使う。
- concurrency 1、少数要求、redirectなし、接続再利用の回数固定。
- timeout、connection close、5xxだけでは脆弱性と判定しない。oracleが必須。
- 正常control、V fixture、F fixtureの3境界をテストする。
- 実装とfixture検証完了後にだけ、theme 17を `ZAP_UNSUPPORTED_IMPLEMENTED_THEMES` とUIの実行対象へ追加する。

## 7. 実装では解決しないタスク

次の2件はHTTP診断機能として実装しない。別のレビュー証跡機能を将来作る場合も、診断結果と混同しない。

1. ASVSの内部設計・構成・運用要件
   - 必要証拠: 設計、構成、ソース、鍵管理、ログ運用、レビュー権限
2. DS-221の調達・契約・実施プロセス要件
   - 必要証拠: 契約、実施計画、承認、報告、確認者

これらは `docs/guideline-conformance-evidence.html` のHTTP診断項目から除外済み。

## 8. 主な変更ファイル

### ガイドライン・計画

- `packages/contracts/src/plan/plan.ts`
- `packages/core/src/domain/plan-service.ts`
- `packages/core/src/domain/workflow-scan.ts`
- `tools/guideline-catalog/src/generate.ts`
- `docs/generated/guideline-catalog.json`
- `docs/design/27-security-guidelines.md`

### ZAP非対応テーマ

- `packages/core/src/domain/zap-unsupported.ts`
- `packages/core/src/application/baseline-flow.ts`
- `packages/core/src/application/api-server.ts`
- `packages/core/src/ports/engines.ts`
- `apps/desktop/src/renderer/guidelines-catalog.tsx`
- `apps/desktop/src/renderer/resources.ja.ts`
- `apps/desktop/src/renderer/resources.en.ts`
- `docs/ZAP-UNSUPPORTED-THEME-DIAGNOSTICS.md`

### tests

- `packages/core/test/unit/application/zap-unsupported-check.test.ts`
- `packages/core/test/unit/business-logic/zap-unsupported.test.ts`
- `packages/adapters/test/workflow-scan.test.ts`
- `packages/adapters/test/workflow-scan-simple-flow.test.ts`
- `packages/adapters/test/dvwa-workflow-guidelines.integration.test.ts`
- `packages/adapters/test/vulnerabilitiesbox-guideline.integration.test.ts`

### HTML証跡

- `docs/guideline-conformance-evidence.html`
- `tools/report-tools/generate-guideline-conformance-evidence.mjs`
- `tools/report-tools/verify-guideline-conformance-evidence.mjs`
- `docs/work-logs/2026-10-31.md`

## 9. 検証コマンド

```powershell
Set-Location -LiteralPath 'C:\Users\GoSugawara\src\ScopePilot2'
npm test
npm run typecheck
npm run build --workspace @scopepilot2/desktop
node tools/report-tools/generate-guideline-conformance-evidence.mjs
node tools/report-tools/verify-guideline-conformance-evidence.mjs
git diff --check
```

focused tests:

```powershell
node --test packages/core/test/unit/application/zap-unsupported-check.test.ts
node --test packages/core/test/unit/business-logic/zap-unsupported.test.ts
node --test packages/adapters/test/workflow-scan.test.ts
node --test packages/adapters/test/workflow-scan-simple-flow.test.ts
```

DVWA gated test:

```text
SCOPEPILOT_DVWA_BASE_URL
SCOPEPILOT_DVWA_USERNAME
SCOPEPILOT_DVWA_PASSWORD
node --test packages/adapters/test/dvwa-workflow-guidelines.integration.test.ts
```

vulnerabilitiesBox gated test:

```text
SCOPEPILOT_VBOX_BASE_URL
SCOPEPILOT_VBOX_LOGIN_PATH
SCOPEPILOT_VBOX_TARGET_PATH
SCOPEPILOT_VBOX_TOKEN_PATH       # JWTのみ
SCOPEPILOT_VBOX_PROTECTED_PATH   # MFA段階スキップのみ
SCOPEPILOT_VBOX_CHECK_KIND
SCOPEPILOT_VBOX_EXPECTED=exposed|denied
node --test packages/adapters/test/vulnerabilitiesbox-guideline.integration.test.ts
```

## 10. 受け入れ条件

### OTP / SAML

- V/F fixtureで同一入力seedの境界が確認できる。
- 正常対照なしでfail / passを出さない。
- OTP / assertion本文がAPI、event、log、evidence、reportへ出ない。
- 未実施sub-checkがあればtheme全体をpassにしない。
- UI、API、Core validation、unit test、integration testが同じinput schemaを共有する。

### Request smuggling

- 専用raw transportと二段parser fixtureがある。
- oracleによる誤配送確認なしでfailにしない。
- 通常の外部対象ではcapability validationが拒否する。
- V fixtureで検出、F fixtureで非検出、control不成立でinconclusiveになる。
- 完了前はtheme 17の実行ボタンを表示しない。

### 共通

- scope、認可、plan hash、request budget、秘密値保護を維持する。
- `npm test`、typecheck、desktop build、HTML verifier、`git diff --check`が成功する。
- 実装後、`docs/ZAP-UNSUPPORTED-THEME-DIAGNOSTICS.md`、設計文書、work log、HTML証跡を更新する。

## 11. 次のagentへの開始手順

1. `AGENTS.md`を読み、本資料と `docs/work-logs/2026-10-31.md`を確認する。
2. `git status --short`で既存変更を確認し、変更を消さない。
3. focused testsを実行して現在の基準を確認する。
4. P0のUI schema不整合を先に修正する。
5. OTP / SAMLはfixtureと期待結果を先に固定し、port → Core判定 → adapter → UI → V/F testの順で実装する。
6. theme 17は専用fixtureが用意できるまでimplemented listへ追加しない。
7. HTTP外要件を自動診断済みとして扱わない。
