/** 案件単位の診断ポリシー。design/40 A43・owner decision Q6。 */
import {
  GenericHttpCheckIds,
  ScanAlertThresholds,
  ScanAttackStrengths,
  ScanPolicySchemaVersion,
  domainError,
  scanPolicyHashOf,
  type SaveScanPolicyRequest,
  type ScanPolicy,
  type ScanPolicyRoutes,
} from '@scopepilot2/contracts';

const MAX_POLICY_NAME_LENGTH = 80;
const MAX_NUCLEI_TEMPLATE_IDS = 1_000;

export const STANDARD_SCAN_POLICY_ID = 'standard';

export function standardScanPolicy(caseId: string, updatedAt: string): ScanPolicy {
  const routes: ScanPolicyRoutes = {
    zap: { enabled: true, attackStrength: 'Medium', alertThreshold: 'Medium' },
    genericHttp: { enabled: true, checkIds: [...GenericHttpCheckIds] },
    // capability が構成済みの場合だけ A40 が実行経路として有効にする。
    nuclei: { enabled: true, templateIds: [] },
  };
  const hashInput = {
    schemaVersion: ScanPolicySchemaVersion,
    policyId: STANDARD_SCAN_POLICY_ID,
    caseId,
    name: '標準',
    isDefault: true,
    routes,
  } as const;
  return { ...hashInput, revision: 1, policyHash: scanPolicyHashOf(hashInput), updatedAt };
}
export interface SaveScanPolicyOutcome {
  readonly policy: ScanPolicy;
  readonly changed: boolean;
}

export class ScanPolicyRegistry {
  private readonly byCase = new Map<string, Map<string, ScanPolicy>>();

  list(caseId: string, now: string): readonly ScanPolicy[] {
    const policies = this.casePolicies(caseId, now);
    return [...policies.values()].sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.name.localeCompare(right.name, 'ja');
    });
  }

  get(caseId: string, policyId: string, now: string): ScanPolicy {
    const policy = this.casePolicies(caseId, now).get(policyId);
    if (policy === undefined) throw domainError('ValidationFailed', `scan policy was not found: ${policyId}`);
    return policy;
  }

  findCurrentByHash(caseId: string, policyHash: string, now: string): ScanPolicy | undefined {
    return [...this.casePolicies(caseId, now).values()].find((policy) => policy.policyHash === policyHash);
  }

  save(caseId: string, input: SaveScanPolicyRequest, policyId: string, now: string): SaveScanPolicyOutcome {
    validateScanPolicyInput(input);
    const policies = this.casePolicies(caseId, now);
    const current = policies.get(policyId);
    const expected = current?.revision ?? 0;
    if (input.expectedRevision !== expected) {
      throw domainError('Conflict', `expected scan policy revision ${String(input.expectedRevision)} does not match current revision ${String(expected)}`, {
        details: { policyId, currentRevision: expected, expectedRevision: input.expectedRevision },
      });
    }

    const routes = canonicalRoutes(input.routes);
    const hashInput = {
      schemaVersion: ScanPolicySchemaVersion,
      policyId,
      caseId,
      name: input.name.trim(),
      isDefault: input.isDefault,
      routes,
    } as const;
    const policyHash = scanPolicyHashOf(hashInput);
    if (current?.policyHash === policyHash) return { policy: current, changed: false };

    const policy: ScanPolicy = {
      ...hashInput,
      revision: expected + 1,
      policyHash,
      updatedAt: now,
    };
    policies.set(policyId, policy);
    if (policy.isDefault) {
      for (const [otherId, other] of policies) {
        if (otherId === policyId || !other.isDefault) continue;
        const revised: ScanPolicy = {
          ...other,
          isDefault: false,
          revision: other.revision + 1,
          policyHash: scanPolicyHashOf({
            schemaVersion: ScanPolicySchemaVersion,
            policyId: other.policyId,
            caseId: other.caseId,
            name: other.name,
            isDefault: false,
            routes: other.routes,
          }),
          updatedAt: now,
        };
        policies.set(otherId, revised);
      }
    }
    return { policy, changed: true };
  }

  private casePolicies(caseId: string, now: string): Map<string, ScanPolicy> {
    let policies = this.byCase.get(caseId);
    if (policies === undefined) {
      policies = new Map([[STANDARD_SCAN_POLICY_ID, standardScanPolicy(caseId, now)]]);
      this.byCase.set(caseId, policies);
    }
    return policies;
  }
}

function validateScanPolicyInput(input: SaveScanPolicyRequest): void {
  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_POLICY_NAME_LENGTH) {
    throw domainError('ValidationFailed', `scan policy name must be 1..${String(MAX_POLICY_NAME_LENGTH)} characters`);
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw domainError('ValidationFailed', 'expectedRevision must be a non-negative integer');
  }
  if (!ScanAttackStrengths.includes(input.routes.zap.attackStrength)) {
    throw domainError('ValidationFailed', `unsupported ZAP attack strength: ${input.routes.zap.attackStrength}`);
  }
  if (!ScanAlertThresholds.includes(input.routes.zap.alertThreshold)) {
    throw domainError('ValidationFailed', `unsupported ZAP alert threshold: ${input.routes.zap.alertThreshold}`);
  }
  const knownChecks = new Set<string>(GenericHttpCheckIds);
  if (input.routes.genericHttp.checkIds.some((checkId) => !knownChecks.has(checkId))) {
    throw domainError('ValidationFailed', 'generic HTTP policy contains an unknown check id');
  }
  if (input.routes.genericHttp.enabled && input.routes.genericHttp.checkIds.length === 0) {
    throw domainError('ValidationFailed', 'enabled generic HTTP route needs at least one check');
  }
  if (input.routes.nuclei.templateIds.length > MAX_NUCLEI_TEMPLATE_IDS) {
    throw domainError('ValidationFailed', `Nuclei template selection exceeds ${String(MAX_NUCLEI_TEMPLATE_IDS)} ids`);
  }
  for (const templateId of input.routes.nuclei.templateIds) {
    if (!/^[A-Za-z0-9_.:/-]{1,200}$/u.test(templateId)) {
      throw domainError('ValidationFailed', `invalid Nuclei template id: ${templateId}`);
    }
  }
  if (!input.routes.zap.enabled && !input.routes.genericHttp.enabled && !input.routes.nuclei.enabled) {
    throw domainError('ValidationFailed', 'scan policy must enable at least one diagnostic route');
  }
}

function canonicalRoutes(routes: ScanPolicyRoutes): ScanPolicyRoutes {
  const checkIds = new Set(routes.genericHttp.checkIds);
  return {
    zap: { ...routes.zap },
    genericHttp: {
      enabled: routes.genericHttp.enabled,
      checkIds: GenericHttpCheckIds.filter((checkId) => checkIds.has(checkId)),
    },
    nuclei: {
      enabled: routes.nuclei.enabled,
      templateIds: [...new Set(routes.nuclei.templateIds.map((id) => id.trim()).filter((id) => id !== ''))].sort(),
    },
  };
}
