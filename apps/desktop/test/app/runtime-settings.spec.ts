import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';

let app: ElectronApplication;
let mainWindow: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['dist/main.cjs'],
    env: {
      ...process.env,
      SCOPEPILOT_ZAP_BASE_URL: 'http://127.0.0.1:1',
      ZCODE_CLI_CREDENTIALS_FILE: `${process.env.TEMP ?? 'C:\\Windows\\Temp'}\\scopepilot-missing-zcode-credentials-${process.pid}.json`,
    },
  });
  mainWindow = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

test('独立した設定ウィンドウに7つの実行パスと保存・キャンセル操作を表示する', async () => {
  const themeSelect = mainWindow.getByRole('combobox', { name: 'テーマ' });
  const originalTheme = await themeSelect.inputValue();
  await themeSelect.selectOption('dark');
  const opened = app.waitForEvent('window');
  await mainWindow.getByRole('button', { name: '設定' }).click();
  const settingsWindow = await opened;

  await expect(settingsWindow.getByRole('heading', { name: '実行環境の設定' })).toBeVisible();
  const pathInputs = settingsWindow.getByRole('textbox');
  await expect(pathInputs).toHaveCount(7);
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
