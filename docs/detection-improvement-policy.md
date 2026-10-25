# 検出率向上に向けた修正方針

- 作成日: 2026-10-12
- ステータス: 提案（未実装）。実装はフェーズごとに着手し、完了時に `docs/work-logs/` へ記録する。
- 位置づけ: 本文は `AGENTS.md`（開発方針）と `docs/PROJECTS-AND-HANDOFF.md`（運用仕様）に従属する。2026-10-17 の方針改訂（`AGENTS.md`、`docs/burp-professional-replacement-spec.md` 3.1）により、旧方針と衝突していた制約（攻撃コードの実装禁止、Spider等の能動クロールの禁止、未観測要求の送信禁止）は解除済みである。フェーズ3の「要合意」はこの合意を受けたものとして扱う。
- 出典: 2026-10-12時点のコードベース調査、`docs/work-logs/2026-10-11.md`、`docs/work-logs/2026-10-12.md`

## 1. 目的と適用範囲

ScopePilotの診断ワークフロー（探索・採用・ZAP/Burpへの引き渡し・結果取込・報告）における検出の網羅性と信頼性を向上させるための修正方針を定める。対象はZAP / Burp Suiteが提供する機能の設定・連携方法の改善を中心とし、独自実装を含む診断エンジンの拡張（Fuzzer相当の自動反復送信を含む）は `docs/burp-professional-replacement-spec.md`（F05等）に従う。

本方針には次を含まない（`AGENTS.md` に従う）:

- 特定の検証対象（DVWA等）専用の処理（明示的な依頼がある場合に限る）
- 検出件数そのものを既定の受け入れ基準とする運用
- 脆弱性情報からの攻撃コードの自動生成

安全な実行制御、許可範囲の遵守、証拠の追跡可能性、結果の誤解を防ぐ表示は、検出率の向上と同時に、本方針のすべての項目で維持・強化する。

## 2. 調査結果の要約（現状）

### 2.1 診断の仕組み

- ZAPの実行はAutomation FrameworkのYAML計画生成による（`Services\ZapHandoffService.cs:154` `CreatePlan`）。計画は「HAR取込（再送なし）→ 受動診断の待機 →（認証時）`replacer` によるCookie注入 → 観測済みURLごとのアクティブ診断 → レポート出力」で構成される。
- 診断対象はScopePilotのクローラ／ブラウザ記録で観測したHARと採用済みURLに限定される。ZAP自身のSpider・Requestor・openapi等のインポートは使わない（`docs\PROJECTS-AND-HANDOFF.md:139`）。
- 実行前の防御: HAR・計画のSHA-256検証、計画再生成との一致検査（改竄防止、`Services\ZapCliRunner.cs:60-63`）、観測済みURLと許可Originの再検証（同39-51）、ACTIVE入力による対話承認（同56-57）、承認証跡の保存（同72-80）、実行済み証拠の上書き拒否（同64-65）。

### 2.2 判明した問題とギャップ

| 区分 | 内容 | 参照 |
|---|---|---|
| 不整合 | 認証付き診断の計画は `replacer` ジョブを生成するのに、必須add-on一覧に `replacer` が含まれない | `Services\ZapAddonService.cs:25-26`、`docs\PROJECTS-AND-HANDOFF.md:120` |
| 未検証 | 認証付きアクティブ診断の実機（ZAP 2.17.0）通し確認が未実施 | `docs\work-logs\2026-10-12.md:24` |
| 履歴 | 2026-10-12のCookie正規表現修正以前の「認証付き」実行は実質すべて未認証（実測: 733件中0件にCookie適用） | `docs\work-logs\2026-10-12.md:31` |
| 固定値 | 攻撃強度の既定がLow。強度依存ルール（時間差SQL注入40019等）はDefault以上でしか発火しない | `Domain\DiagnosticModels.cs:27`、`docs\work-logs\2026-10-12.md:25` |
| 固定値 | `maxRuleDurationInMins: 1`（遅いルールの打ち切り）、`maxAlertsPerRule: 10`、`scanHeadersAllRequests: false`、`addQueryParam: false` がすべて固定 | `Services\ZapHandoffService.cs:181-185`、`Services\ZapCliRunner.cs:78-79` |
| ルール範囲 | 必須化されるのはリリース品質の `pscanrules` / `ascanrules` のみ。ベータ品質packにしか存在しないルール（オープンリダイレクト20019等）は最初から使えない | `Services\ZapAddonService.cs:25-26` |
| 機能不在 | ルール単位・ポリシー単位の選択機能がない（全体強度・閾値のみ） | `MainWindow.xaml` ZAPパネル |
| カバレッジ | クローラが観測しないURLは診断されない（2026-10-11の `/login.php` 「URL Does not Exist」事故が実例） | `docs\work-logs\2026-10-11.md` |
| カバレッジ | API文書から作った下書きは観測応答がないため診断開始不可 | `Services\ZapCliRunner.cs:27-28`、`docs\PROJECTS-AND-HANDOFF.md:136` |

