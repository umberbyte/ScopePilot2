import { type RunRecord, type RunState } from '@scopepilot2/contracts';
import { RunStateMachine } from '../../domain/run-state-machine.ts';
import type { RunSinkPort } from '../../ports/infra.ts';
/** Application receiver for the canonical domain machine and durable run snapshots.
 * No shared current run: simultaneous attempts own distinct machines.
 */
export interface RunLifecyclePort {
    createMachine(initial?: RunState): RunStateMachine;
    save(record: RunRecord): void;
}
export class RunLifecycleService {
    private readonly sink: RunSinkPort | undefined;
    constructor(sink?: RunSinkPort) { this.sink = sink; }
    createMachine(initial: RunState = 'Confirmed'): RunStateMachine { return new RunStateMachine(initial); }
    save(record: RunRecord): void { this.sink?.save(record); }
}
