/**
 * 製品 API (Core API) の共機構。`docs/detailed-design/f20-extension-api.md` §4〜§6。
 * idempotency、permission、SSE event log、extension manifest、互換性、secret 契約。
 * loopback でも wildcard CORS を許可しない。秘密値 read permission は提供しない。
 */
import { domainError, hashStable } from '@scopepilot2/contracts';

/** 同 key/同 body は同じ result、同 key/別 body は Conflict (F20-UT-001/002)。 */
export class IdempotencyStore {
  private readonly entries = new Map<string, { bodyHash: string; result: unknown }>();

  async apply<T>(key: string, body: unknown, handler: () => Promise<T>): Promise<T> {
    const bodyHash = hashStable('scopepilot2.idempotency', body);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.bodyHash !== bodyHash) {
        throw domainError('Conflict', `idempotency key ${key} was already used with a different body`);
      }
      return existing.result as T;
    }
    const result = await handler();
    this.entries.set(key, { bodyHash, result });
    return result;
  }
}

/** permission 不足は handler 前に拒否する (F20-UT-003)。 */
export function mapPermission(operator: { permissions: readonly string[] }, required: string): { allowed: boolean; reason?: string } {
  if (!operator.permissions.includes(required)) {
    return { allowed: false, reason: `operator lacks permission ${required}` };
  }
  return { allowed: true };
}

export interface SseEvent {
  readonly eventId: number;
  readonly type: string;
  readonly payload: string;
}

/** Last-Event-ID は次 event から返し、retention gap は snapshot 再取得を要求する (F20-UT-004/005)。 */
export class SseEventLog {
  private nextId = 1;
  private readonly events: SseEvent[] = [];

  append(type: string, payload: string): SseEvent {
    const event: SseEvent = { eventId: this.nextId, type, payload };
    this.nextId += 1;
    this.events.push(event);
    return event;
  }

  /** retention で破棄された末尾より古い ID を指定された場合は snapshot を要求する。 */
  resumeAfter(lastEventId: number, oldestRetainedId = 1): { kind: 'events'; events: readonly SseEvent[] } | { kind: 'snapshot-required'; oldestRetainedId: number } {
    if (lastEventId < oldestRetainedId - 1) {
      return { kind: 'snapshot-required', oldestRetainedId };
    }
    return { kind: 'events', events: this.events.filter((event) => event.eventId > lastEventId) };
  }

  oldestRetained(oldestRetainedId: number): void {
    // retention 運用の土台: 指定 ID 未満の event を破棄する。
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if ((this.events[index]?.eventId ?? 0) < oldestRetainedId) {
        this.events.splice(index, 1);
      }
    }
  }
}

export interface ExtensionManifest {
  readonly extensionId: string;
  readonly version: string;
  readonly signature: string;
  readonly publisherTrusted: boolean;
  readonly permissions: readonly string[];
  readonly apiRange: readonly string[];
}

function manifestHash(manifest: ExtensionManifest): string {
  return hashStable('scopepilot2.extension.manifest', {
    extensionId: manifest.extensionId,
    version: manifest.version,
    publisherTrusted: manifest.publisherTrusted,
    permissions: manifest.permissions,
    apiRange: manifest.apiRange,
  });
}

/** signature 不一致・非信頼 publisher の extension は load しない (F20-UT-006)。 */
export function verifyExtensionManifest(manifest: ExtensionManifest, expectedSignatureFor: (hash: string) => string): { loaded: boolean; reason?: string } {
  if (!manifest.publisherTrusted) {
    return { loaded: false, reason: 'publisher is not in the trust list' };
  }
  if (manifest.signature !== expectedSignatureFor(manifestHash(manifest))) {
    return { loaded: false, reason: 'manifest signature mismatch' };
  }
  return { loaded: true };
}

/** API range 外の要求は unsupported version とする (F20-UT-007)。 */
export function checkCompatibility(requestedApi: string, supportedRange: readonly string[]): { supported: boolean } {
  if (!supportedRange.includes(requestedApi)) {
    throw domainError('Unsupported', `API version ${requestedApi} is outside the supported range ${supportedRange.join('..')}`);
  }
  return { supported: true };
}

/** secret read 権限は存在せず、値ではなく参照 ID だけを扱う (F20-UT-008)。 */
export function respondToSecretRead(requested: { permission: string }): { referenceIdOnly: boolean } {
  if (requested.permission === 'secrets.read') {
    throw domainError('PermissionDenied', 'secret values are never returned; only secret references (IDs) are exposed');
  }
  return { referenceIdOnly: true };
}
