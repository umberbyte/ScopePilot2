/**
 * WebSocket。`docs/detailed-design/f14-websocket.md`、design/13。
 * text frame のみ対象とし、binary は Unsupported。message 上限は HTTP request 数と別枠。
 */
import { domainError, hashStable } from '@scopepilot2/contracts';

export interface WsFrame {
  readonly frameId: string;
  readonly direction: 'sent' | 'received';
  readonly payload: string;
  readonly receivedAtMs: number;
}

/** 同一 frame の再取込は dedupe する (F14-UT-001)。 */
export function importFrames(frames: readonly WsFrame[]): { imported: readonly WsFrame[]; duplicates: number } {
  const seen = new Set<string>();
  const imported: WsFrame[] = [];
  let duplicates = 0;
  for (const frame of frames) {
    const fingerprint = hashStable('scopepilot2.ws.frame', { id: frame.frameId, direction: frame.direction, payload: frame.payload });
    if (seen.has(fingerprint)) {
      duplicates += 1;
      continue;
    }
    seen.add(fingerprint);
    imported.push(frame);
  }
  return { imported, duplicates };
}

export interface WsSendPlanInput {
  readonly targetUrl: string;
  readonly messages: readonly { readonly kind: 'text' | 'binary'; readonly payload: string }[];
  readonly sessionRevision: number;
  readonly subprotocols?: readonly string[];
}

export interface WsSendPlan {
  readonly planHash: string;
  readonly messageBudget: number;
  readonly sessionRevision: number;
}

/** text message は hash 付き plan を作り (F14-UT-002)、binary は Unsupported (F14-UT-003)。
 *  session revision が変わった confirmation は無効になる (F14-UT-004)。 */
export function buildWsSendPlan(input: WsSendPlanInput): WsSendPlan {
  for (const message of input.messages) {
    if (message.kind === 'binary') {
      throw domainError('Unsupported', 'binary WebSocket messages are not supported in the initial capability set');
    }
  }
  return {
    planHash: hashStable('scopepilot2.ws.send', {
      target: input.targetUrl,
      messages: input.messages,
      sessionRevision: input.sessionRevision,
      subprotocols: input.subprotocols ?? [],
    }),
    messageBudget: input.messages.length,
    sessionRevision: input.sessionRevision,
  };
}

const WS_SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Handshake headerをboundedかつRFC token互換に保つ。順序はclientの提示優先順として維持する。 */
export function validateWsSubprotocols(input: readonly string[]): readonly string[] {
  if (input.length > 16) {
    throw domainError('ValidationFailed', 'WebSocket subprotocols must contain at most 16 entries');
  }
  const seen = new Set<string>();
  for (const protocol of input) {
    if (protocol.length === 0 || protocol.length > 128 || !WS_SUBPROTOCOL_TOKEN.test(protocol)) {
      throw domainError('ValidationFailed', `invalid WebSocket subprotocol: '${protocol}'`);
    }
    if (seen.has(protocol)) {
      throw domainError('ValidationFailed', `duplicate WebSocket subprotocol: '${protocol}'`);
    }
    seen.add(protocol);
  }
  return [...input];
}

export function wsConfirmationValid(plan: WsSendPlan, currentSessionRevision: number): boolean {
  return plan.sessionRevision === currentSessionRevision;
}

/** invalid UTF-8 は暗黙置換せず error にする (F14-UT-005)。 */
export function decodeWsText(bytes: Buffer): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return text;
}

/** rate/size 超過は adapter を呼ばない (F14-UT-006)。 */
export async function sendWithPolicy(
  messages: readonly string[],
  policy: { maxMessageBytes: number; messagesPerSecond: number; now: () => number },
  adapter: { send(message: string): Promise<void> },
): Promise<{ sent: number; rejected: 'size' | 'rate' | null }> {
  let sent = 0;
  const interval = 1000 / policy.messagesPerSecond;
  let nextAvailableMs = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    if (Buffer.byteLength(message, 'utf8') > policy.maxMessageBytes) {
      return { sent, rejected: 'size' };
    }
    const now = policy.now();
    if (now < nextAvailableMs) {
      return { sent, rejected: 'rate' };
    }
    nextAvailableMs = now + interval;
    await adapter.send(message);
    sent += 1;
  }
  return { sent, rejected: null };
}

/** 表示生成では raw hash と text を区別する (F14-UT-007)。 */
export function wsEvidence(frame: WsFrame): { rawHash: string; text: string } {
  return { rawHash: hashStable('scopepilot2.ws.raw', frame.payload), text: frame.payload };
}
