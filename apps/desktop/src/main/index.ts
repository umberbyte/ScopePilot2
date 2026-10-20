/**
 * Electron main process。`docs/detailed-design/01-system-components.md` §1・§2。
 * 責務はウィンドウ・ローカル API 起動・秘密値 bridge・終了処理のみ (業務ルールを重複実装しない)。
 * Core API は loopback でのみ listen し、renderer は preload 経由の apiBase のみを知る。
 */
import { basename, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { BaselineFlowService, createCoreApiServer, InMemoryEvidenceStore, SequentialIdGenerator, SystemClock } from '@scopepilot2/core';
import { composeEngines } from '@scopepilot2/adapters';
import type { OperatorProfile } from '@scopepilot2/contracts';
import type { RunRepository } from '@scopepilot2/storage';
import { DesktopWorkspaceManager, type WorkspaceOpenMode, type WorkspaceSettingsInput } from './workspace.ts';
import { DesktopAiAssistant } from './ai-assistant.ts';

let window: BrowserWindow | null = null;
let closeEngines: (() => Promise<void>) | null = null;
const selectedPaths = new Set<string>();
let selectedCaseDirectory: string | undefined;
let selectedWorkspaceMode: WorkspaceOpenMode | undefined;

interface DesktopPath {
  readonly path: string;
  readonly name: string;
}

function rememberPath(path: string): DesktopPath {
  const normalized = resolve(path);
  selectedPaths.add(normalized);
  return { path: normalized, name: basename(normalized) };
}

function showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  return window === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(window, options);
}

