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

export type StopReason =
  | 'completed'
  | 'user-request'
  | 'budget-exhausted'
  | 'scope-violation'
  | 'authorization-expired'
  | 'engine-failure'
  | 'interrupted';

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
