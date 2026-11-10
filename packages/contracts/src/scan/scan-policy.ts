/**
 * 案件単位の診断ポリシー契約。design/40 A40/A43・owner decision Q6。
 * ZAP の個別 rule ID は扱わず、経路単位と ZAP 全体の強度・閾値だけを固定する。
 */
import type { ScanAttackStrength } from './scan.ts';

export const ScanPolicySchemaVersion = 'scopepilot2.scan-policy.v1' as const;

export const ScanAlertThresholds = ['Off', 'Default', 'Low', 'Medium', 'High'] as const;
export type ScanAlertThreshold = (typeof ScanAlertThresholds)[number];

export const GenericHttpCheckIds = [
  'security-headers',
  'cookie-security',
  'cors-policy',
  'error-disclosure',
  'dom-source-sink',
  'reflected-input',
  'sql-error',
  'open-redirect',
  'path-traversal',
] as const;
export type GenericHttpCheckId = (typeof GenericHttpCheckIds)[number];

export const ScanPolicyRouteKinds = ['zap', 'generic-http', 'nuclei'] as const;
export type ScanPolicyRouteKind = (typeof ScanPolicyRouteKinds)[number];

export interface ScanPolicyRoutes {
  readonly zap: {
    readonly enabled: boolean;
    readonly attackStrength: ScanAttackStrength;
    readonly alertThreshold: ScanAlertThreshold;
  };
  readonly genericHttp: {
    readonly enabled: boolean;
    readonly checkIds: readonly GenericHttpCheckId[];
  };
  readonly nuclei: {
    /** capability が無い案件では A40 で選択不可。 */
    readonly enabled: boolean;
    /** 空配列は、審査済み manifest 内の全 HTTP template を表す。 */
    readonly templateIds: readonly string[];
  };
}
export interface ScanPolicy {
  readonly schemaVersion: typeof ScanPolicySchemaVersion;
  readonly policyId: string;
  readonly caseId: string;
  readonly name: string;
  readonly revision: number;
  readonly isDefault: boolean;
  readonly routes: ScanPolicyRoutes;
  readonly policyHash: string;
  readonly updatedAt: string;
}

export interface SaveScanPolicyRequest {
  /** 新規作成は 0、更新は現在の revision。 */
  readonly expectedRevision: number;
  readonly policyId?: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly routes: ScanPolicyRoutes;
}
export interface ScanPolicyRouteOverrides {
  readonly zap?: boolean;
  readonly genericHttp?: boolean;
  readonly nuclei?: boolean;
}

export interface ScanPolicyHashInput {
  readonly schemaVersion: typeof ScanPolicySchemaVersion;
  readonly policyId: string;
  readonly caseId: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly routes: ScanPolicyRoutes;
}
// Node 専用の hash 計算は scan-policy-hash.ts に分離し、この契約を renderer から安全に読めるようにする。
