import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { createServer, type Server } from 'node:http';

/**
 * Simple wizard (S01〜S07) の実 DOM 検証。`docs/detailed-design/02-ui-information-architecture.md` §2・§7。
 * 進行の強制性 (要件未達で次へ進めない) と、委譲範囲・未確認表示が実際に描画されることを確認する。
 */
let app: ElectronApplication;
let page: Page;
let targetServer: Server;
let targetOrigin: string;

async function visiblePureBlackText(): Promise<readonly string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => element.offsetParent !== null)
      .filter((element) => Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
      ))
      .filter((element) => {
        const color = getComputedStyle(element).color.replaceAll(' ', '').toLowerCase();
        return color === 'rgb(0,0,0)' || color === 'rgba(0,0,0,1)';
      })
      .map((element) => (element.textContent ?? '').trim().slice(0, 80)),
  );
}

test.beforeAll(async () => {
  targetServer = createServer((request, response) => {
    const authenticated = request.headers.cookie?.includes('TESTSESSION=authenticated') === true;
    if (request.url === '/login.php' && request.method === 'GET' && !authenticated) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><form method="post"><input id="username" name="username"><input id="password" name="password" type="password"><input type="submit"></form>');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'TESTSESSION=authenticated; Path=/' });
    response.end('<!doctype html><title>Fixture Target Home</title><a href="/page">Page</a><a href="/login.php">Login</a>');
  });
  await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const address = targetServer.address();
  if (address === null || typeof address === 'string') throw new Error('fixture target did not bind');
  targetOrigin = `http://127.0.0.1:${address.port}`;
  app = await electron.launch({ args: ['dist/main.cjs'], env: { ...process.env, SCOPEPILOT_DISABLE_AI: '1', SCOPEPILOT_DISABLE_NUCLEI: '1' } });
  page = await app.firstWindow();
  await expect(page).toHaveTitle(/ScopePilot2/);
  await app.evaluate(({ dialog, app }) => {
    const caseRoot = `${app.getPath('temp')}\\scopepilot2-desktop-test-${process.pid}-${Date.now()}`;
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async (...args: unknown[]) => {
        const options = args.at(-1) as { properties?: readonly string[] };
        return options.properties?.includes('openDirectory') === true
          ? { canceled: false, filePaths: [caseRoot] }
          : { canceled: false, filePaths: [`${process.cwd()}\\package.json`] };
      },
    });
  });
  await page.getByRole('combobox', { name: 'テーマ' }).selectOption('dark');
});

test.afterEach(async () => {
  expect(await visiblePureBlackText()).toEqual([]);
});

test.afterAll(async () => {
  await page.getByRole('combobox', { name: 'テーマ' }).selectOption('system');
  await app.close();
  await new Promise<void>((resolve, reject) => targetServer.close((cause) => cause === undefined ? resolve() : reject(cause)));
});

test('S01: 案件を開くまで次へは無効', async () => {
  const next = page.getByRole('button', { name: /次へ/ });
  await expect(next).toBeDisabled();
  await page.getByRole('button', { name: '新規案件を作成' }).click();
  await expect(page.getByText(/^scopepilot2-desktop-test-\d+-\d+$/, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '案件を作成' })).toBeEnabled();
  await page.getByRole('textbox', { name: '開始URL' }).fill(`${targetOrigin}/`);
  await page.getByRole('textbox', { name: '診断を許可されたOrigin' }).fill(targetOrigin);
  await page.getByRole('button', { name: '資料ファイルを追加' }).click();
  await expect(page.getByText('package.json', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '案件を作成' }).click();
  const openNotice = page.getByRole('status').filter({ hasText: /案件「scopepilot2-desktop-test-/ });
  await expect(openNotice).toBeVisible();
  await page.getByRole('button', { name: 'URL・Originを保存' }).click();
  await expect(page.getByText('開始URLとOriginを案件へ保存しました。')).toBeVisible();
  await page.getByRole('button', { name: '削除' }).click();
  await expect(page.getByText('package.json', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '資料ファイルを追加' }).click();
  await expect(page.getByText('package.json', { exact: true })).toHaveCount(1);

  // Rendererを再読込して既存案件を選ぶ。追加操作を行う前からDB登録済み資料が
  // 1件だけ表示され、案件も開いた状態になることを確認する。
  await page.reload();
  await page.getByRole('button', { name: '既存案件を開く' }).click();
  await expect(page.getByText('package.json', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('status').filter({ hasText: /案件「scopepilot2-desktop-test-/ })).toBeVisible();
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
  await page.getByRole('button', { name: '認証情報を追加' }).click();
  await page.getByRole('textbox', { name: '認証ロール' }).fill('admin');
  await page.getByRole('textbox', { name: 'ログインURL' }).fill(`${targetOrigin}/login.php`);
  await page.getByRole('textbox', { name: 'ユーザー名', exact: true }).fill('fixture-user');
  await page.locator('input[type="password"]').fill('fixture-pass');
  await page.getByRole('textbox', { name: 'ユーザー名欄のCSSセレクター' }).fill('#username');
  await page.getByRole('textbox', { name: 'パスワード欄のCSSセレクター' }).fill('#password');
  await page.getByRole('textbox', { name: 'ログインボタンのCSSセレクター' }).fill('input[type=submit]');
  await page.getByRole('textbox', { name: '認証後URLのprefix' }).fill(`${targetOrigin}/`);
  await page.getByRole('textbox', { name: '認証後ページに含まれる文字列' }).fill('Fixture Target Home');
  await page.getByRole('button', { name: 'ログインして認証情報を追加' }).click();
  await expect(page.getByText(/admin のログインに成功しました/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('textbox', { name: 'ログインURL' })).toHaveCount(0);
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

test('S06: 診断を実行し、実行経路と完了を表示する', async () => {
  await page.getByRole('button', { name: /診断を実行する/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /診断完了/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('現在のコマンド')).toBeVisible();
  await expect(page.getByText(/ZAP API: context \+ active HTTP session/).first()).toBeVisible();
  await expect(page.getByText('実行ログ')).toBeVisible();
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
