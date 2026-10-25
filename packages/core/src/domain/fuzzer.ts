/**
 * Fuzzer の計画・実行制御。`docs/detailed-design/f05-intruder-fuzzer.md` §4。
 * 初期既定は concurrency 1、2 RPS、window/lease 25、checkpoint 100 (D-05)。
 * 組合せは materialize せず index で生成する。
 */
import { domainError } from '@scopepilot2/contracts';

export interface FuzzPosition {
  readonly name: string;
  readonly values: readonly string[];
}

export const FUZZ_DEFAULTS = {
  concurrency: 1,
  requestsPerSecond: 2,
  leaseWindow: 25,
  checkpointSize: 100,
} as const;

/** 組合せ総数が plan 上限を超えたら送信前に拒否する (F05-UT-001)。 */
export function planCombinations(positions: readonly FuzzPosition[], maxRequests: number): { total: number } {
  let total = 1;
  const names = new Set<string>();
  for (const position of positions) {
    const name = position.name.trim();
    if (name === '') {
      throw domainError('ValidationFailed', 'fuzz position name is required');
    }
    if (names.has(name)) {
      throw domainError('ValidationFailed', `duplicate fuzz position name: ${name}`);
    }
    names.add(name);
    if (position.values.length === 0) {
      throw domainError('ValidationFailed', `fuzz position ${position.name} has no values`);
    }
    total *= position.values.length;
    if (total > maxRequests) {
      throw domainError('ValidationFailed', `combination count ${total} exceeds plan limit ${maxRequests}`, {
        details: { positions: positions.length, maxRequests },
      });
    }
  }
  return { total };
}

/** mixed-radix index から1組合せだけを生成する (全体を materialize しない)。 */
export function combinationAt(positions: readonly FuzzPosition[], index: number): readonly string[] {
  let remainder = index;
  const chosen: string[] = [];
  for (let i = positions.length - 1; i >= 0; i -= 1) {
    const position = positions[i];
    if (position === undefined) {
      continue;
    }
    const size = position.values.length;
    chosen.unshift(position.values[remainder % size] ?? '');
    remainder = Math.floor(remainder / size);
  }
  return chosen;
}

/** 仮想時計向け token bucket。2 RPS 既定で送信間隔を強制する (F05-UT-002)。 */
export class RateGovernor {
  readonly requestsPerSecond: number;
  private nextAvailableMs: number;

  constructor(requestsPerSecond: number = FUZZ_DEFAULTS.requestsPerSecond) {
    this.requestsPerSecond = requestsPerSecond;
    this.nextAvailableMs = Number.NEGATIVE_INFINITY;
  }

  /** 時刻 nowMs で送信するために必要な待機 ms。acquire=true なら token を消費する。 */
  tryAcquire(nowMs: number, acquire = true): number {
    const intervalMs = 1000 / this.requestsPerSecond;
    const waitMs = Math.max(0, this.nextAvailableMs - nowMs);
    if (acquire) {
      this.nextAvailableMs = Math.max(nowMs, this.nextAvailableMs) + intervalMs;
    }
    return waitMs;
  }
}

/**
 * lease 払い出し。window 25 既定で、完了済み index は再送しない (F05-UT-003/004)。
 */
export class LeaseAllocator {
  readonly total: number;
  readonly window: number;

  constructor(total: number, window: number = FUZZ_DEFAULTS.leaseWindow) {
    this.total = total;
    this.window = window;
  }

  /** 完了 index を除外した index のリストを window ごとに払い出す。 */
  leases(completed: ReadonlySet<number> = new Set()): readonly (readonly number[])[] {
    const leases: number[][] = [];
    let current: number[] = [];
    for (let index = 0; index < this.total; index += 1) {
      if (completed.has(index)) {
        continue;
      }
      current.push(index);
      if (current.length >= this.window) {
        leases.push(current);
        current = [];
      }
    }
    if (current.length > 0) {
      leases.push(current);
    }
    return leases;
  }
}

