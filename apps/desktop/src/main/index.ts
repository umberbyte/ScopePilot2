/**
 * Electron main process。`docs/detailed-design/01-system-components.md` §1・§2。
 * 責務はウィンドウ・ローカル API 起動・秘密値 bridge・終了処理のみ (業務ルールを重複実装しない)。
 * Core API は loopback でのみ listen し、renderer は preload 経由の apiBase のみを知る。
 */
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { createCoreApiServer } from '@scopepilot2/core';
import { CaseRepository, migrate, openDatabase, RunRepository } from '@scopepilot2/storage';
import { createHarness, FIXTURE_OPERATOR } from '@scopepilot2/simulation';

let window: BrowserWindow | null = null;

function createWindow(apiBase: string): void {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'ScopePilot2',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--scopepilot-api-base=${apiBase}`],
    },
  });
  window.loadFile(join(__dirname, 'index.html')).catch((cause: unknown) => {
    console.error('failed to load renderer', cause);
  });
  window.on('closed', () => {
    window = null;
  });
}

async function bootstrap(): Promise<void> {
  // run 記録は userData 直下の SQLite へ (design/20 §2)。次回起動時に Running のままの
  // run を Interrupted 検出できる (design/22 §6)。
  const db = openDatabase(join(app.getPath('userData'), 'scopepilot2.db'));
  migrate(db);
  const runRepository = new RunRepository(db);
  const caseRepository = new CaseRepository(db);
  // runs 表は cases 表を参照するため、案件も作成・更新時に保存する。
  const harness = createHarness({ runSink: runRepository, caseSink: caseRepository });
  const server = createCoreApiServer({ service: harness.service, operator: FIXTURE_OPERATOR, runRepository });
  const binding = await new Promise<{ host: string; port: number }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a TCP address for the core api server'));
        return;
      }
      resolve({ host: '127.0.0.1', port: address.port });
    });
  });
  createWindow(`http://${binding.host}:${binding.port}`);

  const shutdown = (): void => {
    server.close();
    db.close();
  };
  app.on('window-all-closed', () => {
    shutdown();
    app.quit();
  });
  app.on('before-quit', shutdown);
}

app.whenReady().then(bootstrap).catch((cause: unknown) => {
  console.error('desktop bootstrap failed', cause);
  app.quit();
});
