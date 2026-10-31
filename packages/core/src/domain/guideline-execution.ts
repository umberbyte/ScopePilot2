import type { ZapUnsupportedThemeNo } from './zap-unsupported.ts';

export const SUPPORTED_HTTP_GUIDELINES = [
  'OWASP Top 10-2025',
  'OWASP ASVS 5.0',
  'OWASP WSTG 4.2',
  'デジタル庁 DS-221',
  'IPA/NISC/WebAppPentestGuidelines',
] as const;

export type SupportedHttpGuideline = (typeof SUPPORTED_HTTP_GUIDELINES)[number];

interface GuidelineExecutionProfile {
  readonly automaticThemeNos: readonly ZapUnsupportedThemeNo[];
  readonly needsInputThemeNos: readonly ZapUnsupportedThemeNo[];
}

/**
 * ガイドライン選択から ZAP 非対応の実行経路を決定する正本。
 * テーマ30は、確認済みHTTP対象へのGET観測だけなので active scan から自動実行できる。
 * それ以外は資格情報・比較role・対象固有payload・副作用確認等を要するため、選択時に
 * needs-input として公開し、A03 の個別実行関数へ接続する。
 */
const PROFILES: Readonly<Record<SupportedHttpGuideline, GuidelineExecutionProfile>> = {
  'OWASP Top 10-2025': {
    automaticThemeNos: ['30'],
    needsInputThemeNos: ['5', '6', '10', '15', '20', '21', '24', '25'],
  },
  'OWASP ASVS 5.0': {
    automaticThemeNos: ['30'],
    needsInputThemeNos: ['2', '3', '4', '5', '6', '7', '9', '10', '11', '13', '14', '15', '16', '18', '20', '21', '23', '24', '25', '26', '27', '29'],
  },
  'OWASP WSTG 4.2': {
    automaticThemeNos: ['30'],
    needsInputThemeNos: ['2', '3', '4', '5', '6', '7', '9', '10', '11', '13', '14', '15', '16', '18', '20', '21', '23', '24', '25', '26', '27', '29'],
  },
  'デジタル庁 DS-221': {
    automaticThemeNos: ['30'],
    needsInputThemeNos: ['3', '4', '5', '6', '7', '10', '13', '15', '16', '20', '21', '23', '24', '25', '29'],
  },
  'IPA/NISC/WebAppPentestGuidelines': {
    automaticThemeNos: ['30'],
    needsInputThemeNos: ['2', '3', '4', '5', '6', '7', '9', '10', '11', '13', '14', '15', '16', '18', '20', '21', '22', '23', '24', '25', '26', '27', '29'],
  },
};

export interface GuidelineThemeRoutePlan {
  readonly themeNo: ZapUnsupportedThemeNo;
  readonly mode: 'automatic' | 'needs-input';
  readonly guidelineIds: readonly SupportedHttpGuideline[];
}

export function resolveGuidelineThemeRoutes(guidelines: readonly string[]): readonly GuidelineThemeRoutePlan[] {
  const selected = SUPPORTED_HTTP_GUIDELINES.filter((guideline) => guidelines.includes(guideline));
  const routes = new Map<ZapUnsupportedThemeNo, { mode: 'automatic' | 'needs-input'; guidelineIds: SupportedHttpGuideline[] }>();
  for (const guideline of selected) {
    const profile = PROFILES[guideline];
    for (const themeNo of profile.needsInputThemeNos) {
      const current = routes.get(themeNo) ?? { mode: 'needs-input' as const, guidelineIds: [] };
      if (!current.guidelineIds.includes(guideline)) current.guidelineIds.push(guideline);
      routes.set(themeNo, current);
    }
    for (const themeNo of profile.automaticThemeNos) {
      const current = routes.get(themeNo) ?? { mode: 'automatic' as const, guidelineIds: [] };
      current.mode = 'automatic';
      if (!current.guidelineIds.includes(guideline)) current.guidelineIds.push(guideline);
      routes.set(themeNo, current);
    }
  }
  return [...routes.entries()]
    .sort(([left], [right]) => Number.parseInt(left, 10) - Number.parseInt(right, 10))
    .map(([themeNo, route]) => ({ themeNo, mode: route.mode, guidelineIds: route.guidelineIds }));
}
