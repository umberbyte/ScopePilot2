# ScopePilot 動作シミュレーション実行手順（顧客説明用・再実行可能）

ScopePilotの標準ワークフロー（入力ドキュメントの補助情報抽出 → クローリング → 診断候補の選定と採用 → ZAP連携による自動診断 → 結果取込）を実際に動かし、その内容を記録して顧客へ説明するための汎用手順。DVWAを対象とした実施例の記録は案件フォルダーの `simulation/` を参照。

## 目的と守るべき前提

- 説明目的は「ScopePilotが具体的に何を・どの制御の内側で行うか」を示すことであり、脆弱性の全検出や検出率の確認ではない。
- 攻撃リクエストを送る処理はZAPなど診断ツールが提供する機能の範囲内で行う。ScopePilot自身は独自の攻撃文字列を生成しない。
- すべての実行は案件の安全制御（許可Origin・禁止操作・通信数・ページ数・実行時間）の内側で行われる。
- 文書（仕様書・README等）由来の情報は「文書の記載」であり観測事実ではない。記録では出典と未確認であることを明示する。
- 秘密情報（パスワード・APIキー・セッションCookieの値など）は記録・派生成果物へ複写しない。ZAPパッケージ内のHAR・ログはローカル証拠としてのみ保管する。
- ZAPの警告は「実影響未確認」として扱う。

## 0. 事前準備

| 確認項目 | 方法 | 今回の値（DVWA実施例） |
|---|---|---|
| 診断対象の稼働 | `curl -s -o /dev/null -w "%{http_code}" <開始URL>` | 302（login.phpへリダイレクト） |
| ZAP / Java | アプリ設定 `%APPDATA%/ScopePilot/settings.json` の `ZapJarPath` / `JavaPath` | zap-2.17.0.jar / jre-17.0.20.101-hotspot |
| Node（クローラ・zcode用） | `node --version` | インストール済み |
| zcode サインイン（GLM利用時） | `zcode` で `~/.zcode/v2/credentials.json` の存在確認 | サインイン済み |
| 記録用Excelの作業コピー | 元資料（ガイドライン診断項目一覧）を案件フォルダー `simulation/` へコピー | `WebAppPentestGuidelines_診断項目_ScopePilot_作業用.xlsx` |

実行方法は次の2通り。どちらもScopePilot本体の同じコマンド本体（MainViewModel・サービス層）を実行する:

- **GUI**: ScopePilot.exe を起動し、画面のボタンで実行（本来の利用形態。認証が必要な案件では探索ブラウザへのログインを人が行う）。
- **ヘッドレス（ハーネス）**: `scripts/simulation/ScopePilot.Simulation` を使う。画面操作ができない環境での再実行・記録採取向け。GUIアプリは案件ファイルの二重書込を防ぐため終了しておく。

## 1. 案件の再開とAI設定（z.ai / GLM）

- 案件ファイル（`project.scopepilot.json`）を開く。
- 文書ヒント抽出AI・画面探索AIを **GLM（Z.ai・zcode）** へ切替え、モデル `glm-5.3` を指定して保存。
  - GUI: 探索設定のAI選択。ハーネス: `open` フェーズ。

```bash
dotnet scripts/simulation/bin/Release/net10.0-windows/ScopePilot.Simulation.dll open
```

記録例（実行記録シート）: 「文書ヒントAI=Glm(glm-5.3) / 画面探索AI=Glm(glm-5.3) へ切替」

## 2. 探索の実行（クローリング）

- GUI: ［探索開始］。ハーネス: `explore` フェーズ（バックグラウンド実行を推奨、30分強かかる場合がある）。

```bash
dotnet scripts/simulation/bin/Release/net10.0-windows/ScopePilot.Simulation.dll explore
```

実行される内容と記録すべき観点:

1. **文書ヒント抽出（AI=z.ai）**: 入力ドキュメントからクロール追加開始点・認証情報の所在・優先規則等を抽出。抽出結果は「文書の記載」扱い。秘密値は所在のみ記録。許可Origin外のURLは除外される。失敗しても探索は継続。
2. **探索用ZAPプロキシ起動**（Safeモード・案件専用ホーム）。
3. **高速クロール**（node + `tools/fast-crawl.js`）: 開始URLから同一Originを巡回。上限（ページ数・通信数・時間）と許可Originの内側で動作。
4. **認証が必要な場合**: 認証画面を検出すると介入記録（human-intervention.json）を作り、人が探索ブラウザへ直接ログインしてロールを選んで再開する設計。ScopePilotは認証情報を扱わない。未認証のままの場合は上限到達で巡回終了し、部分結果を復旧する。
5. **AI画面探索（GLM）**: 動的パターンの確認をzcode（ツール無効化・分離設定でMCP経由）が行う。※未認証で認証ブロックにより探索が終了した場合はこのフェーズに入らない。

記録先（Excel・クローリングと採用記録シート）: 観測された通信ごとにメソッド・URL・分類・ガイドライン適合根拠を候補採用時に一括して記録する。

## 3. 診断候補の生成と全採用

- GUI: ［候補生成］→ 表示「すべて」→ ［採用］。ハーネス: `candidates` フェーズ（77件全採用と同等）。

```bash
dotnet scripts/simulation/bin/Release/net10.0-windows/ScopePilot.Simulation.dll candidates
```

