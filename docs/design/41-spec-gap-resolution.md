# 41 仕様ギャップ解消設計

作成日: 2026-11-10  
対象: ScopePilot2 TypeScript/Electron 版  
状態: 実装前設計

## 1. 目的と前提

本書は、仕様把握と現行実装の照合で判明した横断的な不整合を解消し、次の状態を作るための設計である。

- 選択したガイドラインの各項目について、何を、どの経路で、どの保証等級で、どこまで実行したかを追跡できる。
- 自動実行、追加入力待ち、能力不足、検査不能、実行失敗、判定保留を混同しない。
- API契約、実行状態、runtime adapter、証跡、報告が同じ正本を参照する。
- fixtureは試験環境に閉じ込め、本番構成の欠落を成功応答で隠さない。
- `BaselineFlowService` の既存挙動を保ったまま、概要設計の横断サービスへ段階的に分割する。
- 2026-11-05の残課題とA4配布課題に、依存関係と受け入れ条件を与える。

調査の基準時点は2026-11-10である。実装事実は未コミット28ファイルを含む
`C:\Users\GoSugawara\src\ScopePilot2`、設計の正本は同リポジトリの`AGENTS.md`、
`docs/burp-professional-replacement-spec.md`、`docs/design/**`、`docs/detailed-design/**`、
`docs/work-logs/**`とした。既存の仕様把握レポート
`C:\Users\GoSugawara\AppData\Local\Temp\claude_spec.md`は調査の起点として用いた。

本書は設計のみを扱う。Advancedモードの画面構成、ナビゲーション、詳細レイアウトは
別担当の[40 Advancedモード再設計](40-advanced-mode-redesign.md)を正とする。本書は、40が表示するために必要な
coverage、capability、実行状態、API view modelと、画面に必ず出す意味だけを定義する。40が未作成または変更中でも、
本書のdomain/API契約を画面都合で変更しない。

### 1.1 優先度

| 優先度 | 意味 |
|---|---|
| P0 | 契約違反、誤った実施表示、fixtureへのfail-openなど、現在の結果を誤解させる問題。次の機能追加より先に解消する |
| P1 | 自動診断の実効性、構造分割、探索能力を高める問題。P0の正本を使用して実装する |
| P2 | 高度能力、性能、runtime更新、配布準備。A3/A4 gateとして実施する |
| P3 | 外部入力または専用検証環境がなければ完了できない事項。未実施を明示したまま待てる |

### 1.2 横断的な設計決定

1. ガイドラインcoverageの正本は、項目ID単位の版付き`GuidelineCoverageRoute`とする。テーマ一覧や報告生成時の推定は正本にしない。
2. 実行の正本は`packages/contracts`の`RunState`とし、`Completed`、`Stopped`、`Failed`、`Interrupted`を終端状態とする。
3. 実行したかどうかと、検査結果がpass/failかは別の軸にする。`needs-input`は検査結果ではない。
4. 本番runtimeは実adapterまたは明示的な`Unavailable`だけで構成する。依存欠落時にfixtureへ降格しない。
5. 外部エンジンは[22](22-execution-control.md)の`Delegated`、ScopePilot自身の送信は`Enforced`として表示し、両者を同じ「自動実行済み」に畳み込まない。
6. ガイドライン項目、route、assertion、payload、外部engine capabilityはruntime bundleに固定し、run開始時のsnapshotを不変保存する。

## 2. ガイドラインテーマの自動実行拡大

### 2.1 現状と原因

`packages/core/src/domain/guideline-execution.ts`がactive scanへ自動接続するのは、テーマ13、24、25、30だけである。
テーマ8、12、19、28は汎用workflowで実行されると文書化されているが、テーマrouteの正本には現れない。
残る実装済みテーマはA03から対象固有URL、role、秘密値、比較条件、payload、fixture等を入力して実行するため、
Simpleの通常実行では`needs-input`のまま残る。

原因は、テーマを「常に自動」か「A03で手入力」の二値で分類しており、探索・login・API仕様取込から得た入力を
安全に自動充足する中間層がないこと、また項目IDとruntime routeが結び付いていないことである。

### 2.2 自動化クラス

| クラス | 意味 | 実行計画での扱い |
|---|---|---|
| `automatic` | 採用済み対象と既定の安全なprobeだけで実行可能 | plan作成時に自動採用し、予算を予約する |
| `conditional-automatic` | 既存の案件資産から必要入力を一意に解決できる場合だけ自動実行可能 | preconditionを評価し、満たせばplanへ追加、満たさなければ入力要求を生成する |
| `operator-workflow` | 状態変更、比較主体、復元、対象固有oracle、審査済みpayloadが必要 | Simpleでは必要事項と未実施理由を表示。Advancedでは40の入力・review導線から子計画を作る |
| `external-fixture` | mailbox、IdP/SP、OAST等の許可済み外部設備が必要 | capabilityと認証専用egressが揃ったときだけ公開する |
| `unsupported` | 現在の製品境界では成立判定できない | planへ送信stepを作らず、理由と再開条件をsnapshotする |

### 2.3 テーマ別の到達設計

