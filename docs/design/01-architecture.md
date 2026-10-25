# 01 共通アーキテクチャ 概要設計

対応要件: 仕様書 2章、4章、6章、9章、AGENTS.md「実装方針」

## 1. 目的と原則

ScopePilot2 を TypeScript に統一し、Windows と macOS に配布できる Electron アプリとして構築する。案件、認可、計画、実行制御、証拠、アダプターはヘッドレスなコアへ置き、UI と CLI は同じユースケースを呼ぶ。

- コアから Electron、DOM、UI フレームワークを参照しない。
- renderer からファイル、プロセス、ネットワーク、秘密情報へ直接アクセスさせない。
- ZAP と Nuclei は版固定した外部バイナリであり、API/CLI アダプターの背後へ隔離する。
- Playwright は TypeScript API を直接利用するが、対象サイトは Electron の権限を持つ画面へ表示しない。
- UI–コア境界と外部公開 API は同じ JSON Schema を共有する。トランスポート固有の型をドメインへ持ち込まない。

## 2. リポジトリ構成

```text
apps/
  desktop/       Electron main、preload、React renderer
  cli/           Node CLI。UI と同じ Core API 契約経由で core を使う (単体実行時は in-process で host)
packages/
  contracts/     コマンド、イベント、DTO、JSON Schema、互換性試験
  core/          ドメイン、ユースケース、認可、計画、実行制御
  storage/       SQLite、証拠ファイル、移行
  adapters/      ZAP、Nuclei、Playwright、OS機能、AI
  ui/            renderer の画面と表示状態
tools/
  simulation/    外部エンジンのfixtureと自動完走試験
```

`apps` は `contracts` と core の公開 ApplicationService を呼ぶ。`core` が storage、engine、secret、clock の port を定義し、`storage` と `adapters` がそれを実装する。`core` は `apps`、Electron、具体的な DB ドライバー、外部エンジン SDK を参照しない。`contracts` は他の実装 package に依存しない。この依存方向を CI の静的検査で固定する。

## 3. 技術ベースライン

- 言語は全 package で TypeScript の strict mode とし、境界入力では runtime schema validation を行う。
- renderer は React を使う。SSRやmeta-frameworkは使わず、desktop用の単一page appとする。React固有の型を `packages/contracts` と `packages/core` へ出さない。
- renderer の開発・bundleは Vite を使う。Vite は型検査を行わないため、buildとは別に `tsc --noEmit` を必須checkとして実行する。
- main、preload、CLI、core は Node/Electronが対応する標準ES moduleを優先し、独自decorator、DI framework、class変換へ依存しない。
- stateはcoreのquery/eventを正本とし、React component tree内にrunや案件の正本を複製しない。初期実装ではRedux等の全体state libraryと大型component suiteを導入しない。

React は TypeScript を公式に扱い、Vite は TypeScript と React plugin を公式に提供している。採用理由は、rendererをWeb標準の範囲に保ち、Electronから切り離して再利用できるためである。特定frameworkの機能をIPCやdomain契約へ漏らさないことで、将来のUI置換範囲を `apps/desktop/renderer` と `packages/ui` に限定する。