- 候補は `GuidelineSelectionPolicy`（`Services/GuidelineSelectionPolicy.cs`）により、URL・メソッド・パラメータ・フォーム・ステータスコード・ロールの観測事実から分類され、参照ガイドラインの根拠（WSTG-INFO-06、ASVS 5.0、Top 10:2025 A01/A05/A07 等）が各候補の `GuidelineBasis` に付く。
- Excel「クローリングと採用記録」シートへ、採用した全候補について パターン／代表URL／分類／信頼度／ガイドライン適合根拠／判定経緯／診断上の注意／同型件数 を1行ずつ記録する（`simulation/excelrec.py` を利用）。
- 自動選定で除外したページが安全と証明されたわけではない旨を説明に含める。

## 4. ZAP自動診断の実行

- GUI: 診断タブでZAPを選び、アクティブ診断の承認語 **ACTIVE** を入力して実行。ハーネス: `zap` フェーズ。

```bash
dotnet scripts/simulation/bin/Release/net10.0-windows/ScopePilot.Simulation.dll zap --role 一般ユーザー
```

- `--role` は診断パッケージが使うHARのロール（GUIのロール選択に相当）。
- 実行の流れ: 採用候補の保存済みHARからパッケージ生成（`selected.har`＋`zap-active.yaml`）→ アドオン準備（版・SHA-256を `zap-environment.json` へ記録）→ 計画検証（`-autocheck`）→ 診断実行（`-autorun`）→ `reports/zap-report.json` から警告を「実影響未確認」として取込。
- ScopePilotがZAPを起動する実際のコマンドライン（`Services/ZapCliRunner.cs`）:

```
<JavaPath> -jar <ZapJarPath> -cmd -silent -loglevel DEBUG -dir <run>/zap-home -autocheck <run>/zap-active.yaml   # 計画検証（ログ zap-check.log）
<JavaPath> -jar <ZapJarPath> -cmd -silent -loglevel DEBUG -dir <run>/zap-home -autorun  <run>/zap-active.yaml   # 診断実行（ログ zap-run.log / zap-home/zap.log）
```

- パラメータ（アプリ設定のチューニング値が `zap-active.yaml` の各activeScanジョブへ反映される）: 強度・閾値・スレッド数・遅延ms・ルールごとの時間上限・警告数上限・ヘッダー走査・クエリ追加・CSRFトークン自動処理。1対象=1ジョブとして対象URLごとに記録に残る。
- 記録先（Excel・ZAP実行記録シート）: ①コマンドライン行 ②対象URLごとのジョブとパラメータ ③zap-run.log の要点行（ジョブ開始・完了・所要・警告検出） ④zap-summary.json の結果。セッションCookie等の秘密値は転記しない。
- 既知の失敗扱い: 取込HARに存在しないURLが計画へ含まれるとZAPが `URL Does not Exist` で中断する。実行記録に残し、該当候補の除外またはHARの再取得後に新規パッケージで再実行する。

## 5. ZAP非対応項目と手動診断の記録

- 元資料（ガイドライン診断項目一覧Excel）の「ZAP非対応項目と代替検証手段」シートのテーマから、今回の巡回スコープに該当するものを選ぶ。
- 実施せず記録のみ行う「シミュレーション」と、実際にZAP画面で行う「手動操作」を区別して記載する:
  - **ZAP非対応シミュレーションシート**: テーマ／対象ガイドライン項目／使用ツール（ZAP手動リクエストエディター・ファジング・履歴）／パラメータ・入力／実行内容／出力の見方と判定／備考（禁止操作に当たるものは未実施と明記）。
  - **ZAP手動操作記録シート**: 画面（履歴パネル・手動リクエストエディター・ファジング・アラート）／機能／入力パラメータ／リクエスト例／出力の確認箇所／判断基準／関連ガイドライン。
- ペイロードはZAP同梱定義由来の文字列のみを使用し、ZAPが提供する機能（再送信・ファジング）の範囲で行う。

## 6. 記録と証跡の所在

| 記録 | 場所 |
|---|---|
| 実行の年表 | 作業用Excel「シミュレーション実行記録」シート |
| クロールと採用の根拠 | 同「クローリングと採用記録」シート（全採用候補・ガイドライン適合根拠付き） |
| ZAP自動診断 | 同「ZAP実行記録」シート（コマンドライン・対象ごとのパラメータ・出力の1行記録） |
| ZAP非対応の代替検証 | 同「ZAP非対応シミュレーション」シート |
| ZAP手動診断 | 同「ZAP手動操作記録」シート |
| 実行ログ（ハーネス） | `simulation/logs/<phase>-<時刻>.log` |
| ScopePilotの実行証跡 | `runs/<時刻>-<id>/`（prompt・HAR・計画・ZAPログ・レポート）、`document-hints/<時刻>/` |
| 案件の状態 | `project.scopepilot.json`（観測・候補・採用・所見） |

再実行時は 1→4 のフェーズを同じ順で実行するだけでよい。記録シートは追記型なので、日時列で実施日を区別する。

## 7. ハーネスのビルド

```bash
DOTNET_CLI_HOME="$(cygpath -w "$PWD/.cache/dotnet-home")" ./.cache/dotnet/dotnet.exe build scripts/simulation/ScopePilot.Simulation.csproj -c Release
```

- `open` / `explore` / `candidates` / `zap` の各フェーズが GUI のボタンと同じコマンド本体を呼ぶ。実行ログは `--logdir`（既定は案件フォルダーの `simulation/logs/`）。
- 認証が必要な案件の巡回継続は人が探索ブラウザでログインする設計のため、ハーネス実行では未認証の範囲までとなる。認証後ロールの診断は過去に記録されたHAR（`--role`）を使うか、GUIで実施する。
