import { SiteMapProjector, planTrafficQuery } from '../../domain/target-logger.ts';
import type { BaselineFlowDeps } from '../baseline-contracts.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { ExecutionContext } from './execution-context.ts';
export interface TrafficServicePorts {
}
export class TrafficService {
    private readonly deps: Pick<BaselineFlowDeps, 'ids'>;
    private readonly ports: TrafficServicePorts;
    private readonly events: EventPublisherPort;
    private readonly context: ExecutionContext;
    constructor(deps: TrafficService['deps'], ports: TrafficServicePorts, events: EventPublisherPort, context: ExecutionContext) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.context = context;
    }
    recordObservedExchange(summary: {
        url: string;
        method: string;
        status: number;
        contentType: string;
    }, at: string, source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer'): void {
        (this.context.trafficLog as {
            exchangeId: string;
            url: string;
            method: string;
            status: number;
            contentType: string;
            at: string;
            source: 'explore' | 'repeater' | 'fuzzer' | 'sequencer';
        }[]).push({
            exchangeId: this.deps.ids.next('exchange'),
            ...summary,
            at,
            source,
        });
        this.context.siteMapProjector.add(summary);
    }
    listTraffic(limit: number): {
        mode: 'list' | 'summary';
        total: number;
        entries?: readonly {
            exchangeId: string;
            url: string;
            method: string;
            status: number;
            contentType: string;
            at: string;
            source: string;
        }[];
    } {
        const plan = planTrafficQuery(this.context.trafficLog.length, limit);
        if (plan.mode === 'summary') {
            return { mode: 'summary', total: this.context.trafficLog.length };
        }
        const entries = [...this.context.trafficLog].slice(-plan.limit).reverse();
        return { mode: 'list', total: this.context.trafficLog.length, entries };
    }
    listSiteMapEndpoints(): readonly ReturnType<SiteMapProjector['list']>[number][] {
        return this.context.siteMapProjector.list();
    }
}
