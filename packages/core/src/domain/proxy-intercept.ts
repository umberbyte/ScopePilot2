/**
 * Proxy・Intercept。`docs/detailed-design/f02-proxy-intercept.md` §4〜§6。
 * core は break queue と判断を持ち、adapter 呼出は隔離する。
 * queue 上限と deadline を超えた item は既定で drop し、暗黙 forward しない。
 */
import { domainError } from '@scopepilot2/contracts';
import { ScopePolicy } from './scope-policy.ts';

export type BreakItemState = 'Held' | 'Forwarded' | 'Dropped' | 'Expired';

export interface BreakItem {
  readonly itemId: string;
  readonly messageReference: string;
  readonly direction: 'request' | 'response';
  readonly receivedAtMs: number;
  readonly deadlineMs: number;
  readonly originalRequestHash: string;
  state: BreakItemState;
  editedRequestHash?: string;
}

export interface BreakQueueEvent {
  readonly type: 'expired' | 'dropped';
  readonly itemId: string;
}

/** queue 上限超過は新規 item を拒否する (F02-UT-001)。 */
export class BreakQueue {
  readonly capacity: number;
  private readonly items = new Map<string, BreakItem>();
  private readonly events: BreakQueueEvent[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  enqueue(input: Omit<BreakItem, 'state'>): BreakItem {
    if (this.items.size >= this.capacity) {
      throw domainError('ValidationFailed', `break queue is full (${this.capacity}); implicit forward is not performed`);
    }
    const item: BreakItem = { ...input, state: 'Held' };
    this.items.set(input.itemId, item);
    return item;
  }

  /** deadline 経過は drop し expired event を出す (F02-UT-002)。 */
  expireDeadlines(nowMs: number): readonly BreakItem[] {
    const expired: BreakItem[] = [];
    for (const item of this.items.values()) {
      if (item.state === 'Held' && nowMs >= item.deadlineMs) {
        item.state = 'Expired';
        this.events.push({ type: 'expired', itemId: item.itemId });
        expired.push(item);
      }
    }
    return expired;
  }

  drop(itemId: string): void {
    const item = this.items.get(itemId);
    if (item === undefined || item.state !== 'Held') {
      throw domainError('Conflict', `break item ${itemId} is not held`);
    }
    item.state = 'Dropped';
    this.events.push({ type: 'dropped', itemId });
  }

  get(itemId: string): BreakItem | undefined {
    return this.items.get(itemId);
  }

  /** 全 item (状態を問わない。UI/API の queue 表示用)。 */
  list(): readonly BreakItem[] {
    return [...this.items.values()];
  }

  recordedEvents(): readonly BreakQueueEvent[] {
    return [...this.events];
  }
}

export interface InterceptDecision {
  readonly itemId: string;
  readonly action: 'forward' | 'reject';
  readonly newRequestHash?: string;
  readonly reason?: string;
}

/**
 * 編集後 forward は新 hash と decision を記録し (F02-UT-003)、
 * scope 外への URL 編集は forward せず OutOfScope (F02-UT-004)。
 */
export function decideIntercept(
  queue: BreakQueue,
  itemId: string,
  edited: { requestHash: string; targetUrl: string },
  scope: { allowedOrigins: readonly string[]; deniedOrigins: readonly string[] },
): InterceptDecision {
  const item = queue.get(itemId);
  if (item === undefined || item.state !== 'Held') {
    throw domainError('Conflict', `break item ${itemId} is not held`);
  }
  const decision = ScopePolicy.decide(scope, edited.targetUrl);
  if (!decision.allowed) {
    return { itemId, action: 'reject', reason: decision.reason };
  }
  item.state = 'Forwarded';
  item.editedRequestHash = edited.requestHash;
  return { itemId, action: 'forward', newRequestHash: edited.requestHash };
}

export type ProxySessionState = 'Starting' | 'Ready' | 'Stopping' | 'Stopped' | 'Failed';

/** start 中の stop は adapter stop を一度だけ呼ぶ (F02-UT-002 §6, F02-UT-005)。 */
export class ProxySession {
  private state: ProxySessionState = 'Starting';
  private readonly stopCalls: string[] = [];
  private readonly adapter: { stop(sessionId: string): Promise<void>; readonly sessionId: string };

  constructor(adapter: { stop(sessionId: string): Promise<void>; readonly sessionId: string }) {
    this.adapter = adapter;
  }

  get currentState(): ProxySessionState {
    return this.state;
  }

  markReady(): void {
    if (this.state !== 'Starting') {
      throw domainError('Conflict', `proxy session cannot become Ready from ${this.state}`);
    }
    this.state = 'Ready';
  }

  async stop(): Promise<void> {
    if (this.state === 'Stopped' || this.state === 'Stopping') {
      return;
    }
    this.state = 'Stopping';
    await this.adapter.stop(this.adapter.sessionId);
    this.stopCalls.push(this.adapter.sessionId);
    this.state = 'Stopped';
  }

  adapterStopCalls(): readonly string[] {
    return [...this.stopCalls];
  }
}

/** CA 情報表示は private key material を含まない (F02-UT-006)。 */
export function presentCertificate(ca: { subject: string; serialNumber: string; validUntil: string; privateKeyPem?: string }): {
  subject: string;
  serialNumber: string;
  validUntil: string;
} {
  return { subject: ca.subject, serialNumber: ca.serialNumber, validUntil: ca.validUntil };
}

/** Cookie/Authorization は表示値を mask する (F02-UT-007)。原本 hash 参照は別途保持する。 */
export function maskSecretHeaders(headers: readonly (readonly [string, string])[]): readonly (readonly [string, string])[] {
  return headers.map(([name, value]) => {
    if (/^(cookie|authorization)$/i.test(name)) {
      return [name, '***masked***'] as const;
    }
    return [name, value] as const;
  });
}
