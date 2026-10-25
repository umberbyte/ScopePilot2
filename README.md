# ScopePilot MVP

ScopePilotは、受託Web診断の事前探索と診断対象リクエストの整理を支援するWindowsアプリです。

## プロジェクト管理とZAP連携

0.12.0から、案件は選択したフォルダーとその中のプロジェクトファイルで管理します。入力・出力・証拠・バックアップもそのフォルダーに保存します。

［診断ツールへ］でBurp Suite／ZAPを切り替えます。ZAPは必要add-onの準備、Playwrightによる正常操作の手動記録、観測済みHARのパッシブ解析、明示承認したURLへのアクティブ診断、JSON警告の取込に対応します。アクティブ診断は既定で無効で、実行のたびに `ACTIVE` の入力が必要です。強度・警告しきい値・対象URL上限は診断設定で変更でき（既定は低強度）、記録済みセッションCookieによる認証付き診断（実行前に到達確認）も選択できます。HAR・trace・ZAP Historyの対応と、ZAP本体・add-onの版・SHA-256を実行フォルダーへ保存します。警告は実影響未確認として扱います。API下書きは両ツールへHTTPテキストとして渡せます。詳しい使い方と対応範囲は [プロジェクトと診断ツールへの引き渡し](docs/PROJECTS-AND-HANDOFF.md) を参照してください。

## 診断レポートの出力

［診断所見］の［診断レポートを出力］で、顧客向けWordレポート、構造化レポートv2、日本語Markdown、JSON、HTML、候補作業表を同じ出力フォルダーへ生成します。Wordレポートは案件の対象範囲、カバレッジ、評価方法、指摘詳細、対応計画、証拠索引をScopePilot独自の書式で構成します。Cookie、Authorization、セッショントークン、APIキー、パスワードは提出用本文へ原文のまま掲載しません。

## MarkdownからWordへの変換

［診断所見］の［MarkdownをWordへ変換］で、既存またはScopePilotが生成したMarkdownを `.docx` へ変換できます。出力はプロジェクト内の `reports/` に保存し、［Wordを開く］から参照できます。
A4の日本語レポート書式で、見出し・表・リスト・コード・リンク・ローカル画像を変換します。書式は本文生成から分離し、後でテンプレートを適用できる構成です。詳しくは [Markdown Word変換](docs/MARKDOWN-WORD-REPORT.md) を参照してください。

## ライセンス

ScopePilot本体のソースコード、スクリプト、ドキュメントは **BSD-3-Clause** で公開します。著作権者は `umberbyte` です。利用・改変・再配布の条件と免責事項は [LICENSE](LICENSE) を参照してください。第三者のコンポーネントには各コンポーネントのライセンスが適用されます。詳細は [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) に記載しています。

## 画面探索のAI

Web探索モードでは、リンク巡回の後にAIがPlaywright MCPで探索ブラウザを操作し、代表パターンの機能を確認します。このAIは案件設定の「画面探索のAI」で、Codex CLI（既定・Codex CLIの既定モデル）またはGLM（Z.ai・zcode。GLM-5.3 / GLM-5.3 flash）から選びます。入力ドキュメントを読み取るAIとは別の設定です。Claude Code CLIは画面探索には未対応です。使ったAIは実行フォルダーの `engagement.json`（`explorationAi`）へ記録します。

どちらのAIでも、使えるMCPツールは同じです（`browser_tabs`・`browser_snapshot`・`browser_navigate`・`browser_network_requests`・`browser_take_screenshot`、Burp連携時は履歴参照の2ツール）。クリック・入力・任意コード実行・ファイルアップロードは使えません。

- Codex CLI: 読み取り専用サンドボックス・承認ポリシー・MCPの許可ツール指定・`--output-schema` による構造化出力で実行します（従来どおり）。
- GLM（zcode）: 実行内の分離設定（`zcode-exploration-settings.json`。ユーザーのフック・プラグイン・スキル・サブエージェントは無効）にMCPサーバーを登録し、組み込みツール（シェル・ファイル操作・Web取得・ワークフロー）はすべて `--disallowed-tools` で除外します。zcodeにはMCPツール単位の許可指定がないため、アプリ同梱の `tools/mcp-tool-filter.js` をMCPサーバーの前段に置き、許可外のツールをツール一覧から除いて呼び出しも拒否します。zcodeにはスキーマの強制機能がないため、結果スキーマを指示へ埋め込み、必須項目を検証してから `zcode-result.json` へ保存します。zcodeは途中経過を出力しないため、結果は終了時に表示されます。実行ログは `zcode-run.log` です。認証はアプリ設定のAPIキー、またはzcode loginのサインインを使います。

