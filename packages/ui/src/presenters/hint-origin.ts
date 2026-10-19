/**
 * document hint と観測 URL の表示分離。`docs/detailed-design/02-ui-information-architecture.md` §2 (S04)。
 * 文書由来は「文書の記載」であり観測事実ではないため、未確認ラベルと出典を保持する (UI-UT-004)。
 */
export interface TargetListEntry {
  readonly url: string;
  readonly originType: 'crawl' | 'document-hint';
  readonly documentSource?: string;
}

export interface PresentedTarget {
  readonly url: string;
  readonly confirmed: boolean;
  readonly originLabel: string;
  readonly sourceLabel: string;
}

export function presentTargets(entries: readonly TargetListEntry[]): readonly PresentedTarget[] {
  return entries.map((entry) =>
    entry.originType === 'crawl'
      ? { url: entry.url, confirmed: true, originLabel: '観測', sourceLabel: 'クロール' }
      : {
          url: entry.url,
          confirmed: false,
          originLabel: '未確認',
          sourceLabel: `文書の記載${entry.documentSource === undefined ? '' : ` (${entry.documentSource})`}`,
        },
  );
}
