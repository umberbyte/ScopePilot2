# ScopePilot 診断報告書テンプレート v2

## 目的

この仕様は、ScopePilot が生成する Web アプリケーション脆弱性診断報告書の情報構造と入力元を定義する。顧客向け報告書は、第三者の報告書に含まれる事実上必要な情報項目を保持しながら、章順、文言、表組み、配色、評価表示を ScopePilot 独自のものとする。

顧客向け DOCX には内部フィールド名や生成処理の説明を載せない。未入力値を観測日時などから推測せず、`未入力`、`未実施`、`判定保留`、`対象外`を区別する。

## 情報構造

報告書は次の三層で構成する。

1. 意思決定情報
   - 経営層向け概要、最高深刻度、優先対応事項、重大な制約
2. 診断保証情報
   - 許可範囲、診断条件、実施方法、カバレッジ、評価基準
3. 技術証跡
   - 指摘詳細、再現条件、マスク済み通信、証拠索引、再診断結果

## 章構成

| 章 | 目的 | 主な内容 |
| --- | --- | --- |
| 表紙 | 文書を一意に識別する | レポート ID、案件名、対象システム、提出先、診断区分、発行日、発行者、機密区分 |
| 文書管理 | 作成・承認・配布を管理する | 版数、文書状態、作成者、レビュー担当、承認者、改訂履歴、配布先 |
| 経営層向け概要 | 対応判断に必要な結論を示す | 総合所見、最高深刻度、確認済み指摘数、優先対応事項、重大な制約 |
| 診断条件と対象範囲 | 実施した診断の境界を示す | 期間、診断種別、対象資産、URL、IP、ロール、診断元 IP、許可 Origin、除外、禁止操作、送信上限 |
| 診断カバレッジ | 実施・未実施を区別する | ガイドライン項目、実施状態、検証手段、対象ロール、証拠、制約 |
| 評価方法 | 判定の意味を説明する | 深刻度、成立状態、悪用容易性、対応優先度、総合所見の定義 |
| 指摘事項一覧 | 指摘を比較可能にする | ID、名称、深刻度、成立状態、対象、対応状況、再診断結果 |
| 指摘事項詳細 | 技術的根拠と対応方法を示す | メタデータ、説明、成立条件、影響、再現手順、証跡、改善策、修正確認条件 |
| 対応計画と再診断 | 対応を追跡する | 方針、担当者、期限、状態、再診断日時、結果、残存リスク |
| 証拠索引 | 原本を追跡可能にする | 証拠 ID、種類、保存先、SHA-256、取得日時、マスク状態、関連指摘 |
| 特記事項 | 利用条件と後処理を明示する | 制約、免責、問い合わせ先、診断用アカウント・許可設定の撤去、発行主体情報 |

## レポート項目マッピング

### 文書と案件

| フィールド | 表示名 | 入力元 | 現状 | 必須 |
| --- | --- | --- | --- | :---: |
| `report.id` | レポート ID | 新規生成規則 | 未実装 | ○ |
| `report.version` | 版数 | 新規レポート入力 | 未実装 | ○ |
| `report.status` | 文書状態 | 新規レポート入力 | 未実装 | ○ |
| `report.classification` | 機密区分 | 新規レポート入力 | 未実装 | ○ |
| `report.generatedAt` | 発行日 | 出力日時 | 自動取得可 | ○ |
| `engagement.name` | 案件名 | `EngagementProject.Name` | 自動取得可 | ○ |
| `engagement.systemName` | 対象システム | 新規案件入力 | 未実装 | ○ |
| `engagement.clientName` | 提出先 | 新規案件入力 | 未実装 | ○ |
| `engagement.serviceProvider` | 発行者 | アプリ設定または新規入力 | 未実装 | ○ |
| `report.author` | 作成者 | 新規レポート入力 | 未実装 | ○ |
| `report.reviewer` | レビュー担当 | 新規レポート入力 | 未実装 | ○ |
| `report.approver` | 承認者 | 新規レポート入力 | 未実装 | － |
| `report.distribution` | 配布先 | 新規レポート入力 | 未実装 | － |
| `report.revisions[]` | 改訂履歴 | 新規レポート入力 | 未実装 | ○ |

### 診断条件と対象範囲

