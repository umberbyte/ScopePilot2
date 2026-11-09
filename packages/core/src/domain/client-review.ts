import { createHash, createHmac, timingSafeEqual, createPublicKey, X509Certificate, verify } from 'node:crypto';
import { canonicalJson, type AssetObservation, type ClientReviewSignal } from '@scopepilot2/contracts';

export const CLIENT_ANALYZER_VERSION = 'client-review-1';
export const MAX_ASSET_BYTES = 1024 * 1024;
export const assetHash = (text: string): string => createHash('sha256').update(text).digest('hex');
export function sanitiseObservationUrl(value: string): string {
  const url = new URL(value);
  url.username = ''; url.password = '';
  for (const name of [...url.searchParams.keys()]) {
    if (/token|secret|password|credential|authorization|api.?key|^code$/i.test(name)) url.searchParams.set(name, '[REDACTED]');
  }
  return url.href;
}
export interface ComponentDatabase {
  readonly source: string;
  readonly version: string;
  readonly sha256: string;
  readonly entries: readonly { readonly id: string; readonly name: string; readonly aliases?: readonly string[]; readonly introduced: string; readonly fixed: string }[];
}
export function validateComponentDatabase(db: ComponentDatabase): void {
  if (!db.source || !db.version || db.entries.length > 10000 || assetHash(canonicalJson(db.entries)) !== db.sha256) throw new Error('invalid component database snapshot');
  for (const entry of db.entries) {
    if (!versionParts(entry.introduced) || !versionParts(entry.fixed)) throw new Error('unsupported component database version range');
  }
}
function versionParts(value: string): number[] | null {
  return /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value.split('.').map(Number) : null;
}
function compare(a: string, b: string): number {
  const left = versionParts(a)!, right = versionParts(b)!;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}
