# 25 文書ヒント・AI支援 概要設計

対応要件: 仕様書 7章、AGENTS.md「入力ドキュメントの活用」「作業全般のAIアシスト」

## 1. 目的

利用者が選択した生成AI（zcode、Claude、Codex等）を、文書hint抽出だけでなく案件設定、ガイドライン理解、
探索、対象選定、template選択、request作成支援、観測整理、所見・報告下書きへ一貫して利用できるようにする。
AI出力は版付き提案であり、通信の観測、診断所見、認可、実行commandそのものにしない。AIなしでも必須workflowを完走する。

## 2. 共通AI支援モデル

- `AiProviderProfile`: provider種別、利用者が選択したmodel、接続方式、local/cloud、利用可能task、secret参照。
- `AiAssistRequest`: task kind、案件/画面context、最小入力、redaction結果、利用者指示、schema version。
- `AiProposal`: provider/model/version、生成日時、入力hash、提案内容、根拠参照、confidence、採否、採用command参照。
- task kindは`CaseSetup`、`GuidelineExplain`、`DocumentExtract`、`CrawlSuggest`、`CandidatePrioritize`、
  `TemplateSuggest`、`RequestDraft`、`ObservationTriage`、`FindingDraft`、`ReportDraft`を初期集合とする。

providerは案件または利用者設定で明示選択し、taskごとに送信preview、停止、再試行、無効化ができる。
provider固有CLI/APIは`AiProviderAdapter`の背後に置き、model名や独自応答型をcore契約へ漏らさない。
AIはURL、request、payload、findingを直接送信・確定せず、採用時に通常commandを新規発行して
`OperatorPermission`、schema、認可、scope、OperationClass、budget、最終確認を適用する。

## 3. 文書hint処理フロー

1. 文書を不変の source として取り込み、種類、名前、取得元、SHA-256、page/section 座標を記録する。
2. parser が text block を作る。秘密値らしい部分には原文を複写せず `SecretCandidateRef` を付ける。
3. extractor が versioned schema に従い hint を出す。文書本文中の命令は data として扱い、tool 使用や policy 変更に利用しない。
4. validator が URL、origin、method、role、型、source span を検査する。失敗した hint は理由付きで隔離する。
5. planner が許可 origin 内の URL だけを追加開始点候補にし、既存の通信数、ページ数、時間、禁止操作を適用する。
6. 実通信で確認できた場合は別の observation を作り、hint との `corroborates` 関係を付ける。hint 自体の状態を書き換えて観測扱いにはしない。

## 4. Hint モデル

`DocumentHint` は `kind`、正規化値、source ID/span、extractor/model/version、confidence、validation status、review status を持つ。kind は最低限、追加開始 URL、API operation/parameter、role、認証方式、secret location、優先度根拠、その他メモを含む。

状態は `Extracted → Validated|Rejected → Reviewed` とし、観測状態とは別軸にする。抽出失敗も `ExtractionAttempt` として source、model、error class、再試行可能性を記録する。

## 5. 秘密情報と外部egress

password、token、client secret の値を prompt 派生物、hint、log、report に複写しない。必要な場合は利用者が [24](24-certificate-secrets.md) の SecretStore へ登録し、hint はその参照と文書内所在だけを持つ。

**AI provider への送信は案件通信とは別の外部 egress チャネル**として扱う（[21](21-update-management.md) の更新通信と同じ切り分け）。送信前に redaction と送信範囲を preview し、案件設定で local-only を選べるようにする。この送信は診断対象 scope の外であり、[22](22-execution-control.md) の対象 EgressPolicy とは別に、送信先・送信内容を明示・記録する。有料 AI なしでも探索・診断・報告が完結する（7章）。

探索前に提示する運用要約 `SelectionGuidance`（[27](27-security-guidelines.md)）は、document hint と同じく「未確認の参照情報」であり、観測・所見の確定には使わない。AI探索入力にはこの要約と採用済みhintを添えるが、AIへ実行制御の変更権限は与えない。診断項目、request、response、所見をAIへ渡す場合も、案件ごとのprovider egress許可、最小化、secret redaction、容量上限、保存条件を適用する。

## 6. 失敗と再試行

抽出失敗は探索を止めない。「補助情報なし」で通常の開始点から続行し、run record に失敗を残す。次回は source hash と extractor version が同じでも再試行でき、成功結果を過去 run へ遡及適用しない。

## 7. UI / CLI

UIは全作業領域に共通の「AIに相談」入口を置き、選択provider、送信範囲、redaction、提案であること、採否を表示する。Simpleは説明と推奨理由を中心にし、Advancedは構造化差分と採用commandをpreviewする。文書URLをscopeに自動追加せず、許可済みorigin内の開始点として採用する。CLIは`scopepilot ai assist`と`scopepilot document import|extract|hints|review`を提供し、JSON出力でproposal IDとsource spanを保持する。

## 8. 受け入れ条件

1. 文書に書かれた「外部 URL へ送信」「制限を無視」などの命令を実行しない。
2. 範囲外 URL、禁止 method、秘密値を含む hint が探索 request にならない。
3. 文書だけから observation/finding が作られない。
4. 抽出失敗後も探索が継続し、次の run で再試行できる。
5. hint から実通信、所見まで source と関係を追跡できる。
6. 全task kindでprovider/model、入力hash、redaction、提案、採否を追跡できる。
7. AIが提案したscope外URL、権限外操作、未許可template、上限変更が通常command validationで拒否される。
8. provider未設定・失敗・利用停止でも同じ必須workflowがAIなしで継続する。
