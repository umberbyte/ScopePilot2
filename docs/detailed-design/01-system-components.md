# 全体機能構成とコンポーネント設計

## 1. ランタイム構成

ScopePilot2 は TypeScript を唯一の実装言語とし、次のプロセスで構成する。

| プロセス | 責務 | 禁止事項 |
|---|---|---|
| Electron main | ウィンドウ、ローカル API 起動、秘密値 bridge、終了処理 | 業務ルールの重複実装 |
| Electron renderer | Simple/Advanced UI、表示用 state | DB・外部エンジンへの直接接続 |
| Core API | 案件、認可、計画、実行、証跡、SSE | renderer 固有 API への依存 |
| CLI | Core API の非対話クライアント | 安全確認の独自バイパス |
| Worker/adapter | Playwright、ZAP、Nuclei、OAST の実行 | Core の許可を超える計画変更 |

UI と CLI は同じ OpenAPI/JSON Schema 契約を利用する。main と renderer の同一 JS ランタイムは配布上の単純化であり、層の境界を消す理由にしない。

## 2. リポジトリ配置

```text
apps/
  desktop/src/{main,preload,renderer}/
  cli/src/
packages/
  contracts/src/{openapi,schemas,events}/
  core/src/{application,domain,features,ports}/
  storage/src/{sqlite,evidence,migrations}/
  adapters/src/{playwright,zap,nuclei,oast,os}/
  ui/src/{app,features,shared}/
tools/
  simulation/src/
  simulation/test/{contract,integration,fixture}/
```

各パッケージの `test/unit` は対象 `src` と同じ機能名を持つ。パッケージ間の型は `packages/contracts` の公開型に限定し、UI が core の内部型を import しない。

## 3. 依存方向

```text
desktop renderer ─┐
CLI ──────────────┼─> contracts <─ Core API ─> core domain/application
extension client ─┘                         ├─> storage ports -> storage
                                           └─> engine ports  -> adapters
```

- domain は Node API、SQLite、Electron、Playwright、ZAP、Nuclei に依存しない。
- application は port interface と domain model に依存する。
- adapters/storage は port を実装し、逆方向の import を作らない。
- renderer は生成された API client と UI view model のみに依存する。

## 4. 共通処理モデル

全ての副作用コマンドは `CommandEnvelope` を受け取る。

```ts
interface CommandEnvelope<T> {
  commandId: string;
  caseId: string;
  operator: OperatorProfile;
  expectedRevision?: number;
  payload: T;
}

type CommandResult<T> =
  | { ok: true; value: T; revision: number; evidenceIds: string[] }
  | { ok: false; error: DomainError };
```

読み取りは `Query`、変更は `Command` として分離する。コマンド処理順は `schema 検証 → operator permission → case/scope 認可 → revision 検証 → domain 処理 → atomic 保存 → event/evidence 発行` とする。

## 5. 横断サービス

| サービス | 責務 |
|---|---|
| `AuthorizationService` | 認可記録、scope、OperationClass の判定 |
| `PlanService` | ExecutionPlan 作成、正規化、hash、確認 |
| `JobOrchestrator` | DAG、lease、停止、再開、terminal state |
| `EgressPolicy` | ScopePilot 自身の送信前拒否 |
| `EvidenceService` | 原本、hash、派生成果物、provenance |
| `CapabilityService` | OS/外部エンジン版ごとの能力判定 |
| `AiAssistService` | AI提案、出典、採否、秘密値除外 |
| `Clock/IdGenerator/RandomSource` | 決定的テストのための注入点 |

## 6. エラーと状態

API エラーは `code`, `message`, `retryable`, `details`, `correlationId` を持つ。少なくとも `ValidationFailed`, `PermissionDenied`, `OutOfScope`, `ConfirmationRequired`, `Conflict`, `CapabilityUnavailable`, `NeedsInput`, `Unsupported`, `EngineFailure`, `Cancelled` を定義する。

実行状態の正本は設計41 §6とし、次の状態機械を実装する。

```text
Draft -> Validated -> Authorized -> Confirmed -> Running
Running -> Stopping -> Stopped
Running -> Completed
Running -> Failed
Stopping -> Failed
Running/Stopping --crash recovery--> Interrupted
```

終端は `Completed | Stopped | Failed | Interrupted`。Succeeded/Cancelled はrun状態に使わない。成功は Completed、利用者・安全制御の協調停止は Stopped、engine/保存障害は Failed、process消失等は Interrupted とする。停止要求時は Stopping、子job停止と最終証跡保存の確認後に Stopped とする。API error code Cancelled は維持する。

Completed のreasonは completed、Stopped は user-request/budget-exhausted/scope-violation/authorization-expired、Failed は engine-failure（保存障害を含む）、Interrupted は interrupted とする。保存時に整合性を検証する。

queued はrun状態ではなく `dispatchState=queued|dispatched` として別管理し、queue中の `runState` は Confirmed とする。非同期scan APIのstateはcanonicalなrunStateの互換aliasであり、小文字の別状態機械は持たない。

再開は新しいrunと増加したattemptで行い、完了済みstepのevidenceを参照する。同一runの終端からの遷移とattemptの上書きは拒否する。旧DB値Succeeded/Cancelledのみversion 5の明示migrationでCompleted/Stoppedへ変換し、既存canonical値・run識別子・attempt・時刻は変更しない。

## 7. コンポーネント単体テスト

| ID | 対象 | 検証 |
|---|---|---|
| SYS-UT-001 | command pipeline | 権限判定前に副作用を実行しない |
| SYS-UT-002 | revision guard | 古い revision を `Conflict` にする |
| SYS-UT-003 | error mapper | domain error を安定した API code へ変換する |
| SYS-UT-004 | job state machine | 不正な遷移を拒否し terminal state を再開しない |
| SYS-UT-005 | evidence publisher | 保存成功後だけ event を公開する |
| SYS-UT-006 | capability gate | 未実測能力を既定で公開しない |

対象は `packages/core/test/unit/application/` とし、手書き fake を使う。process、network、実 DB を起動する検証は統合テストへ分離する。