- [React: Using TypeScript](https://react.dev/learn/typescript)
- [Vite: Features](https://vite.dev/guide/features.html)

## 4. 実行プロセスと信頼境界

```text
Electron renderer (sandbox)
  │ 型付き・許可リスト方式の IPC
preload (contextBridge、薄い変換のみ)
  │ JSON Schema 検証
Electron main ─ ApplicationService ─ core ─ storage
                                  ├─ PlaywrightAdapter
                                  ├─ ZapAdapter ─ ZAP/Java
                                  ├─ NucleiAdapter ─ nuclei
                                  └─ AiProviderAdapter ─ 利用者選択provider

CLI process ─ Core API (loopback) ─ ApplicationService ─ 同じ core / storage / adapters
外部利用者 ─ opt-in loopback Product API ─ ApplicationService
```

renderer は `nodeIntegration=false`、`contextIsolation=true`、sandbox 有効、厳格な CSP、任意遷移禁止とする。preload は用途別の型付き操作だけを公開し、汎用 `invoke`、ファイル操作、shell、process spawn を公開しない。IPC の要求と応答は `packages/contracts` のスキーマで双方検証する。[Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) と [Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) を最低基準とする。

外部向け Product API は既定無効の loopback サーバーであり、UI 内部 IPC とは別トランスポートである。CLI は Product API や UI を起動せず、UI と同じ Core API 契約 ([18](18-extension-api.md)、[19](19-cli-automation.md) §3) 経由で core を使う。単体実行時は core を同一 process 内で host して loopback で結合し、desktop 実行時は desktop が host する core へ接続する。将来コアを別言語へ移す場合は Core API 契約を保ち、実装だけを別プロセスへ移せる。

## 5. コアの境界

- `AuthorizationService`: 認可の有効性、操作区分、対象範囲を判定する。
- `PlanService`: 入力を正規化し、上限、ルール、ランタイム版を固定した `ExecutionPlan` を生成する。
- `JobOrchestrator`: 計画の状態遷移、停止、再開、ジョブ依存を管理する。
- `EgressPolicy`: 送信直前とリダイレクトごとに範囲・認証情報・上限を判定する。
- `EvidenceService`: 原本、派生物、ハッシュ、監査イベントを一貫して保存する。
- `EngineAdapter`: 能力、強制可能な制約、起動、停止、進捗、結果を統一する。
- `AiAssistService`: 作業種別ごとの最小入力をredactionし、利用者が選択したAIへ渡して版付き提案を返す。
  提案をcommandや`ExecutionPlan`へ直接変換せず、通常のvalidation、操作者権限、認可、確認を通す。

`UiMode`はrendererの表示・編集範囲でありcoreの権限境界ではない。coreは対象サイトで使う`TargetRole`と、
ScopePilotを操作する`OperatorIdentity` / `OperatorPermission`を別々に検証する。Simple / Advanced、desktop、CLI、
Product APIのどこから呼んでも同じApplicationServiceで拒否結果になる。

各アダプターは `CapabilityManifest` を返す。機能の有無だけでなく、範囲、通信数、速度、停止、プロトコルを、ScopePilot が送信前に強制（Enforced）するのか、エンジンへ委譲して入力 scope・推測・停止・開示で扱う（Delegated）のかを、固定した版ごとの実測値とともに表す（[22](22-execution-control.md)§3）。内部挙動を制御できない ZAP/Nuclei は Delegated を既定とする。入力 scope もライフサイクル停止も保証できないジョブは計画時に拒否する。

## 6. データと契約

ドメイン entity と境界 DTO を分ける。日時、URL、ID、バイト列、秘密値参照は曖昧な文字列にせず schema で形式を固定する。契約には `schemaVersion` を持たせ、破壊的変更は新しい major と移行処理を要求する。

計画は正規化 JSON から SHA-256 を計算し、認可、入力証拠、ランタイム bundle と結び付ける。実行中に計画を書き換えず、追加対象は子計画として記録する。

## 7. 旧版知見の継承

旧 ScopePilot のソースはコピーしない。次の挙動を simulation fixture と契約試験で再現してから実装する。

- Explore は Safe、送信機能は standard とする ZAP モード境界。
- HAR にない URL を直接 Active Scan して `URL Does not Exist` となる経路の回避。
- 計画ハッシュと入力ハッシュの実行直前検証、既存証拠の上書き拒否。
- 取込時の許可範囲検査、重複排除、元エンジンと実行 ID の保持。

## 8. A0 受け入れ条件

1. UI を起動せず TypeScript CLI で、fixture に対する「探索→能動診断→所見」を完走できる。
2. 同じシナリオを desktop から実行し、CLI と同じ計画ハッシュ、状態遷移、結果 schema を得る。
3. renderer から Node/Electron の任意 API と任意 IPC を呼べないことを自動検査する。
4. 各エンジンの能力表に、実測した版、保証できる制約、既知の不足、無効化条件がある。
5. Windows と macOS でプロセス停止、案件ロック、秘密情報保護の最小経路を確認する。
