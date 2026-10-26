/**
 * ScopePilot が直接送信する診断入力の、版管理された静的カタログ。
 *
 * ペイロードは実行時に生成せず、リポジトリ内でレビュー済みの定義だけを利用する。
 * カタログの検証では、状態変更・残留物・遅延を伴う入力に必要な安全属性も強制する。
 */
import { createHash } from 'node:crypto';
import catalogJson from '../catalog/workflow-v2.json' with { type: 'json' };

export const PAYLOAD_CAPABILITIES = [
  'authentication-throttling',
  'sql-injection',
  'command-injection',
  'csrf-control',
  'workflow-state',
  'csp-runtime',
  'padding-oracle',
  'file-upload',
  'browser-canary',
] as const;
export type PayloadCapability = (typeof PAYLOAD_CAPABILITIES)[number];

export const PAYLOAD_CONTEXTS = [
  'query',
  'form',
  'json',
  'header',
  'multipart',
  'html',
  'browser',
  'binary',
  'session',
  'workflow',
] as const;
export type PayloadContext = (typeof PAYLOAD_CONTEXTS)[number];

export const PAYLOAD_PLATFORMS = ['any', 'posix', 'windows', 'php', 'browser', 'sql'] as const;
export type PayloadPlatform = (typeof PAYLOAD_PLATFORMS)[number];

export const PAYLOAD_RISKS = ['read-only', 'bounded-delay', 'state-changing', 'artifact-producing'] as const;
export type PayloadRisk = (typeof PAYLOAD_RISKS)[number];

export const PAYLOAD_ORACLES = [
  'marker-in-response',
  'response-differential',
  'timing-differential',
  'rate-limit-profile',
  'browser-side-effect',
  'state-change-verification',
  'response-cluster',
  'downstream-differential',
  'artifact-retrieval',
] as const;
export type PayloadOracle = (typeof PAYLOAD_ORACLES)[number];

export const PAYLOAD_MUTATIONS = [
  'omit-field',
  'replace-field',
  'reuse-value',
  'cross-session-value',
  'replay-step',
  'skip-step',
  'reorder-step',
  'xor-byte',
] as const;
export type PayloadMutationOperator = (typeof PAYLOAD_MUTATIONS)[number];

export interface PayloadSafety {
  readonly risk: PayloadRisk;
  readonly maxAttempts: number;
  readonly requiresConfirmation: boolean;
  readonly requiresTestAccount: boolean;
  readonly requiresRollback: boolean;
  readonly leavesResidue: boolean;
  readonly maxDelayMs?: number;
  readonly cleanupStrategy?: string;
}

export interface PayloadMutation {
  readonly operator: PayloadMutationOperator;
  readonly target: string;
  readonly valueTemplate?: string;
  readonly byteOffset?: number;
  readonly xorValue?: number;
}

export interface PayloadDefinition {
  readonly id: string;
  readonly capability: PayloadCapability;
  readonly contexts: readonly PayloadContext[];
  readonly platforms: readonly PayloadPlatform[];
  readonly template?: string;
  readonly variables: readonly string[];
  readonly pairId?: string;
  readonly oracle: PayloadOracle;
  readonly tags: readonly string[];
  readonly safety: PayloadSafety;
  readonly mutation?: PayloadMutation;
}

export interface PayloadCatalogMetadata {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly publishedAt: string;
  readonly generated: false;
  readonly description: string;
}

export interface PayloadCatalog {
  readonly schemaVersion: 1;
  readonly catalog: PayloadCatalogMetadata;
  readonly payloads: readonly PayloadDefinition[];
}

export interface PayloadSelection {
  readonly capability?: PayloadCapability;
  readonly context?: PayloadContext;
  readonly platform?: PayloadPlatform;
  readonly oracle?: PayloadOracle;
  readonly maximumRisk?: PayloadRisk;
  readonly tags?: readonly string[];
}

