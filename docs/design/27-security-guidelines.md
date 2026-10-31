# 27 セキュリティガイドライン参照と候補選定 概要設計

対応要件: 仕様書 F03・F08・F19・6.3（実施範囲とガイドライン対応）・5.1（解説と対応表の版管理）・3.1（探索→採用→診断の triage）

## 1. 目的

公開セキュリティガイドラインを案件単位で選び、観測した通信を分類して「なぜ診断対象として採用／除外したか」を**ガイドライン項目の参照つき**で示す。これは旧 ScopePilot の中核機能であり、ScopePilot2 でも維持する。

対象ガイドライン（初期）: OWASP WSTG、OWASP ASVS、OWASP Top 10、WebAppPentestGuidelines（日本）、OWASP AISVS、OWASP Cloud Native Top 10、デジタル庁 DS-221。

**原則**: ガイドライン参照は「選定・確認観点の根拠」であって、脆弱性の確定でも網羅の保証でもない。URL・メソッド・応答メタデータだけで安全／脆弱を断定しない。許可 origin と禁止操作を優先する。triage は観測のみで、追加の対象通信を発生させない。

## 2. 旧版から継承する知見

旧 `GuidelineContext`・`GuidelineSelectionPolicy`・`CandidateSelector`・`FindingReportService` の挙動を、ソース移植ではなく fixture と契約で再現する。

- 案件で有効化したガイドラインだけを適用し、無効なものの項目番号を出さない。
- 分類は観測可能な signal（path 語彙、method、query、form、status、認証ロール、Content-Type）に基づき、各 signal に「断定しない」注意文を添える。
- 静的アセット・静的画面候補は代表 1 件へ集約し、繰り返し診断を避ける。静的扱いは安全の証明ではない。
- AI 機能・クラウド固有・DS-221 は「適用対象と確認できた場合のみ」項目を参照する。
- 報告に「参照ガイドライン（有効化一覧）」と、候補・所見ごとの「参照基準」を残す。

## 3. ガイドラインカタログと版

- `GuidelineCatalog`: ガイドラインごとに、出典 URL、版、ScopePilot が作成した**短い運用要約**、項目対応（例: `OWASP Top 10:2025 A01`、`WSTG-INFO-06`）を持つ。原文は複製せず要約と参照のみを保持し、配布物ごとにlicense、attribution、改変表示を記録する。
- カタログは [21](21-update-management.md) の runtime bundle に「ガイドライン要約・項目対応表」として版固定する。上流で項目番号が変わりうるため、実行記録に使用版を残し、版をまたいで番号を仮定しない（5.1）。
- 初期の項目・template対応入力は[診断項目Excel](../WebAppPentestGuidelines_診断項目_ScopePilot_作業用.xlsx)とする。
  source hash、sheet、row、importer versionを保持するが、workbookをruntimeで直接解釈しない。ガイドライン6sheetの
  769行を`CheckCatalog`へ、ZAP対応/非対応sheetを`DiagnosticTemplateCatalog`の候補へ変換し、実行記録sheetは
  A0 fixtureとして分離する。