### 2.3 実測（DVWA、low、強度Default、63URL、2026-10-12）

- 検出: SQL注入（40018）、ブラインドSQL注入（40018）、反射型XSS（40012）、パストラバーサル＋RFI（6/7、param=page）、CSP（10055）。実行時間約25分。
- 未検出: コマンド注入（90020）、格納型XSS（40014/40016）、DOM XSS（40017）、オープンリダイレクト（20019）。
- 汎用スキャナの範囲外と整理: 総当たり、CAPTCHA回避、アップロード、認証バイパス、BAC、不十分なID、API固有、暗号（`docs\work-logs\2026-10-12.md:32`）。

## 3. 修正方針

共通の実装上の注意: 診断パラメータを変更する項目は、計画生成（`CreatePlan`）と実行時の再生成検査（`Services\ZapCliRunner.cs:60-63`）、承認証跡（`zap-active-authorization.json`）の3箇所が常に一致するよう、まとめて変更する。

### フェーズ0: 認証診断の信頼性回復（最優先）

**F0-1 Replacer add-onの必須扱い**

- 現状: `ActiveScanRequiredIds`（`Services\ZapAddonService.cs:26`）は `ascanrules` まで。認証付き診断で `replacer` ジョブを生成しても、add-onが導入・検証されない経路がある。`PrepareAsync` は `includeActiveScan` しか区別しないため、認証付きの判定が導入処理へ伝わっていない。
- 方針: 認証付きアクティブ診断の準備では `replacer` を必須add-onへ追加する（認証フラグを導入処理へ伝搬）。
- 完了条件: 認証付きの準備で `replacer` が導入され `zap-environment.json` に記録されること、未認証では従来どおり非導入であること、を自動テストで確認する。

**F0-2 認証付き診断の実機通し確認**

- 現状: 実機E2Eが未実施（`docs\work-logs\2026-10-12.md:24`）。あわせて、正規表現修正以前の認証付き実行は実質未認証だった（同31行）。
- 方針: ZAP 2.17.0と認証を要する対象で、Cookieが診断要求へ実際に適用されていることを `zap-home/zap.log`（`-loglevel DEBUG` の記録）で確認する通し実行を行う。修正前に実行した認証付き診断の結果は「未認証相当」として再解釈・再実行が必要であることを報告・手順に明記する。
- 完了条件: 実機でのCookie適用確認と、該当する過去実行の扱い（再診断または注意喚起）が作業記録に残ること。

### フェーズ1: 診断パラメータの設定化

**F1-1 攻撃強度の既定と表示**

- 現状: 既定Low（`Domain\DiagnosticModels.cs:27`）。強度依存ルールはDefault以上でしか発火しない。
- 方針: 既定はLowを維持（安全側）し、強度選択UIに「Lowでは発火しないルールがある」旨の注記を追加する。Default以上への引き上げは利用者の明示選択とし、承認証跡の `settings.strength` で追跡する（既存の仕組みを維持）。許可された対象での段階的な引き上げを前提とする（`docs\work-logs\2026-10-12.md:25`）。
- 完了条件: 注記の表示、および選択強度の計画・承認証跡への反映テストの維持。

**F1-2 `maxRuleDurationInMins` の設定化**

- 現状: 1分固定（`Services\ZapHandoffService.cs:182`、承認証跡も `Services\ZapCliRunner.cs:78` で1固定）。遅いルール（時間差系）が打ち切られうる。
- 方針: 診断設定として変更可能にする（上限はクランプ。初期の上限は5分を想定。実測でも5分で実施した実績がある）。承認証跡へ実値を記録する。
- 完了条件: 設定値の計画・再生成検査・承認証跡の3箇所への反映と、上限強制を自動テストで確認する。

