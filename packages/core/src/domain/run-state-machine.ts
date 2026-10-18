/**
 * run/job の状態機械。`docs/design/22-execution-control.md` §2・§6、
 * `docs/detailed-design/01-system-components.md` §6。
 * 不正な遷移を拒否し、terminal state を再開しない (SYS-UT-004)。
 * 起動時の Running/Stopping 検出は Interrupted へ変換し、自動再開は行わない。
 */
import { domainError, isTerminalRunState, type RunState } from '@scopepilot2/contracts';

const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  Draft: ['Validated'],
  Validated: ['Authorized'],
  Authorized: ['Confirmed'],
  Confirmed: ['Running'],
  Running: ['Stopping', 'Completed', 'Failed'],
  Stopping: ['Stopped', 'Failed', 'Interrupted'],
  Completed: [],
  Stopped: [],
  Failed: [],
  Interrupted: [],
};

export class RunStateMachine {
  private current: RunState;

  constructor(initial: RunState = 'Draft') {
    this.current = initial;
  }

  get state(): RunState {
    return this.current;
  }

  isTerminal(): boolean {
    return isTerminalRunState(this.current);
  }

  canTransition(to: RunState): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  transition(to: RunState): RunState {
    if (isTerminalRunState(this.current)) {
      throw domainError('Conflict', `terminal run state ${this.current} cannot transition (resume requires a new attempt)`);
    }
    if (!this.canTransition(to)) {
      throw domainError('ValidationFailed', `invalid run state transition ${this.current} -> ${to}`);
    }
    this.current = to;
    return this.current;
  }

  /** 停止要求。Running からは Stopping へ、それ以外の実行中状態はそのまま返す。 */
  requestStop(): RunState {
    if (this.current === 'Running') {
      return this.transition('Stopping');
    }
    return this.current;
  }

  /** crash 検出: 実行中状態を Interrupted へ。terminal は null (変更しない)。 */
  static detectInterrupted(state: RunState): RunState | null {
    if (state === 'Running' || state === 'Stopping') {
      return 'Interrupted';
    }
    return null;
  }
}
