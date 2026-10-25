/**
 * self-host Interactsh CLI adapter (design/f13)。公式 client を外部 runtime として
 * 起動し、payload 発行と background poll の JSONL callback を core へ渡す。
 * 認証情報は CLI argv に置かず、利用者が管理する config file を参照する。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { OastProviderEvent, OastProviderPort } from '@scopepilot2/core';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export interface InteractshCliProviderOptions {
  /** 利用者・組織が管理する Interactsh server。公開既定値は持たない。 */
  readonly serverUrl: string;
  /** auth token 等を保持する interactsh-client config file。値自体は argv に出さない。 */
  readonly configPath: string;
  /** 既定は PATH 上の公式 interactsh-client。 */
  readonly command?: string;
  /** stub test 等で command の前に置く固定引数。 */
  readonly argsPrefix?: readonly string[];
  readonly pollIntervalSeconds?: number;
  readonly startupTimeoutMs?: number;
}

interface RunningSession {
  readonly child: ChildProcess;
}

function normalizedServerUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') {
    throw new Error('Interactsh server URL must use https');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('Interactsh server URL must not contain credentials, query, or fragment');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('Interactsh server URL must be an origin without a path');
  }
  return parsed.origin;
}

function payloadFromLine(line: string): string | null {
  if (line.startsWith('{')) {
    return null;
  }
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
  const match = /(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\.?$/i.exec(plain);
  return match?.[1]?.toLowerCase() ?? null;
}

function eventFromLine(line: string, token: string): OastProviderEvent | null {
  if (!line.startsWith('{')) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const protocol = (parsed as Record<string, unknown>).protocol;
    if (protocol !== 'dns' && protocol !== 'http' && protocol !== 'https' && protocol !== 'smtp') {
      return null;
    }
    const digest = createHash('sha256').update(line).digest('hex');
    return { eventId: `interactsh-${digest}`, token, payload: line };
  } catch {
    return null;
  }
}

export class InteractshCliProvider implements OastProviderPort {
  readonly supportedProtocols = ['http', 'dns', 'smtp'] as const;
  private readonly serverUrl: string;
  private readonly configPath: string;
  private readonly command: string;
  private readonly argsPrefix: readonly string[];
  private readonly pollIntervalSeconds: number;
  private readonly startupTimeoutMs: number;
  private readonly sessions = new Map<string, RunningSession>();

  constructor(options: InteractshCliProviderOptions) {
    this.serverUrl = normalizedServerUrl(options.serverUrl);
    this.configPath = options.configPath.trim();
    if (this.configPath === '') {
      throw new Error('Interactsh configPath is required');
    }
    this.command = options.command ?? 'interactsh-client';
    this.argsPrefix = options.argsPrefix ?? [];
    this.pollIntervalSeconds = options.pollIntervalSeconds ?? 60;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    if (!Number.isInteger(this.pollIntervalSeconds) || this.pollIntervalSeconds < 10 || this.pollIntervalSeconds > 21_600) {
      throw new Error('Interactsh poll interval must be an integer between 10 and 21600 seconds');
    }
  }

  async startSession(input: Parameters<OastProviderPort['startSession']>[0]): Promise<{ readonly token: string }> {
    if (this.sessions.has(input.attemptId)) {
      throw new Error(`Interactsh session already exists for ${input.attemptId}`);
    }
    const args = [
      ...this.argsPrefix,
      '-server', this.serverUrl,
      '-config', this.configPath,
      '-poll-interval', String(this.pollIntervalSeconds),
      '-number', '1',
      '-json',
      '-silent',
    ];
    const child = spawn(this.command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.sessions.set(input.attemptId, { child });

    return await new Promise<{ readonly token: string }>((resolve, reject) => {
      let settled = false;
      let token: string | null = null;
      let stdoutBuffer = '';
      let stderr = '';
      const rejectStartup = (cause: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.sessions.delete(input.attemptId);
        child.kill();
        reject(cause);
      };
      const dispatch = (event: OastProviderEvent): void => {
        queueMicrotask(() => {
          try {
            input.onEvents([event]);
          } catch {
            // provider process remains alive; core owns validation/audit policy for callbacks.
          }
        });
      };
      const consumeLine = (rawLine: string): void => {
        const line = rawLine.trim();
        if (line === '') {
          return;
        }
        if (token === null) {
          const issued = payloadFromLine(line);
          if (issued !== null) {
            token = issued;
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve({ token: issued });
            }
          }
          return;
        }
        const event = eventFromLine(line, token);
        if (event !== null) {
          dispatch(event);
        }
      };
      const timer = setTimeout(() => {
        rejectStartup(new Error(`Interactsh client did not issue a payload within ${this.startupTimeoutMs}ms`));
      }, this.startupTimeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_LINE_BYTES) {
          rejectStartup(new Error(`Interactsh client output line exceeds ${MAX_LINE_BYTES} bytes`));
          return;
        }
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          consumeLine(line);
        }
      });
      child.stderr.on('data', (chunk: string) => {
        if (Buffer.byteLength(stderr, 'utf8') < MAX_STDERR_BYTES) {
          stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
        }
      });
      child.once('error', (cause) => rejectStartup(cause));
      child.once('close', (code, signal) => {
        this.sessions.delete(input.attemptId);
        if (!settled) {
          const detail = stderr.trim() === '' ? '' : `: ${stderr.trim()}`;
          rejectStartup(new Error(`Interactsh client exited before payload (code ${String(code)}, signal ${String(signal)})${detail}`));
        }
      });
    });
  }

  async close(): Promise<void> {
    const children = [...this.sessions.values()].map((session) => session.child);
    this.sessions.clear();
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill();
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref();
        }),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }));
  }
}