| テーマ | 現在 | 目標クラス | 自動化方法または残す制約 |
|---|---|---|---|
| 1 認証回避・強制ブラウジング | 個別入力 | conditional-automatic | login flowの認証後URL、認証前後session、assert markerを使う。認証Cookieを一意に特定できない場合は入力待ち |
| 2 既定資格 | 個別入力 | conditional-automatic | document hintに出典付き既定資格候補があり、診断専用login flowへ結び付く場合だけ最大10組を実行。一般辞書は使わない |
| 3 パスワード方針 | 個別入力 | operator-workflow | 診断用アカウント、変更flow、復元flowを必須とする。保存形式レビューは自動結果へ含めない |
| 4 リセット | 個別入力 | external-fixture | リセットflow、診断用mailbox、正常対照、復元を必須とする。token総当たりは行わない |
| 5 ロックアウト | 個別入力 | operator-workflow | 診断専用アカウント、許可試行数、解除手段を要求。大量・高速試験は別の負荷試験として対象外 |
| 6 MFA・OTP・SAML | 一部実装、fixture限定 | external-fixture | §4の実adapterと認証専用egressが揃ったsub-checkだけ実行。未実施sub-checkをpassへ畳み込まない |
| 7 ユーザー列挙 | 個別入力 | conditional-automatic | 有効な診断用ユーザーと、存在しないことを確認した比較名が案件資産にある場合、同一誤資格で少数比較する |
| 8 | 汎用workflow | automatic | item mappingから対応workflow assertionへ明示接続し、テーマrouteにも実行記録を投影する |
| 9 OAuth・OIDC・JWT | 個別入力 | conditional-automatic | login時にmemory-onlyで観測したJWTと対象Originを使用。state/nonce/PKCE等は認可flow定義がない限り未実施 |
| 10 機能・オブジェクト認可 | 個別入力 | conditional-automatic | 2つ以上のrole session、所有主体、具体化済みID、正常対照が揃う場合に差分実行。推測IDは使わない |
| 11 フィールド認可 | 個別入力 | operator-workflow | API schemaまたは観測要求から正常bodyを作り、審査済み追加field、反映oracle、復元flowを要求する |
| 12 | 汎用workflow | automatic | テーマ8と同様にitem mappingから既存assertionへ接続する |
| 13 CORS | 自動 | automatic | 現行の限定Origin probeを継続し、資格情報の実適用とブラウザ成立条件を証跡化する |
| 14 メールヘッダー | 個別入力 | external-fixture | 閉域mail sinkと配送header oracleがある場合だけ自動化。2xxだけで成立としない |
| 15 ZAP対象外注入 | 個別入力 | operator-workflow | 正常値とreview済み変異値、成功markerまたは時間oracleをtemplate化。任意生成payloadは採用しない |
| 16 SSRF | 個別入力 | external-fixture | 自己ホストOASTまたは許可済み内部fixtureとの相関がある場合だけ成立判定。受付応答だけではfailにしない |
| 17 request smuggling | 未実装 | unsupported | §4.1の決定に従い送信しない。専用raw transport、二段parser、誤配送oracleが揃うまで再開しない |
| 18 デシリアライゼーション | 個別入力 | automatic | 観測済みrequest corpusの受動signature分類は自動化。ガジェット実害実証は別routeとして未実施に残す |
| 19 | 汎用workflow | automatic | item mappingから既存assertionへ接続する |
| 20 業務ロジック・競合 | 個別入力 | operator-workflow | workflow、期待結果、復元、冪等性、並行上限を必須とする。汎用の順次比較だけでrace安全を断定しない |
| 21 入力検証の堅牢性 | 個別入力 | conditional-automatic | 観測入力点と版固定payloadの低回数probeを自動化。状態変更入力、秘密値らしい入力は除外する |
| 22 TLS・証明書 | 個別入力 | conditional-automatic | 審査済みNuclei/OpenSSL相当adapterとmanifestがあるときだけ実行し、engine結果はDelegatedで表示する |
| 23 平文・混在コンテンツ | 個別入力 | automatic | HTTPSページのbrowser観測、redirect chain、subresource schemeから受動判定する |
| 24 ブラウザ保護 | 自動 | automatic | 現行probeを継続。欠落だけで攻撃成立とせず、対象文脈と制約を残す |
| 25 HTTP method | 自動 | automatic | OPTIONS、TRACE/TRACKまでを既定自動化。PUT/DELETE/PATCHは副作用reviewなしに送らない |
| 26 GraphQL | 個別入力 | conditional-automatic | endpointと正常queryを観測できた場合、introspectionと上限付き深さ/コストqueryを生成。正常対照なしは入力待ち |
| 27 WebSocket | 個別入力 | conditional-automatic | 観測済み接続、実transport、role sessionが揃う場合にOrigin比較。fixture台帳では実施済みにしない |
| 28 | 汎用workflow | automatic | item mappingから既存assertionへ接続する |
| 29 データ保護・機微露出 | 個別入力 | conditional-automatic | 公開応答と静的素材を版固定patternで受動検査。秘密値候補はmasked fingerprintだけを保持する |
| 30 公開情報・構成情報 | 自動 | automatic | 現行の限定公開面probeを継続し、辞書版、404負対照、上限を証跡化する |

### 2.4 変更対象、テスト、優先度

| 項目 | 設計 |
|---|---|
| 変更ファイル/API | `packages/core/src/domain/guideline-execution.ts`をpreconditionベースへ置換し、`guideline-coverage.ts`、`guideline-input-resolution.ts`を追加する。`ExecutionPlan`へroute snapshot hashを追加。`GET /api/guidelines/coverage`で計画前の見込みを返す |
| テスト | 全30テーマが上記5クラスのいずれかに一意分類されること、入力を推測しないこと、条件未充足時に送信しないこと、予算予約、停止、passへの誤集約防止をunit/contract/fixtureで確認する |
| 優先度 | P0: 正しい表示とroute正本、P1: conditional自動化、P2/P3: 外部fixtureを要するroute |
| 依存 | §3の項目mapping、§8のruntime profile、§9のサービス分割。状態変更系は復元workflowと§5の状態機械が先 |

## 3. 項目ID単位の`GuidelineCoverageRoute`

### 3.1 現状と原因

Top10、ASVS、WSTGは項目ID別runtime mappingを持たず、選択時に現行9個の汎用HTTPチェックへ解決される。
DS-221は現行6個へ絞られる。WAPGのrouteもNo範囲単位があり、項目専用assertionとは限らない。
`docs/guideline-conformance-evidence.html`の対応はコードレビュー時の推定を含み、runtimeの証明には使えない。

原因は、catalog、plan、実行結果、assurance reportが別々の粒度でrouteを解決しているためである。

### 3.2 正本モデル

```ts
interface GuidelineCoverageRoute {
  routeId: string;                 // 版内で安定、一意
  catalog: {
    catalogId: string;
    version: string;
    sha256: string;
  };
  guidelineId: string;
  itemId: string;
  routeKind:
    | 'workflow'
    | 'theme'
    | 'zap-rule'
    | 'nuclei-template'
    | 'browser'
    | 'manual-review'
    | 'unsupported';
  assertionIds: readonly string[];
  inputSchemaRefs: readonly string[];
  targetSelectorId: string;
  evidenceRequirements: readonly string[];
  guarantee: 'Enforced' | 'Delegated' | 'Unsupported';
  completionPolicy: 'all' | 'any' | 'manual';
  applicabilityRuleId: string;
  limitationCodes: readonly string[];
  reviewedBy: string;
  reviewedAt: string;
}
```

`assertionId`は判定ロジックの安定IDであり、関数名や行番号にしない。1項目から複数route、1routeから複数項目への
many-to-manyを許す。同じgeneric assertionを複数項目が共有してもよいが、「共有している」ことを明示し、項目専用検査と表示しない。

