import { expect, test, type ElectronApplication } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('S01はログイン済みCLIのモデルを表示し、選択をアプリ共通設定として再起動後も保持する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scopepilot-ai-selection-'));
  const settingsPath = join(root, 'runtime-tools.json');
  await writeFile(settingsPath, JSON.stringify({
    schemaVersion: 1,
    paths: {},
    aiSelection: { provider: 'codex', model: '' },
  }), 'utf8');
  const env = {
    ...process.env,
    SCOPEPILOT_ZAP_BASE_URL: 'http://127.0.0.1:1',
    SCOPEPILOT_RUNTIME_SETTINGS_FILE: settingsPath,
  };
  let app: ElectronApplication | null = null;
  try {
    app = await electron.launch({ args: ['dist/main.cjs'], env });
    let page = await app.firstWindow();
    const providerSelect = page.getByRole('combobox', { name: '利用するAI' });
    const modelSelect = page.getByRole('combobox', { name: '利用するモデル' });
    await expect(providerSelect).toBeEnabled({ timeout: 20_000 });
    await expect(modelSelect).toBeEnabled();
    const providers = await providerSelect.locator('option').evaluateAll((options) => options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      label: option.textContent ?? '',
    })).filter((option) => option.value !== ''));
    expect(providers.length).toBeGreaterThan(0);
    const selectedProvider = providers.at(-1)!;
    await providerSelect.selectOption(selectedProvider.value);
    const models = await modelSelect.locator('option').evaluateAll((options) => options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      label: option.textContent ?? '',
    })));
    expect(models.length).toBeGreaterThan(0);
    const selectedModel = models.at(-1)!;
    await modelSelect.selectOption(selectedModel.value);
    await expect.poll(async () => await page.evaluate(async ({ provider, model }) => {
      const bridge = (window as unknown as { scopepilotDesktop: { getAiCatalog(): Promise<{ selection: { provider: string; model: string } }> } }).scopepilotDesktop;
      const catalog = await bridge.getAiCatalog();
      return catalog.selection.provider === provider && catalog.selection.model === model;
    }, { provider: selectedProvider.value, model: selectedModel.value })).toBe(true);

    await app.close();
    app = await electron.launch({ args: ['dist/main.cjs'], env });
    page = await app.firstWindow();
    await expect(page.getByRole('combobox', { name: '利用するAI' })).toHaveValue(selectedProvider.value, { timeout: 20_000 });
    await expect(page.getByRole('combobox', { name: '利用するモデル' })).toHaveValue(selectedModel.value);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