/** payload 集合の供給元・版・license は catalog 登録に必須 (F05-UT-006)。 */
export interface PayloadSetRegistration {
  readonly name: string;
  readonly source: string;
  readonly version: string;
  readonly license: string;
  readonly sha256: string;
  readonly values: readonly string[];
}

export class PayloadCatalog {
  private readonly sets = new Map<string, PayloadSetRegistration & { readonly values: readonly string[] }>();

  register(registration: PayloadSetRegistration): void {
    for (const field of ['name', 'source', 'version', 'license', 'sha256'] as const) {
      if (registration[field].trim() === '') {
        throw domainError('ValidationFailed', `payload set field ${field} is required (source/version/license provenance)`);
      }
    }
    this.sets.set(registration.name, registration);
  }

  get(name: string): readonly string[] {
    const set = this.sets.get(name);
    if (set === undefined) {
      throw domainError('ValidationFailed', `payload set ${name} is not registered`);
    }
    return set.values;
  }
}

export interface FuzzSendAdapter {
  send(index: number, combination: readonly string[]): Promise<void>;
}

/** cancel 後の追加送信は行わない (F05-UT-005)。rate token も評価する。 */
export async function runFuzz(
  adapter: FuzzSendAdapter,
  positions: readonly FuzzPosition[],
  total: number,
  options: { isCancelled: () => boolean; now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<{ sent: number; cancelledAt: number | null }> {
  const governor = new RateGovernor();
  let sent = 0;
  for (let index = 0; index < total; index += 1) {
    if (options.isCancelled()) {
      return { sent, cancelledAt: index };
    }
    const waitMs = governor.tryAcquire(options.now());
    if (waitMs > 0) {
      await options.sleep(waitMs);
    }
    await adapter.send(index, combinationAt(positions, index));
    sent += 1;
  }
  return { sent, cancelledAt: null };
}

export interface ExtractorBudget {
  readonly maxScanBytes: number;
  readonly maxMatches: number;
}

export const EXTRACTOR_DEFAULT_BUDGET: ExtractorBudget = { maxScanBytes: 1024 * 1024, maxMatches: 1000 };

/**
 * bounded な正規抽出。scan 長・match 数の上限を超えたら error となり、
 * 部分結果を成功扱いしない (F05-UT-007)。
 */
export function extractMatches(pattern: RegExp, body: string, budget: ExtractorBudget = EXTRACTOR_DEFAULT_BUDGET): readonly string[] {
  if (!pattern.global) {
    throw domainError('ValidationFailed', 'extractor pattern must be global');
  }
  if (body.length > budget.maxScanBytes) {
    throw domainError('ValidationFailed', `extractor scan exceeds ${budget.maxScanBytes} bytes`);
  }
  const matches: string[] = [];
  const anchored = new RegExp(pattern.source, pattern.flags);
  let lastIndex = 0;
  while (lastIndex <= body.length) {
    anchored.lastIndex = lastIndex;
    const match = anchored.exec(body);
    if (match === null) {
      break;
    }
    matches.push(match[0]);
    if (matches.length > budget.maxMatches) {
      throw domainError('ValidationFailed', `extractor matches exceed ${budget.maxMatches}`);
    }
    lastIndex = match.index + Math.max(1, match[0].length);
  }
  return matches;
}

export interface FuzzResponseOutcome {
  readonly status: number;
  readonly contentLength: number;
  readonly bodyHash: string;
}

/**
 * 同一 (status, content-length, body hash) の結果は同一 cluster へ集約する (F05-UT-008)。
 */
export function clusterResponses(outcomes: readonly FuzzResponseOutcome[]): readonly { key: string; members: readonly number[] }[] {
  const clusters = new Map<string, number[]>();
  outcomes.forEach((outcome, index) => {
    const key = `${outcome.status}|${outcome.contentLength}|${outcome.bodyHash}`;
    const members = clusters.get(key) ?? [];
    members.push(index);
    clusters.set(key, members);
  });
  return [...clusters.entries()].map(([key, members]) => ({ key, members }));
}