runにはroute全体を複製せず、`GuidelineRouteSnapshot`としてcatalog識別子、item ID、route ID、assertion ID、
evidence要件、保証等級、route hash、当時の短いlabelを不変保存する。bundle更新は新snapshotを作り、過去runを書き換えない。

### 3.3 実行結果モデル

単一の`status`に実行状態と診断結果を混在させない。

```ts
interface GuidelineItemExecution {
  runId: string;
  itemId: string;
  routeId: string;
  executionStatus:
    | 'not-planned'
    | 'needs-input'
    | 'unavailable'
    | 'queued'
    | 'running'
    | 'completed'
    | 'prohibited'
    | 'stopped'
    | 'failed';
  assessment: 'pass' | 'fail' | 'inconclusive' | 'not-applicable' | 'not-assessed';
  guarantee: 'Enforced' | 'Delegated' | 'Unsupported';
  evidenceRefs: readonly string[];
  missingInputCodes: readonly string[];
  limitationCodes: readonly string[];
}
```

項目の集約は`completionPolicy`で決める。1routeでもfailなら項目はfail、必須routeに未完了があれば検出なしでも
`inconclusive`または`not-assessed`とする。探索URLが存在するだけで項目を「一部実施」にしない。

### 3.4 生成、検証、API

- `tools/guideline-catalog`がcatalogとcoverage routeを同時生成し、手書きの別表を作らない。
- build時に、HTTP観測対象項目の全件が1件以上のrouteまたは明示的`unsupported`を持つことを検査する。
- `assertionIds`は実装側のregistryと双方向parityを検査し、存在しないassertionや未参照assertionを失敗にする。
- plan hashには選択項目集合、route snapshot hash、input resolution結果、capability snapshotを含める。
- `GET /api/guidelines/coverage?guidelineId=...`は項目別の計画見込みを返す。
- `GET /api/runs/{runId}/guideline-coverage`は実行結果を返す。既存`ReportModel.coverage`はこの応答と同じ型を参照する。
- assurance reportは当該APIモデルをそのまま投影し、独自にrouteを推定しない。

| 項目 | 設計 |
|---|---|
| 変更ファイル/API | `docs/generated/guideline-catalog.json`のschema更新、`tools/guideline-catalog/**`、`packages/contracts/src/guidelines/**`、OpenAPI、`ExecutionPlan`、`packages/core/src/domain/guideline-coverage.ts`、`apps/desktop/src/main/assurance-report.ts` |
| テスト | catalog golden、全項目route完全性、assertion registry parity、plan hash失効、run snapshot不変性、report同値性。Top10/ASVS/WSTG/DS-221/WAPGから代表項目とunsupported項目を固定fixtureで確認する |
| 優先度 | P0 |
| 依存 | 先行条件なし。§2、§6、§7、§9の正本になるため最初に実装する |

## 4. テーマ17、ASVS 10.2.3、テーマ6の実adapter

GO-23確定（2026-11-10）: §4.1・§4.2は現行bundleで「検査不能・スキップ」を維持する。
限定実装せず、対象外（not-applicable）やpass/failへ読み替えない。
コード正本、報告契約、再開条件は[43](43-unsupported-assessment-policy.md)。テーマ分類は[42](42-guideline-theme-automation-policy.md)に従う。
§14の未決事項1・2はこの現行bundle方針で解決し、将来の機能公開は再開gateを満たす別実装とする。

### 4.1 テーマ17 request smuggling

現行の「検査不能・スキップ」を維持する。通常のNode HTTP client、ZAP、Repeaterはheaderを正規化するため、
それらを流用した結果をrequest smugglingの合否にしない。coverage routeは`routeKind=unsupported`、
`guarantee=Unsupported`、理由`RAW_TRANSPORT_AND_DUAL_PARSER_ORACLE_MISSING`を持つ。

再開条件は、対象から隔離したfrontend/backend二段parser fixture、byte列を保持する専用transport、誤配送を観測する
一意token oracle、connection reuseとtimeoutの上限、停止・証跡方針が揃うことである。再開してもfixtureで能力を実証した
runtime bundleだけで公開し、一般対象へ曖昧なprobeを送らない。

### 4.2 ASVS 10.2.3

OAuth scopeの最小性は、HTTP応答だけでは「業務上必要なscope」を決められない。現行bundleでは
`not-assessed/unsupported`とし、テーマ17へ誤って対応付けない。将来は、オーナー承認済みの
`OAuthScopePolicy`（client ID、flow、必要scope、禁止scope、resource、比較主体、根拠文書）を案件資産として追加した場合だけ、
実際のgrant/token scopeとの差分を`manual-review`または`conditional-automatic`で評価する。policyなしではpassを作らない。

### 4.3 テーマ6のproduction adapter

現行の`HttpSecurityFixtureOtpInbox`と`HttpSecurityFixtureSaml`はloopback fixture controller専用であり、実mailboxや実IdPのadapterではない。
productionでは次のportとadapterへ分ける。

| 境界 | adapter | 条件 |
|---|---|---|
| OTP受信 | `MailpitOtpInboxAdapter` | 所有するMailpit/MailHog相当の閉域test mailbox。HTTPSまたはloopback、mailboxRef allowlist、SecretStore token、redirect禁止 |
| OTP受信 | `ImapOtpInboxAdapter` | 診断専用mailboxだけ。server/port/TLS pin、folder、宛先allowlist、SecretStore資格情報、受信時刻とchallenge相関を必須とする |
| SAML | `ControlledSamlReplayAdapter` | 承認済みIdP originと対象ACS、診断専用アカウント、新規session oracle、replay許可がある場合だけ。Playwright/proxyで正規assertionをmemory-only捕捉し、改ざんせず再送する |

port名はfixtureに限定しない`OtpInboxPort`と`SamlReplayPort`へ整理し、adapter descriptorに
`adapterKind: real|fixture`とcapabilityを持たせる。OTP、assertion、NameID、署名、Cookie、Authorizationはcontracts、event、
evidence、ログへ出さない。証跡はhash、時刻、status、対照成立、新規session判別結果、adapter versionだけを保持する。

IdPは診断対象Originへ暗黙追加せず、[22](22-execution-control.md)の`AuthenticationEgressPolicy`で別に許可する。
SAML replayはACSへの状態変更を伴うため、`PlanConfirmation`、診断専用アカウント、session cleanupを必須にする。

