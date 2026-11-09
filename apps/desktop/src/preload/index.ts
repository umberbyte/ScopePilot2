/**
 * preload。renderer へは apiBase 参照だけを橋渡しする (秘密値 bridge の範囲を最小化)。
 */
import { contextBridge, ipcRenderer } from 'electron';

function apiBaseFromArgv(): string {
  const marker = '--scopepilot-api-base=';
  const arg = process.argv.find((entry) => entry.startsWith(marker));
  if (arg === undefined) {
    throw new Error('scopepilot api base argument is missing');
  }
  return arg.slice(marker.length);
}

contextBridge.exposeInMainWorld('scopepilotDesktop', {
  apiBase: apiBaseFromArgv(),
  selectCaseDirectory: (mode: 'create' | 'open') => ipcRenderer.invoke('scopepilot:select-case-directory', mode),
  selectMaterialFiles: () => ipcRenderer.invoke('scopepilot:select-material-files'),
  activateCaseWorkspace: (request: unknown) => ipcRenderer.invoke('scopepilot:activate-case-workspace', request),
  saveCaseWorkspaceSettings: (request: unknown) => ipcRenderer.invoke('scopepilot:save-case-workspace-settings', request),
  removeCaseInput: (inputId: string) => ipcRenderer.invoke('scopepilot:remove-case-input', inputId),
  importCaseInputs: (materialPaths: readonly string[]) => ipcRenderer.invoke('scopepilot:import-case-inputs', materialPaths),
  saveReport: (request: unknown) => ipcRenderer.invoke('scopepilot:save-report', request),
  analyzeMaterials: () => ipcRenderer.invoke('scopepilot:analyze-materials'),
  inferLoginForm: (request: unknown) => ipcRenderer.invoke('scopepilot:infer-login-form', request),
  planPostLoginActions: (request: unknown) => ipcRenderer.invoke('scopepilot:plan-post-login-actions', request),
  planInteractiveDiagnostics: (request: unknown) => ipcRenderer.invoke('scopepilot:plan-interactive-diagnostics', request),
  selectInteractiveInput: (kind: 'upload-file' | 'api-spec') => ipcRenderer.invoke('scopepilot:select-interactive-input', kind),
  generateAiReport: (request: unknown) => ipcRenderer.invoke('scopepilot:generate-ai-report', request),
  openSelectedPath: (path: string) => ipcRenderer.invoke('scopepilot:open-selected-path', path),
  openSettings: () => ipcRenderer.invoke('scopepilot:open-settings'),
  testRuntimeConnections: () => ipcRenderer.invoke('scopepilot:runtime-settings-test'),
  getRuntimeSettings: () => ipcRenderer.invoke('scopepilot:runtime-settings-get'),
  saveRuntimeSettings: (settings: unknown) => ipcRenderer.invoke('scopepilot:runtime-settings-save', settings),
  selectRuntimeToolFile: (toolId: string, currentPath: string) => ipcRenderer.invoke('scopepilot:runtime-settings-select-file', toolId, currentPath),
  getAiAuthStatuses: () => ipcRenderer.invoke('scopepilot:ai-auth-status'),
  launchAiLogin: (provider: string) => ipcRenderer.invoke('scopepilot:ai-auth-login', provider),
  getAiCatalog: () => ipcRenderer.invoke('scopepilot:ai-catalog-get'),
  saveAiSelection: (selection: unknown) => ipcRenderer.invoke('scopepilot:ai-selection-save', selection),
  closeSettings: () => ipcRenderer.invoke('scopepilot:runtime-settings-close'),
});