const VARIABLE_PATTERN = /\{\{([a-z][a-zA-Z0-9_]*)\}\}/g;
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const RISK_ORDER: Readonly<Record<PayloadRisk, number>> = {
  'read-only': 0,
  'bounded-delay': 1,
  'state-changing': 2,
  'artifact-producing': 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function requireString(value: unknown, path: string, maximum = 4_096): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new TypeError(`${path} must be a non-empty string up to ${String(maximum)} characters`);
  }
  return value;
}

function optionalString(value: unknown, path: string, maximum = 4_096): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, path, maximum);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean`);
  return value;
}

function requireInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${path} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return value as number;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${path} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function requireStringArray(value: unknown, path: string, maximum = 32): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${path} must be an array with at most ${String(maximum)} entries`);
  const strings = value.map((entry, index) => requireString(entry, `${path}[${String(index)}]`, 128));
  if (new Set(strings).size !== strings.length) throw new TypeError(`${path} must not contain duplicates`);
  return strings;
}

function requireEnumArray<T extends string>(value: unknown, allowed: readonly T[], path: string): T[] {
  const strings = requireStringArray(value, path);
  if (strings.length === 0) throw new TypeError(`${path} must not be empty`);
  return strings.map((entry, index) => requireEnum(entry, allowed, `${path}[${String(index)}]`));
}

function parseSafety(value: unknown, path: string): PayloadSafety {
  const record = requireRecord(value, path);
  const risk = requireEnum(record.risk, PAYLOAD_RISKS, `${path}.risk`);
  const maxAttempts = requireInteger(record.maxAttempts, `${path}.maxAttempts`, 1, 20);
  const requiresConfirmation = requireBoolean(record.requiresConfirmation, `${path}.requiresConfirmation`);
  const requiresTestAccount = requireBoolean(record.requiresTestAccount, `${path}.requiresTestAccount`);
  const requiresRollback = requireBoolean(record.requiresRollback, `${path}.requiresRollback`);
  const leavesResidue = requireBoolean(record.leavesResidue, `${path}.leavesResidue`);
  const maxDelayMs = record.maxDelayMs === undefined
    ? undefined
    : requireInteger(record.maxDelayMs, `${path}.maxDelayMs`, 1, 5_000);
  const cleanupStrategy = optionalString(record.cleanupStrategy, `${path}.cleanupStrategy`, 512);

  if (risk === 'bounded-delay' && maxDelayMs === undefined) {
    throw new TypeError(`${path}.maxDelayMs is required for bounded-delay payloads`);
  }
  if ((risk === 'state-changing' || risk === 'artifact-producing') && !requiresConfirmation) {
    throw new TypeError(`${path}.requiresConfirmation must be true for ${risk} payloads`);
  }
  if (risk === 'state-changing' && !requiresRollback) {
    throw new TypeError(`${path}.requiresRollback must be true for state-changing payloads`);
  }
  if (leavesResidue && cleanupStrategy === undefined) {
    throw new TypeError(`${path}.cleanupStrategy is required when leavesResidue is true`);
  }
  return {
    risk,
    maxAttempts,
    requiresConfirmation,
    requiresTestAccount,
    requiresRollback,
    leavesResidue,
    ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
    ...(cleanupStrategy === undefined ? {} : { cleanupStrategy }),
  };
}

function parseMutation(value: unknown, path: string): PayloadMutation | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, path);
  const operator = requireEnum(record.operator, PAYLOAD_MUTATIONS, `${path}.operator`);
  const target = requireString(record.target, `${path}.target`, 128);
  const valueTemplate = optionalString(record.valueTemplate, `${path}.valueTemplate`, 2_048);
  const byteOffset = record.byteOffset === undefined ? undefined : requireInteger(record.byteOffset, `${path}.byteOffset`, -4_096, 4_096);
  const xorValue = record.xorValue === undefined ? undefined : requireInteger(record.xorValue, `${path}.xorValue`, 1, 255);
  if (operator === 'xor-byte' && (byteOffset === undefined || xorValue === undefined)) {
    throw new TypeError(`${path}.byteOffset and xorValue are required for xor-byte mutations`);
  }
  return {
    operator,
    target,
    ...(valueTemplate === undefined ? {} : { valueTemplate }),
    ...(byteOffset === undefined ? {} : { byteOffset }),
    ...(xorValue === undefined ? {} : { xorValue }),
  };
}

