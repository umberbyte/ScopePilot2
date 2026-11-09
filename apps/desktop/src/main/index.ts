/**
 * Electron main process。`docs/detailed-design/01-system-components.md` §1・§2。
 * 責務はウィンドウ・ローカル API 起動・秘密値 bridge・終了処理のみ (業務ルールを重複実装しない)。
 * Core API は loopback でのみ listen し、renderer は preload 経由の apiBase のみを知る。
 */
import { basename, dirname, join, resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { BaselineFlowService, createCoreApiServer, InMemoryEvidenceStore, SequentialIdGenerator, SystemClock } from '@scopepilot2/core';
import { composeEngines } from '@scopepilot2/adapters';
import type { OperatorProfile, ReportModel } from '@scopepilot2/contracts';
import { SqliteJobStore, type RunRepository } from '@scopepilot2/storage';
import { DesktopWorkspaceManager, type WorkspaceOpenMode, type WorkspaceSettingsInput, type WorkspaceSettingsUpdateInput } from './workspace.ts';
import { DesktopAiAssistant, type AiReportFindingInput } from './ai-assistant.ts';
import type { ReportFindingNarrative } from './assurance-report.ts';
import { observeLoginPage } from './login-page-observer.ts';
import { AiAuthService } from './ai-auth.ts';
import { AiCatalogService } from './ai-catalog.ts';
import { RuntimeSettingsStore } from './runtime-settings.ts';
import { presentActivatedWorkspace } from './workspace-presentation.ts';
import { AiCliLaunchModeValues, AiCliProviders, RuntimeToolIds, type AiCliLaunchModes, type AiCliProvider, type AppAiSelection, type RuntimeSettingsInput, type RuntimeToolId } from '../shared/runtime-settings.ts';

let window: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
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
  runtimeSettings: RuntimeSettingsStore,
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
    return presentActivatedWorkspace(activated);
  });

  ipcMain.handle('scopepilot:save-case-workspace-settings', async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('案件設定が不正です');
    const settings = request as Partial<WorkspaceSettingsUpdateInput>;
    const arraysAreStrings = (items: unknown): items is string[] => Array.isArray(items) && items.every((item) => typeof item === 'string');
    if (typeof settings.startUrl !== 'string' || !arraysAreStrings(settings.allowedOrigins)
      || !arraysAreStrings(settings.supportingOrigins) || !arraysAreStrings(settings.targetRoles)
      || !arraysAreStrings(settings.forbiddenActions) || !['zcode', 'codex', 'claude'].includes(settings.aiProvider ?? '')
      || typeof settings.aiModel !== 'string') {
      throw new Error('案件設定の形式が不正です');
    }
    const updated = workspaceManager.updateSettings(settings as WorkspaceSettingsUpdateInput);
    return { settings: updated.settings, allowedOrigins: updated.existingCase?.scope.allowedOrigins ?? [] };
  });

  ipcMain.handle('scopepilot:remove-case-input', async (_event, inputId: unknown) => {
    if (typeof inputId !== 'string' || inputId.trim() === '') throw new Error('入力資料IDが不正です');
    const directory = workspaceManager.directory();
    const current = workspaceManager.repositories()?.workspace.listInputs().find((entry) => entry.inputId === inputId);
    const inputs = await workspaceManager.removeInput(inputId);
    if (directory !== null && current !== undefined) selectedPaths.delete(resolve(directory, current.relativePath));
    return inputs.map((input) => ({
      ...input,
      path: join(directory ?? '', input.relativePath),
      name: input.originalName,
    }));
  });

  ipcMain.handle('scopepilot:import-case-inputs', async (_event, materialPaths: unknown) => {
    if (!Array.isArray(materialPaths) || !materialPaths.every((path) => typeof path === 'string' && selectedPaths.has(resolve(path)))) {
      throw new Error('native dialogで選択した資料だけを取り込めます');
    }
    const directory = workspaceManager.directory();
    if (directory === null) throw new Error('案件フォルダを先に開いてください');
    const inputs = await workspaceManager.importInputs(materialPaths);
    return inputs.map((input) => {
      const path = join(directory, input.relativePath);
      rememberPath(path);
      return { ...input, path, name: input.originalName };
    });
  });

  ipcMain.handle('scopepilot:save-report', async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('報告書の入力が不正です');
    const value = request as { content?: unknown; modelHash?: unknown; reportId?: unknown; model?: unknown; profile?: unknown; findingNarratives?: unknown };
    const model = value.model as Partial<ReportModel> | undefined;
    if (typeof value.content !== 'string' || typeof value.modelHash !== 'string' || value.modelHash.trim() === ''
      || typeof value.reportId !== 'string' || value.reportId.trim() === ''
      || model === undefined || typeof model.caseId !== 'string' || typeof model.generatedAt !== 'string'
      || !Array.isArray(model.findings) || typeof model.assessmentScope !== 'object' || model.assessmentScope === null) {
      throw new Error('報告書本文またはmodel hashが不正です');
    }
    const findingNarratives = Array.isArray(value.findingNarratives)
      ? value.findingNarratives.filter((entry): entry is ReportFindingNarrative => {
          if (typeof entry !== 'object' || entry === null) return false;
          const item = entry as Partial<ReportFindingNarrative>;
          return typeof item.findingId === 'string' && typeof item.summary === 'string'
            && typeof item.conditions === 'string' && typeof item.cause === 'string' && Array.isArray(item.reproductionSteps)
            && item.reproductionSteps.every((step) => typeof step === 'string')
            && typeof item.remediation === 'string' && typeof item.verificationCriteria === 'string';
        })
      : [];
    const saved = await workspaceManager.saveReport(value.content, value.modelHash, value.reportId, model as ReportModel, value.profile, findingNarratives);
    rememberPath(saved.markdownPath);
    rememberPath(saved.wordPath);
    rememberPath(saved.technicalAnnexHtmlPath);
    rememberPath(saved.structuredJsonPath);
    rememberPath(saved.manifestPath);
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
      allowedOrigins: [...new Set([...(existingCase?.scope.allowedOrigins ?? fallbackOrigin), ...settings.supportingOrigins])],
      invocations: repositories.aiInvocations,
      executablePaths: {
        zcode: runtimeSettings.current().paths.zcodeCli,
        codex: runtimeSettings.current().paths.codexCli,
        claude: runtimeSettings.current().paths.claudeCli,
      },
      launchModes: runtimeSettings.current().aiLaunchModes,
    });
  };

  ipcMain.handle('scopepilot:analyze-materials', async () => await aiAssistant().analyzeDocuments());

  ipcMain.handle('scopepilot:infer-login-form', async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('ログインフォーム推定の入力が不正です。');
    const value = request as { loginUrl?: unknown };
    if (typeof value.loginUrl !== 'string' || value.loginUrl.trim() === '' || value.loginUrl.length > 2_000) {
      throw new Error('推定するログインURLを入力してください。');
    }
    const repositories = workspaceManager.repositories();
    if (repositories === null) throw new Error('案件フォルダーを先に開いてください。');
    const settings = repositories.workspace.getSettings();
    if (settings === null) throw new Error('案件の設定がありません。');
    const existingCase = repositories.cases.list()[0];
    let fallbackOrigins: string[] = [];
    try { fallbackOrigins = [new URL(settings.startUrl).origin]; } catch { /* 保存時に検証済み */ }
    const allowedOrigins = [...new Set([
      ...(existingCase?.scope.allowedOrigins ?? fallbackOrigins),
      ...settings.supportingOrigins,
    ])];
    const snapshot = await observeLoginPage(value.loginUrl.trim(), allowedOrigins);
    return await aiAssistant().inferLoginForm(snapshot);
  });

  ipcMain.handle('scopepilot:plan-post-login-actions', async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('ログイン後の事前操作が不正です');
    const value = request as { instruction?: unknown };
    if (typeof value.instruction !== 'string' || value.instruction.trim() === '' || value.instruction.length > 4_000) {
      throw new Error('ログイン後の事前操作は1〜4000文字の自然文で入力してください');
    }
    return await aiAssistant().planBrowserActions(value.instruction);
  });

  ipcMain.handle('scopepilot:plan-interactive-diagnostics', async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('追加診断計画の入力が不正です');
    const value = request as { instruction?: unknown; candidates?: unknown; roles?: unknown };
    if (typeof value.instruction !== 'string' || value.instruction.trim() === '' || value.instruction.length > 8_000) {
      throw new Error('追加診断の指示を1～8000文字の自然文で入力してください');
    }
    if (!Array.isArray(value.roles) || !value.roles.every((role) => typeof role === 'string') || !Array.isArray(value.candidates)) {
      throw new Error('追加診断の候補またはロールが不正です');
    }
    const candidates = value.candidates.map((entry) => {
      if (typeof entry !== 'object' || entry === null) throw new Error('追加診断候補が不正です');
      const candidate = entry as { url?: unknown; method?: unknown; diagnosticTracks?: unknown; inputPoints?: unknown };
      if (typeof candidate.url !== 'string' || typeof candidate.method !== 'string'
        || !Array.isArray(candidate.diagnosticTracks) || !candidate.diagnosticTracks.every((track) => typeof track === 'string')
        || !Array.isArray(candidate.inputPoints)) throw new Error('追加診断候補の形式が不正です');
      const inputPoints = candidate.inputPoints.map((point) => {
        if (typeof point !== 'object' || point === null) throw new Error('追加診断候補の入力点が不正です');
        const item = point as { location?: unknown; name?: unknown };
        if (typeof item.location !== 'string' || typeof item.name !== 'string') throw new Error('追加診断候補の入力点が不正です');
        return { location: item.location, name: item.name };
      });
      return { url: candidate.url, method: candidate.method, diagnosticTracks: candidate.diagnosticTracks as string[], inputPoints };
    });
    return await aiAssistant().planInteractiveDiagnostics({ instruction: value.instruction, candidates, roles: value.roles as string[] });
  });

  ipcMain.handle('scopepilot:select-interactive-input', async (_event, kind: unknown) => {
    if (kind !== 'upload-file' && kind !== 'api-spec') throw new Error('追加診断入力の種別が不正です');
    const result = await showOpenDialog({
      title: kind === 'upload-file' ? 'アップロード診断に使うファイルを選択' : 'OpenAPI JSONを選択',
      buttonLabel: '選択',
      properties: ['openFile'],
      ...(kind === 'api-spec' ? { filters: [{ name: 'OpenAPI JSON', extensions: ['json'] }] } : {}),
    });
    const path = result.filePaths[0];
    if (result.canceled || path === undefined) return null;
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > 10 * 1024 * 1024) throw new Error('追加診断入力は10 MiB以下のファイルにしてください');
    const data = await readFile(path);
    if (kind === 'api-spec') {
      let document: unknown;
      try { document = JSON.parse(data.toString('utf8')) as unknown; } catch { throw new Error('OpenAPI仕様は有効なJSONファイルを選択してください'); }
      return { kind, inputRef: 'api-spec', name: basename(path), document };
    }
    const extension = basename(path).split('.').pop()?.toLocaleLowerCase();
    const mimeType = extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'pdf' ? 'application/pdf' : 'application/octet-stream';
    return { kind, inputRef: 'upload-file', name: basename(path), mimeType, dataBase64: data.toString('base64') };
  });

  ipcMain.handle('scopepilot:generate-ai-report', async (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null) throw new Error('AI報告書の入力が不正です');
    const value = request as { baseContent?: unknown; baseModelHash?: unknown; guidelines?: unknown; findings?: unknown };
    if (typeof value.baseContent !== 'string' || typeof value.baseModelHash !== 'string'
      || !Array.isArray(value.guidelines) || !value.guidelines.every((item) => typeof item === 'string')
      || !Array.isArray(value.findings)) {
      throw new Error('AI報告書の入力形式が不正です');
    }
    const findings = value.findings.filter((entry): entry is AiReportFindingInput => {
      if (typeof entry !== 'object' || entry === null) return false;
      const item = entry as Partial<AiReportFindingInput>;
      return typeof item.findingId === 'string' && typeof item.title === 'string' && typeof item.url === 'string'
        && typeof item.method === 'string' && typeof item.parameter === 'string';
    });
    if (findings.length !== value.findings.length) throw new Error('AI報告書の所見入力形式が不正です');
    return await aiAssistant().draftReport(value.baseContent, value.baseModelHash, value.guidelines, findings);
  });
}

