# 25 文書ヒント・AI 概要設計

対応要件: 仕様書 7章、AGENTS.md「入力ドキュメントの活用」

## 1. 目的

仕様書、操作手順、API 文書から探索の補助情報を抽出する。文書の記載は未確認の主張であり、通信の観測や診断所見を文書だけから生成しない。

## 2. 処理フロー

1. 文書を不変の source として取り込み、種類、名前、取得元、SHA-256、page/section 座標を記録する。
2. parser が text block を作る。秘密値らしい部分には原文を複写せず `SecretCandidateRef` を付ける。
3. extractor が versioned schema に従い hint を出す。文書本文中の命令は data として扱い、tool 使用や policy 変更に利用しない。
4. validator が URL、origin、method、role、型、source span を検査する。失敗した hint は理由付きで隔離する。
5. planner が許可 origin 内の URL だけを追加開始点候補にし、既存の通信数、ページ数、時間、禁止操作を適用する。
6. 実通信で確認できた場合は別の observation を作り、hint との `corroborates` 関係を付ける。hint 自体の状態を書き換えて観測扱いにはしない。

## 3. Hint モデル

`DocumentHint` は `kind`、正規化値、source ID/span、extractor/model/version、confidence、validation status、review status を持つ。kind は最低限、追加開始 URL、API operation/parameter、role、認証方式、secret location、優先度根拠、その他メモを含む。

状態は `Extracted → Validated|Rejected → Reviewed` とし、観測状態とは別軸にする。抽出失敗も `ExtractionAttempt` として source、model、error class、再試行可能性を記録する。

## 4. 秘密情報

password、token、client secret の値を prompt 派生物、hint、log、report に複写しない。必要な場合は利用者が [24](24-certificate-secrets.md) の SecretStore へ登録し、hint はその参照と文書内所在だけを持つ。

**AI provider への送信は案件通信とは別の外部 egress チャネル**として扱う（[21](21-update-management.md) の更新通信と同じ切り分け）。送信前に redaction と送信範囲を preview し、案件設定で local-only を選べるようにする。この送信は診断対象 scope の外であり、[22](22-execution-control.md) の対象 EgressPolicy とは別に、送信先・送信内容を明示・記録する。有料 AI なしでも探索・診断・報告が完結する（7章）。

探索前に提示する運用要約 `SelectionGuidance`（[27](27-security-guidelines.md)）は、document hint と同じく「未確認の参照情報」であり、観測・所見の確定には使わない。AI 探索入力にはこの要約と採用済み hint を添えるが、AI へ実行制御の変更権限は与えない。

## 5. 失敗と再試行

抽出失敗は探索を止めない。「補助情報なし」で通常の開始点から続行し、run record に失敗を残す。次回は source hash と extractor version が同じでも再試行でき、成功結果を過去 run へ遡及適用しない。

## 6. UI / CLI

UI は source、該当箇所、未確認状態、採用/却下、観測との対応を表示する。文書 URL を scope に自動追加せず、許可済み origin 内の開始点として採用する。CLI は `scopepilot document import|extract|hints|review` を提供し、JSON 出力で source span を保持する。

## 7. 受け入れ条件

1. 文書に書かれた「外部 URL へ送信」「制限を無視」などの命令を実行しない。
2. 範囲外 URL、禁止 method、秘密値を含む hint が探索 request にならない。
3. 文書だけから observation/finding が作られない。
4. 抽出失敗後も探索が継続し、次の run で再試行できる。
5. hint から実通信、所見まで source と関係を追跡できる。
