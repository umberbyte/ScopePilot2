/**
 * API 診断 (OpenAPI/Postman/GraphQL)。`docs/detailed-design/f12-api-scanning.md` §4〜§6。
 * 文書内の instruction/script は実行しない。変数解決は provenance 付き。
 * 生成 request は必ず ExecutionPlan に入り、認証秘密値は派生成果物へ複写しない。
 */
import { domainError, type RequestInputPoint } from '@scopepilot2/contracts';
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

export interface ParsedOpenApiEndpoint {
  readonly method: string;
  readonly path: string;
  readonly inputPoints: readonly RequestInputPoint[];
  readonly contentType?: string;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Resolve a local JSON pointer only. Remote references are never fetched. */
function resolveLocalReference(root: Record<string, unknown>, value: unknown, depth = 0): Record<string, unknown> | null {
  const record = objectRecord(value);
  if (record === null || depth > 16) return record;
  const ref = record['$ref'];
  if (typeof ref !== 'string') return record;
  if (!ref.startsWith('#/')) return null;
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    const parent = objectRecord(current);
    if (parent === null || !(segment in parent)) return null;
    current = parent[segment];
  }
  return resolveLocalReference(root, current, depth + 1);
}

function schemaType(schema: Record<string, unknown> | null): string {
  if (schema === null) return 'string';
  if (typeof schema.format === 'string' && schema.format !== '') return schema.format;
  return typeof schema.type === 'string' && schema.type !== '' ? schema.type : 'string';
}

function topLevelSchemaProperties(
  root: Record<string, unknown>,
  schemaValue: unknown,
  depth = 0,
): readonly RequestInputPoint[] {
  if (depth > 16) return [];
  const schema = resolveLocalReference(root, schemaValue, depth);
  if (schema === null) return [];
  const result: RequestInputPoint[] = [];
  const properties = objectRecord(schema.properties);
  if (properties !== null) {
    for (const [name, propertyValue] of Object.entries(properties)) {
      const property = resolveLocalReference(root, propertyValue, depth + 1);
      result.push({ name, location: 'body', type: schemaType(property) });
    }
  }
  for (const compositionKey of ['allOf', 'oneOf', 'anyOf'] as const) {
    const members = schema[compositionKey];
    if (!Array.isArray(members)) continue;
    for (const member of members) result.push(...topLevelSchemaProperties(root, member, depth + 1));
  }
  return result;
}

function parameterInputPoint(root: Record<string, unknown>, value: unknown): RequestInputPoint | null {
  const parameter = resolveLocalReference(root, value);
  if (parameter === null || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') return null;
  const schema = resolveLocalReference(root, parameter.schema) ?? parameter;
  const location = parameter.in === 'query' || parameter.in === 'path' || parameter.in === 'header' || parameter.in === 'cookie'
    ? parameter.in
    : parameter.in === 'formData'
      ? schemaType(schema) === 'file' ? 'file' : 'body'
      : null;
  if (location === null) return null;
  return { name: parameter.name, location, type: schemaType(schema) };
}

function operationInputs(
  root: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operationValue: unknown,
): { inputPoints: readonly RequestInputPoint[]; contentType?: string } {
  const operation = resolveLocalReference(root, operationValue) ?? {};
  const points: RequestInputPoint[] = [];
  for (const source of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(source)) continue;
    for (const parameterValue of source) {
      const parameter = resolveLocalReference(root, parameterValue);
      if (parameter?.in === 'body') {
        const fields = topLevelSchemaProperties(root, parameter.schema);
        points.push(...(fields.length === 0 ? [{ name: '$body', location: 'body' as const, type: 'json' }] : fields));
      } else {
        const point = parameterInputPoint(root, parameterValue);
        if (point !== null) points.push(point);
      }
    }
  }

  let contentType: string | undefined;
  const requestBody = resolveLocalReference(root, operation.requestBody);
  const content = objectRecord(requestBody?.content);
  if (content !== null) {
    const preferred = ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data']
      .find((mediaType) => mediaType in content) ?? Object.keys(content)[0];
    if (preferred !== undefined) {
      contentType = preferred;
      const media = objectRecord(content[preferred]);
      const fields = topLevelSchemaProperties(root, media?.schema);
      const bodyPoints: RequestInputPoint[] = fields.length === 0
        ? [{ name: '$body', location: 'body', type: preferred }]
        : fields.map((field) => ({
            ...field,
            location: preferred === 'multipart/form-data' && field.type === 'binary' ? 'file' : field.location,
          }));
      points.push(...bodyPoints);
    }
  }
  if (contentType === undefined) {
    const consumes = Array.isArray(operation.consumes) ? operation.consumes : root.consumes;
    if (Array.isArray(consumes)) {
      contentType = consumes.find((entry): entry is string => typeof entry === 'string');
    }
  }

  const deduped = new Map<string, RequestInputPoint>();
  for (const point of points) deduped.set(`${point.location}:${point.name}`, point);
  return { inputPoints: [...deduped.values()], ...(contentType === undefined ? {} : { contentType }) };
}

/**
 * OpenAPI (3.x) / Swagger (2.x) 文書の最小 parse。文書内の instruction/script は
 * 実行しない (f12)。server 候補と path×method の endpoint 一覧を返す。
 * path template ({id} 等) はそのまま返し、呼出側で警告として扱う。
 */
export function parseOpenApiDocument(document: unknown): { servers: readonly string[]; endpoints: readonly ParsedOpenApiEndpoint[] } {
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
  const endpoints: ParsedOpenApiEndpoint[] = [];
  for (const [path, item] of Object.entries(paths)) {
    const pathItem = resolveLocalReference(record, item);
    if (pathItem === null) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation === undefined) continue;
      endpoints.push({ method: method.toUpperCase(), path, ...operationInputs(record, pathItem, operation) });
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
