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
  saveReport: (request: unknown) => ipcRenderer.invoke('scopepilot:save-report', request),
  analyzeMaterials: () => ipcRenderer.invoke('scopepilot:analyze-materials'),
  generateAiReport: (request: unknown) => ipcRenderer.invoke('scopepilot:generate-ai-report', request),
  openSelectedPath: (path: string) => ipcRenderer.invoke('scopepilot:open-selected-path', path),
});
