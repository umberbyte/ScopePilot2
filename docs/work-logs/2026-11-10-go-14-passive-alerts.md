# GO-14 Passive Scan / Alerts (2026-11-10)

## 対応範囲

- 設計40はこのブランチにないため、兄弟 worktree `advanced-mode-redesign/docs/design/40-advanced-mode-redesign.md` の §2、§3 A41/A43/A60、§6、§7 P5 を参照。設計全体は変更していない。
- Advanced の Scan plans の直後に `A41 自動診断 / 受動診断・Alerts` を追加。`case.read` が必要で、Simple からは開けない。
- `GET /api/passive/rules`、`GET /api/passive/status`、`GET /api/passive/alerts`、`GET /api/passive/evidence?findingId=...` と共有 TypeScript / OpenAPI 契約を追加。
- 既存の許可・scope 検査済み探索観測を入力に、HTTP のパスワードフォームと GET のパスワードフォームを検査。受動検査は追加通信を発生させない。ルール ID と版を記録する。
- Alerts は重大度・名称/URLで絞り込み、詳細、状態、観測回数、初回/最終日時、証跡参照と再現の入口（観測ページの GET）を表示する。証拠リンクは保存原本ではなく、秘密値を含まない観測サマリーと再現メタデータを返す。

## Findings との関係

Alerts は別台帳ではなく、既存 `FindingImporter` / Findings 保存先のうち `passive` provenance を持つ所見のビュー。ID、確認状態、人の検証記録、証跡、報告対象は共通。初回は `candidate` / `unverified: true`。確定・棄却と報告は既存 Findings に遷移して行う。確認後も Alerts に同じ状態で表示する。

重複キーは既存の observation 取込規則（ルール ID / 観測 URL / parameter）を利用する。再観測で ID・人の判断を保ち、証跡参照を追加する。SQLite の既存 `finding_json` に provenance も保存でき、別テーブルや移行は不要。GO-13 の診断ポリシー、GO-19 の確認 API、JobRegistry は変更していない。

## 制限・後続範囲

- 今回は ScopePilot のフォーム観測を使う最小受動経路。ZAP pscan のルール設定・実キュー API は未接続で、ZAP 由来の Active Scan Alerts を受動所見と推測して混ぜない。
- ルールは参照のみ。処理待ち/処理済み/失敗件数はセッション内の探索観測単位で、ZAP キューではないことを画面と API に明示。再起動で件数はリセットされるが、保存済み所見は既存 Findings 復元から表示できる。
- ヘッダー、本文全体、未観測ページの検査、完全な Passive Scan Policy Manager は対象外。0 件でも安全性を保証しない。
- 証跡保存失敗は失敗件数に含め、証跡なしの候補を生成せず探索は継続する。

## 検証

通過:

- `npm run typecheck`
- `npm run typecheck:passive --workspace @scopepilot2/desktop`（標準 tsconfig の include は renderer TSX を直接対象にしないため、新画面用の明示的チェックを追加）
- Core unit 361、Contracts 8、UI 14、Desktop unit 43、Storage integration 10（合計436）
- `node --test packages/core/test/integration/passive-api.test.ts`（1件）。権限、件数、共通台帳、証拠参照、原本非公開を検証。
- `npm run build:renderer --workspace @scopepilot2/desktop`
- `cd apps/desktop; npx playwright test passive.spec.ts`（1件）。実 Advanced renderer と実 Core API を Electron 内で接続し、観測 fixture のみで A41→Alerts 詳細→絞り込み→証跡メタデータ→Findings 遷移を検証。ZAP 起動や外部対象通信は不要。検証環境では既存インストールの Electron を `ELECTRON_OVERRIDE_DIST_PATH=C:/Users/GoSugawara/src/ScopePilot2/node_modules/electron/dist` で使用。
- 受動 unit は安全フォーム・不正 action、再観測と確認状態の維持、証跡保存待ちの queued、保存失敗、追加 transport 呼出しなしを検証。Storage test は既存台帳からの provenance 復元を確認。

既存失敗（未変更 HEAD を一時ディレクトリへ `git archive HEAD` で展開し、依存を入れ直して比較）:

- `npm run test:integration --workspace @scopepilot2/core`: 変更後40件中37通過、HEAD39件中36通過。両方で同じ3件が失敗: documents/hints の由来、business-logic role 差分、Findings status API（400 / 200）。新規 passive API テストは通過。
- Advanced renderer 全体も明示的に TSX 型チェックすると、HEAD と同じ9件の既存診断: advanced.tsx の Fluent style/省略値3件、decoder-comparer-screen.tsx の省略値1件、guidelines-catalog.tsx の JSON import 属性1件、repeater-screen.tsx の省略値4件。新画面単体のチェックは通過。

ローカルコミットのみ。push / PR作成 / Linear 更新は行わない。Linear は orca-linear スキルで参照のみ。作業中に現れた既知の `apps/cli/src/main.ts` の無関係な差分はコミットに含めない。
