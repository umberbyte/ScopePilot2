import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RunStateMachine } from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

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