| 項目 | 設計 |
|---|---|
| 変更ファイル/API | `packages/core/src/ports/engines.ts`、`packages/adapters/src/security-fixture.ts`を分離し、新規OTP/SAML adaptersとruntime設定schemaを追加。`/api/capabilities`へadapter kindと制約を追加。coverage routeへASVS 10.2.3とテーマ17の理由codeを登録 |
| テスト | fixture/real識別、任意mailbox・任意IdP拒否、redirect拒否、TLS、secret非露出、OTP再利用/期限/試行上限、SAML新規session判別、停止、capability未構成時の非公開を確認する |
| 優先度 | テーマ17/ASVS表示はP0、OTP adapterはP1、SAML adapterとsmuggling再開はP3 |
| 依存 | §3 mapping、§8 runtime profile、SecretStore、認証専用egress。実adapterの完成にはオーナーが管理するtest設備が必要 |

## 5. 非同期scan APIと契約parity

### 5.1 現状と原因

`api-server.ts`と`wizard.tsx`は`/api/run/scan/start`、`status`、`stop`を使用するが、
`packages/contracts/src/openapi-routes.ts`と`packages/contracts/openapi/core-api.json`には載っていない。
現行parity testはOpenAPIと経路表の一致しか検査せず、server handlerとの一致を検査していないため見逃した。
さらに非同期実行台帳は`api-server.ts`内のmemory mapであり、process再起動後にstatusを復元できない。

### 5.2 契約

| Method / path | request | success response | 主なerror |
|---|---|---|---|
| `POST /api/run/scan/start` | plan、confirmation、adopted、任意role、idempotency key | 202 `ScanExecutionAccepted` | 400/403/409/422/503 |
| `GET /api/run/scan/status?executionId=...` | query `executionId` | 200 `ScanExecutionSnapshot` | 404 |
| `POST /api/run/scan/stop` | `executionId`、任意reason | 202 `ScanStopAccepted` | 404/409 |

`ScanExecutionSnapshot`は`executionId`、任意`runId`、canonical `runState`、`dispatchState`、progress、current engine、
bounded log cursor、result reference、errorを持つ。500行のlog配列を毎回返さず、`after` cursorで差分取得する。
秘密値を含むengine commandは返さない。stopは冪等とし、終端状態への再要求は現在状態を返す。

同期`POST /api/run/scan`はCLI/automation互換のため当面残すが、同じ`JobOrchestrator`を呼ぶ。Desktopは非同期APIを使う。
両経路が異なる認可、状態、証跡処理を持たないようにする。

### 5.3 parity検査

- route descriptorを`packages/contracts`の単一registryに置き、OpenAPI生成/検査とserver登録の両方が参照する。
- `api-server.ts`はdescriptor keyごとのhandler mapを公開し、契約testで「OpenAPI = route registry = handler registry」を比較する。
- query parameterを含むrouteもpathnameとparameter schemaを別々に検査する。
- renderer/CLIの利用pathは手書き文字列を段階的に生成clientへ置換する。
- handler registryにない分岐、未使用descriptor、operationId重複、request/response schemaのloose objectをCIで失敗にする。

| 項目 | 設計 |
|---|---|
| 変更ファイル/API | `openapi-routes.ts`、`core-api.json`、contractsのscan execution型、`api-server.ts`、storageのexecution/run repository、renderer API client |
| テスト | 3者parity、start→status→stop、stop冪等、同一idempotency key、再起動後status、log cursor、同期/非同期結果同値、未契約handler検出 |
| 優先度 | P0 |
| 依存 | §6状態機械を先に確定し、§9`JobOrchestrator`抽出と同じ境界で実装する |

## 6. 正とする実行状態機械

### 6.1 決定

正本は現在のcontractsと[22](22-execution-control.md)に合わせ、次とする。

```text
Draft -> Validated -> Authorized -> Confirmed -> Running
Running -> Stopping -> Stopped
Running -> Completed
Running -> Failed
Stopping -> Failed
Running/Stopping --crash recovery--> Interrupted
```

終端状態は`Completed | Stopped | Failed | Interrupted`である。`Succeeded`と`Cancelled`はrun stateとして使用しない。
成功は`Completed`、利用者停止および安全制御による協調停止は`Stopped`、予期しないengine/保存障害は`Failed`、
process消失または復旧時に実行継続を確認できない場合は`Interrupted`とする。再開は同じrunの遷移ではなくattemptを増やす。

`queued`はrun stateではない。非同期APIでは`dispatchState=queued|dispatched`を別に持ち、queue中の`runState`は`Confirmed`とする。
UIの小文字`running/completed`等は表示用文字列に限定し、APIではcanonical stateを返す。

### 6.2 stop reason制約

| 終端状態 | 許される主なreason |
|---|---|
| Completed | `completed` |
| Stopped | `user-request`、`budget-exhausted`、`scope-violation`、`authorization-expired` |
| Failed | `engine-failure`。証跡保存失敗等は将来の安定codeを追加するまでdetailsで区別する |
| Interrupted | `interrupted` |

domain errorの`Cancelled`はAPI error codeとして残してよいが、永続run stateは`Stopped`にする。
停止要求を受け付けた時点で`Stopping`、全子jobの停止と最終証跡保存を確認した時点で`Stopped`へ進める。

### 6.3 変更とテスト

| 項目 | 設計 |
|---|---|
| 変更ファイル/API | `docs/detailed-design/01-system-components.md`を本節へ整合、`run-state-machine.ts`、contracts/OpenAPI、`api-server.ts`のScanExecution、storage repository、UI resources |
| テスト | 全許可遷移と全不許可遷移、終端再開拒否、Running/Stoppingのcrash recovery、停止期限、reason整合、API projectionをproperty tableで確認する |
| 優先度 | P0 |
| 依存 | §5と§9の前提。migrationは既存値を変更せず、旧`Succeeded/Cancelled`がDBに存在する場合だけ明示migrationを行う |

## 7. 文書、件数、コメントの整合

### 7.1 現状

- `docs/design/27-security-guidelines.md`と2026-10-31 handoffには共通21チェック、DS-221は9チェックとあるが、現行
  `workflow-scan.ts`は9チェック、DS-221は6チェックである。
- `wizard.tsx`冒頭のS04〜S07が次増分というコメントは実装済みの現状と合わない。
- 現行`docs/design/**`を検索した限り、旧C#/WPFの再利用を実装前提にする記述は残っていない。
  `20`、`23`、`26`等のC#/WPF言及は「持ち込まない」という決定・移行記録であり削除対象ではない。
