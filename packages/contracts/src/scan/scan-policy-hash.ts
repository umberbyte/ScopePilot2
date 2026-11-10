import { hashStable } from '../plan/canonical.ts';
import type { ScanPolicyHashInput } from './scan-policy.ts';

/** revision・更新時刻は内容 hash に含めず、同じ内容の再保存を no-op と判定できるようにする。 */
export function scanPolicyHashOf(input: ScanPolicyHashInput): string {
  return hashStable('scopepilot2.scan-policy', input);
}