function requireSettingsWindow(event: IpcMainInvokeEvent): BrowserWindow {
  if (settingsWindow === null || event.sender.id !== settingsWindow.webContents.id) {
    throw new Error('この操作は設定ウィンドウからのみ実行できます');
  }
  return settingsWindow;
}

function requireMainWindow(event: IpcMainInvokeEvent): BrowserWindow {
  if (window === null || event.sender.id !== window.webContents.id) {
    throw new Error('この操作はメインウィンドウからのみ実行できます');
  }
  return window;
}

function createSettingsWindow(apiBase: string): void {
  if (settingsWindow !== null) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 820,
    height: 760,
    minWidth: 680,
    minHeight: 620,
    title: 'ScopePilot2 設定',
    ...(window === null ? {} : { parent: window }),
    modal: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--scopepilot-api-base=${apiBase}`],
    },
  });
  settingsWindow.loadFile(join(__dirname, 'index.html'), { query: { window: 'settings' } }).catch((cause: unknown) => {
    console.error('failed to load settings renderer', cause);
  });
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function registerRuntimeSettingsHandlers(
  runtimeSettings: RuntimeSettingsStore,
  aiAuth: AiAuthService,
  aiCatalog: AiCatalogService,
  apiBase: () => string,
): void {
  ipcMain.handle('scopepilot:open-settings', () => createSettingsWindow(apiBase()));
  ipcMain.handle('scopepilot:runtime-settings-get', (event) => {
    requireSettingsWindow(event);
    return runtimeSettings.current();
  });
  ipcMain.handle('scopepilot:runtime-settings-save', async (event, input: unknown) => {
    requireSettingsWindow(event);
    if (typeof input !== 'object' || input === null) throw new Error('設定値の形式が不正です');
    const value = input as Partial<Record<RuntimeToolId, unknown>> & { paths?: Partial<Record<RuntimeToolId, unknown>>; aiLaunchModes?: Partial<Record<AiCliProvider, unknown>> };
    if (typeof value.paths === 'object' && value.paths !== null) Object.assign(value, value.paths);
    if (!RuntimeToolIds.every((id) => typeof value[id] === 'string')) throw new Error('設定値の形式が不正です');
    if (typeof value.paths !== 'object' || value.paths === null
      || !RuntimeToolIds.every((id) => typeof value.paths?.[id] === 'string')
      || typeof value.aiLaunchModes !== 'object' || value.aiLaunchModes === null
      || !AiCliProviders.every((provider) => AiCliLaunchModeValues.includes(value.aiLaunchModes?.[provider] as AiCliLaunchModes[AiCliProvider]))) {
      throw new Error('設定値の形式が不正です');
    }
    return await runtimeSettings.save(value as RuntimeSettingsInput);
  });
  ipcMain.handle('scopepilot:runtime-settings-select-file', async (event, toolId: unknown, currentPath: unknown) => {
    const owner = requireSettingsWindow(event);
    if (!RuntimeToolIds.includes(toolId as RuntimeToolId)) throw new Error('設定項目が不正です');
    const manifest = toolId === 'nucleiTemplateManifest';
    const selected = await dialog.showOpenDialog(owner, {
      title: manifest ? 'Nuclei審査済みテンプレートマニフェストを選択' : '実行ファイルを選択',
      buttonLabel: 'このファイルを使用',
      ...(typeof currentPath === 'string' && currentPath.trim() !== '' ? { defaultPath: dirname(currentPath) } : {}),
      properties: ['openFile'],
      filters: manifest
        ? [{ name: 'ScopePilot Nuclei manifest', extensions: ['json'] }, { name: 'すべてのファイル', extensions: ['*'] }]
        : process.platform === 'win32'
        ? [{ name: '実行可能ファイル', extensions: ['exe', 'cmd', 'bat', 'ps1'] }, { name: 'すべてのファイル', extensions: ['*'] }]
        : [{ name: 'すべてのファイル', extensions: ['*'] }],
    });
    return selected.canceled ? null : selected.filePaths[0] ?? null;
  });
  ipcMain.handle('scopepilot:runtime-settings-close', (event) => {
    requireSettingsWindow(event).close();
  });
  ipcMain.handle('scopepilot:ai-auth-status', async (event) => {
    requireSettingsWindow(event);
    return await aiAuth.statuses();
  });
  ipcMain.handle('scopepilot:ai-auth-login', (event, provider: unknown) => {
    requireSettingsWindow(event);
    if (!AiCliProviders.includes(provider as AiCliProvider)) throw new Error('AIプロバイダーが不正です');
    aiAuth.launchLogin(provider as AiCliProvider);
  });
  ipcMain.handle('scopepilot:ai-catalog-get', async (event) => {
    requireMainWindow(event);
    return await aiCatalog.catalog();
  });
  ipcMain.handle('scopepilot:ai-selection-save', async (event, input: unknown) => {
    requireMainWindow(event);
    if (typeof input !== 'object' || input === null) throw new Error('AI選択値の形式が不正です');
    const value = input as Partial<AppAiSelection>;
    if (!AiCliProviders.includes(value.provider as AiCliProvider) || typeof value.model !== 'string') {
      throw new Error('AI選択値の形式が不正です');
    }
    return await runtimeSettings.saveAiSelection(value as AppAiSelection);
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
  const runtimeSettings = new RuntimeSettingsStore({
    filePath: process.env.SCOPEPILOT_RUNTIME_SETTINGS_FILE?.trim() || join(app.getPath('userData'), 'runtime-tools.json'),
    applicationDirectory: app.getAppPath(),
  });
  const initialRuntimeSettings = await runtimeSettings.load();
  const aiAuth = new AiAuthService({
    paths: () => runtimeSettings.current().paths,
    launchModes: () => runtimeSettings.current().aiLaunchModes,
  });
  const aiCatalog = new AiCatalogService({
    paths: () => runtimeSettings.current().paths,
    launchModes: () => runtimeSettings.current().aiLaunchModes,
    selection: () => runtimeSettings.current().aiSelection,
    auth: aiAuth,
  });
  // 製品起動は常に実 engine。Playwright は案件 scope を送信前に強制し、ZAP は
  // 明示 endpoint またはローカル導入済み daemon を使用する。fixture への fallback はない。
  const engines = await composeEngines({
    ...process.env,
    ...(initialRuntimeSettings.paths.zapExecutable === '' ? {} : { SCOPEPILOT_ZAP_EXECUTABLE: initialRuntimeSettings.paths.zapExecutable }),
    ...(process.env.SCOPEPILOT_DISABLE_NUCLEI === '1' || initialRuntimeSettings.paths.nucleiExecutable === ''
      ? {}
      : { SCOPEPILOT_NUCLEI_EXECUTABLE: initialRuntimeSettings.paths.nucleiExecutable }),
    ...(process.env.SCOPEPILOT_DISABLE_NUCLEI === '1' || initialRuntimeSettings.paths.nucleiTemplateManifest === ''
      ? {}
      : { SCOPEPILOT_NUCLEI_TEMPLATE_MANIFEST: initialRuntimeSettings.paths.nucleiTemplateManifest }),
  });
  closeEngines = () => engines.close();
  const engineOptions = {
    explorer: engines.explorer,
    scanEngine: engines.scanEngine,
    ...(engines.nucleiRunner === undefined ? {} : { nucleiRunner: engines.nucleiRunner }),
    capabilities: engines.capabilities,
    loginExecutor: engines.loginExecutor,
    workflowScanTransportFactory: engines.workflowScanTransportFactory,
    repeaterTransport: engines.repeaterTransport,
    fuzzTransport: engines.fuzzTransport,
    sequencerTransport: engines.sequencerTransport,
    oastProvider: engines.oastProvider,
    webSocketTransport: engines.webSocketTransport,
    advancedTransport: engines.advancedTransport,
    domObserver: engines.domObserver,
    interactiveBrowser: engines.interactiveBrowser,
    ...(engines.otpInbox === undefined ? {} : { otpInbox: engines.otpInbox }),
    ...(engines.samlFixture === undefined ? {} : { samlFixture: engines.samlFixture }),
    runtimeBundleHash: engines.runtimeBundleHash,
  };
  const createProductService = (options: {
    readonly jobStore?: import('@scopepilot2/core').JobStore;
    readonly runSink?: import('@scopepilot2/core').RunSinkPort;
    readonly caseSink?: { save(record: import('@scopepilot2/contracts').CaseRecord): void };
    readonly authorizationSink?: { save(record: import('@scopepilot2/contracts').AuthorizationRecord): void };
    readonly findingSink?: import('@scopepilot2/core').FindingSinkPort;
    readonly initialFindings?: readonly import('@scopepilot2/contracts').Finding[];
    readonly idSeeds?: Readonly<Record<string, number>>;
    readonly evidenceStore?: import('@scopepilot2/core').EvidenceStorePort;
    readonly initialCase?: import('@scopepilot2/contracts').CaseRecord;
    readonly initialAuthorization?: import('@scopepilot2/contracts').AuthorizationRecord;
  } = {}): BaselineFlowService => {
    const service = new BaselineFlowService({
      ...engineOptions,
      clock: new SystemClock(),
      ids: new SequentialIdGenerator(options.idSeeds),
      evidence: options.evidenceStore ?? new InMemoryEvidenceStore(),
      ...(options.jobStore === undefined ? {} : { jobStore: options.jobStore }),
      ...(options.runSink === undefined ? {} : { runSink: options.runSink }),
      ...(options.caseSink === undefined ? {} : { caseSink: options.caseSink }),
      ...(options.authorizationSink === undefined ? {} : { authorizationSink: options.authorizationSink }),
      ...(options.findingSink === undefined ? {} : { findingSink: options.findingSink }),
      ...(options.initialFindings === undefined ? {} : { initialFindings: options.initialFindings }),
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
      if (property === 'updateCaseScope' && typeof member === 'function') {
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
  const workspaceManager = new DesktopWorkspaceManager(engines.recoverHttpExchanges);
  registerDesktopPathHandlers(workspaceManager, runtimeSettings, async (workspace) => {
    const repositories = workspaceManager.repositories();
    if (repositories === null) throw new Error('案件DBを開けませんでした');
    activeRuns = repositories.runs;
    const temporaryOrigins = workspace.existingCase?.scope.allowedOrigins ?? [new URL(workspace.settings.startUrl).origin];
    engines.updateExplorationScope({
      allowedOrigins: temporaryOrigins,
      deniedOrigins: workspace.existingCase?.scope.deniedOrigins ?? [],
    });
    activeService = createProductService({
      jobStore: new SqliteJobStore(repositories.db),
      runSink: repositories.runs,
      caseSink: repositories.cases,
      authorizationSink: repositories.authorizations,
      findingSink: repositories.findings,
      initialFindings: workspace.existingCase === null ? [] : repositories.findings.list(workspace.existingCase.caseId),
      idSeeds: {
        case: Number((repositories.db.prepare("SELECT COUNT(*) AS count FROM cases").get() as { count: number }).count),
        authz: Number((repositories.db.prepare("SELECT COUNT(*) AS count FROM authorizations").get() as { count: number }).count),
        run: Number((repositories.db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count),
        finding: Number((repositories.db.prepare("SELECT COUNT(*) AS count FROM findings").get() as { count: number }).count),
      },
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
  const apiBase = `http://${binding.host}:${binding.port}`;
  registerRuntimeSettingsHandlers(runtimeSettings, aiAuth, aiCatalog, () => apiBase);
  createWindow(apiBase);

  const shutdown = (): void => {
    server.close();
    settingsWindow?.close();
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
