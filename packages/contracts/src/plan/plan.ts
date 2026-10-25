/** ExecutionPlan と確認の契約型。`docs/design/22-execution-control.md` 2章。 */
import type { OperationClass } from '../case/case.ts';

export const EngineKinds = ['node-http', 'playwright', 'zap', 'nuclei', 'oast'] as const;

export type EngineKind = (typeof EngineKinds)[number];

/** 保証等級。`docs/design/22-execution-control.md` 3章。Delegated は送信前拒否を保証しない。 */
export const GuaranteeLevels = ['Enforced', 'Delegated', 'Unsupported'] as const;

export type GuaranteeLevel = (typeof GuaranteeLevels)[number];

export interface PlanLimits {
  readonly maxRequests: number;
  readonly maxPages: number;
  readonly maxDurationMinutes: number;
  readonly maxConcurrency: number;
  readonly requestsPerSecond: number;
}

export const PlanStepKinds = ['explore', 'active-scan', 'workflow-scan', 'nuclei-scan', 'report'] as const;

export type PlanStepKind = (typeof PlanStepKinds)[number];

export interface PlanStep {
  readonly stepId: string;
  readonly kind: PlanStepKind;
  readonly operationClass: OperationClass;
  /** 正規化済み URL の固定 snapshot。実行中に変化しない。 */
  readonly targetSnapshot: readonly string[];
  readonly engineKind: EngineKind;
  readonly guarantee: GuaranteeLevel;
  readonly engineVersion?: string;
  /** この step に貸し出す上限。Delegated step は maxOvershoot 分を予約する。 */
  readonly limits: PlanLimits;
}

export interface ExecutionPlan {
  readonly planId: string;
  readonly caseId: string;
  readonly authorizationId: string;
  readonly operatorId: string;
  readonly targetRole: string;
  readonly steps: readonly PlanStep[];
  /** 案件の共有上限から step へ配分する前の plan 全体枠。 */
  readonly limits: PlanLimits;
  readonly runtimeBundleHash: string;
  readonly inputEvidenceHash: string;
  readonly createdAt: string;
}

/** plan hash の対象は volatil な id・時刻を除いた正規化内容。同じ入力から同じ hash を返す。 */
export interface PlanHashInput {
  readonly schemaVersion: 'scopepilot2.plan.v1';
  readonly caseId: string;
  readonly authorizationId: string;
  readonly operatorId: string;
  readonly targetRole: string;
  readonly steps: readonly {
    readonly kind: PlanStepKind;
    readonly operationClass: OperationClass;
    readonly targetSnapshot: readonly string[];
    readonly engineKind: EngineKind;
    readonly guarantee: GuaranteeLevel;
    readonly engineVersion?: string;
    readonly limits: PlanLimits;
  }[];
  readonly limits: PlanLimits;
  readonly runtimeBundleHash: string;
  readonly inputEvidenceHash: string;
}

/** 操作者が確認した内容の写し。hash と内容の両方で計画との一致を検証する。 */
export interface PlanConfirmation {
  readonly confirmationId: string;
  readonly planHash: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly confirmedView: readonly {
    readonly kind: PlanStepKind;
    readonly targets: readonly string[];
    readonly limits: PlanLimits;
  }[];
}
