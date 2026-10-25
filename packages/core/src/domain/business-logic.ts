/**
 * 認可・業務ロジック検証。`docs/detailed-design/f17-authorization-business-logic.md`、design/15。
 * Expectation DSL は allowlist 演算のみ。restore は必須で、不一致は成功扱いしない。
 * template catalog は hash 固定、曖昧行は review required。
 */
import { domainError, hashStable, type OperationClass } from '@scopepilot2/contracts';
import { ScopePolicy } from './scope-policy.ts';

const ALLOWED_EXPRESSIONS: readonly string[] = [
  'status.equals',
  'status.in',
  'body.contains',
  'body.notContains',
  'body.jsonPath',
  'header.equals',
  'elapsedMs.lessThan',
  'elapsedMs.greaterThan',
];

/** allowlist 外 expression は validation error (F17-UT-001)。 */
export function parseExpectation(expectation: { readonly expression: string; readonly args: readonly unknown[] }): { expression: string } {
  if (!ALLOWED_EXPRESSIONS.includes(expectation.expression)) {
    throw domainError('ValidationFailed', `expectation expression not allowed: ${expectation.expression}`);
  }
  return { expression: expectation.expression };
}

export interface RolePairPlan {
  readonly roles: readonly string[];
  readonly sessions: ReadonlyMap<string, { readonly cookieJarId: string }>;
  readonly evidenceSeparated: boolean;
}

/** 2 role 検証は session と evidence を分離する (F17-UT-002)。 */
export function planRoleMatrix(roles: readonly string[]): RolePairPlan {
  const sessions = new Map<string, { cookieJarId: string }>();
  for (const role of roles) {
    sessions.set(role, { cookieJarId: `jar-${role}` });
  }
  return { roles, sessions, evidenceSeparated: new Set(sessions.values()).size === roles.length };
}

export type ComparisonOutcome = 'pass' | 'fail' | 'inconclusive';

/** 観測欠落は Inconclusive とし、成功/失敗を推測しない (F17-UT-003)。 */
export function compareObservations(expected: string | null, actual: string | null): { outcome: ComparisonOutcome } {
  if (expected === null || actual === null) {
    return { outcome: 'inconclusive' };
  }
  return { outcome: expected === actual ? 'pass' : 'fail' };
}

/** restore assert 不一致は全体を成功扱いしない (F17-UT-004)。 */
export function evaluateRestore(steps: readonly { readonly name: string; readonly passed: boolean }[]): { outcome: 'restored' | 'restore-failed' } {
  const failed = steps.find((step) => !step.passed);
  if (failed !== undefined) {
    return { outcome: 'restore-failed' };
  }
  return { outcome: 'restored' };
}

/** template hash 不一致は実行拒否 (F17-UT-005)。 */
export function verifyTemplateHash(template: { readonly name: string; readonly content: string }, catalogHash: string): { allowed: boolean } {
  const actual = hashStable('scopepilot2.template', { name: template.name, content: template.content });
  return { allowed: actual === catalogHash };
}

export type CheckOutcomeStatus = 'pass' | 'fail' | 'not-run';

/** setup blocked では Pass/Fail を作らない (F17-UT-006)。 */
export function resolveOutcome(input: { setupBlocked: boolean; assertionPassed?: boolean }): { status: CheckOutcomeStatus; reason?: string } {
  if (input.setupBlocked) {
    return { status: 'not-run', reason: 'setup was blocked; neither pass nor fail is recorded' };
  }
  return { status: input.assertionPassed === true ? 'pass' : 'fail' };
}

export interface CatalogRowInput {
  readonly sheet: string;
  readonly row: number;
  readonly itemId: string;
  readonly templateContent: string;
}

/** 曖昧 (空白・重複 ID) な Excel 行は warning と review required (F17-UT-007)。 */
export function importCatalogRows(rows: readonly CatalogRowInput[]): {
  imported: readonly CatalogRowInput[];
  warnings: readonly { row: number; reason: string }[];
  reviewRequired: boolean;
} {
  const seenIds = new Map<string, number>();
  const imported: CatalogRowInput[] = [];
  const warnings: { row: number; reason: string }[] = [];
  for (const row of rows) {
    if (row.itemId.trim() === '' || row.templateContent.trim() === '') {
      warnings.push({ row: row.row, reason: 'blank item id or template content' });
      continue;
    }
    const previousRow = seenIds.get(`${row.sheet}|${row.itemId}`);
    if (previousRow !== undefined) {
      warnings.push({ row: row.row, reason: `duplicate item id also defined at row ${previousRow}` });
      continue;
    }
    seenIds.set(`${row.sheet}|${row.itemId}`, row.row);
    imported.push(row);
  }
  return { imported, warnings, reviewRequired: warnings.length > 0 };
}

/** 禁止操作は action 実行前に拒否する (F17-UT-008)。 */
export function checkBusinessAction(
  action: { readonly operationClass: OperationClass },
  forbiddenOperations: ReadonlySet<string>,
): { allowed: boolean; reason?: string } {
  if (forbiddenOperations.has(action.operationClass)) {
    return { allowed: false, reason: `operation class ${action.operationClass} is forbidden for this case` };
  }
  return { allowed: true };
}

/** 業務フローの送信先も scope 判定を通す。 */
export function businessTargetInScope(url: string, scope: { allowedOrigins: readonly string[]; deniedOrigins: readonly string[] }): boolean {
  return ScopePolicy.decide(scope, url).allowed;
}
