/**
 * Nuclei CLI runner。`docs/detailed-design/f18-known-vulnerabilities-nuclei.md`。
 * 外部バイナリ (nuclei) を起動し、JSONL 出力を core の取込 (importNucleiResults) に
 * 渡す行集合として返す。ダウンロードは行わない (design/21 の版管理・実行環境による用意)。
 *
 * 秘密値を引数に置かない (F21-UT-007)。対象は temp file 経由で渡す
 * (コマンドライン長・argv に多数の URL を並べないため)。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

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
  /** ScopePilot reviewed-template manifest. Without it, scan execution is unavailable. */
  readonly templateManifestPath?: string;
}

interface ReviewedTemplateManifest {
  readonly schemaVersion: 'scopepilot2.nuclei-template-bundle.v1';
  readonly templates: readonly {
    readonly id: string;
    readonly path: string;
    readonly sha256: string;
    readonly protocol: 'http';
  }[];
}

const MAX_TEMPLATE_COUNT = 1_000;
const MAX_TEMPLATE_BYTES = 512 * 1024;
const FORBIDDEN_EXECUTION_KEY = /^(?:code|javascript|headless|dns|network|file|ssl|websocket|flow|workflow|workflows)\s*:/imu;

export interface NucleiRunResult {
  readonly engineVersion: string;
  readonly templateBundleHash: string;
  /** nuclei の JSONL 出力 (1行1 match)。core の importNucleiResults へそのまま渡す。 */
  readonly lines: readonly string[];
}

export class NucleiRunner {
  private readonly command: string;
  private readonly argsPrefix: readonly string[];
  private readonly severity: string | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly templateManifestPath: string | undefined;

  constructor(options: NucleiRunnerOptions = {}) {
    this.command = options.command ?? 'nuclei';
    this.argsPrefix = options.argsPrefix ?? [];
    this.severity = options.severity;
    this.timeoutMs = options.timeoutMs;
    this.templateManifestPath = options.templateManifestPath;
  }