function templateVariables(...templates: readonly (string | undefined)[]): string[] {
  const variables = new Set<string>();
  for (const template of templates) {
    if (template === undefined) continue;
    for (const match of template.matchAll(VARIABLE_PATTERN)) {
      const variable = match[1];
      if (variable !== undefined) variables.add(variable);
    }
  }
  return [...variables].sort();
}

function parsePayload(value: unknown, index: number): PayloadDefinition {
  const path = `payloads[${String(index)}]`;
  const record = requireRecord(value, path);
  const id = requireString(record.id, `${path}.id`, 128);
  if (!ID_PATTERN.test(id)) throw new TypeError(`${path}.id has an invalid format`);
  const capability = requireEnum(record.capability, PAYLOAD_CAPABILITIES, `${path}.capability`);
  const contexts = requireEnumArray(record.contexts, PAYLOAD_CONTEXTS, `${path}.contexts`);
  const platforms = requireEnumArray(record.platforms, PAYLOAD_PLATFORMS, `${path}.platforms`);
  const template = optionalString(record.template, `${path}.template`, 2_048);
  const variables = requireStringArray(record.variables, `${path}.variables`);
  const pairId = optionalString(record.pairId, `${path}.pairId`, 128);
  const oracle = requireEnum(record.oracle, PAYLOAD_ORACLES, `${path}.oracle`);
  const tags = requireStringArray(record.tags, `${path}.tags`);
  const safety = parseSafety(record.safety, `${path}.safety`);
  const mutation = parseMutation(record.mutation, `${path}.mutation`);
  if (template === undefined && mutation === undefined) throw new TypeError(`${path} must define template or mutation`);
  const referenced = templateVariables(template, mutation?.valueTemplate);
  const declared = [...variables].sort();
  if (JSON.stringify(referenced) !== JSON.stringify(declared)) {
    throw new TypeError(`${path}.variables must exactly match template placeholders (${referenced.join(', ')})`);
  }
  return {
    id,
    capability,
    contexts,
    platforms,
    ...(template === undefined ? {} : { template }),
    variables,
    ...(pairId === undefined ? {} : { pairId }),
    oracle,
    tags,
    safety,
    ...(mutation === undefined ? {} : { mutation }),
  };
}