## クローリング用の入力ドキュメント

Web探索（クローリング）モードでは、案件設定の「入力ドキュメント（仕様書・操作手順）」で対象の文書を選択できます。
Markdown・TXT・HTML・JSON・YAMLのUTF-8文書（最大250,000文字）に対応します。PDF・Wordはテキストへ変換してください。
文書をプロジェクト内の `inputs/` へコピーし、［保存］で選択設定をプロジェクトファイルへ保存します。文書を変更しても自動保存しません。
探索時は実行フォルダーに文書のスナップショットを保存し、選択したAIが画面・通常利用の機能の理解に参照します。文書の情報と実際の観測結果を区別し、許可Originと禁止操作は案件設定を適用します。
探索の開始時、文書を読み取るAI（Codex CLI・Claude Code CLI・GLM。モデルと推論レベルはAPIドキュメントモードと同じ選択肢。GLMの推論レベルはzcode側の設定に従います）が文書から次の補助情報（document hints）を抽出し、探索へ利用します。文書が変わっていない場合は前回の抽出結果を使い、抽出に使ったAIは実行履歴のdocumentHints（extractedBy）へ記録します。
- クローリングでは辿り着かないAPIや管理ページの発見: 許可Origin内の文書記載URLをクローラの追加開始点へ渡します（通常の巡回と同じOrigin・禁止操作・上限の検査を受けます）
- 認証情報の把握: ロールごとの認証方式と文書内の所在を認証待ちの案内へ併記します。パスワード等の秘密値は派生成果物へ複写しません
- クローリング結果の優先付け: 個人情報・決済など文書の優先規則に該当するパターンを高優先としてAI入力の先頭へ並べます
- APIパラメータのバリエーション確認: 文書記載のパラメーター（名前・例値・必須）を一致する代表パターンへ添付します
- その他付随情報: 制約・前提をAI入力とログへ記録します
補助情報は「文書の記載」であり観測事実ではありません。未観測の文書記載エンドポイントは診断対象に含めず、未確認として記録します。抽出に失敗しても探索は継続し、次回の実行で再試行します。抽出の内容と方針は `AGENTS.md` の「入力ドキュメントの活用」に定めています。
［指定を解除］で探索への参照を止められます。取り込んだ原本と過去の実行文書はプロジェクト内に残ります。APIモードの文書とは別に管理します。

## 探索用プロキシ（Burp / ZAP）

### Node.js の検出

高速クロールと Playwright 記録には Node.js が必要です。明示した `SCOPEPILOT_NODE_PATH`（`node.exe` のフルパス）、アプリ内の `tools/node/node.exe`、通常のインストール先、プロセス・ユーザー・システムの PATH を探します。見つからない場合は、この PC の Codex デスクトップ用ローカルランタイムも確認します。Codex 用ランタイムの存在は配布先で必須ではなく、通常の Node.js を導入して使用できます。

`scripts/Start-Local.ps1` は検出した Node.js の場所を起動したアプリへ渡します。変更する PATH はその起動プロセスだけで、ユーザー／システムの永続設定は変更しません。

### 認証画面からの探索

認証画面を検出すると、選択ロールに関係なく入力案内を表示します。ユーザー名・パスワードは、現在開いている**探索用ブラウザ**へ直接入力してください。
ログインしたらScopePilotの探索画面で［認証後のロール］を選択し、［ログイン後のページを確認して再開］を押します。
同じブラウザセッションでログイン状態と実際の到達先を確認し、到達URLを探索画面に表示します。認証画面が残っている場合は再度入力を案内します。
認証待機はScopePilotのブラウザプロセスが担当し、AIのファイル書き込みに依存しません。ログイン後は同じセッションで、画面に表示された通常の参照リンクとその先のリンクを上限内で巡回します。
AI確認も同じブラウザへ接続します。MCP設定は実行内で準備し、利用者の共通MCP登録を変更しません。
開始URLと許可Originのポートを含む一致を開始前に確認します。取得0ページ、認証未完了、上限・エラー終了を全体の完了として扱いません。
［実行履歴］の［到達状況］で、取得したページと未取得・禁止・エラーの理由を参照できます。［巡回ログ］［MCP準備ログ］も実行内に保存します。
案件設定の［認証後の開始URL（任意）］を指定すると、ログイン後にその許可Origin内のURLへ遷移します。空欄では実際のログイン後の遷移先を確認します。
ログイン後の画面は、ログイン前の代表パターンに含まれていなくても通常の参照対象として扱います。開始URLが `login.php` の場合、認証後にログインURLへ戻して探索をやり直しません。
設定は［保存］で手動保存してください。一般のブラウザでログインしても、探索用ブラウザのセッションとは共有されません。

