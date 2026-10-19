/**
 * preload。renderer へは apiBase 参照だけを橋渡しする (秘密値 bridge の範囲を最小化)。
 */
import { contextBridge } from 'electron';

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
});
