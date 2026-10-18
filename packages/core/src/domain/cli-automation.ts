/**
 * CLI 自動化の残モジュール。`docs/detailed-design/f21-cli-automation.md` §4〜§6。
 * AutomationGrant 検証、SSE progress の cursor 再開、SIGINT 二段停止。
 */
import { domainError } from '@scopepilot2/contracts';

export interface AutomationGrantShape {
  readonly issuer: string;
  readonly subject: string;
  readonly caseId: string;
  readonly planHash: string;
  readonly allowedCommands: readonly string[];
  readonly operationClasses: readonly string[];
  readonly expiresAt: string;
  readonly maxRequests: number;
  readonly maxDurationMinutes: number;
}

/** plan hash・期限不一致は実行を拒否する (F21-UT-002)。 */
export function verifyAutomationGrant(
  grant: AutomationGrantShape,
  input: { planHash: string; command: string; now: string },
): { allowed: true } | { allowed: false; code: 'PermissionDenied' | 'OutOfScope'; reason: string } {
  if (input.now >= grant.expiresAt) {
    return { allowed: false, code: 'PermissionDenied', reason: `automation grant expired at ${grant.expiresAt}` };
  }
  if (grant.planHash !== input.planHash) {
    return { allowed: false, code: 'OutOfScope', reason: 'automation grant is bound to a different plan hash' };
  }
  if (!grant.allowedCommands.includes(input.command)) {
    return { allowed: false, code: 'OutOfScope', reason: `command ${input.command} is not allowed by the grant` };
  }
  return { allowed: true };
}

/** CLI option で grant の上限を拡張できない (F21-UT-003)。 */
export function clampToGrant(
  requested: { maxRequests: number; maxDurationMinutes: number },
  grant: AutomationGrantShape,
): { maxRequests: number; maxDurationMinutes: number } {
  const maxRequests = Math.min(requested.maxRequests, grant.maxRequests);
  const maxDurationMinutes = Math.min(requested.maxDurationMinutes, grant.maxDurationMinutes);
  if (maxRequests !== requested.maxRequests || maxDurationMinutes !== requested.maxDurationMinutes) {
    // 拡張要求は黙って切り詰めるのではなく拒否する。
    throw domainError('PermissionDenied', 'CLI options cannot exceed automation grant limits');
  }
  return { maxRequests, maxDurationMinutes };
}

export interface ProgressEvent {
  readonly eventId: number;
  readonly payload: string;
}

/** SSE 切断は cursor から重複なく再開する (F21-UT-006)。 */
export class ProgressSubscriber {
  private lastEventId = 0;
  private readonly received: ProgressEvent[] = [];

  receive(events: readonly ProgressEvent[]): { accepted: readonly ProgressEvent[]; duplicates: number } {
    const accepted: ProgressEvent[] = [];
    let duplicates = 0;
    for (const event of events) {
      if (event.eventId <= this.lastEventId) {
        duplicates += 1;
        continue;
      }
      this.lastEventId = event.eventId;
      accepted.push(event);
      this.received.push(event);
    }
    return { accepted, duplicates };
  }

  cursor(): number {
    return this.lastEventId;
  }

  all(): readonly ProgressEvent[] {
    return [...this.received];
  }
}

export type SignalOutcome = 'stop-requested' | 'interrupted';

/**
 * SIGINT 二回: 1 回目は協調停止要求 (冪等)、期限後の 2 回目は interrupted (F21-UT-008)。
 */
export class SignalController {
  private stopRequests = 0;

  get signalCount(): number {
    return this.stopRequests;
  }

  signal(nowMs: number, graceDeadlineMs: number): SignalOutcome {
    this.stopRequests += 1;
    if (this.stopRequests === 1) {
      return 'stop-requested';
    }
    if (nowMs >= graceDeadlineMs) {
      return 'interrupted';
    }
    return 'stop-requested';
  }
}
