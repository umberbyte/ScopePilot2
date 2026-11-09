import { domainError } from './errors.ts';

/** run の状態遷移と停止理由。`docs/design/22-execution-control.md` 2章、`docs/detailed-design/01-system-components.md` 6章。 */
export const RunStates = [
  'Draft',
  'Validated',
  'Authorized',
  'Confirmed',
  'Running',
  'Stopping',
  'Completed',
  'Stopped',
  'Failed',
  'Interrupted',
] as const;

export type RunState = (typeof RunStates)[number];

export type TerminalRunState = 'Completed' | 'Stopped' | 'Failed' | 'Interrupted';

export function isTerminalRunState(state: RunState): state is TerminalRunState {
  return state === 'Completed' || state === 'Stopped' || state === 'Failed' || state === 'Interrupted';
}

export const StopReasons = [
  'completed',
  'user-request',
  'budget-exhausted',
  'scope-violation',
  'authorization-expired',
  'engine-failure',
  'interrupted',
] as const;

export type StopReason = (typeof StopReasons)[number];

export interface RunRecord {
  readonly runId: string;
  readonly planId: string;
  readonly caseId: string;
  readonly state: RunState;
  readonly attempt: number;
  readonly stopReason?: StopReason;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

/** Canonical asynchronous scan projection; state is a compatibility alias of runState. */
export interface ScanStateProjection {
  readonly state: RunState;
  readonly runState: RunState;
  readonly dispatchState: 'queued' | 'dispatched';
  readonly stopReason?: StopReason;
}

export function assertRunStopReason(state: RunState, reason: StopReason | undefined): void {
  const allowed: Partial<Record<RunState, readonly StopReason[]>> = {
    Completed: ['completed'],
    Stopped: ['user-request', 'budget-exhausted', 'scope-violation', 'authorization-expired'],
    Failed: ['engine-failure'],
    Interrupted: ['interrupted'],
    Stopping: ['user-request', 'budget-exhausted', 'scope-violation', 'authorization-expired'],
  };
  if (!RunStates.includes(state) || (isTerminalRunState(state)
    ? reason === undefined || !allowed[state]?.includes(reason)
    : reason !== undefined && !allowed[state]?.includes(reason))) {
    throw domainError('ValidationFailed', `invalid stop reason ${reason} for run state ${state}`);
  }
}
