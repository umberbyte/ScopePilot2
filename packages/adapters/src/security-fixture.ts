import type { OtpInboxPort, SamlFixturePort } from '@scopepilot2/core';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface SecurityFixtureOptions {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly fetchImpl?: typeof fetch;
  readonly otpPollIntervalMs?: number;
}

function fixtureBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('security fixture URL must use http(s)');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('security fixture URL must resolve to an explicit loopback host');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('security fixture URL must not contain credentials, query, or fragment');
  }
  return parsed.toString().replace(/\/$/u, '');
}

function fixtureTargetUrl(value: string, label: string): string {
  const parsed = new URL(value);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') {
    throw new Error(`${label} must be an http(s) URL without embedded credentials`);
  }
  return parsed.toString();
}

function requiredString(record: Record<string, unknown>, name: string, maximumLength: number): string {
  const value = record[name];
  if (typeof value !== 'string' || value === '' || value.length > maximumLength) {
    throw new Error(`security fixture response field '${name}' is invalid`);
  }
  return value;
}

function requiredBoolean(record: Record<string, unknown>, name: string): boolean {
  const value = record[name];
  if (typeof value !== 'boolean') throw new Error(`security fixture response field '${name}' is invalid`);
  return value;
}

function nullableBoolean(record: Record<string, unknown>, name: string): boolean | null {
  const value = record[name];
  if (value !== null && typeof value !== 'boolean') throw new Error(`security fixture response field '${name}' is invalid`);
  return value;
}

function nullableStatus(record: Record<string, unknown>, name: string): number | null {
  const value = record[name];
  if (value !== null && (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 599)) {
    throw new Error(`security fixture response field '${name}' is invalid`);
  }
  return value as number | null;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted === true) abort();
  const timer = setTimeout(() => controller.abort(new Error('security fixture request timed out')), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function requestHeaders(token: string | undefined): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(token === undefined || token === '' ? {} : { Authorization: `Bearer ${token}` }),
  };
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Loopback の許可済み fixture controller から OTP を短時間だけ取得する。
 * OTP は返却値として Core に渡すだけで、この adapter はログ・ファイルへ保存しない。
 */
export class HttpSecurityFixtureOtpInbox implements OtpInboxPort {
  readonly engineVersion = 'scopepilot-security-fixture/1 otp-inbox';
  private readonly baseUrl: string;
  private readonly bearerToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;

  constructor(options: SecurityFixtureOptions) {
    this.baseUrl = fixtureBaseUrl(options.baseUrl);
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollIntervalMs = options.otpPollIntervalMs ?? 250;
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 50 || this.pollIntervalMs > 5_000) {
      throw new Error('OTP fixture poll interval must be 50..5000 ms');
    }
  }

  async waitForOtp(input: Parameters<OtpInboxPort['waitForOtp']>[0]): ReturnType<OtpInboxPort['waitForOtp']> {
    if (!/^[A-Za-z0-9._:/-]{1,128}$/u.test(input.mailboxRef)) {
      throw new Error('OTP mailboxRef must be a non-secret fixture reference');
    }
    const issuedAfterMs = Date.parse(input.issuedAfter);
    if (!Number.isFinite(issuedAfterMs)) throw new Error('OTP issuedAfter must be an ISO timestamp');
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 120_000) {
      throw new Error('OTP fixture timeout must be 100..120000 ms');
    }
    const deadline = Date.now() + input.timeoutMs;
    const endpoint = new URL(`${this.baseUrl}/v1/otp`);
    endpoint.searchParams.set('mailboxRef', input.mailboxRef);
    endpoint.searchParams.set('issuedAfter', new Date(issuedAfterMs).toISOString());
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const response = await fetchWithTimeout(this.fetchImpl, endpoint.toString(), {
        method: 'GET',
        headers: requestHeaders(this.bearerToken),
      }, Math.min(5_000, remaining), input.signal);
      if (response.status === 204) {
        await wait(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())), input.signal);
        continue;
      }
      if (response.status !== 200) throw new Error(`OTP fixture returned HTTP ${response.status}`);
      const body = await response.json() as unknown;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('OTP fixture returned invalid JSON');
      const record = body as Record<string, unknown>;
      const otp = requiredString(record, 'otp', 64);
      const receivedAt = requiredString(record, 'receivedAt', 64);
      const receivedAtMs = Date.parse(receivedAt);
      if (!Number.isFinite(receivedAtMs)) throw new Error("security fixture response field 'receivedAt' is invalid");
      if (receivedAtMs < issuedAfterMs) {
        await wait(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())), input.signal);
        continue;
      }
      return { otp, receivedAt: new Date(receivedAtMs).toISOString() };
    }
    return null;
  }
}

/** Isolated IdP/SP controller の固定 API だけを呼び、assertion 本文は受け取らない。 */
export class HttpSecurityFixtureSaml implements SamlFixturePort {
  readonly engineVersion = 'scopepilot-security-fixture/1 saml-replay';
  private readonly baseUrl: string;
  private readonly bearerToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SecurityFixtureOptions) {
    this.baseUrl = fixtureBaseUrl(options.baseUrl);
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async issueAndReplay(input: Parameters<SamlFixturePort['issueAndReplay']>[0]): ReturnType<SamlFixturePort['issueAndReplay']> {
    const idpStartUrl = fixtureTargetUrl(input.idpStartUrl, 'SAML IdP start URL');
    const acsUrl = fixtureTargetUrl(input.acsUrl, 'SAML ACS URL');
    if (input.role.trim() === '' || input.role.length > 128) throw new Error('SAML fixture role is invalid');
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/v1/saml/issue-and-replay`, {
      method: 'POST',
      headers: { ...requestHeaders(this.bearerToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ idpStartUrl, acsUrl, role: input.role }),
    }, 30_000, input.signal);
    if (response.status !== 200) throw new Error(`SAML fixture returned HTTP ${response.status}`);
    const body = await response.json() as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('SAML fixture returned invalid JSON');
    const record = body as Record<string, unknown>;
    if (record['fixtureIsolated'] !== true) throw new Error('SAML fixture did not attest isolated execution');
    const assertionHash = requiredString(record, 'assertionHash', 64);
    if (!/^[a-f0-9]{64}$/u.test(assertionHash)) throw new Error('SAML fixture assertionHash must be SHA-256 hex');
    return {
      controlAccepted: requiredBoolean(record, 'controlAccepted'),
      replayAccepted: nullableBoolean(record, 'replayAccepted'),
      controlStatus: nullableStatus(record, 'controlStatus'),
      replayStatus: nullableStatus(record, 'replayStatus'),
      assertionHash,
    };
  }
}

export function createSecurityFixtureAdapters(
  env: Readonly<Record<string, string | undefined>>,
): { readonly otpInbox: OtpInboxPort; readonly samlFixture: SamlFixturePort } | undefined {
  const baseUrl = env['SCOPEPILOT_SECURITY_FIXTURE_BASE_URL']?.trim();
  if (baseUrl === undefined || baseUrl === '') return undefined;
  const options: SecurityFixtureOptions = {
    baseUrl,
    ...(env['SCOPEPILOT_SECURITY_FIXTURE_TOKEN']?.trim()
      ? { bearerToken: env['SCOPEPILOT_SECURITY_FIXTURE_TOKEN']!.trim() }
      : {}),
  };
  return {
    otpInbox: new HttpSecurityFixtureOtpInbox(options),
    samlFixture: new HttpSecurityFixtureSaml(options),
  };
}
