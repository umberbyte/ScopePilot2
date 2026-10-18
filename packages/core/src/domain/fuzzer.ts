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
  for (const position of positions) {
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
