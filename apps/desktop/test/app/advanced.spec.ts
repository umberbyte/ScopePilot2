import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';

/**
 * Advanced モードの実 DOM 検証。`docs/detailed-design/02-ui-information-architecture.md` §3。
 * A01〜A13 ナビ・A01 Dashboard (案件・能力表・Interrupted 検出)・A12 監査 event を確認する。
 */
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['dist/main.cjs'] });
  page = await app.firstWindow();
  await expect(page).toHaveTitle(/ScopePilot2/);
  await page.getByRole('button', { name: 'アドバンスド' }).click();
});

test.afterAll(async () => {
  await app.close();
});

test('A01〜A13 のナビが表示され、A01 が既定の着地画面', async () => {
  const nav = page.getByRole('navigation', { name: 'Advanced 画面ナビ' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('button')).toHaveCount(13);
  await expect(page.getByText('A13 Settings / Certificates / Engines / AI')).toBeVisible();
  await expect(page.getByText('外部 engine 能力 (保証等級)')).toBeVisible();
});

test('A01: 案件を作成すると案件情報と能力表 (保証等級) が表示される', async () => {
  await page.getByRole('button', { name: '案件を作成する' }).click();
  await expect(page.getByText(/案件「ScopePilot2 案件」/)).toBeVisible({ timeout: 30_000 });
  // 能力表は fixture 由来であることと保証等級を行で開示する。
  // 能力表の由来列は engine 行ごとに出る (3 engine)。
  await expect(page.getByRole('cell', { name: 'fixture (実測ではない)' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Delegated' }).first()).toBeVisible();
  // run 永続化 (SQLite) 接続後の Interrupted 検出。通常終了なら「なし」。
  await expect(page.getByText(/検出されませんでした/)).toBeVisible();
});

test('A12: 監査 event に案件作成が記録されている', async () => {
  await page.getByRole('button', { name: /A12 Jobs \/ Evidence \/ Audit/ }).click();
  await expect(page.getByText(/監査 event \(\d+ 件\)/)).toBeVisible();
  await expect(page.getByText(/CaseCreated/)).toBeVisible();
});

test('A02: scope を編集して保存し、競合時は再読込を案内する', async () => {
  await page.getByRole('button', { name: /A02 Scope & Authorization/ }).click();
  // 認可は A01 の案件作成で付与済み。有効期間と許可操作を表示する。
  await expect(page.getByText(/認可: 付与済み/)).toBeVisible();
  await expect(page.getByText(/Browse, ActiveScan/)).toBeVisible();

  // 禁止 Origin を追記して保存 → revision が進む。
  const denied = page.getByLabel('禁止 Origin (1行1件)');
  await denied.fill('http://fixture.target.test\nhttp://denied.fixture.target.test');
  await page.getByRole('button', { name: 'scope を保存する' }).click();
  await expect(page.getByText(/revision 2 で保存しました/)).toBeVisible({ timeout: 30_000 });

  // 別 window による更新を擬似する (page 内から直接 scope を更新して revision 3 へ)。
  await page.evaluate(async () => {
    const base = window.scopepilotDesktop?.apiBase ?? '';
    const current = (await (await fetch(`${base}/api/case`)).json()) as {
      revision: number;
      scope: { allowedOrigins: readonly string[]; deniedOrigins: readonly string[]; limits: { maxRequests: number; maxPages: number; maxDurationMinutes: number } };
    };
    await fetch(`${base}/api/case/scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: current.revision,
        allowedOrigins: current.scope.allowedOrigins,
        deniedOrigins: current.scope.deniedOrigins,
        limits: { maxRequests: current.scope.limits.maxRequests - 1, maxPages: current.scope.limits.maxPages, maxDurationMinutes: current.scope.limits.maxDurationMinutes },
      }),
    });
  });
  // 画面の保持 revision (2) で保存しようとすると 409 → 競合表示、自動上書きしない。
  await page.getByRole('button', { name: 'scope を保存する' }).click();
  await expect(page.getByText(/自動上書きは行いません/)).toBeVisible({ timeout: 30_000 });
  // 再読込で最新 revision (3) を取り込める。
  await page.getByRole('button', { name: '再読込' }).click();
  await expect(page.getByText(/Scope \(現在 revision 3\)/)).toBeVisible({ timeout: 30_000 });
});

test('未実装画面はプレースホルダで明示される (A03)', async () => {
  await page.getByRole('button', { name: /A03 Guidelines & Check Catalog/ }).click();
  await expect(page.getByText('この画面は未実装です (後続増分で提供します)。')).toBeVisible();
});
