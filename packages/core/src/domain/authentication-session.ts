/**
 * 認証・セッション。`docs/detailed-design/f09-authentication-session.md` §3〜§6。
 * flow は最大 10 step・60 秒・retry 1。step 種別は allowlist。secret 値は永続層へ置かない。
 */
import { domainError } from '@scopepilot2/contracts';

export const LOGIN_FLOW_MAX_STEPS = 10;
export const LOGIN_FLOW_TIMEOUT_MS = 60_000;
export const LOGIN_FLOW_MAX_RETRIES = 1;

const ALLOWED_STEP_KINDS = ['navigate', 'fill', 'click', 'wait', 'extract', 'assert', 'select', 'assertValue'] as const;

export interface LoginFlowStep {
  readonly kind: (typeof ALLOWED_STEP_KINDS)[number];
  readonly target?: string;
  readonly secretReference?: string;
  /** Non-secret option value used by select/assertValue. */
  readonly value?: string;
}

/** 11 step は validation error (F09-UT-001)。allowlist 外 step も同様。 */
export function validateLoginFlow(steps: readonly LoginFlowStep[]): { stepCount: number } {
  if (steps.length > LOGIN_FLOW_MAX_STEPS) {
    throw domainError('ValidationFailed', `login flow exceeds ${LOGIN_FLOW_MAX_STEPS} steps`);
  }
  for (const step of steps) {
    if (!ALLOWED_STEP_KINDS.includes(step.kind)) {
      throw domainError('ValidationFailed', `login flow step kind not allowed: ${String(step.kind)}`);
    }
    if (step.kind === 'fill' && step.secretReference === undefined) {
      throw domainError('NeedsInput', 'fill step requires a secret reference (no inline secret values)');
    }
    if (step.kind === 'select' || step.kind === 'assertValue') {
      if (step.target?.trim() === '' || step.target === undefined) {
        throw domainError('ValidationFailed', `${step.kind} step requires a CSS selector target`);
      }
      if (step.value?.trim() === '' || step.value === undefined) {
        throw domainError('ValidationFailed', `${step.kind} step requires a non-empty option value`);
      }
    } else if (step.value !== undefined) {
      throw domainError('ValidationFailed', `value is only accepted by select and assertValue steps`);
    }
  }
  return { stepCount: steps.length };
}

export interface AuthDetectorInput {
  readonly expectedUrlPrefix: string;
  readonly finalUrl: string;
  readonly assertResult: boolean;
}

/** URL 一致だけでは認証済みとせず、assert 不一致は未認証 (F09-UT-002)。 */
export function detectAuthState(input: AuthDetectorInput): 'authenticated' | 'unauthenticated' {
  const urlMatches = input.finalUrl.startsWith(input.expectedUrlPrefix);
  return urlMatches && input.assertResult ? 'authenticated' : 'unauthenticated';
}

/** 同 role の同時 refresh は single-flight とし adapter を 1 回だけ呼ぶ (F09-UT-003)。
 *  retry 2 回目は lockout 回避のため停止する (F09-UT-004)。 */
export class SessionCoordinator {
  private readonly adapter: { refresh(role: string): Promise<string> };
  private inFlight: Promise<string> | null = null;
  private retries = 0;
  private revision = 0;
  private adapterCallCount = 0;

  constructor(adapter: { refresh(role: string): Promise<string> }) {
    this.adapter = adapter;
  }

  get adapterCalls(): number {
    return this.adapterCallCount;
  }

  async refresh(role: string): Promise<{ outcome: 'refreshed' | 'stopped-lockout-guard'; sessionRevision: number }> {
    if (this.inFlight !== null) {
      await this.inFlight;
      return { outcome: 'refreshed', sessionRevision: this.revision };
    }
    if (this.retries >= LOGIN_FLOW_MAX_RETRIES) {
      return { outcome: 'stopped-lockout-guard', sessionRevision: this.revision };
    }
    this.adapterCallCount += 1;
    this.inFlight = this.adapter.refresh(role);
    try {
      await this.inFlight;
      this.revision += 1;
      return { outcome: 'refreshed', sessionRevision: this.revision };
    } catch (cause) {
      this.retries += 1;
      throw cause;
    } finally {
      this.inFlight = null;
    }
  }
}

/** role 間で cookie jar を共有しない (F09-UT-005)。 */
export class RoleSessionRegistry {
  private readonly jars = new Map<string, { cookieNames: readonly string[] }>();

  assignJar(role: string, cookieNames: readonly string[]): { role: string; shared: boolean } {
    const existing = [...this.jars.entries()].find(([, jar]) => jar.cookieNames.some((name) => cookieNames.includes(name)));
    if (existing !== undefined && existing[0] !== role) {
      return { role, shared: true };
    }
    this.jars.set(role, { cookieNames });
    return { role, shared: false };
  }

  jarOf(role: string): { cookieNames: readonly string[] } | undefined {
    return this.jars.get(role);
  }
}

/** evidence projection に secret 値を含めない (F09-UT-006)。 */
export function vaultEvidenceProjection(input: { flowVersion: string; secretReference: string; secretValue?: string }): {
  flowVersion: string;
  secretReference: string;
} {
  return { flowVersion: input.flowVersion, secretReference: input.secretReference };
}

/** mTLS client certificate 不在は NeedsInput (F09-UT-007)。 */
export function requireMtlsBinding(input: { certificateAvailable: boolean; certAlias?: string }): { bound: boolean } {
  if (!input.certificateAvailable) {
    throw domainError('NeedsInput', 'mTLS client certificate is not available; operator must provide it via the OS certificate store');
  }
  return { bound: true };
}

/** virtual 60 秒を超えた flow は timeout とする (F09-UT-008)。 */
export function checkFlowDeadline(elapsedMs: number): { timedOut: boolean } {
  if (elapsedMs > LOGIN_FLOW_TIMEOUT_MS) {
    throw domainError('EngineFailure', `login flow exceeded ${LOGIN_FLOW_TIMEOUT_MS} ms deadline`, { retryable: true });
  }
  return { timedOut: false };
}
