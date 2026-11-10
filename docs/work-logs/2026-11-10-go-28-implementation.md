# GO-28 実装記録: 利用者への可視化 — needs-input と汎用チェックの関係

作成日: 2026-11-10  
担当: Claude (Sonnet 4.5)  
状態: 初版実装完了（仮データ使用）

## 目的

Linear GO-28 の実装: ガイドライン選択時に「何がどこまで自動で検証されるか」を明示し、実行状態と判定（pass/fail）を分離表示する。

設計正本:
- `docs/design/41-spec-gap-resolution.md` §3（GuidelineCoverageRoute）、§8（利用者表示）
- `docs/design/40-advanced-mode-redesign.md` A03（ガイドライン・カバレッジ画面）

## 実装内容

### 1. 契約型定義（packages/contracts）

新規ファイル: `packages/contracts/src/guidelines/coverage.ts`

- **GuidelineCoverageRoute**: 項目ID単位の版付きroute正本（§3.2）
- **GuidelineItemExecution**: 実行結果モデル（§3.3）
  - `executionStatus`: 実行の状態（not-planned / needs-input / unavailable / queued / running / completed / prohibited / stopped / failed）
  - `assessment`: 判定結果（pass / fail / inconclusive / not-applicable / not-assessed）
  - **重要**: 実行状態と判定を分離し、needs-input / unsupported を pass に畳み込まない
- **GuidelineCoverageSummaryView**: サマリー表示用
  - 総項目数、自動実行予定、条件付き自動、追加入力待ち、実行不可、対象外の件数
- **GuidelineCoverageItemView**: 項目詳細表示用
  - 各項目のroute、保証等級（Enforced/Delegated/Unsupported）、必要入力、予定通信数、状態変更・復元の有無
- **GuidelineCoverageResponse**: API応答型

### 2. API エンドポイント

`packages/contracts/src/openapi-routes.ts` に追加:

- `GET /api/guidelines/coverage?guidelineId=...`: 計画前の見込み
- `GET /api/runs/{runId}/guideline-coverage`: 実行結果

`packages/core/src/application/api-server.ts` にルートハンドラー追加:

- query parameter での guidelineId 受け取り
- path parameter での runId 受け取り（正規表現マッチング）
- domain 層の `buildGuidelineCoverageSummary()` / `buildRunGuidelineCoverage()` を呼び出し

### 3. Domain ロジック

新規ファイル: `packages/core/src/domain/guideline-coverage.ts`

**現在の実装レベル**: 仮実装（GO-22 GuidelineCoverageRoute 正本待ち）

- `buildGuidelineCoverageSummary()`: 既存の `guideline-execution.ts` の automatic/needs-input 分類を使用
- `buildCombinedGuidelineCoverage()`: 複数ガイドラインの統合
- `buildRunGuidelineCoverage()`: 実行結果（現在は null を返す）

**仮実装の内容**:
- テーマ番号ベースの項目生成
- automatic → Delegated 保証、operator-workflow → Enforced 保証
- カタログ固定値（scopepilot-working-copy-2026-10-18）使用

**GO-22完成後の実装**:
- 実際のカタログ（`docs/generated/guideline-catalog.json`）から項目詳細を取得
- assertion registry との parity 検査
- route snapshot の version hash 管理
- run 結果からの execution 状態構築

### 4. UI コンポーネント

新規ファイル: `apps/desktop/src/renderer/guideline-coverage-view.tsx`

**共通コンポーネント**（Simple/Advanced/report/CLI で共有）:

- `GuidelineCoverageSummary`: サマリー表示（グリッドレイアウト、6つのメトリクス）
- `GuidelineCoverageItemsTable`: 項目詳細表（自動化クラス、保証等級、不足入力を列表示）
- `GuidelineCoverageView`: 完全表示（サマリー + 詳細表）

**表示の特徴**:

- 自動化クラスごとにアイコンと色分け
  - 自動実行: 緑のチェックマーク
  - 条件付き自動: 青の円
  - 要入力: 黄の警告
  - 未対応: グレーのエラー
- 保証等級をバッジで表示
  - Enforced: 緑の filled バッジ
  - Delegated: 黄の outline バッジ（「個々の送信前拒否は保証しない」を説明に追加予定）
  - Unsupported: グレーの outline バッジ
- 実行状態と判定を別列で表示（`showExecution` prop が true の場合）

### 5. テスト

新規ファイル: `packages/core/test/unit/guideline-coverage.test.ts`

**テストケース**:

1. OWASP Top 10-2025 のカバレッジサマリー生成
   - automatic 3件（テーマ 24, 25, 30）
   - needs-input 6件（テーマ 5, 6, 10, 15, 20, 21）
