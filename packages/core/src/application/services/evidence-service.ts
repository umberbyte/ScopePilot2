import { filterAuthorizationEvidenceMetadata } from '../../domain/authorization-evidence.ts';
import type { EvidenceStorePort } from '../../ports/infra.ts';
/** Central evidence boundary. The caller supplies a redacted projection and provenance metadata.
 * Rejections propagate: a dependent ledger/event must only be updated after this promise resolves.
 */
export interface EvidenceServicePort extends EvidenceStorePort {
    saveAuthorization(label: string, content: string, metadata?: Readonly<Record<string, string>>): ReturnType<EvidenceStorePort['saveText']>;
}
export class EvidenceService implements EvidenceStorePort {
    private readonly store: EvidenceStorePort;
    constructor(store: EvidenceStorePort) { this.store = store; }
    saveText(label: string, content: string, metadata?: Readonly<Record<string, string>>) {
        return this.store.saveText(label, content, metadata);
    }
    saveAuthorization(label: string, content: string, metadata: Readonly<Record<string, string>> = {}) {
        return this.saveText(label, content, filterAuthorizationEvidenceMetadata(metadata));
    }
}
