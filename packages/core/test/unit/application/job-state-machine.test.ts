import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RunStateMachine } from '@scopepilot2/core';
import { RunStates, StopReasons, assertRunStopReason, isTerminalRunState, type RunState, type DomainError } from '@scopepilot2/contracts';

describe('RunStateMachine (job state machine)', () => {
  test('[SYS-UT-004] 正常系の遷移鎖は通し、不正な遷移は拒否する', () => {
    const machine = new RunStateMachine('Draft');
    for (const next of ['Validated', 'Authorized', 'Confirmed', 'Running'] as const) {
      machine.transition(next);
    }
    assert.equal(machine.state, 'Running');

    assert.throws(
      () => new RunStateMachine('Draft').transition('Running'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'ValidationFailed');
        assert.match((error as DomainError).message, /Draft -> Running/);
        return true;
      },
    );
  });

  test('[SYS-UT-004] terminal state は再開できず、遷移要求は Conflict', () => {
    const machine = new RunStateMachine('Confirmed');
    machine.transition('Running');
    machine.transition('Completed');
    assert.equal(machine.isTerminal(), true);

    assert.throws(
      () => machine.transition('Running'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'Conflict');
        assert.match((error as DomainError).message, /terminal run state Completed cannot transition/);
        return true;
      },
    );
    assert.equal(machine.state, 'Completed');
  });

  test('[SYS-UT-004] 停止要求は Running から Stopping へ、crash 検出は Running/Stopping を Interrupted へ', () => {
    const machine = new RunStateMachine('Confirmed');
    machine.transition('Running');
    assert.equal(machine.requestStop(), 'Stopping');
    assert.equal(machine.requestStop(), 'Stopping');

    assert.equal(RunStateMachine.detectInterrupted('Running'), 'Interrupted');
    assert.equal(RunStateMachine.detectInterrupted('Stopping'), 'Interrupted');
    assert.equal(RunStateMachine.detectInterrupted('Completed'), null);
    assert.equal(RunStateMachine.detectInterrupted('Stopped'), null);
  });
});

const edges = new Set([
  'Draft:Validated', 'Validated:Authorized', 'Authorized:Confirmed', 'Confirmed:Running',
  'Running:Stopping', 'Running:Completed', 'Running:Failed', 'Stopping:Stopped', 'Stopping:Failed',
]);

test('GO-26: exhaustive ordinary transitions, terminal immutability and recovery table', () => {
  for (const from of RunStates) {
    for (const to of RunStates) {
      const machine = new RunStateMachine(from);
      const allowed = edges.has(`${from}:${to}`);
      assert.equal(machine.canTransition(to), allowed, `${from} -> ${to}`);
      if (allowed) assert.equal(machine.transition(to), to);
      else {
        assert.throws(() => machine.transition(to), { code: isTerminalRunState(from) ? 'Conflict' : 'ValidationFailed' });
        assert.equal(machine.state, from);
      }
    }
    assert.equal(RunStateMachine.detectInterrupted(from), ['Running', 'Stopping'].includes(from) ? 'Interrupted' : null);
  }
});

test('GO-26: every state/reason pair follows design 41 section 6', () => {
  const reasons: Partial<Record<RunState, readonly string[]>> = {
    Completed: ['completed'], Stopped: ['user-request', 'budget-exhausted', 'scope-violation', 'authorization-expired'],
    Failed: ['engine-failure'], Interrupted: ['interrupted'],
    Stopping: ['user-request', 'budget-exhausted', 'scope-violation', 'authorization-expired'],
  };
  for (const state of RunStates) {
    for (const reason of [...StopReasons, undefined]) {
      const valid = reason === undefined ? !isTerminalRunState(state) : reasons[state]?.includes(reason) === true;
      if (valid) assert.doesNotThrow(() => assertRunStopReason(state, reason));
      else assert.throws(() => assertRunStopReason(state, reason), { code: 'ValidationFailed' });
    }
  }
});
