/**
 * Repeater。`docs/detailed-design/f04-repeater.md` §4〜§6。
 * draft は revision を持ち、送信時は plan hash と confirmation の一致だけを条件に adapter へ渡す。
 * 既定 redirect は手動、許可時も最大 10 hop。timeout は response なしの attempt として保存する。
 */
import { createHash } from 'node:crypto';
import { domainError, hashStable } from '@scopepilot2/contracts';
import { ScopePolicy } from './scope-policy.ts';

export const REPEATER_MAX_TABS = 20;
export const REPEATER_MAX_REDIRECT_HOPS = 10;

export interface RepeaterDraft {
  readonly draftId: string;
  readonly baseExchangeId: string;
  readonly protocol: 'http/1.1' | 'http/2';
  revision: number;
  requestBytes: string;
  readonly targetUrl: string;
}

/** 21 tab 目の作成は拒否する (F04-UT-001)。 */
export class DraftRegistry {
  private readonly drafts = new Map<string, RepeaterDraft>();

  create(input: { draftId: string; baseExchangeId: string; protocol: RepeaterDraft['protocol']; requestBytes: string; targetUrl: string }): RepeaterDraft {
    if (this.drafts.size >= REPEATER_MAX_TABS) {
      throw domainError('ValidationFailed', `repeater tab limit reached (${REPEATER_MAX_TABS})`);
    }
    const draft: RepeaterDraft = { ...input, revision: 1 };
    this.drafts.set(input.draftId, draft);
    return draft;
  }

  get(draftId: string): RepeaterDraft | undefined {
    return this.drafts.get(draftId);
  }
}

export interface RequestEdit {
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

function renderRequest(targetUrl: string, headers: readonly (readonly [string, string])[], body: string): string {
  const parsed = new URL(targetUrl);
  return `${parsed.pathname}${parsed.search} HTTP/1.1\nHost: ${parsed.host}\n${headers.map(([n, v]) => `${n}: ${v}`).join('\n')}\n\n${body}`;
}

/** draft 作成時の初期要求 (既定 header なし・空 body)。service が呼ぶ。 */
export function renderInitialRequest(targetUrl: string): string {
  return renderRequest(targetUrl, [], '');
}

/** header/body 編集は canonical bytes と新 revision を作る (F04-UT-002)。 */
export function applyEdit(draft: RepeaterDraft, edit: RequestEdit): { requestBytes: string; revision: number } {
  if (edit.headers.some(([name, value]) => name.includes('\n') || value.includes('\n'))) {
    throw domainError('ValidationFailed', 'header name/value must not contain newlines (ambiguous framing)');
  }
  const requestBytes = renderRequest(draft.targetUrl, edit.headers, edit.body);
  draft.requestBytes = requestBytes;
  draft.revision += 1;
  return { requestBytes, revision: draft.revision };
}

/** 送信時に適用する session cookie (design/08: F04/F05/F11 へ Cookie として適用)。 */
export interface SessionCookieForSend {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
}

export interface SendCommand {
  readonly draftId: string;
  readonly revision: number;
  readonly planHash: string;
  /** role session の cookie (指定時のみ)。実 adapter が要求へ付けて送る。 */
  readonly sessionCookies?: readonly SessionCookieForSend[];
}

/**
 * session cookie の適用判定 (design/08: 別 Origin への認証送信は拒否)。
 * 対象 URL の host・path に一致する cookie だけを適用する (簡易 browser 規則:
 * domain は host そのものか親 domain、path は前方一致。先頭 dot は無視)。
 */
export function applicableSessionCookies(
  cookies: readonly SessionCookieForSend[],
  targetUrl: string,
): readonly SessionCookieForSend[] {
  const target = new URL(targetUrl);
  const host = target.hostname.toLowerCase();
  return cookies.filter((cookie) => {
    const domain = cookie.domain.toLowerCase().replace(/^\.+/, '');
    const hostMatches = host === domain || host.endsWith(`.${domain}`);
    const pathMatches = cookie.path === '/' || target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`);
    return hostMatches && pathMatches;
  });
}

/** confirmation hash 不一致なら adapter を呼ばない (F04-UT-003)。 */
export async function sendCommand(
  draft: RepeaterDraft,
  confirmedPlanHash: string,
  adapter: { send(command: SendCommand): Promise<void> },
  sessionCookies?: readonly SessionCookieForSend[],
): Promise<{ sent: boolean }> {
  const planHash = hashStable('scopepilot2.repeater.request', { bytes: draft.requestBytes, revision: draft.revision, target: draft.targetUrl });
  if (planHash !== confirmedPlanHash) {
    return { sent: false };
  }
  await adapter.send({ draftId: draft.draftId, revision: draft.revision, planHash, ...(sessionCookies === undefined ? {} : { sessionCookies }) });
  return { sent: true };
}

export interface RedirectHop {
  readonly location: string;
}

/**
 * redirect は各 hop で scope を再評価する。scope 外 Location は hop 前に停止 (F04-UT-004)、
 * 11 hop 目で limit error (F04-UT-005)。
 */
export function runRedirects(
  hops: readonly RedirectHop[],
  scope: { allowedOrigins: readonly string[]; deniedOrigins: readonly string[] },
): { outcome: 'completed' | 'stopped-out-of-scope' | 'limit'; followed: number; lastReason?: string } {
  if (hops.length > REPEATER_MAX_REDIRECT_HOPS) {
    return { outcome: 'limit', followed: REPEATER_MAX_REDIRECT_HOPS, lastReason: `redirect hops exceed ${REPEATER_MAX_REDIRECT_HOPS}` };
  }
  let followed = 0;
  for (const hop of hops) {
    const decision = ScopePolicy.decide(scope, hop.location);
    if (!decision.allowed) {
      return { outcome: 'stopped-out-of-scope', followed, lastReason: decision.reason };
    }
    followed += 1;
  }
  return { outcome: 'completed', followed };
}

export interface ResponseSummary {
  readonly status: number;
  readonly contentType: string;
  readonly bodyBytes: number;
  readonly bodyPreview?: string;
}

/** binary body は text 化せず metadata のみ (F04-UT-006)。 */
export function summarizeResponse(raw: { status: number; headers: readonly (readonly [string, string])[]; body: Buffer }): ResponseSummary {
  const contentType = raw.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? 'application/octet-stream';
  const isText = /^text\/|json|xml|javascript/i.test(contentType);
  const summary: SummaryBuilder = { status: raw.status, contentType, bodyBytes: raw.body.length };
  if (isText && raw.body.length <= 64 * 1024) {
    return { ...summary, bodyPreview: raw.body.toString('utf8').slice(0, 256) };
  }
  return summary;
}
type SummaryBuilder = { status: number; contentType: string; bodyBytes: number };

export interface SendAttemptRecord {
  readonly attemptId: string;
  readonly draftId: string;
  readonly outcome: 'responded' | 'timeout';
  readonly responseHash?: string;
}

/** timeout は response なしの attempt として保存し、成功 response を捏造しない (F04-UT-007)。 */
export function recordSendAttempt(draftId: string, response: Buffer | null): SendAttemptRecord {
  if (response === null) {
    return { attemptId: `attempt-${draftId}-timeout`, draftId, outcome: 'timeout' };
  }
  return {
    attemptId: `attempt-${draftId}-${createHash('sha256').update(response).digest('hex').slice(0, 12)}`,
    draftId,
    outcome: 'responded',
    responseHash: createHash('sha256').update(response).digest('hex'),
  };
}