- 国内Web診断ガイドラインは、公式[WebAppPentestGuidelines](https://github.com/WebAppPentestGuidelines/WebAppPentestGuidelines)
  第1.2版（2022-02-16公開）を第2の版固定sourceとする。commit
  `bcc4df46a7371ea0860e0d0900a22f89286ce5b8`、公式Excel SHA-256
  `bc25519a2b270e5c244cebdf26a08dd1387de7e08143f3ffbd71f2e8e5306dd8`、原本行2〜103を固定し、
  `WAPG-1.2-001`〜`WAPG-1.2-102`へ一意に対応づける。licenseが明示されるまでは原文・payloadを再配布せず、
  項目ID、公式link、原本行、ScopePilotのcoverage routeだけをbundleへ収録する。これによりcatalogは計871項目となる。

## 4. コンポーネント構成

```text
GuidelineCatalog（core・版付き参照データ）:
  ガイドラインの要約・項目・出典・版。原文の代替ではない旨を保持
SelectionGuidance（core）:
  案件で有効化したガイドラインから運用要約（旧 selection-guidance.md 相当）を生成。
  免責（断定しない／許可origin・禁止操作優先）を含め、AI探索入力（25）とUIへ提示
TriagePolicy（core の純関数・通信を発生させない）:
  入力: 観測（Exchange/observation）＋有効ガイドライン
  出力: SelectionAssessment { selected, category, confidence, signals[], caution,
         references[](有効ガイドラインの項目のみ), staticAsset, passiveHtml }
CandidateSelector（core）:
  代表URLパターンごとに DiagnosticCandidate を作り、guidelineBasis（参照項目）と
  caution を付けて診断計画（10）へ根拠付きで渡す
```

- `TriagePolicy` と `CandidateSelector` は送信しない。分類の確定（誤検出抑制）は人が [17](17-organizer-reporting.md) の確認状態で行う。
- `references` は有効化したガイドラインの項目に限り、「該当構成の場合のみ」などの条件を文言として保持する。

## 5. データモデル

- `GuidelineSelection`（案件資産。[02](02-case-scope-authorization.md) の案件へ保持）: ガイドラインごとの有効/無効。
- `GuidelineCatalogVersion`（版・出典・hash。[21](21-update-management.md)）。
- `SelectionAssessment`（triage の根拠。observation/finding の実影響判定とは別層）。
- `DiagnosticCandidate`（代表パターン＋guidelineBasis＋caution）。
- これらは [17](17-organizer-reporting.md) の `CoverageRecord`（検査項目×ガイドライン対応×実施状態）へ接続する。

## 6. 安全制御と誤解防止

- 参照は triage 根拠であり脆弱性の確定ではない。UI・報告で「参照基準」「実影響未確認」を [23](23-ui-and-migration.md)・[17](17-organizer-reporting.md) の表示規則で明示する。
- 項目番号は原文確認前に断定しない旨を表示する。無効化したガイドラインの項目は出さない。
- 静的除外は代表化のためであり安全の証明ではない、と各判定に添える。
- triage は観測のみで通信を発生させないため、[22](22-execution-control.md) の送信制御対象外。採用結果を診断計画へ渡した後は通常の認可・上限の内側で実行する。

## 7. 報告連携

[17](17-organizer-reporting.md) の報告に次を必ず含める。

- 参照ガイドライン: 案件で有効化したガイドラインと版の一覧。
- 候補・所見ごとの参照基準（guidelineBasis）と、選定/除外の理由・confidence・caution。
- CoverageRecord: 検査項目×ガイドライン対応×実施状態（実施済/非該当/未対応/禁止/認証失敗/時間切れ/エラー）。

## 8. UI / CLI

- 案件設定にガイドライン選択パネル（有効/無効・版・出典）。Simple / Advancedの両方で利用できる。
- 候補一覧に分類・signal・参照基準・caution を表示し、observation/finding とは別層であることを明示する。
- SelectionGuidance（運用要約）を探索前に提示する。
- Simpleではガイドラインと探索後対象だけを選び、review済みtemplateはcoreが能力・認可・適用条件から組み立てる。
  Advancedではガイドライン項目からtemplateを選択・編集できるが、review状態と安全制御を越えて昇格できない。
- CLI: `scopepilot guideline list|show`、候補出力（`candidates`）に guidelineBasis を含める。

## 9. 確定事項

1. 初期bundleの必須catalogはWSTG、ASVS、OWASP Top 10とし、build時点のstable releaseをversion/hash固定する。
   WebAppPentestGuidelinesは公式第1.2版の102項目を安定ID、公式link、原本行、coverage routeで保持し、
   licenseが明示されるまで本文・payloadを再配布しない。
   AISVS、Cloud Native Top 10、DS-221はconditional catalogとする。旧769項目は[17](17-organizer-reporting.md)の
   `CheckCatalog`へ一方向変換し、guideline itemとはmany-to-many mappingにする。旧件数を初期catalogの完成条件にせず、
   source座標、根拠、reviewer、catalog versionがあるmappingだけを公開する。
2. `ApplicabilityFact`を案件資産に追加し、`WebApplication`、`HasAiFeature`、`CloudNativeAssetInScope`、
   `GovernmentProcurementContext`を`True|False|Unknown`、根拠source、確認者、日時付きで持つ。WSTG/ASVS/Top10は
   WebApplication=Trueで、AISVSはHasAiFeature=True、Cloud NativeはCloudNativeAssetInScope=True、DS-221は
   GovernmentProcurementContext=Trueでだけ有効化する。UnknownはAI提案を表示できるが、自動有効化しない。
   DS-221は調達・実施範囲の確認観点であり、単独で攻撃requestを生成しない。
3. OWASP由来の要約・mapping packageは原典ごとのlicenseを記録し、CC BY-SA対象の派生dataはcodeと分離して
   CC BY-SA 4.0、出典、版、変更表示を同梱する。デジタル庁DS-221はPDL 1.0/CC BY互換条件に従い出典と加工表示を
   付ける。license不明のWebAppPentestGuidelinesはlink-onlyとする。どのcatalogも原文全文をbundleへ複製せず、
   `sourceUrl`はversion固有の公式URL、`retrievedAt`、`sourceHash`を持つ。
4. run作成時に`GuidelineRefSnapshot`（catalog ID/version/hash、item ID、当時の短いlabel、source URL）を不変保存する。
   updateは新catalogを追加するだけで過去snapshotを書き換えない。項目番号変更は
   `Supersedes|SplitInto|MergedInto|NoMapping`の明示relationで表し、自動的に新番号へ置換しない。
   再診断は旧・新版を並べ、比較不能を表示できる。

## 10. 実行計画への反映

- Simple の選択値は `ExecutionPlan.guidelineIds` へ正規化して保存し、plan hash と確認内容の対象にする。
  選択を変更した場合は既存 confirmation を再利用できず、再確認を要求する。
- `workflow-scan` は選択ガイドラインからチェックID集合を解決してから実行する。未指定の旧計画は互換性のため
  21チェックを実行する。ASVS、WSTG、OWASP Top 10、国内Web診断プロファイルは21チェック、DS-221は
  workbookでDS項目へ直接対応づけられた9チェックを実行する。
- 実行済み表示は、実際に検出または未検出として記録されたチェックIDと診断経路の対応がある場合だけ更新する。
  選択外の経路を「実施済」と表示しない。
- 実DVWAでASVS（21チェック）とDS-221（9チェック）の切替を回帰確認する。DVWAに存在しない機能は
  vulnerabilitiesBoxを補助対象にし、対象機能も検証前提もない項目をモデルの推測だけで実施済みにしない。

公式参照: [OWASP WSTG](https://github.com/OWASP/wstg)、[OWASP ASVS](https://owasp.org/projects/asvs)、
[OWASP Top 10](https://owasp.org/projects/top-ten)、[デジタル庁 DS-221](https://www.digital.go.jp/resources/standard_guidelines)、
[デジタル庁コピーライトポリシー](https://www.digital.go.jp/copyright-policy)、
[WebAppPentestGuidelines](https://github.com/WebAppPentestGuidelines/WebAppPentestGuidelines)。
