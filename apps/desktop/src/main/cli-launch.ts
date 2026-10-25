import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AiCliLaunchMode } from '../shared/runtime-settings.ts';

export interface CliLaunch {
  readonly executable: string;
  readonly prefix: readonly string[];
}

function findOnPath(fileName: string): string | null {
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(entry.replace(/^"|"$/gu, ''), fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function npmShimLaunch(shimPath: string): CliLaunch | null {
  let source: string;
  try {
    source = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const relativeEntry = /\$basedir[\\/]((?:node_modules)[\\/][^"'`\r\n]+?\.(?:c|m)?js)/iu.exec(source)?.[1];
  if (relativeEntry === undefined) return null;
  const shimDirectory = dirname(shimPath);
  const entryPoint = resolve(shimDirectory, ...relativeEntry.split(/[\\/]/u));
  const fromShim = relative(shimDirectory, entryPoint);
  if (fromShim === '' || fromShim.startsWith('..') || isAbsolute(fromShim) || !existsSync(entryPoint)) return null;
  const bundledNode = join(shimDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
  const nodeExecutable = existsSync(bundledNode)
    ? bundledNode
    : findOnPath(process.platform === 'win32' ? 'node.exe' : 'node');
  if (nodeExecutable === null) return null;
  return { executable: nodeExecutable, prefix: [entryPoint] };
}

function powershellLaunch(scriptPath: string): CliLaunch {
  return {
    executable: 'powershell.exe',
    prefix: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
  };
}

function commandPromptLaunch(scriptPath: string): CliLaunch {
  return { executable: process.env.ComSpec?.trim() || 'cmd.exe', prefix: ['/d', '/s', '/c', scriptPath] };
}

function fileLaunch(path: string): CliLaunch {
  if (process.platform === 'win32' && path.toLowerCase().endsWith('.ps1')) return powershellLaunch(path);
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(path)) return commandPromptLaunch(path);
  return { executable: path, prefix: [] };
}

/** Resolve an AI CLI according to the user-selected execution mode. */
export function resolveCliLaunch(name: string, mode: AiCliLaunchMode | 'auto' = 'auto'): CliLaunch {
  if (process.platform !== 'win32') {
    if (mode === 'node') {
      const launch = npmShimLaunch(name);
      if (launch !== null) return launch;
      throw new Error(`${name} からNode.jsエントリーポイントを特定できません。ファイル実行を選択するか、npmのCLI shimを指定してください。`);
    }
    return fileLaunch(name);
  }

  if (existsSync(name)) {
    const normalized = resolve(name);
    if (mode === 'file') return fileLaunch(normalized);
    if (mode === 'node') {
      const shim = /\.(?:cmd|bat)$/iu.test(normalized) && existsSync(normalized.replace(/\.(?:cmd|bat)$/iu, '.ps1'))
        ? normalized.replace(/\.(?:cmd|bat)$/iu, '.ps1')
        : normalized;
      const launch = npmShimLaunch(shim);
      if (launch !== null) return launch;
      throw new Error(`${normalized} からNode.jsエントリーポイントを特定できません。ファイル実行を選択するか、npmのCLI shimを指定してください。`);
    }
    if (normalized.toLowerCase().endsWith('.ps1')) return npmShimLaunch(normalized) ?? powershellLaunch(normalized);
    if (/\.(?:cmd|bat)$/iu.test(normalized)) {
      const powershellShim = normalized.replace(/\.(?:cmd|bat)$/iu, '.ps1');
      if (existsSync(powershellShim)) return npmShimLaunch(powershellShim) ?? powershellLaunch(powershellShim);
    }
    return fileLaunch(normalized);
  }

  const extensions = mode === 'node' ? ['.ps1', '.cmd'] : ['.exe', '.ps1', '.cmd'];
  for (const extension of extensions) {
    const candidate = findOnPath(`${name}${extension}`);
    if (candidate === null) continue;
    if (mode === 'file') return fileLaunch(candidate);
    if (mode === 'node') {
      const shim = extension === '.cmd' && existsSync(candidate.replace(/\.cmd$/iu, '.ps1'))
        ? candidate.replace(/\.cmd$/iu, '.ps1')
        : candidate;
      const launch = npmShimLaunch(shim);
      if (launch !== null) return launch;
      continue;
    }
    if (extension === '.exe') return fileLaunch(candidate);
    return npmShimLaunch(candidate) ?? fileLaunch(candidate);
  }
  if (mode === 'node') throw new Error(`${name} のnpm CLI shimまたはNode.jsエントリーポイントが見つかりません。`);
  throw new Error(`${name} CLIが見つかりません。インストールと設定を確認してください。`);
}