| フィールド | 表示名 | 入力元 | 現状 | 必須 |
| --- | --- | --- | --- | :---: |
| `assessment.startedAt` | 診断開始日時 | 新規案件入力 | 未実装 | ○ |
| `assessment.endedAt` | 診断終了日時 | 新規案件入力 | 未実装 | ○ |
| `assessment.type` | 診断種別 | 案件モードと新規入力 | 一部取得可 | ○ |
| `assessment.methods[]` | 診断方法 | 実行履歴 | 一部取得可 | ○ |
| `assessment.sourceIps[]` | 診断元 IP | 新規案件入力 | 未実装 | － |
| `assessment.allowedOrigins[]` | 許可 Origin | `EngagementProject.AllowedOrigins` | 自動取得可 | ○ |
| `assessment.supportingOrigins[]` | 補助 Origin | `EngagementProject.SupportingOrigins` | 自動取得可 | － |
| `assessment.roles[]` | 認証ロール | `EngagementProject.Roles` | 自動取得可 | ○ |
| `assessment.forbiddenActions[]` | 禁止操作 | `EngagementProject.ForbiddenActions` | 自動取得可 | ○ |
| `assessment.exclusions[]` | 除外対象 | 新規案件入力 | 未実装 | ○ |
| `assessment.assumptions[]` | 前提条件 | 新規案件入力 | 未実装 | － |
| `assessment.requestLimits` | 送信・時間・ページ上限 | `MaxRequests`、`MaxMinutes`、`MaxPages` | 自動取得可 | ○ |
| `assessment.tools[]` | ツール・版・ルールセット | 実行環境証跡 | 一部取得可 | ○ |
| `assets[]` | 対象資産 | 開始 URL、Origin、対象入力 | 一部取得可 | ○ |
| `assets[].name` | 機能・資産名 | ページ名または新規入力 | 一部取得可 | ○ |
| `assets[].fqdn` | FQDN | URL から抽出 | 自動取得可 | ○ |
| `assets[].ipAddresses[]` | IP アドレス | 新規入力または名前解決記録 | 未実装 | － |
| `assets[].urls[]` | 対象 URL | Requests、Candidates、Observations | 自動取得可 | ○ |
| `assets[].notes` | 備考 | 新規案件入力 | 未実装 | － |

### 結果とカバレッジ

| フィールド | 表示名 | 入力元 | 現状 | 必須 |
| --- | --- | --- | --- | :---: |
| `summary.conclusion` | 総合所見 | 担当者入力 | 未実装 | ○ |
| `summary.highestSeverity` | 最高深刻度 | 確認済み指摘から算出 | 算出可能 | ○ |
| `summary.counts` | 深刻度・成立状態別件数 | 指摘一覧から算出 | 算出可能 | ○ |
| `summary.priorities[]` | 優先対応事項 | 担当者入力 | 未実装 | ○ |
| `summary.majorLimitations[]` | 重大な制約 | 実行履歴と担当者入力 | 一部取得可 | ○ |
| `coverage[].controlId` | 診断項目 ID | ガイドライン選択・テーマ定義 | 一部取得可 | ○ |
| `coverage[].title` | 診断観点 | ガイドライン定義 | 自動取得可 | ○ |
| `coverage[].status` | 実施状態 | 実行履歴 | 一部取得可 | ○ |
| `coverage[].method` | 検証手段 | ZAP、代替検証、手動確認 | 自動取得可 | ○ |
| `coverage[].roles[]` | 対象ロール | 実行履歴 | 自動取得可 | － |
| `coverage[].targets[]` | 対象 | 実行履歴 | 自動取得可 | ○ |
| `coverage[].evidenceIds[]` | 証拠 ID | 証拠索引 | 新規集約が必要 | － |
| `coverage[].limitations` | 制約・未実施理由 | 実行結果と担当者入力 | 一部取得可 | ○ |

`coverage.status` は `実施済み`、`一部実施`、`未実施`、`対象外`、`判定保留`のいずれかとする。警告がないことを `実施済み` の根拠にしない。

### 指摘事項

