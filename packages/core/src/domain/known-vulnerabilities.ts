/**
 * 既知脆弱性診断 (Nuclei 統合)。`docs/detailed-design/f18-known-vulnerabilities-nuclei.md`、design/16。
 * template は HTTP-only AST allowlist、版・hash 固定。実行は引数配列で shell を使わない。
 */
import { domainError, hashStable } from '@scopepilot2/contracts';
import type { FindingSeverity } from '@scopepilot2/contracts';
import { ScopePolicy } from './scope-policy.ts';

const ALLOWED_TEMPLATE_PROTOCOLS: readonly string[] = ['http'];
export const TEMPLATE_MAX_BYTES = 512 * 1024;
export const TEMPLATE_BUNDLE_MAX_COUNT = 1000;

export interface NucleiTemplate {
  readonly templateId: string;
  readonly protocol: string;
  readonly content: string;
}

/** code protocol は拒否する (F18-UT-001)。 */
export function validateTemplateProtocol(template: NucleiTemplate): void {
  if (!ALLOWED_TEMPLATE_PROTOCOLS.includes(template.protocol)) {
    throw domainError('ValidationFailed', `template protocol ${template.protocol} is not allowed (HTTP-only allowlist)`);
  }
}

/** size/count 超過は bounded error (F18-UT-002)。 */
export function validateTemplateBundle(templates: readonly NucleiTemplate[]): void {
  if (templates.length > TEMPLATE_BUNDLE_MAX_COUNT) {
    throw domainError('ValidationFailed', `template bundle exceeds ${TEMPLATE_BUNDLE_MAX_COUNT} templates`);
  }
  for (const template of templates) {
    if (Buffer.byteLength(template.content, 'utf8') > TEMPLATE_MAX_BYTES) {
      throw domainError('ValidationFailed', `template ${template.templateId} exceeds ${TEMPLATE_MAX_BYTES} bytes`);
    }
  }
}

/** scope 外 target は plan に入れない (F18-UT-003)。 */
export function selectPlanTargets(targets: readonly string[], scope: { allowedOrigins: readonly string[]; deniedOrigins: readonly string[] }): readonly string[] {
  return targets.filter((target) => ScopePolicy.decide(scope, target).allowed);
}

/** metachar を含む path も引数として保持し、shell は使わない (F18-UT-004)。 */
export function buildProcessCommand(executablePath: string, args: readonly string[]): readonly string[] {
  for (const arg of args) {
    if (arg.includes('\0')) {
      throw domainError('ValidationFailed', 'argument contains NUL');
    }
  }
  return [executablePath, ...args];
}

export interface NucleiMatch {
  readonly templateId: string;
  readonly matchedAt: string;
  readonly severity: string;
  readonly name: string;
}

/** Nuclei JSONL 1 行を解析する (壊れた行は quarantine)。 */
export function parseNucleiJsonl(lines: readonly string[]): { matches: readonly NucleiMatch[]; quarantined: number } {
  const matches: NucleiMatch[] = [];
  let quarantined = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) {
        quarantined += 1;
        continue;
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record['template-id'] !== 'string' || typeof record['matched-at'] !== 'string') {
        quarantined += 1;
        continue;
      }
      const info = (record.info ?? {}) as Record<string, unknown>;
      matches.push({
        templateId: record['template-id'],
        matchedAt: record['matched-at'],
        severity: typeof info.severity === 'string' ? info.severity : '',
        name: typeof info.name === 'string' ? info.name : '',
      });
    } catch {
      quarantined += 1;
    }
  }
  return { matches, quarantined };
}

/** 同一 JSONL 再取込は dedupe する (F18-UT-005)。 */
export function importMatches(matches: readonly NucleiMatch[]): { imported: readonly NucleiMatch[]; duplicates: number } {
  const seen = new Set<string>();
  const imported: NucleiMatch[] = [];
  let duplicates = 0;
  for (const match of matches) {
    const key = hashStable('scopepilot2.nuclei.match', { templateId: match.templateId, matchedAt: match.matchedAt });
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    imported.push(match);
  }
  return { imported, duplicates };
}

/** nuclei の critical は本製品 severity 集合にないため high へ正規化し、原値を source に保持する。 */
export function normalizeNucleiSeverity(source: string): { severity: FindingSeverity; sourceSeverity: string } {
  const lowered = source.trim().toLowerCase();
  if (lowered === 'critical') {
    return { severity: 'high', sourceSeverity: source };
  }
  const known: readonly FindingSeverity[] = ['info', 'low', 'medium', 'high'];
  return { severity: known.find((severity) => severity === lowered) ?? 'unknown', sourceSeverity: source };
}

export type NucleiRunOutcome = 'success' | 'partial' | 'cancelled';

/** partial/cancel は success と区別する (F18-UT-007)。 */
export function classifyRunOutcome(completedTemplates: number, totalTemplates: number, cancelled: boolean): NucleiRunOutcome {
  if (cancelled) {
    return 'cancelled';
  }
  return completedTemplates === totalTemplates ? 'success' : 'partial';
}

/** hash/signature 不一致の template は実行拒否 (F18-UT-008)。 */
export function verifyTemplateCatalog(entry: { readonly templateId: string; readonly content: string; readonly sha256: string }): { allowed: boolean } {
  const actual = hashStable('scopepilot2.nuclei.template', { id: entry.templateId, content: entry.content });
  return { allowed: actual === entry.sha256 };
}
