import { canonicalJson, domainError, type CaseRecord, type Finding, type OperatorProfile } from '@scopepilot2/contracts';
import { ScopePolicy } from '../../domain/scope-policy.ts';
import { dedupeKeyOf } from '../../domain/finding-importer.ts';
import { importMatches, parseNucleiJsonl } from '../../domain/known-vulnerabilities.ts';
import type { BaselineFlowDeps, ImportNucleiResultsInput, ImportNucleiResultsResult } from '../baseline-contracts.ts';
import type { EventPublisherPort } from './event-publisher.ts';
import type { EvidenceServicePort } from './evidence-service.ts';
import type { ExecutionContext } from './execution-context.ts';
import { requirePermission } from './authorization-policy.ts';
export interface FindingServicePorts {
    currentCase(): CaseRecord;
}
export class FindingService {
    private readonly deps: Pick<BaselineFlowDeps, 'findingSink' | 'clock' | 'ids'>;
    private readonly ports: FindingServicePorts;
    private readonly events: EventPublisherPort;
    private readonly context: ExecutionContext;
    private readonly evidence: EvidenceServicePort;
    constructor(deps: FindingService['deps'], ports: FindingServicePorts, events: EventPublisherPort, context: ExecutionContext, evidence: EvidenceServicePort) {
        this.deps = deps;
        this.ports = ports;
        this.events = events;
        this.context = context;
        this.evidence = evidence;
    }
    listFindings(): readonly Finding[] {
        return this.context.importer.list();
    }
    persistFindings(findings: readonly Finding[]): void {
        const caseId = this.ports.currentCase().caseId;
        for (const finding of findings) {
            const key = finding.source.kind === 'nuclei-match'
                ? `nuclei|${finding.enginePluginId ?? ''}|${finding.url}`
                : dedupeKeyOf({
                    engineAlertId: finding.findingId,
                    pluginId: finding.enginePluginId ?? '',
                    name: finding.title,
                    risk: finding.severity === 'info' || finding.severity === 'unknown'
                        ? 'Informational'
                        : finding.severity === 'low' ? 'Low' : finding.severity === 'medium' ? 'Medium' : 'High',
                    url: finding.url,
                    method: finding.method ?? 'GET',
                    ...(finding.param === undefined ? {} : { param: finding.param }),
                    evidenceSummary: '',
                });
            this.deps.findingSink?.save(caseId, key, finding);
        }
    }
    updateFindingStatus(operator: OperatorProfile, input: {
        readonly findingId: string;
        readonly next: 'confirmed' | 'rejected';
        readonly reproduction: 'reproduced' | 'not-reproduced';
        readonly notes: string;
        readonly severityRationale: string;
        readonly cvss?: {
            readonly version: '3.1' | '4.0';
            readonly vector: string;
            readonly score: number;
        };
    }): Finding {
        requirePermission(operator, 'finding.confirm');
        const at = this.deps.clock.now().toISOString();
        const before = this.context.importer.list().find((finding) => finding.findingId === input.findingId);
        if (before === undefined) {
            throw domainError('ValidationFailed', `finding ${input.findingId} does not exist`);
        }
        if (input.notes.trim() === '' || input.severityRationale.trim() === '') {
            throw domainError('ValidationFailed', 'human review notes and severity rationale are required');
        }
        if ((input.next === 'confirmed') !== (input.reproduction === 'reproduced')) {
            throw domainError('ValidationFailed', 'review result and reproduction result are inconsistent');
        }
        if (input.cvss !== undefined && (input.cvss.vector.trim() === '' || input.cvss.score < 0 || input.cvss.score > 10)) {
            throw domainError('ValidationFailed', 'CVSS vector and score (0..10) are invalid');
        }
        const updated = this.context.importer.updateStatus(input.findingId, input.next, {
            now: at,
            changedBy: operator.operatorId,
            review: {
                reproduction: input.reproduction,
                notes: input.notes.trim(),
                severityRationale: input.severityRationale.trim(),
                ...(input.cvss === undefined ? {} : { cvss: input.cvss }),
            },
        });
        this.persistFindings([updated]);
        this.events.publish({ type: 'FindingStatusChanged', at, findingId: input.findingId, from: before.status, to: input.next, changedBy: operator.operatorId });
        return updated;
    }
    async importNucleiResults(operator: OperatorProfile, input: ImportNucleiResultsInput): Promise<ImportNucleiResultsResult> {
        requirePermission(operator, 'run.manage');
        const caseRecord = this.ports.currentCase();
        if (input.engineVersion.trim() === '') {
            throw domainError('ValidationFailed', 'engineVersion must not be empty');
        }
        const parsed = parseNucleiJsonl(input.lines);
        const inScope = parsed.matches.filter((match) => ScopePolicy.decide(caseRecord.scope, match.matchedAt).allowed);
        const excludedOutOfScope = parsed.matches.length - inScope.length;
        const batch = importMatches(inScope);
        const importId = this.deps.ids.next('nuclei-import');
        let rawEvidence;
        try {
            rawEvidence = await this.evidence.saveText(`nuclei-jsonl-raw:${importId}`, canonicalJson({ importId, engineVersion: input.engineVersion, lines: input.lines }));
        }
        catch (cause) {
            throw domainError('EngineFailure', `evidence storage failed before nuclei import: ${String(cause)}`, {
                retryable: true,
                details: { importId },
            });
        }
        const result = this.context.importer.importNucleiMatches(batch.imported, {
            now: this.deps.clock.now().toISOString(),
            engineVersion: input.engineVersion,
            makeFindingId: () => this.deps.ids.next('finding'),
            evidenceRef: rawEvidence.evidenceId,
        });
        this.persistFindings([...result.created, ...result.reobserved]);
        this.events.publish({
            type: 'FindingsImported',
            at: this.deps.clock.now().toISOString(),
            source: 'nuclei-match',
            engineVersion: input.engineVersion,
            importedCount: result.created.length,
            duplicateCount: batch.duplicates + result.duplicateCount,
        });
        return {
            findings: this.context.importer.list(),
            importedCount: result.created.length,
            duplicateCount: batch.duplicates + result.duplicateCount,
            quarantinedCount: parsed.quarantined,
            excludedOutOfScope,
            evidenceRef: rawEvidence.evidenceId,
        };
    }
}