### プロキシの設定

案件設定の［探索用プロキシ］で「自動／Burp／ZAP」を選択します。自動では指定したBurpプロキシへ接続し、接続できなければZAPを起動します。
Burpの接続先は既定で `http://127.0.0.1:8080` です。ZAPを利用する場合は別途導入したZAPのJARと対応するJavaの `java.exe` を指定してください。
ZAPの既定ポートは8090、0を指定すると空きポートを割り当てます。接続先はローカルに限定します。
設定は［保存］で手動保存します。探索用プロキシと［診断ツールへ］の引き渡し先は別に選択できます。

ZAPは探索ごとに専用のdaemonをSafeモードで起動し、既存のクローラとPlaywrightの通信を中継・記録します。
高速クロールとAI探索のHARは分けて実行フォルダーへ保存します。HAR出力にはZAPのImport/Exportアドオンが必要です。
終了・停止時はScopePilotが起動したZAPを終了します。途中でプロキシが停止した場合は探索も停止し、接続先の切替は次の実行で行います。
Burp履歴MCPは任意です。利用できない場合やZAP使用時は、PlaywrightとHARの記録を使用します。
実際に使用したプロキシは実行履歴から確認できます。

## アプリ設定

「アプリ設定」画面で、ユーザー単位の既定値を `%APPDATA%\ScopePilot\settings.json` に保存します。

- ZAP実行環境: ZAPのJARと `java.exe` の既定パス。案件設定が空欄のときに使用します。
- ZAPアクティブ診断のチューニング: ルールごとの実行上限（1〜10分）・警告上限（1〜100件）・要求間隔（0〜1000ms）・ホストごとのスレッド数（1〜4）・すべての要求でのヘッダー診断・未観測パラメーターの追加。既定は従来どおり（1分・10件・100ms・1スレッド・ともに無効）です。値はZAP計画・再生成検査・承認証跡へ反映されます。
- Burp MCPプロキシ: `mcp-proxy-all.jar` の場所。空欄なら環境変数 `SCOPEPILOT_BURP_PROXY_JAR`、次に既定位置の順に解決します。
- AI連携: Codex CLI・Claude Code CLI・GLM（Z.ai・zcode）を水平線で区切った欄に分け、AIごとに接続状況を確認できます（［すべて確認］で一括確認も可能）。Codex CLIは `codex login status`、Claude Code CLIは実行ファイル（`%USERPROFILE%\.local\bin` または `%APPDATA%\npm` 配布）と認証情報、GLMはzcode CLI（`%APPDATA%\npm` 配布）と、APIキーまたはZ.aiサインイン（`zcode login`）を確認します。いずれもモデルへの生成要求（課金対象）は行いません。
- GLMのAPIキー: GLM欄でZ.ai Coding PlanのAPIキーを登録できます。入力して［設定を保存］で登録し、Windows DPAPI（ユーザー単位）で暗号化して設定ファイルへ保存します。実行時は「設定ファイル → 環境変数 `ZAI_API_KEY` → `Z_AI_API_KEY`」の順に解決し、キーがなければ `zcode login` のサインインで実行します。［登録を解除］で削除できます。［既定値に戻す］ではキーの登録を保持します。

## APIドキュメントモード