| フィールド | 表示名 | 入力元 | 現状 | 必須 |
| --- | --- | --- | --- | :---: |
| `findings[].id` | 指摘 ID | 安定した ID を採番 | 一部実装済み | ○ |
| `findings[].title` | 指摘名称 | 所見または警告 | 自動取得可 | ○ |
| `findings[].category` | 分類 | 所見・ルール辞書 | 自動取得可 | ○ |
| `findings[].severity` | 深刻度 | 担当者評価またはツール原評価 | 一部取得可 | ○ |
| `findings[].exploitability` | 悪用容易性 | 担当者評価 | 未実装 | ○ |
| `findings[].validationStatus` | 成立状態 | 手動確認結果 | 一部取得可 | ○ |
| `findings[].confidence` | 確信度 | ツールまたは担当者評価 | 自動取得可 | ○ |
| `findings[].cvss.version` | CVSS 版 | 担当者入力またはルール情報 | 未実装 | － |
| `findings[].cvss.score` | CVSS ベーススコア | 担当者入力またはルール情報 | 未実装 | － |
| `findings[].cvss.vector` | CVSS ベクター | 担当者入力またはルール情報 | 未実装 | － |
| `findings[].cweIds[]` | CWE | ZAP 原本または担当者入力 | ZAPから自動取得可 | － |
| `findings[].cveIds[]` | CVE | ZAP説明・参考情報または担当者入力 | ZAPから自動抽出可 | － |
| `findings[].guidelineRefs[]` | OWASP・ASVS・WSTG 等 | `GuidelineBasis` とテーマ定義 | 一部取得可 | ○ |
| `findings[].affectedAssets[]` | 対象資産 | URL と対象資産一覧 | 一部取得可 | ○ |
| `findings[].method` | HTTP メソッド | 観測・警告・手動確認 | 自動取得可 | － |
| `findings[].url` | URL | 観測・警告・手動確認 | 自動取得可 | ○ |
| `findings[].parameter` | パラメータ | ZAP 原本など | 一部取得可 | － |
| `findings[].role` | 認証ロール | 実行履歴 | 自動取得可 | － |
| `findings[].source` | 検出元 | ZAP、代替検証、手動、探索 | 自動取得可 | ○ |
| `findings[].observedAt` | 確認日時 | 実行履歴 | 自動取得可 | ○ |
| `findings[].summary` | 概要 | 辞書と担当者入力 | 一部取得可 | ○ |
| `findings[].conditions` | 成立条件 | 担当者入力 | 未実装 | ○ |
| `findings[].technicalCause` | 技術的原因 | 担当者入力 | 未実装 | － |
| `findings[].businessImpact` | 業務影響 | 担当者入力 | 未実装 | ○ |
| `findings[].reproduction.prerequisites` | 再現前提 | 担当者入力 | 未実装 | ○ |
| `findings[].reproduction.steps[]` | 再現手順 | 担当者入力 | 未実装 | ○ |
| `findings[].reproduction.expected` | 期待結果 | 担当者入力 | 未実装 | － |
| `findings[].reproduction.actual` | 実際の結果 | 手動確認結果 | 一部取得可 | ○ |
| `findings[].technicalEvidence.request` | Request | ZAP traditional-json-plus、Bruno HAR | マスクして自動取得可 | － |
| `findings[].technicalEvidence.response` | Response | ZAP traditional-json-plus、Bruno HAR | マスクして自動取得可 | － |
| `findings[].technicalEvidence.attackInput` | 診断入力・攻撃文字列 | ZAP原本 | マスクして自動取得可 | － |
| `findings[].technicalEvidence.observedEvidence` | 観測根拠 | ZAP原本・担当者記録 | マスクして自動取得可 | － |
| `findings[].technicalEvidence.externalInteraction` | 外部サービスインタラクション・追加観測 | ZAP原本 | マスクして自動取得可 | － |
| `findings[].technicalEvidence.collectionStatus` | 収集・マスク状態 | レポート生成処理 | 自動取得可 | ○ |
| `findings[].evidenceIds[]` | 証拠 ID | EvidenceReference 等 | 新規集約が必要 | ○ |
| `findings[].remediation.immediate` | 暫定対策 | 担当者入力 | 未実装 | － |
| `findings[].remediation.permanent` | 恒久対策 | 辞書と担当者入力 | 一部取得可 | ○ |
| `findings[].verificationCriteria` | 修正確認条件 | 担当者入力 | 未実装 | ○ |
| `findings[].references[]` | 参考情報 | ZAP 原本、CWE、担当者入力 | 一部取得可 | － |
| `findings[].limitations` | 制約 | `DiagnosticFinding.Limitations` 等 | 自動取得可 | － |

