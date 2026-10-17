# 17 整理と報告（Organizer相当） 概要設計

対応要件: 仕様書 F19（Organizer と報告）・6.3（確認状態）

## 1. 目的

要確認通信・メモ・タグ・所見の重複整理・日本語報告・再診断を一元化する。
「スキャナ警告」と「人の確認結果」を明確に区別する表示の中核。

## 2. 旧版から継承する知見

- observation と finding を分け、機械の検出と人の確認状態を混同しない。
- 日本語Markdown/Word報告、手動確認記録、checklist を共通の report model から生成する。
- report はガイドライン、実行条件、証拠参照、未実施範囲を含む。

## 3. コンポーネント構成

```text
OrganizerService（新規）:
  要確認トレイ: 通信・観測・フローを「要確認」として束ねる。担当・期限・メモ・タグ
  重複整理: engine/rule版×role×owner context×method×同系URL×parameter location×payload classを
    候補keyとする。確認状態や実影響の異なる観測は自動統合せず、代表1件＋件数＋差分を保持
  確認状態: 未確認→調査中→確認済み/誤検出/受容/修正確認（6.3）。
    状態変更は確認者・日時・根拠（観測参照）付きで記録
ReportComposer:
  診断条件（エンジン版・ルール版・強度・上限・認可）を必ず冒頭に記載
  参照ガイドライン: 案件で有効化したガイドラインと版の一覧を記載（[27](27-security-guidelines.md)）
  未実施領域（実施範囲モデル）の可視化: 対象×検査項目の実施済/非該当/未対応/禁止/認証失敗/
    時間切れ/エラー（6.3）を報告に含める
  発生元別の明示: Passive/Active/Fuzzer/Manual/API/Nuclei/DOM/文書記載を区別表示
  候補・所見ごとの参照基準（guidelineBasis）を triage 根拠として示し、実影響の確定と混同しない
```

## 4. データモデル

- `Finding`: 確認状態・確認者・重複グループId・タグ・関連観測列。
- `CoverageRecord`（実施範囲）: 検査項目（元資料の診断項目・ガイドライン対応、[27](27-security-guidelines.md)）×実施状態。
- 報告物: Markdown（現行）＋Word。共有用エクスポートはマスク済み派生物のみ。

## 5. 安全制御と証跡

- 報告には「どの条件で何を実施し、何を実施していないか」を必ず含める（終了コード0・警告0件で
  完了としない）。実影響未確認と確認済みの混在を禁止（表示レベルで強制）。
- 通信原本を報告へ無条件で含めない。証拠は参照（hash・ポインタ）で示す。

## 6. UI / CLI

- 「所見と証拠」画面: 重複グループ・確認状態のカンバン/リスト、観測→証拠→報告の導線。
- CLI: `scopepilot report --format markdown|word|json`。

## 7. 確定事項

1. [診断項目Excel](../WebAppPentestGuidelines_診断項目_ScopePilot_作業用.xlsx)のガイドライン6sheet・769行は
   runtimeで直接読まず、[15](15-authorization-business-logic.md)と共通の一方向importerで`CheckCatalog`へ変換する。
   各`CheckItem`はstable `SPC-CHECK-xxxxx`、日本語表示名、確認目的、必要能力、OperationClass、
   source file hash/sheet/row、license状態、guideline mapping、対応template IDを持つ。重複・空欄・参照切れを
   schema検査し、人がreviewしたcatalog versionだけをbundleへ入れる。769件はこのsource versionの取込照合値であり、
   将来版の固定件数、全項目の自動実行、脆弱性網羅の保証にしない。
2. 再診断の機械比較keyは`ruleFamily + normalized endpoint pattern + method + parameter location/name +
   role + owner context + protocol`の`FindingFingerprint`とする。同じengine rule versionならExact、版だけが
   変わればComparableRuleChanged、endpoint/parameterが変われば候補として提示し自動同一視しない。
   `New|Persistent|Resolved|Regressed|NotRetested|Incomparable`を表示し、証拠hashの一致だけでResolvedにしない。
3. DOCX生成はTypeScript-firstの`docx` libraryをversion/hash固定して採用し、Word automationやOS固有COMを
   使わない。生成元はMarkdown変換ではなく共通ReportModelとし、A4 landscapeを含むpage geometry、style、
   font fallbackをtemplateとして固定する。CIはOOXML schema、paragraph/table/link構造、抽出text、page-break
   landmarkを比較し、固定LibreOffice rendererによるPDFのpage数とvisual diffを補助fixtureにする。
   release gateではWindows/macOSのWordで同じ必須内容、表の欠落なし、許容範囲内の改ページを確認する。
   font engine差があるためpixel完全一致は保証しない。

根拠: [`docx`公式documentation](https://github.com/dolanmiu/docx/blob/master/docs/README.md) はNode対応の
TypeScript/JavaScript生成libraryであり、[MIT license](https://github.com/dolanmiu/docx/blob/master/LICENSE)で公開される。