案件設定の「入力モード」で、既存のWeb探索とAPIドキュメントからのリクエスト生成を切り替えます。APIモードはクローリングを行わず、Codex CLI・Claude Code CLI・GLM（Z.ai・zcode）のいずれかが読み込んだ文書を解釈します。プロバイダーごとにモデル（Codex: GPT-6.1-Sol/GPT-6-Astra/GPT-6-Sol/GPT-6-Luna/Daybreak Blue、Claude: Opus 5.5/Sonnet 5.5/Fable 5.1、GLM: GLM-5.3/GLM-5.3 flash）を選択でき、案件に保存されます。推論レベル（Highest/High/Middle/Low）はCodexとClaude Codeでのみ選択できます（GLMはzcode側の設定に従うため選択不可）。

1. 入力モードで「APIドキュメント」を選び、診断を許可されたOriginを設定します。
2. 「ドキュメントを選択」でOpenAPI / SwaggerのJSON・YAML、Postman Collection、Markdown・HTML・TXTのAPI仕様書を読み込みます。対象はテキスト文書で、上限は250,000文字です。PDF・Wordはテキストへ変換してから読み込んでください。
3. 実際の環境のAPIベースURL（例: `https://api.example.com/v1`）とAIを設定します。文書のservers/hostより、このベースURLを優先します。通信数上限は生成件数の上限として、実行時間はAI生成時間の上限として適用します。
4. 「APIリクエストを生成」を押します。選択したAIのCLIがインストール・ログイン済みである必要があります。APIモードの生成時にBurp、Node.js、Playwright MCPの準備は不要です。
5. 「APIリクエスト」でメソッド、URL、ヘッダー、本文、出典と仮値を確認・編集し、Burpへ渡す下書きを採用します。生成直後は全件未採用です。編集は「編集を保存」または「案件を保存」で保存します。
6. 「Burpへ引き渡し」で「HTTPリクエストを出力」を押します。採用したリクエストを個別の `.http`、出典付き `api-requests.json`、`api-request-checklist.tsv` へ出力します。「選択したHTTPをコピー」も使用できます。
7. `.http` の全文をBurp Repeaterの新しいタブへ貼り付け、JSONのURLに合わせて接続先のTLS・Host・Portを設定します。認証情報、仮値、案件の操作制限を確認したうえで送信を判断します。

生成は文書に記載された通常利用のリクエストを下書きにする処理です。実際の通信・応答・診断所見として扱いません。認証トークンなどは置換値を使用し、文書にない実データのIDや値は未解決項目として記録します。外部 `$ref` の取得やmultipart・バイナリの補完は行わず、生成の制約へ記録します。大きい仕様書はAIの出力上限に収まらない場合があるため分割してください。

読み込んだ文書は選択したAIへ渡され、案件JSONと実行履歴へ保存されます。バックアップにも含まれます。生成し直すと下書き一覧と採用状態が置き換わります。失敗や停止では、既存の下書きを保持します。実行履歴ではAPI実行ログ・生成結果・生成サマリーを参照し、同じ文書を現在の許可範囲で再生成できます。