**F1-3 `maxAlertsPerRule` の設定化**

- 現状: 10件固定（`Services\ZapHandoffService.cs:185`、`Services\ZapCliRunner.cs:79`）。
- 方針: 診断設定として変更可能にする（上限つき）。多発見の切り捨て防止と、警告増加時の確認負荷のバランスを注記で案内する。
- 完了条件: F1-2と同様。

**F1-4 `scanHeadersAllRequests` / `addQueryParam` のオプション化**

- 現状: いずれも false 固定（`Services\ZapHandoffService.cs:184-185`）。ヘッダ経由の問題や未観測パラメータが診断されない。
- 方針: 既定無効のトグルとして設定可能にする。有効時は要求数が増える旨をUIに表示し、承認証跡の `safeguards` へ実値を記録する。
- 完了条件: 計画・承認証跡への反映、既定無効の回帰テスト。

**F1-5 スキャンポリシーの選択（後段）**

- 現状: 全体の強度・閾値のみで、ルール単位の取捨選択ができない。
- 方針: ZAP Automation Frameworkが提供するポリシー指定（activeScanジョブの `policy` 等）を利用し、ZAP提供のスキャンポリシーを選択可能にする。独自ルール・ペイロードの実装は2026-10-17 の方針改訂で認められたが、本項目ではZAP提供ポリシーの選択に限定し、独自部分は `docs/burp-professional-replacement-spec.md` F05・F20 の範囲で扱う。
- 完了条件: ポリシー指定が計画・承認証跡へ反映され、再生成検査と整合すること。

### フェーズ2: ルールパックの拡張と品質表示

**F2-1 ベータ／アルファ品質ルールpackの導入オプション**

- 現状: リリース品質のみ必須化（`Services\ZapAddonService.cs:25-26`）。`ascanrulesBeta` / `pscanrulesBeta` 等、公式Marketplace提供のpackには現状使えないルールがある（例: オープンリダイレクト20019）。
- 方針: 既定無効のオプションとして、公式Marketplaceからベータ／アルファ品質packを導入可能にする（既存の `-addoninstall` 経路と `zap-environment.json` 記録をそのまま使う）。取込・一覧・報告にはルールの品質（release/beta/alpha）を明示し、検証の成熟度が異なることを利用者が誤解しない表示をセットにする。
- 完了条件: オプション有効時の導入・検証・記録、品質の表示、既定では非導入であることの回帰テスト。

**F2-2 日本語解説辞書の拡充**

- 現状: `Services\JapaneseZapAlertCatalog.cs`（版2）は主要ルールのみ解説。
- 方針: F2-1で有効になるルールを含め解説を拡充する。未収録ルールは「解説なし」と明示し、不当な安心感を与えない。
- 完了条件: 追加ルールの解説と、未収録時の表示。

### フェーズ3: 診断対象カバレッジの拡大（2026-10-17 合意済み）

`docs\PROJECTS-AND-HANDOFF.md` の「SpiderやRequestorは実行しません」「`sendRequests` パラメータは指定しません」は現行実装の記述である。本フェーズが前提としていた方針変更（能動クロール・未観測要求の送信）は、2026-10-17 の方針改訂（`AGENTS.md`、`docs/burp-professional-replacement-spec.md` 3.1 F08/F11/F12）により認められた。実装時に `PROJECTS-AND-HANDOFF.md` の該当記述を更新すること。

**F3-1 ZAPスパイダーのオプション化**

- 現状: 診断対象はHAR観測済み・採用済みURLのみ。クローラが観測しないURLは永久に診断されない。
- 方針案: contextの `includePaths` に限定したspider / ajaxSpiderジョブを、ACTIVE承認の内側で、既定無効のオプションとして追加する。スパイダーが送信する要求の性質（GET中心とはいえ能動的な要求送信であること）をUIと承認証跡に明記する。結果取込の許可Originフィルタ（`Services\ZapResultImporter.cs`）は二重に効かせたまま維持する。
- 経緯: 「保存済み通信のみを診断する」という旧原則からの変更は2026-10-17 に認められた（仕様書3.1 F11）。

**F3-2 API文書起点の診断経路**