const knownNames = ['jquery', 'lodash', 'angular', 'react', 'express', 'moment'];
function oneEdit(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
  }
  return true;
}
export function allowedTextAsset(url: string, mime: string): boolean {
  const path = new URL(url).pathname;
  if (/\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|zip|gz|exe|dll|wasm)$/i.test(path)) return false;
  return /^(?:text\/(?:plain|javascript|html|xml)|application\/(?:javascript|json|[^;]+\+json|xml|x-pem-file|pkix-cert|x-x509-ca-cert))(?:;|$)/i.test(mime);
}
/** In-memory JWT review. No payload/header values are returned. Acceptance needs a separate active assertion. */
export function reviewJwt(token: string, publicKey?: string): readonly ClientReviewSignal[] {
  if (token.length > 16384) return [];
  const parts = token.split('.');
  if (parts.length !== 3) return [];
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<string, unknown>;
    if (!header || !payload || typeof header.alg !== 'string') return [];
    const signals: ClientReviewSignal[] = [];
    const add = (ruleId: string, detail: string) => signals.push({ kind: 'jwt', ruleId, confidence: 1, detail, fingerprint: assetHash(token) });
    if (header.alg.toLowerCase() === 'none') add('jwt-none', 'Unsigned JWT configuration observed; server acceptance untested');
    if (payload.exp === undefined) add('jwt-no-exp', 'JWT has no expiry claim; server policy untested');
    if (header.jwk !== undefined || header.jku !== undefined || header.x5u !== undefined) add('jwt-key-reference', 'Token supplies a key reference; trust and key confusion untested');
    if (header.alg === 'HS256') {
      const observed = Buffer.from(parts[2]!, 'base64url');
      const keys = [...(publicKey ? [publicKey] : []), 'secret', 'password', 'changeme'];
      for (const key of keys) {
        const expected = createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest();
        if (observed.length === expected.length && timingSafeEqual(observed, expected)) {
          add(key === publicKey ? 'jwt-key-confusion' : 'jwt-weak-key', 'Signature matches review key; server acceptance and token mutation untested');
          break;
        }
      }
    }
    if (publicKey && header.alg === 'RS256') {
      const valid = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey(publicKey), Buffer.from(parts[2]!, 'base64url'));
      add('jwt-signature', valid ? 'Signature matches supplied public key; acceptance untested' : 'Signature does not match supplied public key');
    }
    return signals;
  } catch { return []; }
}
/** Passive only: no network lookup, evaluation, or execution of untrusted code. */
export function analyzeClientAsset(input: { url: string; sourceUrl: string; contentType: string; body: string; headers?: Readonly<Record<string, string>>; database?: ComponentDatabase }): AssetObservation | null {
  const { body } = input;
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_ASSET_BYTES || body.includes('\0') || !allowedTextAsset(input.url, input.contentType) || new URL(input.url).origin !== new URL(input.sourceUrl).origin) return null;
  if (input.database) validateComponentDatabase(input.database);
  const signals: ClientReviewSignal[] = [];
  const components = new Map<string, { name: string; version?: string }>();
  const addComponent = (name: string, version?: string) => {
    name = name.toLowerCase();
    if (name.length > 100 || components.size >= 128 || !/^(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]+$/.test(name)) return;
    const component = { name, ...(version && versionParts(version) ? { version } : {}) };
    components.set(`${name}@${component.version ?? '?'}`, component);
  };
  for (const name of ['server', 'x-powered-by']) {
    const value = input.headers?.[name] ?? '';
    const match = value.match(/^(nginx|apache|express|php)[ /](\d+\.\d+\.\d+)(?:$|[ ;])/i);
    if (match) addComponent(match[1]!, match[2]);
  }
  // Versioned banner signatures and package metadata; never infer a version from an API name.
  for (const match of body.matchAll(/\b(jquery|lodash|angular|react|moment)[ /@v-]+(\d+\.\d+\.\d+)\b/gi)) addComponent(match[1]!, match[2]);
  try {
    const metadata = JSON.parse(body) as Record<string, unknown>;
    if (typeof metadata.name === 'string') addComponent(metadata.name, typeof metadata.version === 'string' ? metadata.version : undefined);
    if (metadata.dependencies && typeof metadata.dependencies === 'object') {
      for (const [name, version] of Object.entries(metadata.dependencies).slice(0, 128)) addComponent(name, typeof version === 'string' ? version : undefined);
    }
    if (Array.isArray(metadata.sources)) {
      for (const source of metadata.sources.slice(0, 512)) {
        if (typeof source !== 'string') continue;
        const match = source.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
        if (match) addComponent(match[1]!);
      }
    }
  } catch { /* A JavaScript bundle is usually not JSON. */ }
  for (const component of components.values()) {
    signals.push({ kind: 'dependency', ruleId: 'declared-component', confidence: 0.8, detail: 'Dependency declaration observed; presence and exploitability unverified', component });
    const similar = knownNames.find((name) => oneEdit(name, component.name));
    if (similar) signals.push({ kind: 'typosquatting', ruleId: 'name-one-edit', confidence: 0.4, detail: `Name resembles ${similar}; manual review required`, component });
    if (component.version && input.database) for (const entry of input.database.entries) {
      if ((entry.name === component.name || entry.aliases?.includes(component.name)) && compare(component.version, entry.introduced) >= 0 && compare(component.version, entry.fixed) < 0) {
        signals.push({ kind: 'component-db', ruleId: entry.id, confidence: 0.8, detail: 'Declared version matches local advisory range; exploitability unverified', component });
      }
    }
  }
  for (const [ruleId, pattern] of [['jquery-html', /(?:\bjQuery|\$)\([^\n;]{0,100}\)\.html\(/], ['lodash-template', /\b_\.template\(/]] as const) {
    if (pattern.test(body)) signals.push({ kind: 'unsafe-api', ruleId, confidence: 0.4, detail: 'Potentially unsafe API usage; input trust unverified' });
  }
  // Two-stage, versioned secret patterns. Never return matched text or context.
  for (const [ruleId, pattern] of [['aws-access-key', /\bAKIA[A-Z0-9]{16}\b/g], ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g], ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{30,10000}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]] as const) {
    let count = 0;
    for (const match of body.matchAll(pattern)) {
      if (++count > 16) break;
      const value = match[0];
      const frequencies = new Map<string, number>();
      for (const char of value) frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
      const entropy = [...frequencies.values()].reduce((sum, n) => sum - n / value.length * Math.log2(n / value.length), 0);
      if (entropy < 3) continue;
      signals.push({ kind: 'secret', ruleId, confidence: 0.85, detail: 'Secret-shaped material in served response [REDACTED]; validity untested', fingerprint: assetHash(value) });
    }
  }
  const pem = body.match(/-----BEGIN (PUBLIC KEY|CERTIFICATE)-----[\s\S]{1,16384}?-----END \1-----/);
  if (pem) try {
    const key = pem[1] === 'CERTIFICATE' ? new X509Certificate(pem[0]).publicKey : createPublicKey(pem[0]);
    const bits = key.asymmetricKeyDetails?.modulusLength;
    signals.push({ kind: 'public-key', ruleId: bits && bits < 2048 ? 'weak-rsa-key' : 'key-properties', confidence: 1, detail: `Public key algorithm=${key.asymmetricKeyType ?? 'unknown'}${bits ? ` bits=${bits}` : ''}`, fingerprint: assetHash(pem[0]) });
  } catch { /* Invalid PEM is not a key observation. */ }
  for (const match of body.matchAll(/\beyJ[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{0,2048}/g)) {
    if (signals.length >= 256) break;
    signals.push(...reviewJwt(match[0]));
  }
  return { url: sanitiseObservationUrl(input.url), sourceUrl: sanitiseObservationUrl(input.sourceUrl), contentType: input.contentType, bytes, sha256: assetHash(body), analyzerVersion: CLIENT_ANALYZER_VERSION, signals: signals.slice(0, 256), ...(input.database ? { database: { source: input.database.source, version: input.database.version, sha256: input.database.sha256 } } : {}) };
}
