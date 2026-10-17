# F19 Organizer・報告

## 1. 対象

候補の triage、所見、重複、severity、evidence chain、Markdown/DOCX report、監査 export を扱う。上位は `design/17`, `20`, `25`, `27`。

## 2. UI/CLI

- Simple: S07 で確認が必要な候補、確定所見、report 作成。
- Advanced: A11/A12 で候補統合、根拠、影響、再現、remediation、coverage を編集。
- CLI: findings list/show/export、report build。AI draft は自動確定しない。

## 3. モジュール

`FindingCandidate`, `FindingAggregate`, `DuplicateMatcher`, `SeverityPolicy`, `EvidenceChain`, `ReportModelBuilder`, `MarkdownRenderer`, `DocxRenderer`, `AuditExporter`。CheckCatalog 769項目と fingerprint を参照する。

## 4. 処理

candidate は source と evidence を保持し、人の採用で finding になる。duplicate は自動 merge せず候補提示し、merge 履歴を残す。report model は renderer 非依存の正規形で、観測事実、文書記載、AI提案、推論を区別する。

## 5. 安全・証跡

原本→派生成果物の hash chain を切らない。secret/PII redaction は report profile ごとに適用し、redaction 自体を監査する。未確認事項、外部エンジン委譲、coverage limitation を省略しない。

## 6. 失敗

evidence なしでは Confirmed にできない。render failure は中間 model を保持し再試行可能にする。AI文章を事実 field に自動転記しない。DOCX layout は生成成功だけで完了としない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F19-UT-001 | `core/test/unit/reporting/finding-aggregate.test.ts` | evidence なしで Confirm | 拒否 |
| F19-UT-002 | `duplicate-matcher.test.ts` | 類似候補 | merge せず suggestion |
| F19-UT-003 | `severity-policy.test.ts` | source と手動値 | 両値と変更理由を保持 |
| F19-UT-004 | `report-model.test.ts` | hint/observation/AI 混在 | origin label を分離 |
| F19-UT-005 | `redaction.test.ts` | secret/PII | profile に従い除外 |
| F19-UT-006 | `markdown-renderer.test.ts` | 固定 model | deterministic output |
| F19-UT-007 | `evidence-chain.test.ts` | hash 不一致 | broken chain として失敗 |
| F19-UT-008 | `report-model.test.ts` | delegated coverage | limitation を必ず含む |

## 8. 非単体テスト

Markdown/DOCX golden test、DOCX render の視覚 QA、large report 性能、監査 export の再検証、AI provider 別 structured proposal CT を行う。
