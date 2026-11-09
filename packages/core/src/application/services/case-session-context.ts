import { type AuthorizationRecord, type DocumentAuthHintEntry, type DocumentPriorityRule, type DocumentParameterHintEntry } from '@scopepilot2/contracts';
import { CaseAggregate } from '../../domain/case-aggregate.ts';
/** One context per opened workspace. Services never share a process-global current case. */
export class CaseSessionContext {
    aggregate: CaseAggregate | null = null;
    authorization: AuthorizationRecord | null = null;
    documentHintDocuments: {
        documentLabel: string;
        urls: readonly string[];
    }[] = [];
    documentAuthHintDocuments: DocumentAuthHintEntry[] = [];
    documentPriorityRules: DocumentPriorityRule[] = [];
    documentParameterHintDocuments: DocumentParameterHintEntry[] = [];
    explorationHintSeeds = new Map<string, ReadonlySet<string>>();
}
