# F17 認可・業務ロジック検証

## 1. 対象

複数 role/状態での期待値 DSL、比較、復元、CheckCatalog と承認済みテンプレート実行を扱う。上位は `design/15`, `22`, `27`。

## 2. UI/CLI

- Simple: guideline 選択、探索後の対象選択、最終計画確認だけ。
- Advanced: A03/A09 で role matrix、前提、操作、期待値、restore flow、template を編集。
- CLI: check plan validate/run。role secret は reference で指定。

## 3. モジュール

`CheckCatalog`, `ExpectationDsl`, `RoleMatrixPlanner`, `BusinessFlow`, `RestoreFlow`, `ObservationComparator`, `CheckOutcomeBuilder`。Excel は一方向 importer で versioned catalog artifact へ変換し、実行時に workbook を直接解釈しない。

## 4. 処理

check は setup、action、observe、expect、restore を持つ。expectation は status、header、JSON path、DOM text、redirect、side-effect observation の allowlist。role ごとの同じ action を比較する場合も session jar と evidence を分離する。

## 5. 安全・証跡

restore は成功を仮定せず observation で確認する。破壊操作は operation class と認可で明示許可された場合だけ。結果は `Pass | Fail | Inconclusive | Blocked` とし、未観測を Pass にしない。template source/version/hash を保存する。

## 6. 失敗

前提不足、role secret 不足、restore 不成立は `Blocked` または `Inconclusive`。Excel 行の曖昧さは importer warning として人の review queue へ送る。AI提案は catalog を直接変更しない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F17-UT-001 | `core/test/unit/business-logic/expectation-dsl.test.ts` | allowlist 外 expression | validation error |
| F17-UT-002 | `role-matrix-planner.test.ts` | 2 role | session/evidence を分離 |
| F17-UT-003 | `observation-comparator.test.ts` | observation 欠落 | Inconclusive |
| F17-UT-004 | `restore-flow.test.ts` | restore assert 不一致 | 成功扱いしない |
| F17-UT-005 | `check-catalog.test.ts` | template hash 不一致 | 実行拒否 |
| F17-UT-006 | `check-outcome.test.ts` | setup blocked | Pass/Fail を作らない |
| F17-UT-007 | `catalog-import.test.ts` | 曖昧 Excel 行 | warning と review required |
| F17-UT-008 | `business-flow.test.ts` | 禁止操作 | action 前に拒否 |

## 8. 非単体テスト

workbook→catalog 変換の golden CT、複数 role fixture と restore の FT、catalog artifact の署名/版更新を IT で検証する。
