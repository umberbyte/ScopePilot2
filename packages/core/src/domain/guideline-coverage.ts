/**
 * ガイドラインカバレッジの計算・生成ロジック
 *
 * 設計正本: docs/design/41-spec-gap-resolution.md §3, §8
 *
 * GO-28実装の初版: GO-22の GuidelineCoverageRoute 正本が完成するまで、
 * 既存の guideline-execution.ts の分類を使って仮実装する。
 */

import type {
  GuidelineCoverageSummaryView,
  GuidelineCoverageItemView,
  GuidelineCoverageResponse,
  RunGuidelineCoverageResponse,
} from '@scopepilot2/contracts';
import { resolveGuidelineThemeRoutes, type SupportedHttpGuideline } from './guideline-execution.ts';

/**
 * 選択ガイドラインのカバレッジサマリーと項目詳細を生成する（計画前の見込み）
 *
 * @param guidelineId - ガイドラインID
 * @param catalogVersion - カタログ版（現在は固定値）
 * @returns ガイドラインカバレッジ応答
 */
export function buildGuidelineCoverageSummary(
  guidelineId: string,
  catalogVersion: string = 'scopepilot-working-copy-2026-10-18',
): GuidelineCoverageResponse {
  // 現在の仮実装: guideline-execution の分類を使用
  const routes = resolveGuidelineThemeRoutes([guidelineId]);

  const automaticCount = routes.filter((r) => r.mode === 'automatic').length;
  const needsInputCount = routes.filter((r) => r.mode === 'needs-input').length;

  // カタログから項目を取得（仮実装: 実際のカタログ読込はGO-22で実装）
  const items = buildCoverageItems(guidelineId, routes);

  const summary: GuidelineCoverageSummaryView = {
    guidelineId,
    guidelineDisplayName: guidelineId,
    totalItems: routes.length,
    automaticCount,
    conditionalAutomaticCount: 0, // GO-22で実装
    needsInputCount,
    unavailableCount: 0, // GO-22で実装
    notApplicableCount: 0, // GO-22で実装
    catalog: {
      catalogId: 'scopepilot-working-workbook',
      version: catalogVersion,
      sha256: '33d32b195f84a36a77dd0eadeecfb490d0034a6dc6b2b41803af5ac8c99b882c', // 現在の固定値
    },
  };

  return {
    summary,
    items,
  };
}

/**
 * カバレッジ項目詳細を構築（仮実装）
 */
function buildCoverageItems(
  guidelineId: string,
  routes: readonly { themeNo: string; mode: 'automatic' | 'needs-input'; guidelineIds: readonly SupportedHttpGuideline[] }[],
): readonly GuidelineCoverageItemView[] {
  return routes.map((route) => {
    const automationClass = route.mode === 'automatic' ? 'automatic' : ('operator-workflow' as const);
    const guarantee = route.mode === 'automatic' ? ('Delegated' as const) : ('Enforced' as const);

    const item: GuidelineCoverageItemView = {
      itemId: `theme-${route.themeNo}`,
      itemDisplayName: `テーマ${route.themeNo}`,
      checkItem: `テーマ${route.themeNo}の検証項目`, // GO-22でカタログから取得
      requirement: `テーマ${route.themeNo}の要件`, // GO-22でカタログから取得
      routes: [
        {
          routeId: `theme-${route.themeNo}-route-1`,
          routeKind: 'theme',
          guarantee,
          automationClass,
          estimatedRequests: route.mode === 'automatic' ? 10 : 0, // 仮値
          hasStateChange: route.mode !== 'automatic',
          requiresRestoration: route.mode !== 'automatic',
          missingInputs:
            route.mode === 'needs-input'
              ? [
                  {
                    code: 'REQUIRES_OPERATOR_INPUT',
                    description: '操作者による入力・確認・復元が必要',
                  },
                ]
              : [],
          limitations: [],
        },
      ],
      // execution は実行後のみ（optional property は省略）
    };
    return item;
  });
}

/**
 * 実行済みrunのガイドラインカバレッジを取得（実行結果）
 *
 * @param runId - run ID
 * @returns run別ガイドラインカバレッジ応答
 */
export function buildRunGuidelineCoverage(runId: string): RunGuidelineCoverageResponse | null {
  // GO-22実装待ち: 実際のrun結果からカバレッジを構築
  // 現在は仮実装として null を返す（「該当runなし」）
  return null;
}

/**
 * 複数ガイドラインのカバレッジを統合
 *
 * @param guidelineIds - ガイドラインID配列
 * @returns 統合されたカバレッジ応答
 */
export function buildCombinedGuidelineCoverage(guidelineIds: readonly string[]): GuidelineCoverageResponse {
  if (guidelineIds.length === 0) {
    return {
      summary: {
        guidelineId: '',
        guidelineDisplayName: '（未選択）',
        totalItems: 0,
        automaticCount: 0,
        conditionalAutomaticCount: 0,
        needsInputCount: 0,
        unavailableCount: 0,
        notApplicableCount: 0,
        catalog: {
          catalogId: '',
          version: '',
          sha256: '',
        },
      },
      items: [],
    };
  }

  // 複数ガイドラインの場合は、重複排除して集約
  const allRoutes = resolveGuidelineThemeRoutes(guidelineIds);
  const uniqueThemes = new Set(allRoutes.map((r) => r.themeNo));

  const automaticCount = allRoutes.filter((r) => r.mode === 'automatic').length;
  const needsInputCount = allRoutes.filter((r) => r.mode === 'needs-input').length;

  const items = buildCoverageItems(guidelineIds.join(', '), allRoutes);

  return {
    summary: {
      guidelineId: guidelineIds.join(', '),
      guidelineDisplayName: `${guidelineIds.length}件のガイドライン`,
      totalItems: uniqueThemes.size,
      automaticCount,
      conditionalAutomaticCount: 0,
      needsInputCount,
      unavailableCount: 0,
      notApplicableCount: 0,
      catalog: {
        catalogId: 'scopepilot-working-workbook',
        version: 'scopepilot-working-copy-2026-10-18',
        sha256: '33d32b195f84a36a77dd0eadeecfb490d0034a6dc6b2b41803af5ac8c99b882c',
      },
    },
    items,
  };
}