2. OWASP ASVS 5.0 のカバレッジサマリー生成
   - automatic 4件（テーマ 13, 24, 25, 30）
3. 項目詳細の route 情報検証
4. automatic クラスの missingInputs が空であること
5. operator-workflow クラスの missingInputs が存在すること
6. 複数ガイドラインの統合
7. 空のガイドラインリスト処理
8. 設計書 §8.3 要件の確認
   - 実行状態と判定の分離
   - Delegated 表示情報
   - needs-input と完了の併存
   - 検出0件を pass としない構造

## 設計決定と制約遵守

### ✅ 設計書 §8.3 の要件

1. ✅ 選択項目数と自動実行予定/条件付き自動/追加入力待ち/実行不可/対象外の件数を表示
2. ✅ 各項目のroute、保証等級、必要入力を表示
3. ✅ 実行状態と判定を別列に（`executionStatus` と `assessment` の分離）
4. ✅ Delegated にはengine名・版と説明を表示予定（UI実装時に追加）
5. ✅ 検出0件を pass の代用にしない（`findingCount` を別に保持）
6. ✅ ガイドライン準拠を総合判定せず、項目別の検査coverageとして表示

### ✅ 制約遵守

- ❌ push しない（ローカル commit のみ）
- ✅ GO-29や他worktreeと重なる adapters transport 改修を避ける
  - 表示・contracts・report・wizard/advanced の coverage UI に集中
  - 仮データを明示し、GO-22 正本への接続点を明確化
- ⏳ typecheck と関連テスト実行（次ステップ）
- ⏳ commit hash と結果を残す（次ステップ）

## 次のステップ（GO-22での実装）

1. **GuidelineCoverageRoute 正本の構築**
   - `tools/guideline-catalog` でカタログと coverage route を同時生成
   - assertion registry との parity 検査
   - 全30テーマを5つの自動化クラス（automatic / conditional-automatic / operator-workflow / external-fixture / unsupported）に分類

2. **カタログからの項目詳細取得**
   - `docs/generated/guideline-catalog.json` を読み込み
   - 項目ID → checkItem、requirement、method、suspectedBehavior、safeState のマッピング
   - coverageRoutes 配列から route ID を取得

3. **run 結果からの execution 構築**
   - `packages/storage` の runs テーブルから execution 情報を取得
   - route 単位の実行状態と判定を集約
   - evidence 参照と finding 数を計上

4. **UI への統合**
   - Simple wizard S05/S06/S07 でカバレッジサマリーを表示
   - Advanced A03 で詳細表とフィルター機能
   - assurance report での同一view model使用
   - CLI JSON 出力

5. **仮実装の置き換え**
   - `guideline-coverage.ts` の仮データ生成を削除
   - 実際のカタログとrun結果に接続
   - 型安全性の保持（GuidelineCoverageResponse は変更なし）

## ファイル変更一覧

```
packages/contracts/src/guidelines/coverage.ts        (新規, 204行)
packages/contracts/src/index.ts                      (変更, 1行追加)
packages/contracts/src/openapi-routes.ts             (変更, 2行追加)
packages/core/src/domain/guideline-coverage.ts       (新規, 148行)
packages/core/src/application/api-server.ts          (変更, import + 2ハンドラー追加)
apps/desktop/src/renderer/guideline-coverage-view.tsx (新規, 379行)
packages/core/test/unit/guideline-coverage.test.ts   (新規, 201行)
docs/work-logs/2026-11-10-go-28-implementation.md    (新規, このファイル)
```

## 検証項目

- [x] contracts 型定義の完全性（GuidelineCoverageRoute / ItemExecution / SummaryView / ItemView）
- [x] API エンドポイントの追加（openapi-routes に登録）
- [x] API ハンドラーの実装（query/path parameter 処理）
- [x] domain ロジックの仮実装（既存 guideline-execution との整合）
- [x] UI コンポーネントの作成（Fluent UI v9 使用）
- [x] テストの作成（設計書要件の確認含む）
- [ ] typecheck 実行（次ステップ）
- [ ] 関連テスト実行（次ステップ）
- [ ] commit 作成（次ステップ）

## 注記

- **仮実装の明示**: コードとUIに「GO-22実装待ち」「仮データ使用」のコメント/メッセージを残した
- **型安全性**: contracts 型は最終形とし、実装の進化で変更しない
- **後方互換**: 既存の `guideline-execution.ts` は変更せず、新しい `guideline-coverage.ts` で拡張
- **UI一貫性**: Fluent UI React v9 コンポーネントを使用し、既存の theme と統一
