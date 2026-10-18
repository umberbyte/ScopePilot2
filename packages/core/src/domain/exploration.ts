/**
 * 探索の詳細ポリシー。`docs/detailed-design/f08-browser-exploration.md` §3〜§6。
 * frontier は canonical URL・発見元・depth・priority・origin type を持つ。
 * document hint URL は許可 Origin 内だけ追加し、未確認を保持する。
 */
import { domainError, type FormClassification } from '@scopepilot2/contracts';
import { ScopePolicy, type ScopeOrigins } from './scope-policy.ts';

export interface FrontierEntry {
  readonly canonicalUrl: string;
  readonly depth: number;
  readonly discoveredFrom: string | null;
  readonly originType: 'crawl' | 'document-hint';
  readonly provenance: readonly string[];
}

/** 同 URL 再発見は dedupe し provenance だけ追加する (F08-UT-001)。 */
export class UrlFrontier {
  private readonly entries = new Map<string, FrontierEntry>();
  private readonly order: string[] = [];

  add(input: { url: string; depth: number; discoveredFrom: string | null; originType: FrontierEntry['originType'] }): { added: boolean } {
    const canonical = ScopePolicy.canonicalUrl(input.url);
    const existing = this.entries.get(canonical);
    if (existing !== undefined) {
      const provenance = [...new Set([...existing.provenance, input.discoveredFrom ?? 'seed'])];
      this.entries.set(canonical, { ...existing, provenance });
      return { added: false };
    }
    this.entries.set(canonical, {
      canonicalUrl: canonical,
      depth: input.depth,
      discoveredFrom: input.discoveredFrom,
      originType: input.originType,
      provenance: [input.discoveredFrom ?? 'seed'],
    });
    this.order.push(canonical);
    return { added: true };
  }

  has(url: string): boolean {
    return this.entries.has(ScopePolicy.canonicalUrl(url));
  }

  entry(url: string): FrontierEntry | undefined {
    return this.entries.get(ScopePolicy.canonicalUrl(url));
  }

  drain(): readonly FrontierEntry[] {
    const drained = this.order.map((url) => this.entries.get(url)).filter((entry): entry is FrontierEntry => entry !== undefined);
    this.entries.clear();
    this.order.length = 0;
    return drained;
  }
}

/** delete/logout 等の危険表現は自動操作しない (F08-UT-003)。 */
export type ActionSafety = 'auto' | 'manual-only';

export function classifyAction(input: { label: string; method?: string }): { safety: ActionSafety; reason?: string } {
  const label = input.label.toLowerCase();
  const dangerous = /(delete|remove|drop|logout|log-out|signout|sign-out|退会|削除|ログアウト|unsubscribe|purge|reset)/;
  if (dangerous.test(label)) {
    return { safety: 'manual-only', reason: `label matches a destructive/logout pattern: ${input.label}` };
  }
  if (input.method !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(input.method.toUpperCase())) {
    return { safety: 'manual-only', reason: `non-idempotent method ${input.method} requires explicit confirmation` };
  }
  return { safety: 'auto' };
}

/** write の可能性がある form は確認へ送る (F08-UT-004)。 */
export function formRequiresConfirmation(classification: FormClassification): { requires: boolean; reason?: string } {
  if (classification === 'data-write') {
    return { requires: true, reason: 'data-write form changes server state; plan confirmation required' };
  }
  if (classification === 'login') {
    return { requires: true, reason: 'credential submission requires explicit confirmation and a secret reference' };
  }
  return { requires: false };
}

export interface DocumentHints {
  readonly urls: readonly string[];
}

/** scope 外の document URL は frontier へ追加しない (F08-UT-005)。hint 抽出失敗は継続する (F08-UT-006)。 */
export function seedHints(
  extraction: { ok: true; hints: DocumentHints } | { ok: false; reason: string },
  scope: ScopeOrigins,
): { seeded: readonly string[]; skipped: readonly { url: string; reason: string }[]; continued: boolean; note?: string } {
  const seeded: string[] = [];
  const skipped: { url: string; reason: string }[] = [];
  if (!extraction.ok) {
    // 抽出失敗でも探索は継続する (空 hint として記録)。
    return { seeded, skipped, continued: true, note: `hint extraction failed (${extraction.reason}); continuing without hints` };
  }
  for (const url of extraction.hints.urls) {
    const decision = ScopePolicy.decide(scope, url);
    if (decision.allowed) {
      seeded.push(url);
    } else {
      skipped.push({ url, reason: decision.reason });
    }
  }
  return { seeded, skipped, continued: true };
}

/** cancel 後は adapter action を呼ばない (F08-UT-007)。 */
export async function runBudgetedActions(
  actions: readonly { label: string }[],
  budget: { maxActions: number },
  options: { isCancelled: () => boolean; adapter: { act(label: string): Promise<void> } },
): Promise<{ performed: number; cancelledAt: number | null }> {
  let performed = 0;
  for (let index = 0; index < actions.length && performed < budget.maxActions; index += 1) {
    if (options.isCancelled()) {
      return { performed, cancelledAt: index };
    }
    await options.adapter.act(actions[index]?.label ?? '');
    performed += 1;
  }
  return { performed, cancelledAt: null };
}

/** document hint のみでは observed page を生成しない (F08-UT-008)。 */
export function observedPageFromSources(sources: readonly { originType: 'crawl' | 'document-hint' }[]): { observed: boolean } {
  return { observed: sources.some((source) => source.originType === 'crawl') };
}

/** frontier 追加前の URL 妥当性 (循環 seed 防御)。 */
export function assertFrontierUrl(url: string): void {
  try {
    ScopePolicy.canonicalUrl(url);
  } catch (cause) {
    throw domainError('ValidationFailed', `invalid frontier url: ${url} (${String(cause)})`);
  }
}
