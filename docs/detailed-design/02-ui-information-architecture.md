# 画面構成と情報設計

## 0. UI 技術基盤

UI コンポーネント・デザインシステムは [Fluent UI](https://developer.microsoft.com/en-us/fluentui) を使う。`packages/ui` は React + Fluent UI React v9 (`@fluentui/react-components`) で構築し、Simple/Advanced 両モード・共通 shell を同じコンポーネントと design token の上に置く。layout は v9 の token で表現し、scope 外・認可期限切れ・未確認の表示に色以外の文言・icon を必ず併記する要件（6章）は token のみで満たさない。`@fluentui/react-components` の版は他の npm 依存と同じく `docs/design/21` の規律で固定する。

## 1. 共通シェル

全画面上部に `案件`, `対象ロール`, `操作者`, `モード`, `認可状態`, `実行状態` を表示する。scope 外・認可期限切れ・未確認を色だけでなく文言と icon で示す。右側に通知、AI アシスト drawer、停止操作を配置する。

左 navigation はモードで変えるが、URL/route ID は共通にする。非公開機能は見た目だけ隠さず、API 側の operator permission でも拒否する。

## 2. Simple モード

Simple は一本道の wizard とし、利用者が変更できる項目を次に限定する。

```text
S01 案件を開く
  → S02 ガイドライン選択
  → S03 認証準備・探索開始
  → S04 探索結果から対象選択
  → S05 実行計画の最終確認
  → S06 実行状況
  → S07 結果レビュー・報告
```

- S02 は診断ガイドラインと check set の選択だけを見せる。
- S03 の詳細 crawl limit は既定値を表示専用とする。
- S04 は観測済み endpoint と document hint を由来別に表示する。
- S05 は送信目的、対象、概算通信数、禁止操作、外部エンジン委譲範囲を平易に表示する。
- Repeater、Fuzzer、raw request 編集、エンジン設定は Simple から直接開かない。

## 3. Advanced モード

```text
A01 Dashboard / Case
A02 Scope & Authorization
A03 Guidelines & Check Catalog
A04 Browser / Site map / HTTP history
A05 Proxy / Intercept
A06 Repeater
A07 Fuzzer
A08 Scan plans (Passive / Active / API / Nuclei / OAST)
A09 Sessions / Roles / Business logic
A10 Decoder / Comparer / Sequencer
A11 Findings / Organizer / Report
A12 Jobs / Evidence / Audit
A13 Settings / Certificates / Engines / AI
```

操作者権限に応じ、crawl 設定、対象選択、計画 step、上限、テンプレートを編集できる。ZAP で表現できない検証は CheckCatalog から承認済みテンプレートを選び、ScopePilot 管理送信として実行する。テンプレート本文を自由生成して無確認実行する導線は作らない。

## 4. 画面 state

各 feature は次を分離する。

- `server state`: API client が取得し revision/ETag を保持する。
- `draft state`: 未保存の入力。秘密値は renderer の永続 store に置かない。
- `presenter`: server/draft/capability/permission から表示 model を純関数で作る。
- `command builder`: 入力を schema 準拠 command に変換する純関数。
- `effect controller`: API 呼出し、SSE 再接続、route 遷移だけを扱う。

同一案件を複数 window で編集した場合は revision conflict を表示し、自動上書きしない。

## 5. AI アシスト

AI は `CaseSetup`, `GuidelineExplain`, `DocumentExtract`, `CrawlSuggest`, `CandidatePrioritize`, `TemplateSuggest`, `RequestDraft`, `ObservationTriage`, `FindingDraft`, `ReportDraft` の提案を drawer に返す。提案は出典、モデル/プロバイダー、生成時刻、適用前差分を表示し、人間または許可された automation grant が採用するまで state を変更しない。秘密値は prompt へ渡さない。

## 6. Accessibility と大量表示

- keyboard だけで主要操作、確認、停止へ到達できる。
- focus 移動、dialog label、表 header、live region を定義する。
- HTTP 履歴等は仮想化し、sort/filter は server query と一致させる。
- 100,000 件超は集約 view を既定とし、全件 DOM 展開しない。
- 時刻、severity、scope 判定は色以外の文字情報を持つ。

## 7. UI 単体テスト

| ID | 対象ファイル | シナリオ | 期待結果 |
|---|---|---|---|
| UI-UT-001 | `packages/ui/test/unit/app/mode-policy.test.ts` | Simple で raw 編集 route を要求 | route を拒否し wizard に戻す |
| UI-UT-002 | 同上 | Advanced だが permission 不足 | 操作を隠し API 用 command も生成しない |
| UI-UT-003 | `presenters/execution-summary.test.ts` | 委譲 step を表示 | ScopePilot 強制と外部委譲を分けて表示 |
| UI-UT-004 | `presenters/hint-origin.test.ts` | document hint と観測 URL が混在 | 未確認ラベルと出典を保持 |
| UI-UT-005 | `commands/plan-confirmation.test.ts` | 表示後に plan hash が変化 | confirmation を無効化 |
| UI-UT-006 | `app/revision-conflict.test.ts` | stale revision | 自動上書きせず再読込を案内 |
| UI-UT-007 | `ai/proposal-reducer.test.ts` | AI 提案を受信 | 明示採用まで draft を変更しない |
| UI-UT-008 | `presenters/secret.test.ts` | secret reference を表示 | 値ではなく保存先・状態のみ表示 |

| UI-UT-009 | `packages/ui/test/unit/wizard/wizard-state.test.ts` | 未完了 step の進行 | 拒否し理由を返す |
| UI-UT-010 | 同上 | step→route 写像 | 全 step が Simple 許可 route に一意に写る |
| UI-UT-011 | 同上 | 戻り遷移 | S01 以外は常に許可、S07 は常に完了扱い |

実 DOM、keyboard、仮想化、Electron bridge は Playwright component/app test で検証し、presenter の単体テストだけで画面品質を保証したことにしない。
