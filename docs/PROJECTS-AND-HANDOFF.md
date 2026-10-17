# プロジェクトと診断ツールへの引き渡し（0.12.0）

## 保存方式

起動時は必ず次の3つから選択します。

1. プロジェクトフォルダーを開く（そのフォルダー内にプロジェクトファイルが1つ必要）
2. 新規プロジェクトフォルダーとプロジェクトファイルを作成
3. キャンセルしてアプリを閉じる

新規作成では作成先の親フォルダーと新しいフォルダー名を指定し、その中に `project.scopepilot.json` を生成します。
中央の案件一覧、最近の案件、起動時の自動復元はありません。
`SCOPEPILOT_DATA_DIRECTORY` は使用しません。

プロジェクトファイルは手動保存です。入力・取込・採否変更・実行結果を反映した後、各画面の［保存］またはCtrl+Sで保存してください。
未保存の変更がある状態で案件を切り替えたりアプリを閉じたりすると、変更を破棄してよいか確認します。
入力のコピーや実行ログ・出力ファイルの生成は、取込・実行・出力操作の際にプロジェクトフォルダー内で行います。

```text
案件フォルダー/
  project.scopepilot.json       設定・観測・下書き・採否・警告
  inputs/                      取り込んだ仕様書・操作手順、API文書、HAR、JSONの原本
  runs/                        AI生成・Web探索・ZAP診断の条件、ログ、証拠
  outputs/playwright/          ブラウザーによる出力
  exports/                     BurpへのScope・HTTPリクエスト
  reports/                     ローカル案件レポート、診断サマリー
  backups/                     プロジェクト全体のZIP（過去のZIPは含めない）
```

同じフォルダーに複数のプロジェクトファイルは作れません。入力はコピーしてSHA-256を記録します。
証拠と実行参照はプロジェクトフォルダーに対する相対パスです。フォルダー全体を移動した後、プロジェクトファイルを開き直せます。
保存は一時ファイルからの置換で行います。範囲外パスやジャンクションを案件データとして使用しません。
外部ツールの実行ファイル、Codex/Claudeの認証・設定は各ツール側に残ります。

旧形式は［旧案件を移行］で、旧保存ルートの `projects/<ID>.json` を選択し、移行先の新しいプロジェクトフォルダーを作成します。
同じ保存ルートの `runs/<ID>`、`exports/<ID>`、`reports/<ID>` をコピーし、元データは保持します。
旧原本JSONとAPI文書も入力として残します。旧データを自動検出する仕組みはありません。

## ログの表示・コピー

画面下の［ログを表示］で独立したログ画面を開きます。認証待ちや小さいウィンドウでも利用できます。
［すべてコピー］、［選択範囲をコピー］、Ctrl+C、右クリックからコピーできます。クリップボードが使用中の場合は再試行し、結果を表示します。
表示は開いた時点のログ（直近最大500件）です。選択中に内容が変わらないよう自動更新せず、［更新］で最新のログを表示します。
［TXT保存］は表示中の内容をプロジェクト内の `reports/logs/` にUTF-8で保存します。プロジェクトファイル自体は保存しません。
実行ごとの詳細ログは、引き続き［実行履歴］から参照できます。

ScopePilot本体は通常のWindowsデスクトッププロセスとして起動します。画面探索のAI（Codex CLIまたはGLM（zcode））はシェル・ファイル操作を使わず許可したMCPツールだけで実行し、認証待機・観測・結果ファイルの保存はScopePilot側で処理します。ログのコピーもScopePilot本体が処理します。

## 認証とログイン後の到達先

認証ページのURL・ページタイトル・ユーザー名／パスワード入力欄・401応答をAI確認の手掛かりとして渡します。入力値はこの手掛かりへ含めません。
認証が必要な画面を確認した場合、未認証ロールでも入力案内を表示します。認証情報は現在の探索用ブラウザへユーザーが直接入力します。
探索画面で認証後のロールを選択し、［ログイン後のページを確認して再開］を押してください。
必要に応じて案件設定の［認証後の開始URL］を指定できます。URLは許可Origin内であることを確認してから実行します。