- `AGENTS.md`の「旧C#前提の箇所がある」という注意は、現行設計の実態より広い。履歴文書と現行設計を区別できていない。

### 7.2 解決方針

件数を固定の説明値として二重管理しない。coverage registryから`workflowAssertionCount`とプロファイル別件数を生成し、
設計書には「件数は生成artifactを正とする」と記載する。移行直後の基準値は現行に合わせ9/6とするが、§3の項目mapping導入後は
単純な件数だけでcoverageを説明しない。

handoffとwork logは履歴なので本文を書き換えず、先頭に現行値への注記または後継設計へのlinkを追加する。
`wizard.tsx`の古いコメントは実装時に削除または現状説明へ更新する。

`docs/design/**`にはCI lintを設け、`ScopePilot.csproj`、削除済みclass名、WPF/XAML/ViewModel共有等を実装指示として
新規追加した場合に失敗させる。ただし「使用しない」「移行しない」という否定文と要求トレーサビリティの履歴はallowlistする。
`AGENTS.md`は別の実装変更で「旧版由来の参考文書には残るが、現行`docs/design/**`はTypeScript前提」と事実へ更新する。

| 項目 | 設計 |
|---|---|
| 変更ファイル/API | 実装時に`docs/design/27-security-guidelines.md`、handoff注記、`wizard.tsx`コメント、`AGENTS.md`、生成件数artifact、docs lintを変更。API変更なし |
| テスト | 生成件数とregistryの一致、設計文書lint、wizard stepのE2E到達、履歴文書が正本扱いされないlink検査 |
| 優先度 | P0 |
| 依存 | 件数生成は§3に依存。古いコメントと注記は先行可能 |

## 8. `needs-input`と汎用チェックの関係、および表示

### 8.1 問題

汎用HTTPチェック、ZAP/Nuclei、テーマhandler、browser検証が同じ項目を部分的に覆う一方、現行表示はテーマrouteの
`executed/delegated/needs-input/unavailable`へ寄っている。このため、汎用チェックが動いた項目をテーマ全体の実施済みと誤解したり、
逆に一部自動検査済みでも`needs-input`だけが目立つ可能性がある。

### 8.2 関係の定義

- 汎用チェックは`assertion`であり、テーマまたはガイドライン項目そのものではない。
- テーマは複数assertionを束ねるcoverage groupである。1assertionの完了をテーマ全体のpassにしない。
- `needs-input`はrouteのprecondition未充足であり、既に完了した別routeの結果を無効にしない。
- 同じHTTP送信を複数routeが共有した場合、送信と証跡は1件、各routeの評価参照は複数にできる。通信数を重複計上しない。
- generic assertionとtheme assertionが同じ観点を検査する場合、route registryに`supersedes`または`complements`を記録し、
  二重実行と二重所見を防ぐ。

### 8.3 利用者表示

画面詳細は設計40へ委ねるが、Simple/Advanced/報告/CLIの全てが次の情報を同じview modelから表示する。

1. 選択項目数と、`自動実行予定 / 条件付き自動 / 追加入力待ち / 実行不可 / 対象外`の件数。
2. 各項目のroute、保証等級、必要入力、予定通信数、状態変更・復元の有無。
3. 実行後は`実行状態`と`判定`を別列にし、`完了・判定保留`、`未実行・入力待ち`等を明記する。
4. `Delegated`にはengine名・版と「個々の送信前拒否は保証しない」を表示する。
5. 検出0件をpassまたは実施済みの代用にしない。
6. 「ガイドライン準拠」を総合判定せず、項目別の検査coverageとして表示する。

APIは`GuidelineCoverageSummaryView`と`GuidelineCoverageItemView`をcontractsに置き、設計40、wizard S05/S06/S07、
assurance report、CLI JSONが共有する。

| 項目 | 設計 |
|---|---|
| 変更ファイル/API | contracts/OpenAPI、plan confirmation view、S05/S06/S07、Advanced A03（詳細は40）、assurance report、CLI output |
| テスト | 同一view modelのUI/report/CLI投影、部分完了、複数route、共有送信、needs-inputと完了の併存、Delegated表示、0件表示をgoldenで確認 |
| 優先度 | P0 |
| 依存 | §3が必須。Advancedの配置だけ設計40に依存 |

## 9. fixture fallbackの廃止

### 9.1 現状と原因

`BaselineFlowDeps`のRepeater、Fuzz、Sequencer、OAST、WebSocket portはoptionalで、未注入時に決定的fixture応答や
fixture台帳へ落ちる。正式Desktopの`composeEngines()`は現在Repeater/Fuzz/Sequencer/WebSocketへ実transportを注入し、
OAST未設定時も明示的なunavailable providerを作っているため、通常起動が直ちにfixtureへ落ちるわけではない。
しかしCoreの構成ミス、別entry point、将来のDI変更では成功風のfixture結果を返せるfail-openが残る。

### 9.2 runtime profile

```ts
type RuntimeProfile = 'production' | 'simulation' | 'test';
type AdapterKind = 'real' | 'fixture' | 'unavailable';
```

- `production`: 全公開機能に`real` adapterを要求する。未構成は`CapabilityUnavailable`で、送信、台帳追加、所見生成をしない。
- `simulation`: `tools/simulation`のcomposition rootだけがfixture adapterを明示注入できる。
- `test`: unit test factoryがfixtureを注入できる。既定constructorがfixtureを生成しない。
- `adapterKind`、version、capability fixture hash、制約、構成時刻を`/api/capabilities`とruntime bundleへ保存する。
- production planにfixture routeが混入した場合はplan validationで拒否する。UIも機能を無効化し、理由を表示する。

`BaselineFlowService`内の`transport ?? fixture response`を除去し、fixture実装は`tools/simulation`またはtest supportへ移す。
OASTのような未構成能力は、空protocolの実装ではなく共通`UnavailableCapability`として表現する。

| 項目 | 設計 |
|---|---|
| 変更ファイル/API | `BaselineFlowDeps`、各tool service、`engine-config.ts`、simulation composition、`/api/capabilities`、runtime bundle manifest、Settings表示 |
| テスト | productionで各portを1つずつ欠落させて送信前に503/CapabilityUnavailableとなること、fixtureがsimulation/testでだけ動くこと、結果にadapter kindが残ることを確認 |
| 優先度 | P0 |
| 依存 | §5契約、§10 runtime bundle、§11分割のcomposition root |

