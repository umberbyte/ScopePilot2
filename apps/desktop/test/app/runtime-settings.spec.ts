import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let mainWindow: Page;
let settingsRoot: string;

test.beforeAll(async () => {
  settingsRoot = await mkdtemp(join(tmpdir(), 'scopepilot-settings-app-'));
  app = await electron.launch({
    args: ['dist/main.cjs'],
    env: {
      ...process.env,
      SCOPEPILOT_RUNTIME_SETTINGS_FILE: join(settingsRoot, 'runtime-tools.json'),
      SCOPEPILOT_ZAP_BASE_URL: 'http://127.0.0.1:1',
      ZCODE_CLI_CREDENTIALS_FILE: `${process.env.TEMP ?? 'C:\\Windows\\Temp'}\\scopepilot-missing-zcode-credentials-${process.pid}.json`,
    },
  });
  mainWindow = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
  await rm(settingsRoot, { recursive: true, force: true });
});

test('設定を保存して接続テストし、Advancedでも同じ設定を編集できる', async () => {
  const opened = app.waitForEvent('window');
  await mainWindow.getByRole('button', { name: '設定', exact: true }).click();
  const settings = await opened;
  const port = settings.getByLabel('ローカルAPIポート', { exact: true });
  await port.fill('65536');
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await expect(settings.getByText('APIポートは0〜65535の整数で指定してください')).toBeVisible();
  await port.fill('0');
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await expect(settings.getByText('設定を保存しました。', { exact: false })).toBeVisible();
  const stored = JSON.parse(await readFile(join(settingsRoot, 'runtime-tools.json'), 'utf8'));
  expect(stored.environment.SCOPEPILOT_API_PORT).toBe('0');
  await settings.getByRole('button', { name: '保存済み設定の接続テスト', exact: true }).click();
  await expect(settings.getByText('zap: 利用不可', { exact: true })).toBeVisible();
  await expect(settings.getByText('oast: 未設定', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await mainWindow.getByRole('button', { name: 'アドバンスド', exact: true }).click();
  await mainWindow.getByRole('navigation', { name: 'Advanced 画面ナビ' }).getByRole('button', { name: /A13/ }).click();
  await expect(mainWindow.getByLabel('ローカルAPIポート', { exact: true })).toHaveValue('0');
  await mainWindow.getByLabel('ローカルAPIポート', { exact: true }).fill('12345');
  await mainWindow.getByRole('button', { name: '保存', exact: true }).click();
  await expect(mainWindow.getByText('設定を保存しました。', { exact: false })).toBeVisible();
  expect(mainWindow.isClosed()).toBe(false);
  expect(JSON.parse(await readFile(join(settingsRoot, 'runtime-tools.json'), 'utf8')).environment.SCOPEPILOT_API_PORT).toBe('12345');
});

test('独立した設定ウィンドウに7つの実行パスと保存・キャンセル操作を表示する', async () => {
  const themeSelect = mainWindow.getByRole('combobox', { name: 'テーマ' });
  const originalTheme = await themeSelect.inputValue();
  await themeSelect.selectOption('dark');
  const opened = app.waitForEvent('window');
  await mainWindow.getByRole('button', { name: '設定', exact: true }).click();
  const settingsWindow = await opened;

  await expect(settingsWindow.getByRole('heading', { name: '実行環境の設定' })).toBeVisible();
  const pathInputs = settingsWindow.getByRole('textbox');
  await expect(pathInputs).toHaveCount(11);
  await expect(pathInputs.nth(0)).not.toHaveValue('');
  await expect(pathInputs.nth(1)).not.toHaveValue('');
  await expect(pathInputs.nth(2)).not.toHaveValue('');
  await expect(settingsWindow.getByText('zcode-cli', { exact: true }).first()).toBeVisible();
  await expect(settingsWindow.getByText('Codex CLI', { exact: true }).first()).toBeVisible();
  await expect(settingsWindow.getByText('Claude CLI', { exact: true }).first()).toBeVisible();
  await expect(settingsWindow.getByRole('combobox', { name: 'zcode-cli の起動方式' })).toHaveValue(/node|file/u);
  await expect(settingsWindow.getByRole('combobox', { name: 'Codex CLI の起動方式' })).toHaveValue(/node|file/u);
  await expect(settingsWindow.getByRole('combobox', { name: 'Claude CLI の起動方式' })).toHaveValue(/node|file/u);
  await expect(settingsWindow.getByText('OWASP ZAP', { exact: true }).first()).toBeVisible();
  await expect(settingsWindow.getByText('Nuclei', { exact: true }).first()).toBeVisible();
  await expect(settingsWindow.getByText('Nuclei審査済みテンプレート', { exact: true }).first()).toBeVisible();
  await expect(settingsWindow.getByText('Playwright CLI', { exact: true }).first()).toBeVisible();
  const zcodeAuth = settingsWindow.getByLabel('zcode-cli 認証状態');
  await expect(zcodeAuth.getByText('未ログイン', { exact: true })).toBeVisible();
  await expect(zcodeAuth.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible();
  const blackText = await settingsWindow.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('body *'))
    .filter((element) => element.offsetParent !== null)
    .filter((element) => Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== ''))
    .filter((element) => ['rgb(0,0,0)', 'rgba(0,0,0,1)'].includes(getComputedStyle(element).color.replaceAll(' ', '').toLowerCase()))
    .map((element) => (element.textContent ?? '').trim().slice(0, 80)));
  expect(blackText).toEqual([]);
  await expect(settingsWindow.getByRole('button', { name: '保存して閉じる' })).toBeEnabled();
  const closed = settingsWindow.waitForEvent('close');
  await settingsWindow.getByRole('button', { name: 'キャンセル' }).click();
  await closed;
  expect(mainWindow.isClosed()).toBe(false);
  await themeSelect.selectOption(originalTheme);
});