  private async stageReviewedTemplates(workdir: string, templateIds?: readonly string[]): Promise<{ readonly directory: string; readonly count: number; readonly bundleHash: string }> {
    if (this.templateManifestPath === undefined || this.templateManifestPath.trim() === '') {
      throw new Error('nuclei reviewed template manifest is not configured');
    }
    const manifestPath = resolve(this.templateManifestPath);
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<ReviewedTemplateManifest>;
    if (parsed.schemaVersion !== 'scopepilot2.nuclei-template-bundle.v1' || !Array.isArray(parsed.templates)) {
      throw new Error('nuclei template manifest schema is invalid');
    }
    if (parsed.templates.length === 0 || parsed.templates.length > MAX_TEMPLATE_COUNT) {
      throw new Error(`nuclei template manifest must contain 1..${String(MAX_TEMPLATE_COUNT)} templates`);
    }
    const manifestDirectory = dirname(manifestPath);
    const stagedDirectory = join(workdir, 'reviewed-http-templates');
    await mkdir(stagedDirectory, { recursive: true });
    const spotIds = templateIds === undefined ? undefined : new Set(templateIds);
    if (spotIds !== undefined) {
      const known = new Set(parsed.templates.map((entry) => (typeof entry?.id === 'string' ? entry.id : '')));
      const unknown = [...spotIds].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new Error(`nuclei spot template ids not in the reviewed manifest: ${unknown.join(', ')}`);
      }
    }
    const seenIds = new Set<string>();
    const pinnedEntries: { readonly id: string; readonly sha256: string }[] = [];
    const entries = parsed.templates.filter((entry) => spotIds === undefined || spotIds.has(typeof entry?.id === 'string' ? entry.id : ''));
    for (const [index, entry] of entries.entries()) {
      if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string' || entry.id.trim() === ''
        || typeof entry.path !== 'string' || entry.path.trim() === '' || typeof entry.sha256 !== 'string'
        || entry.protocol !== 'http' || isAbsolute(entry.path)) {
        throw new Error(`nuclei template manifest entry ${String(index + 1)} is invalid`);
      }
      if (seenIds.has(entry.id)) throw new Error(`duplicate nuclei template id: ${entry.id}`);
      seenIds.add(entry.id);
      const sourcePath = resolve(manifestDirectory, entry.path);
      const outside = relative(manifestDirectory, sourcePath);
      if (outside.startsWith('..') || isAbsolute(outside)) throw new Error(`nuclei template path escapes the manifest directory: ${entry.path}`);
      const content = await readFile(sourcePath);
      if (content.byteLength === 0 || content.byteLength > MAX_TEMPLATE_BYTES) {
        throw new Error(`nuclei template ${entry.id} exceeds the allowed size`);
      }
      const actualHash = createHash('sha256').update(content).digest('hex');
      if (actualHash.toLowerCase() !== entry.sha256.trim().toLowerCase()) {
        throw new Error(`nuclei template hash mismatch: ${entry.id}`);
      }
      pinnedEntries.push({ id: entry.id, sha256: actualHash });
      const source = content.toString('utf8');
      if (FORBIDDEN_EXECUTION_KEY.test(source) || !/^http\s*:/mu.test(source)) {
        throw new Error(`nuclei template ${entry.id} is not HTTP-only`);
      }
      const safeName = entry.id.replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
      await writeFile(join(stagedDirectory, `${String(index).padStart(4, '0')}-${safeName}.yaml`), content);
    }
    const bundleHash = createHash('sha256').update(JSON.stringify(pinnedEntries), 'utf8').digest('hex');
    return { directory: stagedDirectory, count: parsed.templates.length, bundleHash };
  }

  async verifyTemplateBundle(): Promise<{ readonly templateCount: number; readonly bundleHash: string }> {
    const workdir = await mkdtemp(join(tmpdir(), 'scopepilot2-nuclei-verify-'));
    try {
      const verified = await this.stageReviewedTemplates(workdir);
      return { templateCount: verified.count, bundleHash: verified.bundleHash };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }

  private async exec(
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    onLog?: (line: string) => void,
    maxRequests?: number,
  ): Promise<{ stdout: string; stderr: string; projectedRequests: number }> {
    return await new Promise((resolve, reject) => {
      // stdin は ignore で閉じる: 開いたままの stdin pipe を nuclei が待ち続け、
      // 実機 (v3.11.1) で完了しないことを確認済み (execFile の stdin pipe で hang)。
      const child = spawn(this.command, [...this.argsPrefix, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(signal === undefined ? {} : { signal }),
      });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let stdoutPending = '';
      let stderrPending = '';
      let timedOut = false;
      let outputExceeded = false;
      let requestLimitExceeded: number | undefined;
      let projectedRequests = 0;
      const timer = setTimeout(() => {
        timedOut = true;
        onLog?.(`scopepilot: confirmed execution time limit reached (${(timeoutMs / 60_000).toFixed(1)} minutes); stopping nuclei`);
        child.kill();
      }, timeoutMs);
      const publishLines = (pending: string, source: 'stdout' | 'stderr'): string => {
        const parts = pending.split(/\r\n|\r|\n/);
        const remainder = parts.pop() ?? '';
        for (const line of parts) {
          const normalized = line.trim();
          if (normalized !== '') {
            onLog?.(`${source}: ${normalized}`);
            const requestCount = /Requests:\s*[\d,]+\s*\/\s*([\d,]+)/i.exec(normalized)
              ?? /(?:Total Requests|Requests Total):\s*([\d,]+)/i.exec(normalized);
            const projected = requestCount === null
              ? undefined
              : Number.parseInt((requestCount[1] ?? '').replaceAll(',', ''), 10);
            if (projected !== undefined && Number.isFinite(projected)) {
              projectedRequests = Math.max(projectedRequests, projected);
            }
            if (maxRequests !== undefined && projected !== undefined && projected > maxRequests && requestLimitExceeded === undefined) {
              requestLimitExceeded = projected;
              onLog?.(`scopepilot: nuclei projected ${String(projected)} requests, exceeding the confirmed limit ${String(maxRequests)}; stopping nuclei`);
              child.kill();
            }
          }
        }
        return remainder;
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        stdoutPending = publishLines(stdoutPending + chunk, 'stdout');
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES && !outputExceeded) {
          outputExceeded = true;
          child.kill();
        }
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        stderrPending = publishLines(stderrPending + chunk, 'stderr');
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES && !outputExceeded) {
          outputExceeded = true;
          child.kill();
        }
      });
      child.on('error', (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (stdoutPending.trim() !== '') onLog?.(`stdout: ${stdoutPending.trim()}`);
        if (stderrPending.trim() !== '') onLog?.(`stderr: ${stderrPending.trim()}`);
        if (code === 0) {
          resolve({ stdout, stderr, projectedRequests });
          return;
        }
        if (timedOut) {
          reject(new Error(`nuclei exceeded execution time limit (${(timeoutMs / 60_000).toFixed(1)} minutes)`));
          return;
        }
        if (outputExceeded) {
          reject(new Error(`nuclei console output exceeded ${String(MAX_OUTPUT_BYTES)} bytes`));
          return;
        }
        if (requestLimitExceeded !== undefined) {
          reject(new Error(`nuclei projected request count ${String(requestLimitExceeded)} exceeds confirmed limit ${String(maxRequests)}`));
          return;
        }
        const suffix = signal === null ? '' : ` (signal ${signal})`;
        reject(new Error(`nuclei exited with code ${code === null ? 'unknown' : String(code)}${suffix}`));
      });
    });
  }

  /** nuclei -version の出力から版を取り出す (v3 は Engine Version、v2 は Current Version)。 */
  async version(): Promise<string> {
    const { stderr, stdout } = await this.exec(['-version'], 10_000);
    const match = /(?:Engine Version|Current Version):\s*(\S+)/i.exec(`${stderr}\n${stdout}`);
    return match === null ? 'nuclei (version unknown)' : `nuclei ${match[1] ?? ''}`.trim();
  }

  /** 対象へ nuclei を実行し、JSONL 行を返す。 */
  async run(input: {
    readonly targets: readonly string[];
    readonly limits?: {
      readonly maxRequests: number;
      readonly maxDurationMinutes: number;
      readonly maxConcurrency: number;
      readonly requestsPerSecond: number;
    };
    readonly signal?: AbortSignal;
    readonly onLog?: (line: string) => void;
    readonly templateIds?: readonly string[];
  }): Promise<NucleiRunResult> {
    if (input.targets.length === 0) {
      throw new Error('nuclei run requires at least one target');
    }
    const workdir = await mkdtemp(join(tmpdir(), 'scopepilot2-nuclei-'));
    try {
      const targetFile = join(workdir, 'targets.txt');
      await writeFile(targetFile, `${input.targets.join('\n')}\n`, 'utf8');
      const templates = await this.stageReviewedTemplates(workdir, input.templateIds);
      const totalTimeoutMs = input.limits === undefined
        ? (this.timeoutMs ?? 15 * 60_000)
        : this.timeoutMs === undefined
          ? input.limits.maxDurationMinutes * 60_000
          : Math.min(this.timeoutMs, input.limits.maxDurationMinutes * 60_000);
      const deadline = Date.now() + totalTimeoutMs;
      if (input.signal?.aborted === true) {
        throw new Error('nuclei scan aborted');
      }
      const remainingTimeoutMs = deadline - Date.now();
      const resultFile = join(workdir, 'http-findings.jsonl');
      const args = [
        '-no-color', '-disable-update-check', '-no-interactsh', '-no-stdin',
        '-include-rr',
        '-type', 'http',
        '-t', templates.directory,
        '-exclude-tags', 'dos,fuzz,intrusive,bruteforce,headless,code,network,file,dns,oast',
        '-severity', this.severity ?? 'medium,high,critical',
        '-stats', '-stats-interval', '2',
        '-jsonl-export', resultFile,
        '-l', targetFile,
      ];
      if (input.limits !== undefined) {
        args.push('-rate-limit', String(Math.max(1, Math.floor(input.limits.requestsPerSecond))));
        args.push('-concurrency', String(Math.max(1, Math.floor(input.limits.maxConcurrency))));
        args.push('-max-time', `${String(Math.max(1, Math.ceil(remainingTimeoutMs / 60_000)))}m`);
      }
      input.onLog?.(`scopepilot: starting nuclei reviewed HTTP profile (${String(templates.count)} templates, ${String(input.targets.length)} targets)`);
      if (input.templateIds !== undefined) {
        input.onLog?.(`scopepilot: spot execution limited to reviewed templates: ${input.templateIds.join(', ')}`);
      }
      await this.exec(args, remainingTimeoutMs, input.signal, (line) => input.onLog?.(`[http] ${line}`), input.limits?.maxRequests);
      const output = await readFile(resultFile, 'utf8').catch((cause: unknown) => {
        if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return '';
        throw cause;
      });
      const lines = output.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      return { engineVersion: await this.version(), templateBundleHash: templates.bundleHash, lines };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}
