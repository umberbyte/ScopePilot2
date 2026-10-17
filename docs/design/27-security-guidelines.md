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

- `GuidelineCatalog`: ガイドラインごとに、出典 URL、版、ScopePilot が作成した**短い運用要約**、項目対応（例: `OWASP Top 10:2025 A01`、`WSTG-INFO-06`）を持つ。原文は複製せず要約と参照のみを保持する（9章のライセンス確認。再配布可否は版ごとに記録）。
- カタログは [21](21-update-management.md) の runtime bundle に「ガイドライン要約・項目対応表」として版固定する。上流で項目番号が変わりうるため、実行記録に使用版を残し、版をまたいで番号を仮定しない（5.1）。

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

- 案件設定にガイドライン選択パネル（有効/無効・版・出典）。
- 候補一覧に分類・signal・参照基準・caution を表示し、observation/finding とは別層であることを明示する。
- SelectionGuidance（運用要約）を探索前に提示する。
- CLI: `scopepilot guideline list|show`、候補出力（`candidates`）に guidelineBasis を含める。

## 9. 未解決事項（A1）

1. 項目対応表の初期セットと、旧資料 769 診断項目（[17](17-organizer-reporting.md)）との対応付け。
2. 各ガイドラインの「適用対象のみ」判定（AI 機能・クラウドネイティブ・DS-221）の精度。
3. カタログ要約・項目対応表の配布ライセンス（WSTG/ASVS/Top 10/AISVS/Cloud Native Top 10/WebAppPentestGuidelines/DS-221 の再配布可否）と、原文へのリンク方式（9章）。
4. 版更新で項目番号が変わった場合の、過去 run の参照整合（遡及変更しない記録方法）。