再開後は同じブラウザで実際のURL、認証画面が残っていないこと、ログイン後の画面上の手掛かりを確認します。
確認結果を `authentication-navigation.json` に保存し、探索画面へ到達先を表示します。ボタン操作だけで認証成功と扱いません。
ログイン前の代表パターンだけに探索を限定せず、認証後の到達ページと表示された通常の参照リンクも許可範囲内で確認します。
認証待機はAIのファイル作成を必要としません。ブラウザを維持し、認証後の各参照リンクとその先のリンクをキューへ追加します。AI確認もCDPでそのブラウザへ接続し、認証状態を引き継ぎます。
認証後の肯定的な表示にはLogoutリンク、User menu、data-authenticatedを使用します。認証済みの手掛かりがない画面では、認証成功と断定せず入力確認を再度案内します。
到達状況は `crawl-coverage.json`、巡回ログは `crawler-run.log`、MCPの実行設定と準備ログは `codex-mcp-config.json` と `mcp-setup.log` に保存します。設定ファイルへの共通MCP登録は不要です。
通常閲覧はGET/HEADに限定し、画面のフォームは入力点として記録します。状態変更を伴う送信は巡回時に行いません。ユーザーによる認証入力の間だけ認証通信を許可します。
入力待機と再開はrequestIdで対応付け、古い再開信号では新しい認証要求を通過させません。再度ログインが必要な場合も新しい入力案内を表示します。
プロジェクトファイルの保存は手動です。認証後のロールを含む設定・結果を残すには、探索終了後に［保存］してください。

## クローリングで参照する文書

Web探索モードの案件設定で［入力ドキュメント（仕様書・操作手順）］を選択します。
Markdown・TXT・HTML・JSON・YAMLのUTF-8テキストを最大250,000文字まで読み込めます。PDF・Wordはテキストへ変換してください。
選択した文書の原本を `inputs/` にコピーし、相対パスとSHA-256を記録します。設定を残すには［保存］を押してください。
探索時に原本のハッシュを確認し、文書の内容を実行フォルダーの `reference-document.txt` へ保存します。
探索の開始時、文書のSHA-256が変わっていれば、案件設定の「文書を読み取るAI」で選択したAI（Codex CLI・Claude Code CLI・GLM。読み取り専用サンドボックス・構造化出力）が補助情報（document hints）を抽出し、案件へ保存します。モデルと推論レベルはAPIドキュメントモードと同じ選択肢です。内容は (1) クローリングでは辿り着かないAPI・管理ページのURL、(2) ロールごとの認証方式と文書内の所在（秘密値は複写しない）、(3) 個人情報・決済等の優先規則、(4) APIパラメーターのバリエーション、(5) その他付随情報です。許可Origin外のURLは除外を制約へ記録します。抽出に使ったAIはヒントの `extractedBy` として実行履歴へ記録します。
抽出結果は `document-hints.json` として実行へ同梱し、`engagement.json` の `documentHints.crawlTargets` をクローラが追加の開始点として巡回します。追加開始点も通常巡回と同じOrigin・禁止操作・ページ数・通信数・時間上限の検査を受けます。優先規則はAI入力の並べ替えと理由表示に、認証記載は認証待ちの案内に、APIパラメーターは一致する代表パターンへの添付に使用します。
画面探索のAIは代表パターンの画面・機能・通常の操作手順を理解するために参照します。文書だけから観測通信や所見を作らず、未確認の項目は制約へ記録します。未観測の文書記載エンドポイントは診断対象に含めません。
動的パターンがなくても文書を指定した実行ではAIによる参照を行います。文書内の命令で許可Originや禁止操作を変更しません。抽出に失敗した場合は文書なしで探索を続行し、次回の実行で再抽出します。
［指定を解除］は今回以降の参照を止める操作で、取り込んだ原本と過去の実行文書は残ります。APIモードの入力文書には影響しません。