## 10. `baseline-flow.ts`分割計画

### 10.1 現状と原因

`packages/core/src/application/baseline-flow.ts`は約5,565行、約315 KiBで、案件、認可、文書hint、Proxy、
業務ロジック、25テーマ、session、Fuzz、Sequencer、API import、OAST、WebSocket、DOM、extension、CA、Repeater、探索、scan、
Nuclei、報告までを単一classと多数のin-memory台帳で保持する。domain純関数は既に分離されているが、application orchestrationと
状態所有が集中し、設計01の横断サービス境界、永続化、並行実行、再起動復旧を実装しにくい。

### 10.2 目標構成

| サービス | 主な責務 | 現在の移動元 |
|---|---|---|
| `CaseService` | 案件、scope、revision、document hints | case/hints系methodとaggregate |
| `AuthorizationService` | 認可、operator permission、OperationClass、認証専用egress | grant/current auth、permission helper |
| `PlanService` | plan生成、正規化、hash、route snapshot、confirmation | build/authorize/confirm plan |
| `JobOrchestrator` | run/attempt、DAG、共有budget/lease、cancel、状態機械、復旧 | runActiveScanの横断制御、ScanMonitor連携 |
| `ExplorationService` | frontier、login観測、script/API候補、ranking | runExploration、candidate helper |
| `DiagnosticRouter` | candidateからZAP/workflow/browser/theme/Nuclei routeを解決 | diagnostic/guideline route計画 |
| `GuidelineExecutionService` | テーマ、input resolution、assertion、coverage結果 | runAuthBypass/runZapUnsupportedと自動theme loop |
| `SessionService` | login flow、role別memory session、refresh | login/session系methodと台帳 |
| `ToolService群` | Repeater、Fuzzer、Sequencer、OAST、WebSocket、DOM、HTTP/2 | 各機能methodと台帳。機能ごとに分割する |
| `EgressPolicy` | ScopePolicy、credential転送、redirect、request lease | 各methodに散在する判定を共通化 |
| `EvidenceService` | 保存、provenance、redaction projection、保存後event | 直接`evidence.saveText`している箇所 |
| `FindingService` | import、dedupe、状態更新 | importer/findings台帳 |
| `ReportService` | report model生成 | generateReport |
| `CapabilityService` | runtime profile、adapter/bundle能力 | deps.capabilitiesと個別分岐 |

サービスは相互の具象classを参照せず、command/query portと不変snapshotで接続する。案件単位状態はapplication serviceのfieldではなく
repositoryまたは明示的な`CaseSessionContext`へ置き、同時案件を扱える形にする。memory-only secretは`SessionVault`へ隔離し、
永続repositoryへ渡さない。

### 10.3 段階移行

1. 現在のpublic methodとAPI応答をcharacterization testで固定し、`BaselineFlowService`をfacadeとして残す。
2. `RunStateMachine`、runtime profile、`EvidenceService`、event publisher、repository transactionを先に抽出する。
3. `CaseService`、`AuthorizationService`、`PlanService`を抽出し、facadeから委譲する。
4. Repeater/Fuzz/Sequencer/OAST/WebSocket等の独立ToolServiceを1機能ずつ抽出し、fixture fallbackを同時に除去する。
5. `SessionService`と`ExplorationService`を抽出し、memory-only browser stateの所有を明確にする。
6. `GuidelineExecutionService`、`DiagnosticRouter`、`JobOrchestrator`を抽出してactive scanを移す。
7. report/finding/capability queryを抽出し、API serverの依存をfacadeからcommand/query handlerへ切り替える。
8. facadeの利用がなくなった時点で削除する。各段階で大規模一括renameやAPI変更を同時に行わない。

| 項目 | 設計 |
|---|---|
| 変更ファイル/API | `packages/core/src/application/services/**`、`commands/**`、`queries/**`、ports/repositories、composition root、API handler。外部APIは移行中も互換維持 |
| テスト | facadeと新serviceのcontract同値、command順序、保存成功後event、並行案件分離、停止/復旧、secret非永続、既存全unit/integration/simulationを各段階で実行 |
| 優先度 | P1。ただしP0の状態、mapping、runtime profileの受け皿だけは先行抽出する |
| 依存 | §3、§5、§6、§9の決定。機能追加と巨大分割を同一PRに混ぜない |

## 11. 2026-11-05残課題とA4課題

### 11.1 探索、静的素材、client側経路、ranking

| 課題 | 現状・原因 | 解決方針 | 変更/API | テスト | 優先度・依存 |
|---|---|---|---|---|---|
| 隠れた経路 | link、観測XHR、script API、document hintまでは候補化。参照されない管理/backup面が残る | `robots.txt`、sitemap、manifest、観測文字列、版固定の小規模wordlistをsource別に探索。404類似度の負対照、同一Origin、深度/件数/時間上限、ActiveCrawl認可を必須にする | `ExplorationService`、探索planに`discoverySources`、候補へprovenance | wildcard/soft-404、scope外、redirect、予算、対象固有語なしの所有fixture | P1。§10 ExplorationService、§6停止に依存 |
| 静的素材巡回 | scriptは解析するが鍵、map、manifest等を一貫した対象として扱わない | MIME/拡張子/サイズallowlistでJS、source map、JSON、manifest、text、公開鍵/証明書をbounded取得。画像/動画/font/binary executableは既定除外。本文は証跡上限内 | asset observation schema、`GET /api/observations/assets`、body lazy load | MIME偽装、圧縮爆弾、巨大file、scope、secret mask、同一asset dedupe | P1。§11.2の30.2〜30.5に先行 |
| client側経路 | bundleからAPI定義は抽出するが、操作時に組み立てるrouteを通常探索が観測できない | History API、hashchange、router link、service worker登録、browser requestを観測。状態変更操作は設計40のreview済みworkflowからのみ実行し、操作前後を証跡化 | `PageObservation.clientRoutes`、interactive workflow結果を探索候補へ合成 | hash/history router、遅延route、認証storage、禁止操作、stop | P1。§10 Session/Exploration、設計40に依存 |
| Juice Shop候補ranking | transport除外、重複排除、ID頻度優先は実装済み。製品側の説明可能な総合rankingは未確立 | 対象非依存のscoreを定義: 観測済み>script定義>仕様>文書hint、入力点、認証role差、中心性、静的/transport penalty、状態変更risk、重複代表性。score理由を返し、benchmark固有route名を使わない | `CandidateRankingPolicy`、candidateに`score`と`scoreSignals`、一覧sort/filter | 順序決定性、同点安定、transport抑制、危険操作を自動昇格しない、Juice Shopは評価データに限定 | P1。隠れ経路/asset/client routeの後 |

