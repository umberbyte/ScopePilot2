import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { AiCliAuthStatus, AiCliLaunchMode, AiCliLaunchModes, AiCliProvider, RuntimeToolPaths } from '../shared/runtime-settings.ts';
import { resolveCliLaunch } from './cli-launch.ts';

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AuthCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly launchMode?: AiCliLaunchMode;
}

export type AuthCommandRunner = (command: AuthCommand) => Promise<CommandResult>;
export type InteractiveLoginLauncher = (provider: AiCliProvider, executable: string, launchMode: AiCliLaunchMode) => void;

const TOOL_PATH: Readonly<Record<AiCliProvider, keyof RuntimeToolPaths>> = {
  zcode: 'zcodeCli',
  codex: 'codexCli',
  claude: 'claudeCli',
};

function boundedAppend(chunks: Buffer[], chunk: Buffer, limit: number): void {
  const used = chunks.reduce((sum, value) => sum + value.length, 0);
  if (used < limit) chunks.push(chunk.subarray(0, limit - used));
}

export const runAuthCommand: AuthCommandRunner = async (command) => await new Promise<CommandResult>((resolveResult) => {
  let launch: ReturnType<typeof resolveCliLaunch>;
  try {
    launch = resolveCliLaunch(command.executable, command.launchMode ?? 'auto');
  } catch (cause) {
    resolveResult({ exitCode: null, stdout: '', stderr: String(cause) });
    return;
  }
  const child = spawn(launch.executable, [...launch.prefix, ...command.args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settled = false;
  const finish = (result: CommandResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveResult(result);
  };
  const timer = setTimeout(() => {
    child.kill();
    finish({ exitCode: null, stdout: '', stderr: 'status check timed out' });
  }, 10_000);
  child.stdout.on('data', (chunk: Buffer) => boundedAppend(stdout, chunk, 2 * 1024 * 1024));
  child.stderr.on('data', (chunk: Buffer) => boundedAppend(stderr, chunk, 256 * 1024));
  child.once('error', (cause) => finish({ exitCode: null, stdout: '', stderr: String(cause) }));
  child.once('close', (exitCode) => finish({
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }));
});

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export const launchInteractiveLogin: InteractiveLoginLauncher = (provider, executable, launchMode) => {
  if (process.platform !== 'win32') {
    throw new Error('対話ログイン用シェルは現在Windowsでのみ利用できます');
  }
  const args: Readonly<Record<AiCliProvider, readonly string[]>> = {
    zcode: ['login'],
    codex: ['login'],
    claude: ['auth', 'login'],
  };
  const labels: Readonly<Record<AiCliProvider, string>> = { zcode: 'ZCode', codex: 'Codex', claude: 'Claude' };
  const launch = resolveCliLaunch(executable, launchMode);
  const interactivePrefix = launch.prefix.filter((argument) => argument !== '-NonInteractive');
  const invocation = `& ${powershellLiteral(launch.executable)} ${[...interactivePrefix, ...args[provider]].map(powershellLiteral).join(' ')}`;
  const script = [
    `$Host.UI.RawUI.WindowTitle = ${powershellLiteral(`ScopePilot2 - ${labels[provider]} ログイン`)}`,
    'try { $Host.UI.RawUI.WindowSize = New-Object System.Management.Automation.Host.Size(108, 30) } catch {}',
    'Clear-Host',
    `Write-Host ${powershellLiteral(`${labels[provider]} CLIを起動します。画面の案内に従ってログインしてください。`)} -ForegroundColor Cyan`,
    `Write-Host ${powershellLiteral('完了後、このウィンドウを閉じてScopePilot2の「状態を再確認」を押してください。')}`,
    "Write-Host ''",
    invocation,
    "Write-Host ''",
    `Write-Host ${powershellLiteral('CLIが終了しました。このウィンドウは閉じて構いません。')} -ForegroundColor Green`,
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-EncodedCommand', encoded,
  ], { detached: true, windowsHide: false, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
};

function zcodeCredentialsPath(): string {
  const explicit = process.env.ZCODE_CLI_CREDENTIALS_FILE?.trim();
  if (explicit) return explicit;
  const base = process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  return join(base, '.zcode', 'v2', 'credentials.json');
}

function hasNonEmptyCredential(record: Record<string, unknown>): boolean {
  return Object.entries(record).some(([key, value]) =>
    /(?:access_token|zcodejwttoken|:api-key)$/iu.test(key)
    && typeof value === 'string'
    && value.trim() !== '');
}

export interface AiAuthServiceOptions {
  readonly paths: () => RuntimeToolPaths;
  readonly launchModes: () => AiCliLaunchModes;
  readonly runner?: AuthCommandRunner;
  readonly loginLauncher?: InteractiveLoginLauncher;
  readonly zcodeCredentialsFile?: string;
  readonly now?: () => Date;
}

export class AiAuthService {
  private readonly options: AiAuthServiceOptions;

  constructor(options: AiAuthServiceOptions) {
    this.options = options;
  }

  async statuses(): Promise<readonly AiCliAuthStatus[]> {
    return await Promise.all((['zcode', 'codex', 'claude'] as const).map(async (provider) => await this.status(provider)));
  }

  launchLogin(provider: AiCliProvider): void {
    const executable = this.options.paths()[TOOL_PATH[provider]];
    if (executable === '' || !isAbsolute(executable) || !existsSync(executable)) {
      throw new Error(`${provider} CLIの有効なパスを先に保存してください`);
    }
    (this.options.loginLauncher ?? launchInteractiveLogin)(provider, executable, this.options.launchModes()[provider]);
  }

  private result(provider: AiCliProvider, state: AiCliAuthStatus['state'], detail: string): AiCliAuthStatus {
    return { provider, state, detail, checkedAt: (this.options.now ?? (() => new Date()))().toISOString() };
  }

  private async status(provider: AiCliProvider): Promise<AiCliAuthStatus> {
    const executable = this.options.paths()[TOOL_PATH[provider]];
    if (executable === '' || !isAbsolute(executable) || !existsSync(executable)) {
      return this.result(provider, 'unavailable', 'CLIの実行パスが未設定または無効です');
    }
    if (provider === 'zcode') return await this.zcodeStatus();
    const runner = this.options.runner ?? runAuthCommand;
    if (provider === 'codex') {
      const status = await runner({ executable, args: ['login', 'status'], launchMode: this.options.launchModes()[provider] });
      const output = `${status.stdout}\n${status.stderr}`;
      if (status.exitCode === 0 && /logged in/iu.test(output) && !/not logged in/iu.test(output)) {
        return this.result(provider, 'authenticated', 'ログイン済み');
      }
      if (/not logged in|login required|not authenticated/iu.test(output)) {
        return this.result(provider, 'unauthenticated', 'ログインしていません');
      }
      return this.result(provider, 'unknown', 'CLIからログイン状態を取得できませんでした');
    }
    const status = await runner({ executable, args: ['auth', 'status', '--json'], launchMode: this.options.launchModes()[provider] });
    try {
      const parsed = JSON.parse(status.stdout) as { loggedIn?: unknown; authMethod?: unknown };
      if (parsed.loggedIn === true) {
        const method = typeof parsed.authMethod === 'string' && parsed.authMethod.trim() !== '' ? `（${parsed.authMethod}）` : '';
        return this.result(provider, 'authenticated', `ログイン済み${method}`);
      }
      if (parsed.loggedIn === false) return this.result(provider, 'unauthenticated', 'ログインしていません');
    } catch { /* stderrや個人情報をrendererへ渡さない */ }
    return this.result(provider, 'unknown', 'CLIからログイン状態を取得できませんでした');
  }

  private async zcodeStatus(): Promise<AiCliAuthStatus> {
    try {
      const parsed = JSON.parse(await readFile(this.options.zcodeCredentialsFile ?? zcodeCredentialsPath(), 'utf8')) as unknown;
      if (typeof parsed === 'object' && parsed !== null && hasNonEmptyCredential(parsed as Record<string, unknown>)) {
        return this.result('zcode', 'authenticated', '認証情報あり（有効性は実行時に確認）');
      }
      return this.result('zcode', 'unauthenticated', 'ログインしていません');
    } catch {
      return this.result('zcode', 'unauthenticated', 'ログインしていません');
    }
  }
}
