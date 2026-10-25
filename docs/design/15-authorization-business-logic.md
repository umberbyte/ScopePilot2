# 15 認可（アクセス制御）と業務ロジックの確認 概要設計

対応要件: 仕様書 F17（認可と業務ロジック）

## 1. 目的

ロール・所有者別の要求比較と期待結果の突合で、認可不備・業務ロジック不備の「確認作業」を
支援する。差分のみで認可不備を確定しない（仕様書3.1の維持事項）。

## 2. 共通基盤

- [08](08-authentication-session.md) のロール別sessionと通信分離。
- 代表URLパターン、[04](04-repeater.md) の再送、[06](06-decoder-comparer-sequencer.md) の差分。
- 診断テーマの手順は版付き `DiagnosticTemplateCatalog`、RulePackage、checklistとして取り込む。
  初期入力は[診断項目Excel](../WebAppPentestGuidelines_診断項目_ScopePilot_作業用.xlsx)とする。

## 3. コンポーネント構成

```text
AuthorizationMatrix（新規）:
  対象操作（エンドポイント×パラメータ）×ロール/所有者のマトリクス定義。
  各セルに「期待結果」（拒否されるべき/自分のデータのみ/等）を設定
DifferentialJob（Orchestrator配下・05のジョブ体系を利用）:
  同一要求をロール別セッション（08）で送信し、応答（ステータス・本文・所有者識別子）を比較。
  ID差し替え（他者ID）・属性追加（マスアサインメント）などのバリエーションは
  PayloadSet（05）の「認可系」集合として版管理
ExpectationCheck: 期待結果との突合結果を「要確認/期待どおり/期待外れ」で表示。
  確定は人が行い、確認状態（17）へ記録
```

- 業務ロジック（金額・数量・順序・二重送信）も同じ仕組み: バリエーション生成→送信→
  事後状態の確認要求（状態取得API/画面の観測）で突合。自動化できない部分はチェックリスト（17）へ。

## 4. データモデル

- `AuthorizationMatrix`（案件資産として保存）: 操作・ロール・期待結果・直近実行結果。
- 実行結果は DiagnosticObservation（区分=認可/業務ロジック確認・実影響未確認）と
  手動確認記録（確認者・日時・判断）。

## 5. 安全制御と証跡

- 他者ID・他ロールへの切替えは認可の許可操作区分（`CrossRoleTest`）で明示許可。
- 状態変更を伴う業務ロジック検証は、実施後の状態戻し手順を必ずマトリクスに登録させてから実行
 （戻し不能な場合は実行不可）。

## 6. UI

- 「認可マトリクス」画面: 操作×ロールのグリッド、期待結果設定、一括実行（05の速度制御の内側）、
  差分ビューア（06）、確認状態の記録。

## 7. 確定事項

1. `Expectation` は任意codeを含まないJSON DSLとし、`allOf` / `anyOf` / `not` の下にstatus range、
   header存在/literal、body literal/bounded regex、JSON Pointer、XML XPath、HTML selector、長さ範囲、
   baselineとの差分を置く。owner識別子はJSON Pointer、XPath、HTML selector、header、Cookieから抽出し、
   正規化後のkeyed fingerprintだけを比較できる。条件不能は失敗扱いにせず`Inconclusive`とする。
2. 状態変更cellは`Setup → Exercise → Verify → Restore → VerifyRestore`の宣言的step列を必須とし、各stepは
   [08](08-authentication-session.md)のrequest/extract/assertと同じ制約を使う。Restoreと復元確認がない場合は、
   認可された使い捨て環境で`DisposableEnvironment=true`を固定した計画以外、自動実行しない。戻し不能な
   本番検証は手動checklistへ送り、「自動化対象外・状態変更の影響を確認できない」と報告する。
3. [診断項目Excel](../WebAppPentestGuidelines_診断項目_ScopePilot_作業用.xlsx)は一方向importerでversioned
   `DiagnosticTemplateCatalog`と`CheckCatalog`へ変換する。ガイドライン6sheetの769行、ZAP診断rule sheetの
   102行、ZAP非対応代替sheetの94行を入力候補とし、シミュレーション・クローリング・実行・手動操作の5sheetは
   fixture/referenceに分離してproduction templateへ自動昇格しない。row番号をIDにせず、内容から割り当てた
   stable `SPC-TEMPLATE-xxxxx` / `SPC-CHECK-xxxxx`、source file hash、sheet、元row、importer versionを保持する。
   各templateはguideline item、OperationClass、parameter schema、request mutation、execution route、Expectation、
   必要capability、復元要件、危険度、Simple可否へmappingする。任意codeは取り込まず、安全制御と矛盾するセルは
   instructionとして実行しない。schema検査、license確認、人のreviewを通ったversionだけをruntime bundleへ入れ、
   Excelを実行時依存にしない。