### 11.2 design/30 30.2〜30.5

| 節 | 解決方針 | 安全・証跡 | テスト | 優先度・依存 |
|---|---|---|---|---|
| 30.2 依存静的解析 | JS/source map/package metadataから依存名・版・framework signatureを抽出し、confidence付きcomponent observationにする | 対象が配布した同一Origin assetだけ。版不明を推測確定しない | minified bundle、source map有無、偽陽性、巨大asset | P1。静的素材巡回に依存 |
| 30.3 component DB照合 | hash/版固定したローカルOSV等のsnapshotへ照合し、名前・版範囲一致を候補所見にする | 対象URLを外部送信しない。DB source/version/hashをrunへ保存 | semver範囲、alias、版不明、DB rollback | P2。§11.3 runtime bundleに依存 |
| 30.4 暗号素材・JWT | login時JWTの受動検査、公開鍵/証明書のalgorithm/key length、承認済みtoken変異を別assertionにする | token/key値を保存せずfingerprint。改変送信はActiveScan認可と正常対照が必要 | alg/exp/kid/JWK、鍵長、拒否/受理、secret非露出 | P1/P2。theme 9、静的素材、SessionVaultに依存 |
| 30.5 機密漏洩 | 公開応答/assetを版固定patternとentropyの二段で検査し、検証済み形式だけ候補所見化 | 値はmasked preview+hash。無効化確認や外部照会を自動実行しない | canary secret、一般文字列の誤検出、binary除外、report mask | P1。静的素材とEvidenceServiceに依存 |

### 11.3 macOS、署名・公証、runtime bundle、10万件表示

| 課題 | 現状・原因 | 解決方針 | 変更/API | テスト・gate | 優先度・依存 |
|---|---|---|---|---|---|
| macOS検証 | 同一コードを対象とする設計はあるが、正式なarm64 package smokeと必須workflow記録がない | macOS 15 arm64でinstall/launch、案件、login、探索、scan、report、停止/復旧、Keychain、CA、Playwright、ZAP/Javaを同一scenario manifestで実行 | packaging config、OS capability manifest、CI artifact | Windowsと同じcontract/simulation、実機smoke、差異はUnsupported表示 | P2/A4。runtime bundleとpackagingに依存 |
| 署名・公証 | 組織名義と資格情報は未入力、packaging workflow未完成 | hardened runtime、最小entitlement、Developer ID署名、notary submit/staple、Gatekeeper検証、DMG/app hash、SBOMをrelease manifestへ記録。秘密はCI SecretStoreだけ | packaging/release tools、manifest schema | unsigned拒否、署名検証、staple offline確認、更新/rollback | P3/A4。オーナー入力が必要 |
| runtime bundle更新 | 実行時hashはengine version文字列の合成で、[21]のimmutable manifest、atomic切替、rollbackが未実装 | app/Electron/Node/Playwright/browser/Java/ZAP/add-on/Nuclei/template/payload/catalog/assertion mappingをartifact hash付きmanifestにし、stage→verify→activate→rollbackを実装 | `RuntimeBundleService`、Settings/CLI、planのbundle ID/hash | 部分更新拒否、改ざん、engine capability再測定、実行中run固定、一世代rollback | P2。§3 mapping、§9 profile、署名方針に依存 |
| 10万件仮想化 | 設計20/23/28に閾値はあるが、現行rendererの10万件実測とcursor API/仮想化完成の証拠がない | traffic/findings/observationsをserver-side cursor/filter/sort、page上限500、本文lazy loadへ分ける。UIはstable row keyのvirtualized listと詳細遅延読込を使用 | list APIへcursor/filter/sort、`GET .../{id}/body`、設計40の一覧component | 10万件でcase open 5秒、初回一覧2秒、query p95 1秒、本文64KiB 1秒、renderer memory/scroll/focusを測定 | P2/A4。storage indexと設計40に依存 |

## 12. 未コミット28ファイルの扱い

### 12.1 調査結果

正式ソースのworktreeには28ファイル、概算`+1256/-349`の未コミット変更がある。内容は無関係な一括変更ではなく、
2026-11-05の第10次作業を中心に次の依存した変更群である。

| 変更群 | 主なファイル | 内容 |
|---|---|---|
| 認証済みSPA state | `ports/engines.ts`、login/explorer/DOM/interactive adapter、`baseline-flow.ts`、ZAP adapter | cookieに加えてlocal/session storageとOrigin固定Authorizationをmemory-onlyで引き継ぎ、ZAP rule cleanupとsecret redactionを追加 |
| API候補と診断精度 | `api-scanning.ts`、workflow scan transport/domain、探索/scan test | OpenAPI request素材、候補track、4xx/5xx基準応答の過剰所見抑制等 |
| ガイドライン自動接続 | `guideline-execution.ts`、`baseline-flow.ts`、関連test | テーマ13/24/25/30を通常scanへ接続し、budget内でroute結果を保持 |
| assurance report | desktop reportとtest | guideline/diagnostic routeの実施、入力待ち、利用不可、委譲を表示 |
| benchmark・記録 | `docs/benchmark/**`、`docs/work-logs/2026-11-05.md` | Juice Shop/crAPIの測定表、判定script、実装・実測記録の更新 |

### 12.2 決定

本設計の実装をこのdirty worktreeへ直接重ねない。まず変更の所有者確認、secret/対象固有処理のreview、記録済みの
typecheck/全testの再実行、差分reviewを行い、基準commitとして保全するべきである。本書作成ではcommitしない。

推奨する保全単位は次の3つである。ただし中間commitがbuild/test不能になる場合は、1つの原子的commitを優先する。

1. `authenticated SPA session propagation and scan safety`（production codeと対応test）。
2. `guideline route reporting and automatic safe themes`（coverage/report codeと対応test）。
3. `Juice Shop/crAPI measurement evidence`（benchmark script、生成表、work log）。

generated Markdown 2件の大半が改行差分でないこと、benchmark生成が決定的であることを確認する。変更群を先にcommitする理由は、
本設計がその挙動を「現状」として前提にしており、分割refactor中に失われると原因追跡が困難になるためである。