## Burp Suite

### 探索時のBurp／ZAP切替

案件設定の［探索用プロキシ］で「自動／Burp／ZAP」を指定し、［保存］で保存します。
この設定と、探索後の引き渡し先は独立しています。
自動はBurpの接続先を確認し、接続できない場合に探索専用のZAPを起動します。Burp履歴MCPの有無は切替条件に含めません。
Burpの既定接続先は `http://127.0.0.1:8080`、探索用ZAPの既定ポートは8090です。ZAPポート0は空きポートの自動割当です。
使用中の固定ポートでは別のプロセスを終了せず、開始エラーとして案内します。
ZAPのJAR・Javaのパスは、案件設定と引き渡し画面で共有します。案件側が空欄のときはアプリ設定画面の既定パス（`%APPDATA%\ScopePilot\settings.json`）を使用します。
アプリ設定画面の「AIの接続状況を確認」は、AIごとに個別にも実行できます。Codex CLIはログイン状態（`codex login status`）、Claude Code CLIは実行ファイル（`%USERPROFILE%\.local\bin` または `%APPDATA%\npm` 配布の `node_modules\@anthropic-ai\claude-code\bin\claude.exe`）と認証情報、GLM（Z.ai・zcode）はzcode CLI（`%APPDATA%\npm` 配布・node.jsで起動）とZ.aiサインインの資格情報ファイルを確認します。設定画面ではAIごとの欄を水平線で区切っています。GLM欄ではZ.ai Coding PlanのAPIキーを登録でき（Windows DPAPIで暗号化して設定ファイルへ保存。環境変数 `ZAI_API_KEY` / `Z_AI_API_KEY` より優先）、キーがない場合はzcode自身のZ.aiサインイン（`zcode login`）を使います。いずれの確認もモデルへの生成要求（課金対象）は行いません。

ZAPはCLI daemonで起動し、REST APIで応答とSafeモードを確認してからクローラを開始します。
ZAPのホーム・セッション・ログは実行内の `zap-proxy-home/` に、起動ログは `zap-proxy-console.log` に保存します。
プロキシURLと実際の選択結果は `exploration-proxy.json` へ保存し、実行履歴に表示します。
APIキーは実行ごとに生成し、APIキー付きURLをAI・プロジェクトファイル・実行ログへ渡しません。ZAP自身の設定ファイルは実行ホーム内で管理します。
Playwrightのブラウザープロファイルも実行内の `browser-profile/` へ保存します。

高速クロール後は `zap-fast-capture.har`、AI探索後は `zap-ai-capture.har` に通信を保存します。
HARは実行の境界と許可Originで絞り込みます。通常巡回のHARには認証前後が含まれます。観測一覧は通信時刻と確認済みの認証ロールを用いて集約し、判別できない通信は認証状態未確認とします。
高速クロールの引き渡しにはPlaywrightの `fast-capture.har` を使用し、同じ通信を含む `zap-fast-capture.har` は補助原本として保存します。重複して引き渡しません。
ブラウザのHARにはログイン手順の通信も含まれます。観測一覧への取り込みでは本文・Cookie・認証値を転記しません。ロール間の権限差を評価する際は、通信ごとの認証状態を担当者が確認してください。
HAR出力にはImport/Exportアドオンが必要です。取得に失敗した場合はログで案内し、Playwrightの取得済み記録を保持します。

Burp履歴MCPは必須ではありません。ZAP使用時やBurp履歴MCPが利用できない場合、AIはPlaywrightの記録を使用します。
利用者の共通MCP登録は変更しません。今回の実行で必要なPlaywrightと、利用可能な場合のBurp履歴MCPだけをCLIへ渡します。
探索の終了・停止・開始失敗時には所有するZAPだけを終了します。既に起動しているBurpやZAPを終了しません。
実行途中で接続が切れた場合は探索を停止します。自動切替は次回の開始前に行います。