### 証拠と再診断

| フィールド | 表示名 | 入力元 | 現状 | 必須 |
| --- | --- | --- | --- | :---: |
| `evidence[].id` | 証拠 ID | 新規採番 | 未実装 | ○ |
| `evidence[].type` | 種類 | HAR、JSON、HTTP、画像、DOM、ログ等 | 一部取得可 | ○ |
| `evidence[].localPath` | 保存先 | `EvidenceReference.LocalPath` | 自動取得可 | ○ |
| `evidence[].sha256` | SHA-256 | `EvidenceReference.Sha256` | 自動取得可 | ○ |
| `evidence[].capturedAt` | 取得日時 | 実行履歴 | 一部取得可 | ○ |
| `evidence[].sensitivity` | 機密度 | 新規分類 | 未実装 | ○ |
| `evidence[].redactionStatus` | マスク状態 | 出力処理 | 一部実装済み | ○ |
| `evidence[].relatedFindingIds[]` | 関連指摘 | 新規集約 | 未実装 | ○ |
| `responses[].findingId` | 指摘 ID | 指摘一覧 | 自動取得可 | ○ |
| `responses[].plan` | 対応方針 | 担当者入力 | 未実装 | ○ |
| `responses[].owner` | 担当者 | 担当者入力 | 未実装 | ○ |
| `responses[].dueDate` | 期限 | 担当者入力 | 未実装 | － |
| `responses[].status` | 対応状態 | 担当者入力 | 未実装 | ○ |
| `responses[].retestAt` | 再診断日時 | 再診断実行履歴 | 未実装 | － |
| `responses[].retestResult` | 再診断結果 | 再診断結果 | 未実装 | ○ |
| `responses[].residualRisk` | 残存リスク | 担当者入力 | 未実装 | － |
| `responses[].retestEvidenceIds[]` | 再診断証拠 | 証拠索引 | 未実装 | － |

## 評価語彙

深刻度、成立状態、対応状態を混同しない。

- 深刻度: `Critical`、`High`、`Medium`、`Low`、`Informational`、`未評価`
- 成立状態: `確認済み`、`推定`、`未再現`、`誤検知`、`対象外`、`判定保留`
- 悪用容易性: `高`、`中`、`低`、`未評価`
- 対応状態: `未着手`、`対応中`、`対応済み`、`受容`、`保留`
- 再診断結果: `解消`、`一部解消`、`未解消`、`再診断不能`、`未実施`

総合所見は件数だけで自動決定しない。最高深刻度と確認済み指摘数は自動集計できるが、業務影響、対象範囲、未実施項目、重大な制約を担当者が確認して確定する。

## 秘密情報の扱い

- 顧客向け DOCX には Cookie、Authorization、セッショントークン、API キー、パスワードを原文のまま掲載しない。
- HTTP 要求・応答はマスク済みの複製を掲載し、原本は証拠 ID、相対パス、SHA-256 で参照する。
- URL のユーザー情報、クエリ値、フラグメントは、指摘の成立説明に必要な場合を除いて除去する。
- 提出前検査で未マスクの秘密値、内部ファイルパス、第三者の商標・著作権表記、サンプル報告書への参照がないことを確認する。

## 実装方針

既存の Markdown 文面から直接 DOCX を構成せず、まず不変の `ReportDocumentV2` を生成し、Markdown、DOCX、JSON を同じモデルから出力する。これにより集計値、指摘 ID、証拠 ID、再診断結果を形式間で一致させる。

DOCX テンプレート ID は `scopepilot-assurance-ja-v2` とする。現在の `scopepilot-a4-ja-v1` は既存互換のため残し、v2 の完成後に出力画面から選択できるようにする。

## 実装状況

- `ReportDocumentV2` と案件保存用の `ReportSettings` を追加した。
- 案件、観測通信、ツール警告、担当者所見、Bruno確認、証拠参照から構造化レポートを生成する。
- ［診断レポートを出力］で `report-document-v2.json` と `engagement-report.ja.v2.docx` を従来のMarkdown、JSON、HTMLと同時に出力する。
- v1のMarkdownからWordへの変換は、任意Markdownの変換機能として維持する。