| 項目 | 設計 |
|---|---|
| 変更ファイル/API | この設計作業では変更しない。実装着手前に正式ソース側で上記review/commitを行う |
| テスト | `npm run typecheck`、全workspace test、変更対象integration、benchmark generator再現性、secret scan、`git diff --check` |
| 優先度 | P0、全実装の着手条件 |
| 依存 | 変更所有者の確認。commit/pushはオーナーまたは別途許可された実装作業で行う |

## 13. 実装順序と依存関係

| 段階 | 実装内容 | 完了条件 |
|---|---|---|
| 0 | 未コミット28ファイルをreview・再検証・保全 | 基準commitが一意で、全test結果と変更群が記録される |
| 1 | 状態機械を§6へ統一し、scan async 3 APIを契約へ追加、3者parityを導入 | OpenAPI、route、handlerが一致し、start/status/stopと復旧が契約testを通る |
| 2 | production fixture fallbackを廃止し、runtime profile/capabilityを導入 | port欠落が成功応答にならず、simulationだけがfixtureを使う |
| 3 | `GuidelineCoverageRoute` schema、assertion registry、catalog生成、run snapshotを実装 | 対象全項目がrouteまたはunsupportedを持ち、plan/reportが同じmappingを使う |
| 4 | 9/6件数、handoff注記、wizardコメント、詳細設計01、docs lintを整合 | 文書と生成artifactに矛盾がない |
| 5 | coverage view modelとSimple/report/CLI表示を実装し、Advanced表示を設計40へ接続 | 実行状態と判定、needs-input、Delegated、unsupportedが項目単位で見える |
| 6 | `BaselineFlowService`から横断基盤、Case/Auth/Plan、ToolServiceを抽出 | facade互換testを保ってP0境界が独立serviceになる |
| 7 | Session/Exploration/GuidelineExecution/DiagnosticRouter/JobOrchestratorを抽出 | active scanが新service経由で同じ結果を返し、再起動/並行案件を扱える |
| 8 | conditional-automaticテーマを低リスク順（18/23/29→9/21/26/27→1/2/7/10）に接続 | 入力解決根拠がsnapshotされ、条件不足時は送信せずneeds-inputになる |
| 9 | 隠れ経路、静的素材、client route、ranking、design/30を実装 | 所有fixtureと一般化した評価でprovenance、上限、停止、誤検出を確認する |
| 10 | OTP/mailboxとSAML controlled adapter | 許可済み設備でV/F境界、secret非露出、cleanupを実測する |
| 11 | runtime bundle service、10万件仮想化、macOS package、署名・公証 | [21]、[20]、A4のgateを満たす |

主要な依存は次のとおりである。

```text
未コミット変更の保全
  -> 状態/API契約 -> runtime profile
  -> coverage route正本 -> coverage表示
  -> application service分割
      -> conditional自動化
      -> 探索/asset/client/ranking -> design/30
      -> 実OTP/SAML adapter
  -> runtime bundle -> macOS/署名公証

storage cursor API -> 10万件UI（画面配置はdesign/40）
```

## 14. オーナーに確認する未決事項

設計上の既定は示したが、次は外部入力または製品方針の決定が必要である。

1. テーマ17は現在の「検査不能・スキップ」を製品初回releaseでも維持するか。維持する場合、完全代替の必須シナリオから明示除外するか。
2. ASVS 10.2.3用`OAuthScopePolicy`を案件入力として将来実装するか。それまでは`not-assessed`表示でよいか。
3. production OTP adapterの最初の対象をMailpit/MailHog、IMAP、組織固有APIのどれにするか。許可されるtest mailboxとSecretStore運用は何か。
4. SAML replay用に、オーナーが管理する試験IdP/SPと診断専用アカウントを用意できるか。実顧客IdPへのreplayを既定禁止としてよいか。
5. ガイドラインcoverageで、HTTP観測では評価不能な設計・運用項目を`manual-review`として製品に残すか、catalog表示だけにするか。
6. 現行9 workflow checks / DS-221 6 checksを短期基準として承認するか。旧21/9を復元する要求はあるか。件数ではなく項目routeの受け入れへ移行してよいか。
7. 同期`POST /api/run/scan`の互換維持期間と、CLIを非同期APIへ統一するreleaseをどこに置くか。
8. 未コミット28ファイルの変更所有者と、1〜3 commitへの分割方針。正式ソース`main`へ保全してから本設計を実装してよいか。
9. runtime bundleの更新をA1の同梱・rollbackまでに留めるか、A2でnetwork update UIまで実装するか。
10. macOS署名・公証に使う組織名義、Apple Developer Program、CI秘密情報の管理主体と、対応arch（初回はarm64のみか）。
11. 10万件性能のA0基準端末とmacOS実機を継続的に利用できるか。性能gateをrelease CIの必須条件にするか。
12. Advanced画面再設計40で、coverage summary/detail、capability、needs-input解消導線をどの画面へ配置するか。意味とAPIは本書を正とし、配置だけを40で決める方針でよいか。

## 15. 受け入れ条件

本書の仕様ギャップ解消は、少なくとも次を満たした時点で完了とする。

1. 契約にないCore API handlerが0件で、OpenAPI、route registry、handler registryがCIで一致する。
2. 実行状態は1つのcanonical machineから永続化、API、UI、報告へ投影される。
3. 選択したHTTP観測対象の全ガイドライン項目に、版付きrouteまたは明示的unsupported理由がある。
4. 実行状態とassessmentが別に保存・表示され、検出0件、needs-input、unavailableをpassと表示しない。
5. productionで実transportがない機能は`CapabilityUnavailable`となり、fixture結果、台帳、所見を生成しない。
6. テーマ17とASVS 10.2.3は未観測の合否を推測せず、テーマ6は実行したsub-checkと未実施sub-checkを分ける。
7. `BaselineFlowService`の横断責務が分割され、同時案件、停止、復旧、証跡保存、secret境界をservice単位で試験できる。
8. 2026-11-05残課題は対象固有処理を本番codeへ入れず、provenance、scope、予算、停止、証跡の内側で実装される。
9. runtime bundle、10万件表示、Windows/macOS配布は設計20、21、22、23、26のgateへ同じ証拠で接続される。
10. Advancedのレイアウトは設計40に従いながら、Simple、Advanced、CLI、報告が同じcoverage view modelを使う。