一次資料: [ZAP CLI](https://www.zaproxy.org/docs/desktop/cmdline/)、
[プロキシのCLI設定](https://www.zaproxy.org/docs/desktop/addons/network/cmdline/)、
[Safeモード](https://www.zaproxy.org/docs/desktop/start/features/modes/)、
[HAR出力](https://www.zaproxy.org/docs/desktop/addons/import-export/)。

### 探索後の引き渡し

［診断ツールへ］の引き渡し先をBurp Suiteにします。
Webモードでは採用候補のScope正規表現、APIモードでは採用した `.http`、出典付きJSON、TSVを出力します。
ScopeはTarget > Scopeへ、HTTPテキストはRepeaterへ手動登録します。
Burp MCPプロキシは配布物に含めません。別途取得したJARの場所を、アプリ設定画面（`%APPDATA%\ScopePilot\settings.json`）、環境変数 `SCOPEPILOT_BURP_PROXY_JAR` の順に確認します。いずれも指定がなければ既定位置（`%LOCALAPPDATA%\ScopePilot\mcp\mcp-proxy-all.jar`）を参照します。

## ZAP CLI

1. ZAPと対応するJavaを別途導入します。Playwright記録にはNode.js、同梱のPlaywright runtime、Microsoft Edgeも必要です。
2. 対象を採用し、［診断ツールへ］でZAPを選択します。`zap*.jar` と `java.exe` を指定します。
3. ［add-onを準備］でAutomation Framework (`automation`)、Import/Export (`exim`)、Network (`network`)、Passive Scanner (`pscan`)、パッシブルール (`pscanrules`)、Report Generation (`reports`) を確認します。アクティブ診断を有効にした場合だけActive Scanner Rules (`ascanrules`) も、認証付き診断を有効にした場合だけReplacer (`replacer`) も確認します。不足分は公式Marketplaceからプロジェクト内の `tools/zap-addon-home/` へ導入します。既存ZAPのホームやインストールを変更しません。自動更新や全add-onの一括導入は行いません。
4. ［Playwrightで記録］で別ブラウザーを開き、手動でログイン・正常操作を行います。［停止］でHARとtraceを保存します。毎回新しいBrowserContextと専用ZAPを使い、Cookieやストレージを別実行へ引き継ぎません。選択中ロールは利用者のラベルであり、サーバー上の主体が検証済みであることを意味しません。既存のHARを取り込むこともできます。
5. 既定のパッシブ診断では、［ZAPパッケージを出力］で内容を確認できます。［ZAP診断を開始］は新しい実行フォルダーを作り、必要add-onの確認、計画検証、実行、結果取込を行います。
6. アクティブ診断を行う場合は、許可を得た対象であることと採用URLを確認し、［ZAPアクティブ診断を有効にする］を選択します。実行のたびに確認欄へ `ACTIVE` と入力します。未入力の状態では開始ボタンが無効で、サービス層でも実行を拒否します。
7. ［停止］でScopePilotが開始した処理を停止します。Playwright記録ではブラウザーを閉じ、パッシブ待機と原本保存を行ってから所有するZAPを終了します。保存処理が時間上限に達した場合や原本が欠けた場合は未完了として記録します。

`zap-environment.json` はZAP JARと利用可能なadd-on archiveの版・SHA-256を保存します。CLIの実際の読込一覧とJava等の情報は `zap-addon-list.log`、記録用daemonの読込一覧は `zap-loaded-addons.json` に保存します。本体・add-onのSHAは処理前後で検証し、差があれば完了にしません。

記録フォルダーには `browser.har`、`browser-trace.zip`、`browser-events.jsonl`、`zap-history.json`、`zap-browser.har` を保存します。`browser-zap-correlation.json` はブラウザーHARのentryとZAP message IDを、メソッド・URL・Cookie・Authorization・要求本文・応答statusで照合し、各原本のSHAとpointerを結びます。一つのZAP messageを複数のブラウザーentryへ使い回しません。Historyの欠落や不一致は `partial` とします。ブラウザーHARだけを次の解析へ渡し、同じ通信を含むZAP HARは補助原本として保持します。

この記録は人による正常操作の通信対応確認です。主体確認endpoint、期待権限表、正常対照、独立した事後oracleによる実影響判定は実施しません。Client Spiderの進捗やHTTP 200を必要条件への到達成功として扱いません。外部PlaywrightへZAPのclient拡張が自動導入される前提も置きません。

現在の記録ブラウザーはHTTP(S)の許可Originをrouteごとに確認し、Service WorkerとWebSocketをブロックします。それらが必要なケースは対応範囲外です。ローカルZAPプロキシのHTTPS記録では証明書検証を無効化しているため、TLSに関する正常対照には使用できません。HAR、History、traceはCookieや本文を含むローカル原本として管理してください。

Web探索の高速クロールは `fast-capture.har` に実通信を保存します。このクロールは未認証なので、そのHARは「未認証」ロールの診断に使用します。
終了前にプロセスが停止した場合などはHARが生成されないことがあります。その場合は別途記録したHARを取り込めます。
API文書から作った下書きはZAPのManual Request Editorへ渡すHTTPテキストを出力します。実応答を含まない下書きだけではパッシブ診断を開始できません。

計画は採用されたメソッド・URLパターンと許可Originに一致するHARだけを抽出し、HAR取込の既定値（再送しない）で取り込みます。旧アドオンとの互換性のため、`sendRequests` パラメータは指定しません。診断設定で［探索時に記録したZAP通信（HAR参照）も対象に使う］を有効にすると、`har-reference` のHAR（探索時のZAP取込通信）も同じ採用パターン照合で対象に加わります。
アクティブ診断では、HARで観測済みかつ採用済みの具体的なURLを、診断設定の対象URL上限（既定100件・最大500件）まで計画へ含めます。コンテキストの `includePaths` と各 `activeScan` ジョブの `url` を同じ対象に固定し、SpiderやRequestorは実行しません。攻撃強度（既定Low、Default/Medium/Highへ変更可）、警告しきい値（既定Medium、Low/Highへ変更可）は案件ごとの診断設定です。1ホストのスレッド数（既定1・最大4）、要求間隔（既定100ms・最大1000ms）、ルールごとの実行上限（既定1分・最大10分）、ルールごとの警告上限（既定10件・最大100件）、すべての要求でのヘッダー診断と未観測パラメーターの追加（既定ともに無効）はアプリ設定画面（`%APPDATA%\ScopePilot\settings.json`）でユーザー単位に変更します。これらの値はZAP計画・実行前の再生成検査・承認証跡へ反映し、変更後に作成済みパッケージを実行する場合はパッケージの再作成が必要です。案件の最大実行時間は各ジョブとScopePilot側のプロセス停止に適用します。
［記録済みセッションCookieで認証して診断］を有効にすると、採用対象のHAR要求からCookieヘッダーを抽出し、Automation Frameworkの `replacer` ジョブとして診断対象Originに限定して要求へ再適用します。実行直前に認証後URL（未設定なら最初の対象URL）へ読み取り専用のGETを送り、ログイン画面へのリダイレクトやHTTPエラーがあると診断を開始しません。Cookieの値は `selected.har` と同一のローカル証拠として扱い、承認ファイルにはCookie名だけを記録します。実行にはReplacerアドオンが必要です。
実行時の承認日時・ロール・対象URL・許可Origin・診断設定・認証の到達確認結果は `zap-active-authorization.json` に保存します。承認文字列そのものや認証情報は保存しません。
CLIは `-cmd -silent -dir <実行内のzap-home> -autocheck/-autorun <計画>` を使用します。
任意の外部計画を実行する機能はありません。計画・HARのSHA-256を検証してから実行します。
終了コード0は完了、2は警告あり、その他または結果欠落は失敗です。待機には時間上限を設けます。
実行中はZAPのジョブ開始・完了（対象URLと所要時間）に加え、診断ルールの実行開始、警告の検出、WARN/ERRORをアプリのログに逐次表示し、`zap-run.log` にも標準出力を即時に書き込みます。ZAPは `-loglevel DEBUG` で実行し、ルール単位の攻撃内容（どのURLのどのパラメータに何を送ったか）を `zap-home/zap.log`（4MB×3世代のローテーション付き）に記録します。zap.log には記録時のCookieが含まれるため、HAR等と同じローカル証拠として扱ってください。停止した場合も書き込み済みの内容が残ります。
実行ログ、ZAPのTraditional JSON/HTML、状態JSONはすべてプロジェクト内に保存されます。

この実装は**正常操作の手動記録、保存済み通信のパッシブ解析、明示承認された採用URLのアクティブ診断**に対応します。アクティブ診断は攻撃リクエストを送信します。認証付き診断は記録済みCookieの再利用と実行前の到達確認のみを行い、状態変更の事後oracle、脆弱性の再現確認、MCPによる診断制御は実装していません。
2026-10-17 の方針改訂（`AGENTS.md`、`docs/burp-professional-replacement-spec.md` 3.1）により、攻撃コードを含む診断エンジンの実装・診断の自動実行化（Spider等の能動クロール、API定義からの未観測要求送信、Fuzzer相当の自動反復送信）が認められました。本節の記述は現行実装の仕様であり、拡張の実装時に本書を更新します。
Web探索のクロール設定で［フォーム送信を含める］を有効にすると、クローラが各フォームを無害な仮値で1回だけ送信し、POSTなどの通信をHARに記録します。パスワード入力やファイルアップロードを含むフォーム、禁止操作・状態変更のURLには送信しません。既定は無効です。
ZAP本体がなくても、HTTPパッケージ出力と［ZAP JSON結果を取り込む］を使用できます。

一次資料: [HARの非再送取込](https://www.zaproxy.org/docs/desktop/addons/import-export/automation/)、
[CLIと終了コード](https://www.zaproxy.org/docs/desktop/addons/automation-framework/)、
[アクティブ診断ジョブ](https://www.zaproxy.org/docs/desktop/addons/automation-framework/job-ascan/)、
[Automation環境と対象範囲](https://www.zaproxy.org/docs/desktop/addons/automation-framework/environment/)、
[ZAPのモード](https://www.zaproxy.org/docs/desktop/start/features/modes/)、
[CLI設定](https://www.zaproxy.org/docs/desktop/cmdline/)、
[レポート生成](https://www.zaproxy.org/docs/desktop/addons/report-generation/automation/)。

## 外部ツールの結果と出典

### Brunoで行った手動確認を記録

Brunoは利用者が別途導入します。オープンソース版は[MITライセンス](https://github.com/usebruno/bruno/blob/main/license.md)で、コレクションをローカルのフォルダーに保存できます。ScopePilotの配布物にはBrunoを同梱しません。

1. [Brunoのプロキシ設定](https://docs.usebruno.com/get-started/configure/proxy-config)でZAP等のHAR出力に対応したプロキシを指定し、Brunoで対象へのHTTP通信を実施します。ZAPで警告を検出できない場合も、通信記録用のプロキシとして使用できます。ZAPではImport/Exportアドオンの[「Save Selected Entries as HAR」](https://www.zaproxy.org/docs/desktop/addons/import-export/)で対象通信を保存します。
2. ［診断所見］→［Bruno確認を記録］でHARを選び、対象の要求・応答を1件選択します。
3. 確認項目、確認状態、認証ロール、実際に観測した結果を入力します。［未実施・中断］の場合は理由と再開に必要な入力・改善も記録します。
4. ［通信と確認結果を保存］でプロジェクト内の `inputs/bruno/<ID>/exchange.har.json` に選択した1通信だけを保存し、プロジェクトファイルも明示的に保存します。
5. ［日本語Markdownを出力］でB番号の確認記録を生成します。元の要求・応答がSHA-256で照合できた場合だけ、機密値を伏せた本文をMarkdownに掲載します。［MarkdownをWordへ変換］で同じ内容をWordへ移せます。

HARにはCookieやAuthorization、本文中の機密情報が含まれます。原本はプロジェクト内のローカル証拠として扱ってください。レポートでは一般的な機密フィールドを伏せますが、共有前の内容確認は必要です。BrunoだけではHAR書き出しを前提にせず、プロキシ側から保存します。

ScopePilotは案件設定、診断対象の整理、Burp／ZAPへの引き渡しと結果取込を行います。
引き渡し先は横並びのBurp Suite／ZAPカードから選択します。現在の選択は丸印・枠と［選択中］表示で確認できます。ZAP処理の実行中は切り替えできません。
取り込んだZAP警告は「要確認」として表示し、内容は診断担当者が判断します。
ZAPの警告一覧は危険度と警告名・URLを表示します。各行の［詳細］またはダブルクリックで、説明、対策、参考情報、CWE/WASC、メソッド・パラメータ・証拠・入力値、原本のパス・SHA-256・JSON Pointerを別ウィンドウで確認できます。テキストは選択してコピーできます。
詳細はハッシュを照合した原本JSONからその都度読み、以前に取り込んだ警告にも対応します。原本が欠けている、ハッシュが変わった、出典位置が無効な場合は詳細を表示せず理由を案内します。説明のHTMLはテキスト化し、実行しません。各フィールドは最大40,000文字まで表示し、長い内容は原本を参照するよう案内します。
ZAPの確度評価はツールの評価として表示し、実影響の確認とは区別します。原本の証拠・入力値は詳細画面にだけ読み込み、プロジェクトファイルや公開用要約に複製しません。
原本のSHA-256とJSON Pointerを記録し、同じ原本・位置・ロールの再取込は重複させません。
原本レポートのattack/evidence本文やURLのクエリ値は警告一覧へ転記しません。

入力HAR、元レポート、ログ、`engagement-report` はプロジェクト内で管理します。
`diagnostic-summary.json` は外部ツールの結果と出典参照・ハッシュを出力し、Cookie、Authorization、応答本文、ツールのattack/evidence値を出力しません。
ソースdigest、seed、条件系列の入力や、到達・実影響の判定記録を管理する機能はありません。

## 日本語 Markdown レポート

［診断所見］または ZAP 欄の［日本語Markdownを出力］から、`reports/<出力日時>/engagement-report.ja.md` を出力できます。出力先フォルダーは自動で開きます。
実施概要、対象 URL、指摘一覧、個別の説明・対応案・出典、対応管理の記入欄を含みます。ZAP の代表的な13ルールに日本語解説を付け、検証済み原文を併記します。未登録の警告、原本欠落・改変、総合評価や再現確認の未実施は明示します。
構成と入力項目の対応は [日本語レポート仕様](JAPANESE-MARKDOWN-REPORT.md) を参照してください。

## 開発時の動作確認

プロジェクトの移動、中央保存先への依存排除、原子的保存、範囲外パス拒否、バックアップ、旧案件移行、
パッシブ／アクティブ計画、実行ごとの承認、URL範囲・速度制限、ロール分離、改変検出、終了コード・停止、警告取込を単体テストで確認します。
CLIの実行順序と終了状態は代替プロセスで検証し、ZAP 2.17.0・Import/Export 0.16.0・Java 17で、外部通信を行わないHARの解析とJSON/HTML生成・取込を確認しました。`SCOPEPILOT_TEST_ZAP_JAR` と `SCOPEPILOT_TEST_JAVA` を設定すると、同じ実機テストを実行できます。
UIはBurp/ZAP × Web/API × 明暗 × 2サイズ × 空/データありを描画します。
