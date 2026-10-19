import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';

/**
 * Simple wizard (S01〜S07) の実 DOM 検証。`docs/detailed-design/02-ui-information-architecture.md` §2・§7。
 * 進行の強制性 (要件未達で次へ進めない) と、委譲範囲・未確認表示が実際に描画されることを確認する。
 */
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['dist/main.cjs'] });
  page = await app.firstWindow();
  await expect(page).toHaveTitle(/ScopePilot2/);
});

test.afterAll(async () => {
  await app.close();
});

test('S01: 案件を開くまで次へは無効', async () => {
  const next = page.getByRole('button', { name: /次へ/ });
  await expect(next).toBeDisabled();
  await page.getByRole('button', { name: '案件を開く' }).click();
  const openNotice = page.getByRole('status').filter({ hasText: /案件「ScopePilot2 案件」を開きました/ });
  await expect(openNotice).toBeVisible();
  await expect(next).toBeEnabled();
  await next.click();
});

test('S02: ガイドライン選択しないと次へは無効', async () => {
  // ステップ名はサイドバー (S01〜S07 の一覧) と本文の両方に出るため first を使う。
  await expect(page.getByText('S02 ガイドライン選択').nth(1)).toBeVisible();
  const next = page.getByRole('button', { name: /次へ/ });
  await expect(next).toBeDisabled();
  await page.getByRole('checkbox', { name: /OWASP WSTG 4\.2/ }).check();
  await expect(next).toBeEnabled();
  await next.click();
});

test('S03: 上限は表示専用で探索を実行できる', async () => {
  await expect(page.getByText(/表示専用/)).toBeVisible();
  await page.getByRole('button', { name: /探索を開始する/ }).click();
  await expect(page.getByText(/探索完了:/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /次へ/ }).click();
});

test('S04: 候補を採用すると次へが有効になる', async () => {
  const checkboxes = page.getByRole('checkbox');
  const count = await checkboxes.count();
  expect(count).toBeGreaterThan(0);
  // 全候補を採用する (Simple の標準運用)。
  for (let index = 0; index < count; index += 1) {
    await checkboxes.nth(index).check();
  }
  await page.getByRole('button', { name: /選択を採用する/ }).click();
  await expect(page.getByRole('button', { name: /次へ/ })).toBeEnabled();
  await page.getByRole('button', { name: /次へ/ }).click();
});

test('S05: 委譲範囲の開示を表示して計画を確認する', async () => {
  await page.getByRole('button', { name: /計画を作成して確認する/ }).click();
  await expect(page.getByText(/送信前拒否は保証しない/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/概算通信数上限/)).toBeVisible();
  await page.getByRole('button', { name: /次へ/ }).click();
});

test('S06: 診断を実行し所見に実影響未確認ラベルが出る', async () => {
  await page.getByRole('button', { name: /診断を実行する/ }).click();
  await expect(page.getByText(/診断完了/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/実影響未確認/).first()).toBeVisible();
  await page.getByRole('button', { name: /次へ/ }).click();
});

test('S07: 報告書を生成して限界開示を含む', async () => {
  await page.getByRole('button', { name: /報告書を生成する/ }).click();
  await expect(page.getByText(/診断報告書/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/送信前に拒否できない/)).toBeVisible();
});

test('戻るで前の step に戻り、達成済み要件は保持される (state machine)', async () => {
  const back = page.getByRole('button', { name: /戻る/ });
  // S07 → S06 → S05 → S04 まで戻る。
  await back.click();
  await expect(page.getByText('S06 実行状況').nth(1)).toBeVisible();
  await back.click();
  await expect(page.getByText('S05 実行計画の最終確認').nth(1)).toBeVisible();
  await back.click();
  await expect(page.getByText('S04 探索結果から対象選定').nth(1)).toBeVisible();
  // 採用済みのため次へは有効のまま (要件の再達成は求めない)。
  await expect(page.getByRole('button', { name: /次へ/ })).toBeEnabled();
  // そのまま S07 まで進み直せる。
  await page.getByRole('button', { name: /次へ/ }).click();
  await page.getByRole('button', { name: /次へ/ }).click();
  await page.getByRole('button', { name: /次へ/ }).click();
  await expect(page.getByText('S07 結果レビュー・報告').nth(1)).toBeVisible();
  // 生成済みの報告書は step を行き来しても保持される (button は再表示されない)。
  await expect(page.getByText(/診断報告書/)).toBeVisible({ timeout: 30_000 });
});

test('モード切替を挟んでも wizard の状態は保持される (mount 維持)', async () => {
  await page.getByRole('button', { name: 'アドバンスド' }).click();
  await expect(page.getByRole('navigation', { name: 'Advanced 画面ナビ' })).toBeVisible();
  await page.getByRole('button', { name: 'シンプル' }).click();
  // S07 の内容がそのまま残る (wizard は隠すだけで unmount しない)。
  await expect(page.getByText(/診断報告書/)).toBeVisible({ timeout: 30_000 });
});
