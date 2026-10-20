/**
 * Electron main process。`docs/detailed-design/01-system-components.md` §1・§2。
 * 責務はウィンドウ・ローカル API 起動・秘密値 bridge・終了処理のみ (業務ルールを重複実装しない)。
 * Core API は loopback でのみ listen し、renderer は preload 経由の apiBase のみを知る。
 */
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { createCoreApiServer, SystemClock } from '@scopepilot2/core';
import { composeEngines } from '@scopepilot2/adapters';
import { CaseRepository, migrate, openDatabase, RunRepository } from '@scopepilot2/storage';
import { createHarness, FIXTURE_OPERATOR } from '@scopepilot2/simulation';

let window: BrowserWindow | null = null;
let closeEngines: (() => Promise<void>) | null = null;

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
  // engine は環境変数で明示 opt-in したときだけ実物 (SCOPEPILOT_ZAP_BASE_URL・
  // SCOPEPILOT_EXPLORER=playwright)。既定は fixture。実 engine 時は実時間で記録する。
  const engines = await composeEngines();
  closeEngines = () => engines.close();
  const harness = createHarness({
    runSink: runRepository,
    caseSink: caseRepository,
    ...(engines.mode === 'fixture'
      ? {}
      : {
          engines: {
            explorer: engines.explorer,
            scanEngine: engines.scanEngine,
            capabilities: engines.capabilities,
            clock: new SystemClock(),
            ...(engines.loginExecutor === undefined ? {} : { loginExecutor: engines.loginExecutor }),
            ...(engines.repeaterTransport === undefined ? {} : { repeaterTransport: engines.repeaterTransport }),
            ...(engines.fuzzTransport === undefined ? {} : { fuzzTransport: engines.fuzzTransport }),
            ...(engines.sequencerTransport === undefined ? {} : { sequencerTransport: engines.sequencerTransport }),
            ...(engines.oastProvider === undefined ? {} : { oastProvider: engines.oastProvider }),
            ...(engines.runtimeBundleHash === undefined ? {} : { runtimeBundleHash: engines.runtimeBundleHash }),
          },
        }),
  });
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
    void closeEngines?.().catch(() => undefined);
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
