import { domainError, type CaseRecord, type OperatorProfile } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { parseOpenApiDocument, type ParsedOpenApiEndpoint } from '../../domain/api-scanning.ts';
import type { BaselineFlowDeps } from '../baseline-contracts.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { ExecutionContext } from './execution-context.ts';
import { requirePermission } from './authorization-policy.ts';
export interface ApiImportServicePorts {
    currentCase(): CaseRecord;
}
export class ApiImportService {
    private readonly deps: Pick<BaselineFlowDeps, 'clock'>;
    private readonly ports: ApiImportServicePorts;
    private readonly events: EventPublisherPort;
    private readonly context: ExecutionContext;
    constructor(deps: ApiImportService['deps'], ports: ApiImportServicePorts, events: EventPublisherPort, context: ExecutionContext) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.context = context;
    }
    importApiSpec(operator: OperatorProfile, input: {
        readonly documentLabel: string;
        readonly document: unknown;
    }): {
        documentLabel: string;
        servers: readonly string[];
        excludedServers: readonly string[];
        endpoints: readonly {
            method: string;
            path: string;
            url: string;
        }[];
        warnings: readonly string[];
    } {
        requirePermission(operator, 'case.manage');
        if (input.documentLabel.trim() === '') {
            throw domainError('ValidationFailed', 'documentLabel must not be empty');
        }
        const caseRecord = this.ports.currentCase();
        const parsed = parseOpenApiDocument(input.document);
        // server の scope 除外は domain と同一規則 (F12-UT-001)。URL 構築は basePath を
        // 保持するため生 server 表記を使う (canonicalOrigin は path を落とす)。
        const allowed = parsed.servers.filter((server) => ScopePolicy.decide(caseRecord.scope, server).allowed);
        const excluded = parsed.servers.filter((server) => !ScopePolicy.decide(caseRecord.scope, server).allowed);
        if (allowed.length === 0) {
            throw domainError('OutOfScope', 'no api spec server is within the allowed origins');
        }
        const candidates = allowed.map((server) => server.replace(/\/+$/, ''));
        const endpoints = candidates.flatMap((server) => parsed.endpoints.map((endpoint) => ({ ...endpoint, url: `${server}${endpoint.path}` })));
        const warnings = [...new Set(parsed.endpoints.filter((endpoint) => endpoint.path.includes('{')).map((endpoint) => `path template ${endpoint.path} needs explicit values`))];
        const importedAt = this.deps.clock.now().toISOString();
        (this.context.apiSpecImports as {
            documentLabel: string;
            servers: readonly string[];
            excludedServers: readonly string[];
            endpoints: readonly (ParsedOpenApiEndpoint & {
                readonly url: string;
            })[];
            importedAt: string;
        }[]).push({ documentLabel: input.documentLabel, servers: candidates, excludedServers: excluded, endpoints, importedAt });
        this.events.publish({
            type: 'ApiSpecImported',
            at: importedAt,
            documentLabel: input.documentLabel,
            endpointCount: endpoints.length,
            excludedServerCount: excluded.length,
        });
        return {
            documentLabel: input.documentLabel,
            servers: candidates,
            excludedServers: excluded,
            endpoints: endpoints.map(({ method, path, url }) => ({ method, path, url })),
            warnings,
        };
    }
    listApiSpecImports(): readonly {
        documentLabel: string;
        endpointCount: number;
        importedAt: string;
    }[] {
        return this.context.apiSpecImports.map((entry) => ({ documentLabel: entry.documentLabel, endpointCount: entry.endpoints.length, importedAt: entry.importedAt }));
    }
}
