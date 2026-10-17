# F18 既知脆弱性・Nuclei

## 1. 対象

承認済み Nuclei template、HTTP 入力、起動、停止、result import、severity 正規化を扱う。上位は `design/16`, `21`, `22`。

## 2. UI/CLI

- Simple: guideline/check set 由来の選択と最終確認のみ。
- Advanced: A08/A13 で template set、severity、tag、target、上限を編集。
- CLI: templates verify、plan/run/status/stop/import。AutomationGrant 必須。

## 3. モジュール

`NucleiTemplateCatalog`, `TemplateAstPolicy`, `NucleiPlanBuilder`, `NucleiProcessAdapter`, `NucleiResultImporter`, `SeverityNormalizer`。初期対象は HTTP template の allowlist subset。

## 4. 処理

template は YAML text ではなく parse 後 AST を size/count/feature policy で検査し、source/version/hash/license/signature を固定する。process は引数配列で起動し shell 展開しない。JSONL result は streaming import し、template/target/result hash で dedupe。

## 5. 安全・証跡

target input と template selection で範囲を狭めるが、個々の外部送信は delegated control。未実測版は公開しない。code/headless/file/network interaction 等 allowlist 外 feature を拒否する。source severity と正規化値を併記する。

## 6. 失敗

malformed template/result は quarantine。process exit、timeout、cancel、partial result を区別する。結果なしを脆弱性なしと断定せず coverage として表示する。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F18-UT-001 | `core/test/unit/known-vulnerabilities/template-policy.test.ts` | code protocol | 拒否 |
| F18-UT-002 | 同上 | size/count 超過 | bounded error |
| F18-UT-003 | `nuclei-plan-builder.test.ts` | scope 外 target | plan に入れない |
| F18-UT-004 | `process-command.test.ts` | metachar を含む path | 引数として保持、shell 不使用 |
| F18-UT-005 | `result-importer.test.ts` | 同一 JSONL 再取込 | dedupe |
| F18-UT-006 | `severity-normalizer.test.ts` | 未知 severity | Unknown と原値保持 |
| F18-UT-007 | `nuclei-outcome.test.ts` | partial/cancel | success と区別 |
| F18-UT-008 | `template-catalog.test.ts` | hash/signature 不一致 | 実行拒否 |

## 8. 非単体テスト

固定 Nuclei 版の template/result CT、process stop IT、隔離 HTTP fixture の通信観測 FT、update rollback を実施する。
