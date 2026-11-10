# GO-9: アクティビティパネル実装 (2026-11-10)

## 実装内容

Linear GO-9「共通の実行中ログ/進捗の可視化パネル（アクティビティパネル）」を実装。

設計正本: `docs/design/40-advanced-mode-redesign.md` §5.4 および §7.1 P1

### 実装したコンポーネント

1. **packages/ui/src/activity-panel/**
   - `activity-panel-types.ts`: 型定義 (ActivityEvent, ActivityFilter, ActivityJobSummary, ActivityTab)
   - `activity-panel.tsx`: React コンポーネント本体
   - `use-activity-panel.ts`: 状態管理フック (polling ベース暫定実装)
   - `index.ts`: エクスポート

2. **apps/desktop/src/renderer/advanced.tsx**
   - ActivityPanel を画面下部に配置
   - useActivityPanel フックで状態管理
   - イベントクリック・ジョブクリックのハンドラー (TODO あり)

3. **packages/ui/test/unit/activity-panel/activity-panel.test.tsx**
   - 基本的な unit test (collapsed/展開、タブ、フィルタ)

### 機能

- **タブ**: ジョブ / ログ / 送信 / 拒否 / エラー
- **フィルタ**: 水準 (debug/info/warn/error)、出典 (scopepilot/zap/nuclei/playwright/system)、テキスト検索
- **折りたたみ**: collapsed 状態で最小表示、展開で詳細表示
- **自動スクロール**: 最新ログへの自動スクロール (一時停止可能)
- **カウンター**: 実行中ジョブ数、拒否数、エラー数をバッジ表示
- **ジョブ一覧**: 実行中・最近のジョブを表示 (状態・経過時間・カウンター)
- **ログ表示**: イベントの時系列表示 (タイムスタンプ・レベル・ソース・メッセージ)

### 暫定実装 (P0 JobRegistry マージ待ち)

現在は既存の `/api/events` と `/api/runs/interrupted` を使用:

1. **イベント取得**: `/api/events` を polling (2秒間隔)
   - P0 後は SSE `/api/jobs/events` に移行
   - BaselineFlowEvent を ActivityEvent に変換

2. **ジョブ取得**: events から推測 + `/api/runs/interrupted`
   - P0 後は `/api/jobs` を使用
   - JobSummary として表示

3. **カウンター**: events から集計
   - P0 後は JobCounters を使用

## 未実装 API (P0 後に実装)

以下の API は P0 JobRegistry マージ後に実装が必要:

### 1. `/api/jobs` (GET)
- **目的**: ジョブ一覧取得
- **レスポンス**: `{ jobs: JobSummary[] }`
- **フィルタ**: `state`, `kind`, `limit`, `cursor`
- **優先度**: P0

### 2. `/api/jobs/{jobId}` (GET)
- **目的**: ジョブ詳細取得
- **レスポンス**: `JobSummary & { routes: ..., results: ... }`
- **用途**: A70 ジョブ詳細画面
- **優先度**: P0

### 3. `/api/jobs/events` (GET, SSE)
- **目的**: 全ジョブの JobEvent streaming
- **レスポンス**: SSE (text/event-stream)
- **フィルタ**: `since`, `category`, `level`, `jobId`, `runId`
- **優先度**: P0

### 4. `/api/jobs/{jobId}/events` (GET, SSE)
- **目的**: 特定ジョブの JobEvent streaming
- **レスポンス**: SSE (text/event-stream)
- **用途**: ジョブ詳細画面のログ
- **優先度**: P0

### 5. `/api/jobs/{jobId}/stop` (POST)
- **目的**: ジョブの協調停止
- **レスポンス**: `{ jobId, state }`
- **優先度**: P0

### 6. `/api/jobs/stop-all` (POST)
- **目的**: 全ジョブの停止
- **レスポンス**: `{ stopped: string[] }`
- **用途**: 共通シェルの「すべて停止」
- **優先度**: P1

### 7. `/api/workspace/status` (GET)
- **目的**: 共通シェル・概要・ステータスバーの一括状態
- **レスポンス**: `WorkspaceStatus` (案件、認可、role、実行中ジョブ数、予算、所見件数、チェックリスト、transport 種別)
- **用途**: 共通シェル (P1)、ステータスバー
- **優先度**: P1

### 8. `/api/operator` (GET)
- **目的**: 操作者と権限取得
- **レスポンス**: `{ name: string, permissions: OperatorPermission[] }`
- **用途**: 共通シェル、ハードコード `OPERATOR_PERMISSIONS` の廃止
- **優先度**: P1

## TODO リスト

### UI 側 (packages/ui)

1. **ActivityPanel.tsx**
   - [ ] SSE への移行 (`/api/jobs/events`)
   - [ ] Last-Event-ID による再接続
   - [ ] イベント詳細表示 (onEventClick の実装)
   - [ ] ログ行のコピー機能
   - [ ] ログのエクスポート (NDJSON/テキスト)
   - [ ] キーボードナビゲーション (aria-live の実装)
   - [ ] 仮想化 (10,000 イベント超の場合)

2. **use-activity-panel.ts**
   - [ ] SSE polling の置き換え
   - [ ] `/api/jobs` からの JobSummary 取得
   - [ ] `/api/jobs/events` からの JobEvent 取得
   - [ ] エラーハンドリングの改善

3. **activity-panel-types.ts**
   - [ ] P0 マージ後に JobEvent・JobSummary へ型を移行
   - [ ] JobCounters の統合

### Advanced 画面側 (apps/desktop/src/renderer/advanced.tsx)

1. **イベントクリックハンドラー**
   - [ ] exchangeId → HTTP 履歴 (A21) へのナビゲーション
   - [ ] evidenceId → 証拠 (A61) へのナビゲーション
   - [ ] findingId → 所見 (A60) へのナビゲーション

2. **ジョブクリックハンドラー**
   - [ ] ジョブ詳細画面 (A70) への遷移

3. **現在のジョブ/runId の渡し方**
   - [ ] 各画面 (A22, A40 等) から currentJobId を useActivityPanel に渡す
   - [ ] フィルタの自動切替 (this-job / all-jobs)

### Core 側 (P0 実装)

1. **packages/core/src/application/job-registry.ts** (新設)
   - [ ] ジョブの起動・状態遷移・停止
   - [ ] JobEvent の発行
   - [ ] JobCounters の集約
   - [ ] 同時実行上限 (既定 2)
   - [ ] Queued 状態の管理

2. **packages/core/src/application/baseline-flow.ts**
   - [ ] 送信系メソッドに `control?: { signal, onEvent, jobId }` を追加
   - [ ] `record()` に jobId を伝える
   - [ ] EgressPolicy の拒否に jobId を渡す

3. **packages/core/src/application/api-server.ts**
   - [ ] SSE streaming 実装 (接続管理、keep-alive、切断時の購読解除)
   - [ ] `/api/jobs*` routes の実装
   - [ ] `/api/events` の streaming 化

4. **packages/storage**
   - [ ] migration 追加: `jobs`, `job_events`, `audit_events`
   - [ ] `exchanges` テーブルに `jobId` カラム追加
   - [ ] JobStorePort の実装

5. **packages/contracts**
   - [ ] `packages/contracts/src/jobs/jobs.ts` (JobKind, JobState, JobCounters, JobSummary)
   - [ ] `packages/contracts/src/jobs/job-events.ts` (JobEvent, JobEventCategory, messageKey)
   - [ ] BaselineFlowEvent に `jobId`, `runId` を任意フィールドとして追加

## テスト

### 実施したテスト

- `packages/ui/test/unit/activity-panel/activity-panel.test.tsx`
  - collapsed 状態の表示
  - 展開状態のタブとログ表示
  - ジョブタブの表示
  - フィルタ (拒否・エラー)
  - 空メッセージの表示

### 実施できなかったテスト (理由)

- **E2E テスト**: 環境都合により実施せず
  - 理由: P0 JobRegistry が未マージのため、実エンジンでの統合テストは不可
  - P0 マージ後に fixture エンジンでの E2E を追加

- **タイプチェック**: tsc が利用できず
  - 理由: ワークツリー環境で tsc が見つからない
  - main ブランチでの確認が必要

## 変更ファイル

### 新規作成

- `packages/ui/src/activity-panel/activity-panel-types.ts`
- `packages/ui/src/activity-panel/activity-panel.tsx`
- `packages/ui/src/activity-panel/use-activity-panel.ts`
- `packages/ui/src/activity-panel/index.ts`
- `packages/ui/test/unit/activity-panel/activity-panel.test.tsx`
- `docs/work-logs/go-9-implementation.md` (本文書)

### 変更

- `packages/ui/src/index.ts`: ActivityPanel のエクスポート追加
- `apps/desktop/src/renderer/advanced.tsx`: ActivityPanel の統合

## 次のステップ (P1 以降)

1. **共通シェル** (§7.1 P1)
   - `/api/operator`, `/api/workspace/status` の実装
   - 上部バーの案件・認可・実行状態・停止ボタン
   - ステータスバー (予算・拒否・エラー・所見件数・transport 種別)

2. **ナビゲーション再編** (§3.2)
   - 9 グループの左ナビ
   - route の写像 (旧 advanced.* → adv.*.*)

3. **FeaturePage** (§4)
   - 共通レイアウト (見出し・入力・実行・進捗・結果・アクティビティ)
   - FeatureSpec による画面定義

4. **クロールと能動診断の非同期化** (P2)
   - `POST /api/jobs` (crawl, active-scan)
   - 確認ダイアログ
   - ジョブ詳細 (A70)

## コミット内容

```
feat: implement activity panel (GO-9)

アクティビティパネルの基礎実装。docs/design/40-advanced-mode-redesign.md §5.4 に基づく。

- ActivityPanel コンポーネント (タブ・フィルタ・折りたたみ)
- useActivityPanel フック (暫定: polling ベース)
- advanced.tsx への統合
- 基本的な unit test

P0 JobRegistry マージ待ちのため、既存 /api/events を使用。
P0 後は /api/jobs/events の SSE に移行。

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

## 参照

- 設計: `docs/design/40-advanced-mode-redesign.md` §5, §7.1 P1
- Linear: GO-9
- 関連: GO-8 (FeaturePage), GO-26/GO-29/GO-22 (実行制御)
