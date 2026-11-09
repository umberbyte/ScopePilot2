import { type BaselineFlowEvent } from '@scopepilot2/contracts';
/** Workspace-local audit publisher. Call only after the command's durable writes succeed. */
export interface EventPublisherPort {
    publish(event: BaselineFlowEvent): void;
}
export class EventPublisher implements EventPublisherPort {
    private readonly log: BaselineFlowEvent[] = [];
    publish(event: BaselineFlowEvent): void { this.log.push(event); }
    events(): readonly BaselineFlowEvent[] { return [...this.log]; }
}