/** Parse and validate an untrusted catalog document before any payload can be selected. */
export function parsePayloadCatalog(value: unknown): PayloadCatalog {
  const root = requireRecord(value, 'catalog document');
  if (root.schemaVersion !== 1) throw new TypeError('schemaVersion must be 1');
  const metadataRecord = requireRecord(root.catalog, 'catalog');
  const id = requireString(metadataRecord.id, 'catalog.id', 128);
  if (!ID_PATTERN.test(id)) throw new TypeError('catalog.id has an invalid format');
  const version = requireString(metadataRecord.version, 'catalog.version', 32);
  if (!VERSION_PATTERN.test(version)) throw new TypeError('catalog.version must be semantic version x.y.z');
  const metadata: PayloadCatalogMetadata = {
    id,
    version,
    source: requireString(metadataRecord.source, 'catalog.source', 256),
    publishedAt: requireString(metadataRecord.publishedAt, 'catalog.publishedAt', 64),
    generated: metadataRecord.generated === false ? false : (() => { throw new TypeError('catalog.generated must be false'); })(),
    description: requireString(metadataRecord.description, 'catalog.description', 1_024),
  };
  if (!Array.isArray(root.payloads) || root.payloads.length === 0 || root.payloads.length > 500) {
    throw new TypeError('payloads must contain between 1 and 500 entries');
  }
  const payloads = root.payloads.map(parsePayload);
  const byId = new Map<string, PayloadDefinition>();
  for (const payload of payloads) {
    if (byId.has(payload.id)) throw new TypeError(`duplicate payload id: ${payload.id}`);
    byId.set(payload.id, payload);
  }
  for (const payload of payloads) {
    if (payload.pairId === undefined) continue;
    const pair = byId.get(payload.pairId);
    if (pair === undefined) throw new TypeError(`payload ${payload.id} references missing pair ${payload.pairId}`);
    if (pair.capability !== payload.capability || pair.oracle !== payload.oracle) {
      throw new TypeError(`payload ${payload.id} pair must use the same capability and oracle`);
    }
  }
  return deepFreeze({ schemaVersion: 1, catalog: metadata, payloads });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function payloadCatalogSha256(catalog: PayloadCatalog): string {
  return createHash('sha256').update(canonicalize(catalog), 'utf8').digest('hex');
}

export function payloadCatalogReference(catalog: PayloadCatalog): string {
  return `${catalog.catalog.id}/v${catalog.catalog.version} sha256:${payloadCatalogSha256(catalog)}`;
}

/** Select payloads by observed input context and the caller's accepted risk ceiling. */
export function selectPayloads(catalog: PayloadCatalog, selection: PayloadSelection): readonly PayloadDefinition[] {
  const maximumRisk = selection.maximumRisk ?? 'artifact-producing';
  const requiredTags = new Set(selection.tags ?? []);
  return catalog.payloads.filter((payload) => {
    if (selection.capability !== undefined && payload.capability !== selection.capability) return false;
    if (selection.context !== undefined && !payload.contexts.includes(selection.context)) return false;
    if (selection.platform !== undefined && !payload.platforms.includes('any') && !payload.platforms.includes(selection.platform)) return false;
    if (selection.oracle !== undefined && payload.oracle !== selection.oracle) return false;
    if (RISK_ORDER[payload.safety.risk] > RISK_ORDER[maximumRisk]) return false;
    return [...requiredTags].every((tag) => payload.tags.includes(tag));
  });
}

export function payloadById(catalog: PayloadCatalog, id: string): PayloadDefinition {
  const payload = catalog.payloads.find((candidate) => candidate.id === id);
  if (payload === undefined) throw new RangeError(`unknown payload id: ${id}`);
  return payload;
}

/** Render a reviewed template. Missing variables and undeclared caller values are rejected. */
export function renderPayload(payload: PayloadDefinition, values: Readonly<Record<string, string | number>>): string {
  const template = payload.template ?? payload.mutation?.valueTemplate;
  if (template === undefined) throw new TypeError(`payload ${payload.id} does not define a renderable template`);
  const provided = Object.keys(values).sort();
  const expected = [...payload.variables].sort();
  if (JSON.stringify(provided) !== JSON.stringify(expected)) {
    throw new TypeError(`payload ${payload.id} requires exactly: ${expected.join(', ')}`);
  }
  return template.replace(VARIABLE_PATTERN, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new TypeError(`missing payload variable: ${name}`);
    const text = String(value);
    if (text.length > 512 || /[\r\n]/.test(text)) throw new TypeError(`payload variable ${name} is invalid`);
    return text;
  });
}

export const WORKFLOW_PAYLOAD_CATALOG = parsePayloadCatalog(catalogJson);
export const WORKFLOW_PAYLOAD_CATALOG_SHA256 = payloadCatalogSha256(WORKFLOW_PAYLOAD_CATALOG);
export const WORKFLOW_PAYLOAD_CATALOG_REFERENCE = payloadCatalogReference(WORKFLOW_PAYLOAD_CATALOG);

