import type { Finding } from '../findings/findings.ts';

export interface PassiveRule {
  readonly ruleId: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly version: string;
}

export interface PassiveStatus {
  readonly source: 'scopepilot-observation';
  readonly queued: number;
  readonly processed: number;
  readonly failed: number;
  readonly alerts: number;
  readonly limitations: readonly string[];
}

export interface PassiveAlertsResponse {
  /** A projection of the shared Findings ledger; findingId is unchanged. */
  readonly alerts: readonly Finding[];
}