Codexは `exec --output-schema`、Claude Codeは `-p --json-schema --output-format json` で構造化出力を返します。APIモードではユーザーのMCP登録を使わず、文書を標準入力から渡します。Codexは `--ignore-user-config` 対応版（`%LOCALAPPDATA%\OpenAI\Codex\bin` など）、Claude Codeは `--safe-mode`・構造化出力対応の実行ファイル（`%USERPROFILE%\.local\bin` または `%APPDATA%\npm` 配布の `node_modules\@anthropic-ai\claude-code\bin\claude.exe`）が必要です。既存のログインを使用します。Claudeの `--bare` はサブスクリプションのログインを使わないため、この連携では認証を保持する `--safe-mode` とツール無効化を使用します。推論レベルはCodexでは `model_reasoning_effort`（Highest=xhigh）、Claude Codeでは `MAX_THINKING_TOKENS` へ変換します。GLMはZCode実装のzcode CLI（`%APPDATA%\npm` 配布。node.jsで起動）を使い、認証はアプリ設定に登録したAPIキー（または環境変数 `ZAI_API_KEY`）を優先し、ない場合はzcode自身のZ.aiサインイン（`zcode login`）を使います。APIキーを使う場合は、Z.ai Coding Planテンプレート（`zai-api`）を使う実行ごとのプロバイダー設定を `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` で渡し、モデルを `scopepilot-zai/GLM-5.3` 形式で指定します。キーを含むこの設定ファイルは証跡となる実行フォルダーではなくユーザーの一時フォルダーへ作成し、実行後に削除します。実行ログには認証方式（`auth=api-key` / `auth=zcode-login`）だけを記録します。プロンプトは `--attach` で渡し、`--json` の最終応答（response）を結果として使います。zcodeにはスキーマ強制がないため、`-p` 指示へ最終応答のJSONスキーマを埋め込み、全ツールを無効化し、ユーザーのフック・プラグインを無効化した分離設定（実行内 `zcode-settings.json`）で実行します。サインインを使う場合、モデルは `--model account:zai-individual-coding-plan/GLM-5.3` 形式で指定します。CLIオプションの出典: [Codex非対話実行](https://developers.openai.com/codex/noninteractive)、[Claude Code CLI](https://code.claude.com/docs/en/cli-reference)。

## 現在の実装

- 作業順の左ナビゲーション、画面別の主要操作、共通の状態表示
- 明暗テーマ対応のボタン・チェックボックス・一覧・スクロールバー、サイズ変更可能な一覧／詳細領域
- 候補の1クリック採用、Ctrl+Fで候補検索、Ctrl+Sで案件保存、データがない場合の操作案内
- 案件条件、許可Origin、認証ロール、禁止操作、探索上限の保存
- プロジェクトフォルダー内の `.scopepilot.json` を明示的に作成・読み込み（通信、候補、所見、ツールの結果を復元）
- 案件ごとの参照ガイドライン選択と、候補選定・AIコンテキストへの連動
- HAR、JSONL、URL一覧TXTの取込
- URLパターン・HTTPメソッドによる代表化
- 同一Method・URLでも認証ロールが異なる通信を保持し、候補根拠とAI入力へ観測ロールを反映
- 今回探索する認証ロールの選択、認証情報を扱わない手動ログイン待機、同一ブラウザセッションでの再開
- CMS記事で使われる英字＋連番、日付スラッグ、数値ID、GUIDの同一テンプレート集約
- 画面確認済みでフォーム・入力点等の手掛かりがない単純GET HTMLを「静的画面候補」として除外候補にする優先度判定
- 候補選択時のURL正規化、メソッド、応答、画面確認状況、選定根拠、参照ガイドラインのシミュレーション表示
- 診断対象候補の代表URLをクリックして既定ブラウザで開く操作
- 候補のURL・分類・理由・ロール検索、採用状態による絞り込み、表示中候補の一括採用・除外
- Windowsのライト・ダークアプリモードへ追従する画面配色とタイトルバー
- 採用候補ごとの「静的と断定できなかった理由」と診断実行時の注意事項
- 認証、権限、ファイル、外部連携、状態変更、API、AI機能、運用・クラウド機能などの初期分類
- Codex、Node.js、Playwright MCP、Burp MCPの環境チェック
- 画面探索ジョブ（Codex CLIまたはGLM（zcode））の起動、実行ログ表示、停止
- 環境確認・高速クロール・AI入力整理・Codex確認・結果取込の段階別進捗表示
- Playwrightによる画面探索とBurp経由の通信観測
- 高速GETクローラによるサイト全体のリンク巡回
- `robots.txt`のSitemap指定と同一Originの`sitemap.xml`からのURL発見（既存の上限・禁止操作・許可Originを適用）
- HTTPメソッド、Content-Type、拡張子、URL、クエリ、フォーム、応答ステータス、認証ロールによるAI投入前のパターン分類
- 静的ページ・画像・CSS・JavaScript・フォント等のAI入力除外と、動的代表パターンへの集約
- AI確認対象がない場合の画面探索の自動省略
- 開始URLは静的画面候補に見えても初回のAI確認を省略しない保護
- MFA、CAPTCHA、SSOなどの手動操作待ちと同一ジョブでの再開
- 探索完了後の `observed-requests.jsonl` 自動取込
- Burp MCPの履歴取得が失敗した場合も、保存済みの観測を部分結果として取り込む
- 高速クローラの1回自動再試行、異常終了前の観測データ復旧、再起動時の未完了状態修復、復旧記録の保存
- 候補の採用・除外状態を案件に保存し、次回は採用済みと新規発見パターンをCodexへ渡す
- 案件単位で採用・除外・確認済みの保存記録を一括解除し、観測通信から候補を再判定
- 採用候補からBurp Suite Community Edition用のScope正規表現、代表URL、JSON証跡を出力
- Community Edition向けにScope正規表現を20候補単位へ集約し、専用画面から順次コピーできる手動登録支援とTSV診断作業表を出力
- Codexの探索結果から診断所見、深刻度、確信度、観測根拠、対象URL、制約を取り込み、案件へ保存
- 所見が0件でも出力できる案件レポート（許可範囲、制約、探索カバレッジ、認証ロール、候補、選定理由、注意、所見、参照ガイドライン）のJSON/HTML/TSV出力
- Codexに渡す `engagement.json`、`prompt.md`、`selection-guidance.md`、構造化出力スキーマの生成
- プロジェクトフォルダー内への入力・実行パッケージ・引き渡し出力・レポート・バックアップ保存
- 案件JSON・探索実行・Burp出力・レポートのZIPバックアップ、保存容量集計、選択実行と生成物の確認付き削除
- 案件ごとの探索実行履歴、結果概要・制約・通信数の一覧表示、実行成果物の参照と再試行
- 直前の探索実行と比較した新規・応答変更・今回未観測のリクエストパターン差分
- 独立したログ画面、選択・全体コピー（クリップボード使用中の再試行）、プロジェクト内へのTXT保存
- 同じ探索ブラウザへ接続するPlaywright MCPと、任意のBurp履歴MCPの実行ごとの設定
- バージョン付きWindows x64自己完結型ポータブルZIP、SHA-256、初回起動ガイドの自動生成
- 日本語の利用者別インストーラー、明暗テーマ追従、ショートカット、更新・アンインストール

高速クロールの全件ログは証跡として保存しますが、Codexには渡しません。ScopePilotが確認対象のリクエストとフォームをアプリ側で代表化し、最大200リクエストパターン・100フォームパターンの `ai-input.json` と短いガイドライン要約だけをCodexへ渡します。Codexは代表的な機能の確認と追加通信の収集を担当し、結果をScopePilotが候補へ変換します。リンク巡回に加えて、利用可能な`robots.txt`とサイトマップから同一OriginのURLを補完的に発見します。未確認HTMLを静的と断定せず、フォーム付き画面、認証・認可境界、API、エラー応答などを残します。選定は一次判定であり、脆弱性や安全性の判定ではありません。

選定基準の出典はWebAppPentestGuidelines、OWASP Top 10:2025、ASVS、WSTG、AISVS、Cloud Native Application Security Top 10、デジタル庁DS-221です。AISVSはAI機能、Cloud Native Top 10は該当構成、DS-221は適用対象の案件に限って参考にします。各出典へのリンクと適用条件は探索パッケージの `selection-guidance.md` に記載します。

## 起動と保存

Brunoで手動確認した結果は［診断所見］→［Bruno確認を記録］から追加できます。Brunoの通信をZAPなどHAR出力に対応したプロキシで保存し、要求・応答1組と確認結果をプロジェクトに保存します。日本語Markdownと変換後のWordに、原本照合済みの通信を機密値の伏せ字とともに掲載します。手順は[プロジェクトと診断ツールへの引き渡し](docs/PROJECTS-AND-HANDOFF.md)を参照してください。

起動時は必ず「プロジェクトフォルダーを開く」「新規フォルダーとプロジェクトファイルを作成」「キャンセルしてアプリを閉じる」の3択を表示します。新規作成では作成先とフォルダー名を指定すると、フォルダー内に `project.scopepilot.json` を生成します。

プロジェクトファイルは手動保存です。入力・取込・候補の採否変更・実行結果の反映後、各編集画面の［保存］またはCtrl+Sで保存してください。

## 操作手順

1. Burp Suite Community Editionを起動し、Proxy Listenerを `127.0.0.1:8080` で待ち受けます。
2. BurpのMCPタブでサーバーを有効にします。
3. ScopePilotの案件設定で開始URLと診断を許可されたOriginを入力します。
4. 「探索」画面で「環境チェック」を実行し、初回は「MCP接続を設定」を押してCodexを再起動します。
5. 「探索を開始」を押します。設定は開始時に保存されます。
6. 手動操作待ちになった場合は、開いているブラウザで操作してから「手動操作を完了して再開」を押します。
7. 「候補レビュー」で採用チェックと判断根拠・注意点を確認します。上下の境界線をドラッグすると一覧と詳細の高さを調整できます。個々の通信は「観測した通信」で確認できます。
8. 「Burpへ引き渡し」で「Scope出力を生成」を押し、生成された `burp-scope-regex.txt` をBurpのTarget > Scopeへ手動登録します。
9. 「診断所見」で根拠と制約を確認し、「案件レポートを出力」でJSON/HTML/TSVを保存します。所見0件でも出力できます。
10. 過去の結果や失敗理由は「実行履歴」で確認します。選択した実行のログ、AI入力、Codex結果、探索サマリーを直接開けます。

高速クロールで `ERR_PROXY_CONNECTION_FAILED` が表示された場合は、開始URLへ到達できていません。BurpのProxy settingsで `127.0.0.1:8080` のListenerを有効にし、ScopePilotの「環境チェック」でBurp ProxyがOKになってから再実行してください。通信をBurpで観測できない状態では、Codex探索へ進めず失敗として停止します。

別案件へ切り替える場合は「新規プロジェクトフォルダー」を押します。未保存の変更がある場合は破棄してよいか確認し、案件設定、観測通信、診断対象候補、手動操作表示、実行ログを新しい案件用に初期化します。保存済みの旧案件ファイルは削除しません。

## ビルドと起動

案件ごとにプロジェクトフォルダーと `.scopepilot.json` を作成します。既存案件は［フォルダーを開く］で選択します。旧形式は［旧案件を移行］から元データを保持して移行できます。詳細は [プロジェクトと診断ツールへの引き渡し](docs/PROJECTS-AND-HANDOFF.md) を参照してください。

ローカル開発では `./scripts/Start-Local.ps1` でビルド済みアプリを起動できます。`.cache/dotnet` にSDKがある場合はそのランタイムを使用します。起動後は毎回プロジェクトフォルダーを選択または新規作成します。

```powershell
$env:DOTNET_CLI_HOME = "$PWD\.dotnet-home"
Push-Location tools/playwright-runtime
npm ci
Pop-Location
dotnet build ScopePilot.csproj
dotnet run
```

GitHub Actionsでも同じ手順でPlaywright MCPランタイムを復元し、win-x64の自己完結型配布物を成果物として生成します。

配布ZIPは `powershell -ExecutionPolicy Bypass -File scripts/Publish.ps1` で生成します。自動テスト後、`artifacts` にWindows x64自己完結型ZIPとSHA-256ファイルを出力します。配布先での準備は [DISTRIBUTION.md](DISTRIBUTION.md) を参照してください。

配布インストーラーは `./scripts/Build-Installer.ps1` で生成します（Inno Setup 6.7.3以降が必要）。`-Runtime win-arm64` を指定するとWindows ARM64ネイティブ版を生成します。テスト、ZIP、Setup.exe、SHA-256を一括生成します。初回ガイドとPlaywright MCPを同梱し、外部ソフトは利用者が準備します。

主要ロジックの自動テストは `dotnet test Tests/ScopePilot.Tests.csproj -c Release` で実行できます。URL代表化、認証ロール、AI入力除外、実行差分、Burp連携、案件レポート、バックアップを検証します。

## MCPの前提

- Playwright MCP本体はアプリに同梱され、インストール済みNode.jsから直接起動します。
- Burp MCP用のGPL-3.0プロキシは別途導入します。Burp MCP拡張のstdioプロキシ抽出機能から `mcp-proxy-all.jar` を取得し、`%LOCALAPPDATA%\ScopePilot\mcp\mcp-proxy-all.jar` へ保存してください。保存ルートを変更している場合は、そのルートの `mcp` フォルダーを使用します。別の場所にあるJARを使う場合は、ScopePilotの起動環境の `SCOPEPILOT_BURP_PROXY_JAR` に完全なパスを指定します。上流の導入手順は [PortSwigger MCP Server](https://github.com/PortSwigger/mcp-server#stdio-mcp-proxy-server) を参照してください。
- Burp: BApp StoreのMCP ServerをBurp Community Editionに追加し、MCPタブから有効化
- ScopePilotのセットアップにより、PlaywrightブラウザはBurp Proxy経由に設定されます。

外部サイトへの探索は、案件の許可範囲と禁止操作を確認してから実行してください。
