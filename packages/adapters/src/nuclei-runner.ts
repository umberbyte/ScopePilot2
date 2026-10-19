/**
 * Nuclei CLI runner。`docs/detailed-design/f18-known-vulnerabilities-nuclei.md`。
 * 外部バイナリ (nuclei) を起動し、JSONL 出力を core の取込 (importNucleiResults) に
 * 渡す行集合として返す。ダウンロードは行わない (design/21 の版管理・実行環境による用意)。
 *
 * 秘密値を引数に置かない (F21-UT-007)。対象は temp file 経由で渡す
 * (コマンドライン長・argv に多数の URL を並べないため)。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface NucleiRunnerOptions {
  /** nuclei binary の path。既定 'nuclei' (PATH 上)。 */
  readonly command?: string;
  /** binary が解釈に必要な固定引数 (例: node で stub を動かす場合の script path)。 */
  readonly argsPrefix?: readonly string[];
  /** severity 絞り込み (nuclei -severity に渡す)。 */
  readonly severity?: string;
  /** 1 実行の timeout (ms)。 */
  readonly timeoutMs?: number;
}

export interface NucleiRunResult {
  readonly engineVersion: string;
  /** nuclei の JSONL 出力 (1行1 match)。core の importNucleiResults へそのまま渡す。 */
  readonly lines: readonly string[];
}

export class NucleiRunner {
  private readonly command: string;
  private readonly argsPrefix: readonly string[];
  private readonly severity: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: NucleiRunnerOptions = {}) {
    this.command = options.command ?? 'nuclei';
    this.argsPrefix = options.argsPrefix ?? [];
    this.severity = options.severity;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
  }

  private async exec(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      // stdin は ignore で閉じる: 開いたままの stdin pipe を nuclei が待ち続け、
      // 実機 (v3.11.1) で完了しないことを確認済み (execFile の stdin pipe で hang)。
      const child = spawn(this.command, [...this.argsPrefix, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.timeoutMs,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          child.kill();
        }
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          child.kill();
        }
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const suffix = signal === null ? '' : ` (signal ${signal})`;
        reject(new Error(`nuclei exited with code ${code === null ? 'unknown' : String(code)}${suffix}`));
      });
    });
  }

  /** nuclei -version の出力から版を取り出す (v3 は Engine Version、v2 は Current Version)。 */
  async version(): Promise<string> {
    const { stderr, stdout } = await this.exec(['-version']);
    const match = /(?:Engine Version|Current Version):\s*(\S+)/i.exec(`${stderr}\n${stdout}`);
    return match === null ? 'nuclei (version unknown)' : `nuclei ${match[1] ?? ''}`.trim();
  }

  /** 対象へ nuclei を実行し、JSONL 行を返す。 */
  async run(input: { readonly targets: readonly string[] }): Promise<NucleiRunResult> {
    if (input.targets.length === 0) {
      throw new Error('nuclei run requires at least one target');
    }
    const workdir = await mkdtemp(join(tmpdir(), 'scopepilot2-nuclei-'));
    try {
      const targetFile = join(workdir, 'targets.txt');
      await writeFile(targetFile, `${input.targets.join('\n')}\n`, 'utf8');
      const args = ['-jsonl', '-silent', '-l', targetFile];
      if (this.severity !== undefined) {
        args.push('-severity', this.severity);
      }
      const { stdout } = await this.exec(args);
      const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      return { engineVersion: await this.version(), lines };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}