/** renderer に filesystem 全体を公開せず、native dialog で選ばれた path だけを扱う。 */
function registerDesktopPathHandlers(
  workspaceManager: DesktopWorkspaceManager,
  activateService: (workspace: Awaited<ReturnType<DesktopWorkspaceManager['activate']>>) => Promise<void>,
): void {
  ipcMain.handle('scopepilot:select-case-directory', async (_event, mode: unknown): Promise<DesktopPath | null> => {
    if (mode !== 'create' && mode !== 'open') throw new Error('案件フォルダの選択方法が不正です');
    const result = await showOpenDialog({
      title: mode === 'create' ? '新規案件用の空フォルダを選択' : '既存の案件フォルダを選択',
      buttonLabel: mode === 'create' ? 'このフォルダに作成' : 'この案件を開く',
      properties: mode === 'create' ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const selectedPath = result.filePaths[0];
    if (selectedPath === undefined) {
      return null;
    }
    const selection = rememberPath(selectedPath);
    selectedCaseDirectory = selection.path;
    selectedWorkspaceMode = mode;
    return selection;
  });

  ipcMain.handle('scopepilot:select-material-files', async (): Promise<readonly DesktopPath[]> => {
    const result = await showOpenDialog({
      title: 'ディレクターから受領した資料を選択',
      buttonLabel: '資料を追加',
      ...(selectedCaseDirectory === undefined ? {} : { defaultPath: selectedCaseDirectory }),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '診断資料', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'md', 'json', 'yaml', 'yml', 'har', 'http'] },
        { name: 'すべてのファイル', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths.map(rememberPath);
  });

  ipcMain.handle('scopepilot:open-selected-path', async (_event, path: unknown): Promise<void> => {
    if (typeof path !== 'string' || !selectedPaths.has(resolve(path))) {
      throw new Error('native dialog で選択されていないパスは開けません');
    }
    const error = await shell.openPath(resolve(path));
    if (error !== '') {
      throw new Error(error);
    }
  });

  ipcMain.handle('scopepilot:activate-case-workspace', async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('案件ワークスペースの入力が不正です');
    const value = request as { directory?: unknown; materialPaths?: unknown; settings?: unknown; mode?: unknown };
    if (typeof value.directory !== 'string' || resolve(value.directory) !== selectedCaseDirectory) {
      throw new Error('native dialogで選択した案件フォルダだけを開けます');
    }
    if ((value.mode !== 'create' && value.mode !== 'open') || value.mode !== selectedWorkspaceMode) {
      throw new Error('案件フォルダ選択時と異なる方法では開けません');
    }
    if (!Array.isArray(value.materialPaths) || !value.materialPaths.every((path) => typeof path === 'string' && selectedPaths.has(resolve(path)))) {
      throw new Error('native dialogで選択した資料だけを取り込めます');
    }
    if (typeof value.settings !== 'object' || value.settings === null) throw new Error('案件設定が不正です');
    const settings = value.settings as Partial<WorkspaceSettingsInput>;
    const arraysAreStrings = (items: unknown): items is string[] => Array.isArray(items) && items.every((item) => typeof item === 'string');
    if (typeof settings.startUrl !== 'string' || !arraysAreStrings(settings.supportingOrigins)
      || !arraysAreStrings(settings.targetRoles) || !arraysAreStrings(settings.forbiddenActions)
      || !['zcode', 'codex', 'claude'].includes(settings.aiProvider ?? '') || typeof settings.aiModel !== 'string') {
      throw new Error('案件設定の形式が不正です');
    }
    const activated = await workspaceManager.activate(value.directory, value.materialPaths, settings as WorkspaceSettingsInput, value.mode);
    rememberPath(activated.directory);
    rememberPath(activated.dbPath);
    for (const input of activated.inputs) rememberPath(join(activated.directory, input.relativePath));
    await activateService(activated);
    return {
      directory: activated.directory,
      dbPath: activated.dbPath,
      existingCase: activated.existingCase,
      settings: activated.settings,
      inputs: activated.inputs.map((input) => ({
        ...input,
        path: join(activated.directory, input.relativePath),
        name: input.originalName,
      })),
    };
  });

  ipcMain.handle('scopepilot:save-report', async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('報告書の入力が不正です');
    const value = request as { content?: unknown; modelHash?: unknown };
    if (typeof value.content !== 'string' || typeof value.modelHash !== 'string' || value.modelHash.trim() === '') {
      throw new Error('報告書本文またはmodel hashが不正です');
    }
    const saved = await workspaceManager.saveReport(value.content, value.modelHash);
    rememberPath(saved.markdownPath);
    rememberPath(saved.wordPath);
    return saved;
  });

  const aiAssistant = (): DesktopAiAssistant => {
    const repositories = workspaceManager.repositories();
    const directory = workspaceManager.directory();
    if (repositories === null || directory === null) throw new Error('案件フォルダを先に開いてください');
    const settings = repositories.workspace.getSettings();
    if (settings === null) throw new Error('案件のAI設定がありません');
    const existingCase = repositories.cases.list()[0];
    let fallbackOrigin: string[] = [];
    try { fallbackOrigin = [new URL(settings.startUrl).origin]; } catch { /* 案件作成時の検証が正本 */ }
    return new DesktopAiAssistant({
      directory,
      settings,
      inputs: repositories.workspace.listInputs(),
      allowedOrigins: existingCase?.scope.allowedOrigins ?? fallbackOrigin,
      invocations: repositories.aiInvocations,
    });
  };

  ipcMain.handle('scopepilot:analyze-materials', async () => await aiAssistant().analyzeDocuments());

  ipcMain.handle('scopepilot:generate-ai-report', async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('AI報告書の入力が不正です');
    const value = request as { baseContent?: unknown; baseModelHash?: unknown; guidelines?: unknown };
    if (typeof value.baseContent !== 'string' || typeof value.baseModelHash !== 'string'
      || !Array.isArray(value.guidelines) || !value.guidelines.every((item) => typeof item === 'string')) {
      throw new Error('AI報告書の入力形式が不正です');
    }
    return await aiAssistant().draftReport(value.baseContent, value.baseModelHash, value.guidelines);
  });
}

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
  // 製品起動は常に実 engine。Playwright は案件 scope を送信前に強制し、ZAP は
  // 明示 endpoint またはローカル導入済み daemon を使用する。fixture への fallback はない。
  const engines = await composeEngines();
  closeEngines = () => engines.close();
  const engineOptions = {
    explorer: engines.explorer,
    scanEngine: engines.scanEngine,
    capabilities: engines.capabilities,
    loginExecutor: engines.loginExecutor,
    repeaterTransport: engines.repeaterTransport,
    fuzzTransport: engines.fuzzTransport,
    sequencerTransport: engines.sequencerTransport,
    oastProvider: engines.oastProvider,
    webSocketTransport: engines.webSocketTransport,
    advancedTransport: engines.advancedTransport,
    domObserver: engines.domObserver,
    runtimeBundleHash: engines.runtimeBundleHash,
  };
  const createProductService = (options: {
    readonly runSink?: import('@scopepilot2/core').RunSinkPort;
    readonly caseSink?: { save(record: import('@scopepilot2/contracts').CaseRecord): void };
    readonly authorizationSink?: { save(record: import('@scopepilot2/contracts').AuthorizationRecord): void };
    readonly evidenceStore?: import('@scopepilot2/core').EvidenceStorePort;
    readonly initialCase?: import('@scopepilot2/contracts').CaseRecord;
    readonly initialAuthorization?: import('@scopepilot2/contracts').AuthorizationRecord;
  } = {}): BaselineFlowService => {
    const service = new BaselineFlowService({
      ...engineOptions,
      clock: new SystemClock(),
      ids: new SequentialIdGenerator(),
      evidence: options.evidenceStore ?? new InMemoryEvidenceStore(),
      ...(options.runSink === undefined ? {} : { runSink: options.runSink }),
      ...(options.caseSink === undefined ? {} : { caseSink: options.caseSink }),
      ...(options.authorizationSink === undefined ? {} : { authorizationSink: options.authorizationSink }),
    });
    if (options.initialCase !== undefined) service.restoreWorkspace(options.initialCase, options.initialAuthorization);
    return service;
  };
  let activeService = createProductService();
  let activeRuns: RunRepository | null = null;
  const serviceProxy = new Proxy(activeService, {
    get: (_target, property) => {
      const member = Reflect.get(activeService, property, activeService) as unknown;
      if (property === 'createCase' && typeof member === 'function') {
        return (operator: OperatorProfile, input: { readonly allowedOrigins: readonly string[]; readonly deniedOrigins: readonly string[] }) => {
          const result = member.call(activeService, operator, input) as unknown;
          engines.updateExplorationScope({ allowedOrigins: input.allowedOrigins, deniedOrigins: input.deniedOrigins });
          return result;
        };
      }
      return typeof member === 'function' ? member.bind(activeService) : member;
    },
  }) as BaselineFlowService;
  const runRepositoryProxy = {
    listInterruptedCandidates: () => activeRuns?.listInterruptedCandidates() ?? [],
    markInterrupted: () => activeRuns?.markInterrupted() ?? [],
  };
  const workspaceManager = new DesktopWorkspaceManager();
  registerDesktopPathHandlers(workspaceManager, async (workspace) => {
    const repositories = workspaceManager.repositories();
    if (repositories === null) throw new Error('案件DBを開けませんでした');
    activeRuns = repositories.runs;
    const temporaryOrigins = workspace.existingCase?.scope.allowedOrigins ?? [new URL(workspace.settings.startUrl).origin];
    engines.updateExplorationScope({
      allowedOrigins: temporaryOrigins,
      deniedOrigins: workspace.existingCase?.scope.deniedOrigins ?? [],
    });
    activeService = createProductService({
      runSink: repositories.runs,
      caseSink: repositories.cases,
      authorizationSink: repositories.authorizations,
      evidenceStore: repositories.evidence,
      ...(workspace.existingCase === null ? {} : { initialCase: workspace.existingCase }),
      ...(workspace.existingAuthorization === null ? {} : { initialAuthorization: workspace.existingAuthorization }),
    });
  });
  const desktopOperator: OperatorProfile = {
    operatorId: 'desktop-local-operator',
    displayName: 'Desktop local operator',
    permissions: ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'],
  };
  const server = createCoreApiServer({ service: serviceProxy, operator: desktopOperator, runRepository: runRepositoryProxy });
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
    workspaceManager.close();
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
