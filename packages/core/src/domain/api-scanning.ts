/**
 * API 診断 (OpenAPI/Postman/GraphQL)。`docs/detailed-design/f12-api-scanning.md` §4〜§6。
 * 文書内の instruction/script は実行しない。変数解決は provenance 付き。
 * 生成 request は必ず ExecutionPlan に入り、認証秘密値は派生成果物へ複写しない。
 */
import { domainError } from '@scopepilot2/contracts';
import { ScopePolicy, type ScopeOrigins } from './scope-policy.ts';

/** 複数 server は scope 内のものだけ候補化する (F12-UT-001)。 */
export function normalizeOpenApiServers(servers: readonly string[], scope: ScopeOrigins): { candidates: readonly string[]; excluded: readonly string[] } {
  const candidates: string[] = [];
  const excluded: string[] = [];
  for (const server of servers) {
    if (ScopePolicy.decide(scope, server).allowed) {
      candidates.push(ScopePolicy.canonicalOrigin(server));
    } else {
      excluded.push(server);
    }
  }
  return { candidates, excluded };
}

/** pre-request script は実行せず unsupported warning を返す (F12-UT-002)。 */
export function normalizePostmanCollection(input: { name: string; hasPreRequestScript: boolean }): {
  warnings: readonly string[];
} {
  const warnings: string[] = [];
  if (input.hasPreRequestScript) {
    warnings.push(`collection ${input.name}: pre-request scripts are never executed; affected variables need explicit values (Unsupported)`);
  }
  return { warnings };
}

/** GraphQL mutation は write candidate と分類する (F12-UT-003)。 */
export function classifyGraphqlOperation(operation: { name: string; type: 'query' | 'mutation' }): { category: 'read' | 'write' } {
  return { category: operation.type === 'mutation' ? 'write' : 'read' };
}

export type VariableProvenance = 'case-setting' | 'environment-reference' | 'document-default';

/** 変数は定義順 (案件設定 > 環境参照 > 文書既定) で provenance 付き解決する (F12-UT-004)。 */
export function resolveVariable(
  name: string,
  layers: { caseSettings?: Record<string, string>; environmentReferences?: Record<string, string>; documentDefaults?: Record<string, string> },
): { resolved: true; value: string; provenance: VariableProvenance } | { resolved: false } {
  if (layers.caseSettings?.[name] !== undefined) {
    return { resolved: true, value: layers.caseSettings[name] ?? '', provenance: 'case-setting' };
  }
  if (layers.environmentReferences?.[name] !== undefined) {
    return { resolved: true, value: layers.environmentReferences[name] ?? '', provenance: 'environment-reference' };
  }
  if (layers.documentDefaults?.[name] !== undefined) {
    return { resolved: true, value: layers.documentDefaults[name] ?? '', provenance: 'document-default' };
  }
  return { resolved: false };
}

/** secret 変数が未解決なら値を推測せず NeedsInput (F12-UT-005)。 */
export function requireSecretVariable(name: string, resolution: { resolved: boolean; value?: string }): { value: string } {
  if (!resolution.resolved || (resolution.value ?? '') === '') {
    throw domainError('NeedsInput', `secret variable ${name} is unresolved; provide it via the OS secret store instead of guessing`);
  }
  return { value: resolution.value ?? '' };
}

/** binary schema は自動本文を作らず NeedsInput (F12-UT-006)。 */
export function buildApiRequestBody(schema: { readonly format: 'json' | 'binary' } | null): { kind: 'json' } | { kind: 'needs-input' } {
  if (schema === null) {
    return { kind: 'json' };
  }
  if (schema.format === 'binary') {
    throw domainError('NeedsInput', 'binary request bodies are never synthesized; provide the payload explicitly');
  }
  return { kind: 'json' };
}

const MAX_REFERENCE_DEPTH = 32;

/** 循環参照は bounded error とする (F12-UT-007)。 */
export function resolveSchemaReference(root: { components(): Record<string, unknown> }, startRef: string): { ref: string } {
  const components = root.components();
  const seen = new Set<string>();
  let current = startRef;
  for (let depth = 0; depth < MAX_REFERENCE_DEPTH; depth += 1) {
    if (seen.has(current)) {
      throw domainError('ValidationFailed', `cyclic schema reference detected at ${current} (bounded at depth ${MAX_REFERENCE_DEPTH})`);
    }
    seen.add(current);
    const next = components[current];
    if (next === undefined) {
      throw domainError('ValidationFailed', `unknown schema reference ${current}`);
    }
    const nextRef = (next as { '$ref'?: string })['$ref'];
    if (nextRef === undefined) {
      return { ref: current };
    }
    current = nextRef.replace(/^#\/components\/schemas\//, '');
  }
  throw domainError('ValidationFailed', `schema reference depth exceeds ${MAX_REFERENCE_DEPTH}`);
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

/**
 * OpenAPI (3.x) / Swagger (2.x) 文書の最小 parse。文書内の instruction/script は
 * 実行しない (f12)。server 候補と path×method の endpoint 一覧を返す。
 * path template ({id} 等) はそのまま返し、呼出側で警告として扱う。
 */
export function parseOpenApiDocument(document: unknown): { servers: readonly string[]; endpoints: readonly { method: string; path: string }[] } {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw domainError('ValidationFailed', 'api spec must be a JSON object');
  }
  const record = document as Record<string, unknown>;
  const version = record.openapi ?? record.swagger;
  if (typeof version !== 'string') {
    throw domainError('ValidationFailed', 'api spec must declare openapi or swagger version');
  }
  const servers: string[] = [];
  if (Array.isArray(record.servers)) {
    for (const server of record.servers) {
      if (typeof server === 'object' && server !== null && typeof (server as { url?: unknown }).url === 'string') {
        servers.push((server as { url: string }).url);
      }
    }
  }
  if (servers.length === 0 && typeof record.host === 'string') {
    const schemes = Array.isArray(record.schemes) && record.schemes.every((scheme) => typeof scheme === 'string') ? (record.schemes as string[]) : ['https'];
    const basePath = typeof record.basePath === 'string' ? record.basePath : '';
    for (const scheme of schemes) {
      servers.push(`${scheme}://${record.host}${basePath}`);
    }
  }
  if (servers.length === 0) {
    throw domainError('ValidationFailed', 'api spec has no usable server entry');
  }
  const paths = record.paths;
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
    throw domainError('ValidationFailed', 'api spec must have a paths object');
  }
  const endpoints: { method: string; path: string }[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      if ((item as Record<string, unknown>)[method] !== undefined) {
        endpoints.push({ method: method.toUpperCase(), path });
      }
    }
  }
  if (endpoints.length === 0) {
    throw domainError('ValidationFailed', 'api spec has no endpoint operations');
  }
  return { servers, endpoints };
}

/** 文書由来の候補は observed=false を保持する (F12-UT-008)。 */
export function planApiCandidates(operations: readonly { readonly method: string; readonly path: string; readonly source: 'document' | 'observation' }[]): readonly { method: string; path: string; observed: boolean }[] {
  return operations.map((operation) => ({
    method: operation.method,
    path: operation.path,
    observed: operation.source === 'observation',
  }));
}