- 現状: API下書きは観測応答がないため診断開始不可（`Services\ZapCliRunner.cs:27-28`）。`sendRequests` 指定の除外は意図的な安全策（`docs\PROJECTS-AND-HANDOFF.md:138`）。
- 方針案: (a) ZAPプロキシ（Safe mode）経由で下書き要求を手動送信して観測する手順の整備、または (b) ZAPのopenapi等のインポートジョブを承認ゲートの内側で実行する経路の追加。未観測要求の自動送信は2026-10-17 の方針改訂により認められた（仕様書3.1 F12）。
- 経緯: (b)が前提としていた「再送しない」原則の緩和は同改訂で承認済み。

**F3-3 探索HAR参照オプションの案内（追加実装なし）**

- `IncludeReferenceHars`（`Domain\DiagnosticModels.cs:21`）は実装済み。案内文の充実のみ。

### フェーズ4: 結果取込・報告の改善

**F4-1 報告物への診断条件の記録**

- 現状: 承認証跡に強度・閾値・上限の一部が記録される（`Services\ZapCliRunner.cs:78-79`）が、診断レポート（`Services\JapaneseDiagnosticReportService.cs`）への診断条件・ルール品質の明記は網羅的でない。
- 方針: 強度・閾値・各上限・有効化したルールpackとその品質を診断レポートへ明記し、「どの条件で何を実施したか」を追跡可能にする。未実施の領域（フェーズ5参照）も「自動診断の対象外」として可視化する。
- 完了条件: レポートへの記載と、記載内容が承認証跡と一致することの確認。

**F4-2 受動診断待ちの実機確認**

- 現状: `passiveScan-wait` の `maxDuration` は実行時間のクランプ値（`Services\ZapHandoffService.cs:169`）。
- 方針: HAR取込直後の受動解析が待ち時間で打ち切られないか実機で確認し、必要なら待ち条件を調整する。
- 完了条件: 実機確認の記録。

### フェーズ5: 汎用スキャナの範囲外領域への対応

**F5-1 手動確認フローの拡充**

- 現状: `docs\required-service-spec.md` が網羅する領域（認可・アクセス制御、ビジネスロジック、ファイルアップロード、認証バイパス、API固有検査等）は汎用診断ルールの対象外。Bruno手動確認（`Services\BrunoCaptureService.cs`）とチェックリスト（`diagnostic-checklist.tsv`）で補完する設計。
- 方針: チェックリストとBruno記録の様式を `required-service-spec.md` のカテゴリに対応させ、未実施領域が報告で可視化されるようにする。本項目は手動確認の見落とし防止に限定し、攻撃の自動化は `docs/burp-professional-replacement-spec.md`（F05等、2026-10-17 の方針改訂で実装を認められた範囲）で扱う。
- 完了条件: チェックリストのカテゴリ対応と、報告での未実施領域の可視化。

## 4. 検証方針

- 各フェーズの完了時に、回帰テスト（現状161件合格が基準）と、実機ZAPを要するオフライン統合テストで動作確認する。
- DVWA等での強度別再検証（未検出だった90020、40014/40016、40017、20019の強度Highでの確認）は、`AGENTS.md` に従い明示的な依頼があった場合のみ実施する。その場合は依頼の範囲を受け入れ基準とし、成果物はプロジェクトフォルダー外に置く慣行（`../benchmark-low-20261012/` と同様）に従う。

## 5. 優先順位と依存関係

| 順 | フェーズ | 依存・備考 |
|---|---|---|
| 1 | フェーズ0 | 他のすべての前提。過去実行の再解釈を含む |
| 2 | フェーズ1・2 | 並行して着手可能。F2-2はF2-1依存 |
| 3 | フェーズ4 | F1・F2で設定項目が確定してからが望ましい |
| 4 | フェーズ3 | 方針変更は2026-10-17 に合意済み。着手可能（実装時に `PROJECTS-AND-HANDOFF.md` を更新） |
| 5 | フェーズ5 | どのタイミングでも着手可能。自動診断の拡大ではない |

## 6. 受け入れ基準の基本方針

- 既定の受け入れ基準は検出件数ではなく、(1) 機能の正しさ（計画・承認証跡・実行の一致）、(2) 安全制御の維持（許可Origin検証、ACTIVE承認、上書き防止、証拠SHA-256検証）、(3) 表示の正確さ（ルール品質の明示、実影響未確認の明示）とする。
- 検出率の数値確認は明示的な依頼があった場合のみ、その依頼範囲で実施する（`AGENTS.md`）。
