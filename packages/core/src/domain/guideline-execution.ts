import { guidelineAutomationPolicy, GUIDELINE_AUTOMATION_POLICY_VERSION } from './guideline-automation.ts';
import type { GuidelineAutomationDisclosure } from '@scopepilot2/contracts';
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
  readonly themeNos: readonly ZapUnsupportedThemeNo[];
}

/** Guideline applicability only. Automation and disclosure come from the versioned policy registry. */
const PROFILES: Readonly<Record<SupportedHttpGuideline, GuidelineExecutionProfile>> = {
  'OWASP Top 10-2025': {
    themeNos: ['24', '25', '30', '5', '6', '10', '15', '20', '21'],
  },
  'OWASP ASVS 5.0': {
    themeNos: ['13', '24', '25', '30', '2', '3', '4', '5', '6', '7', '9', '10', '11', '14', '15', '16', '18', '20', '21', '23', '26', '27', '29'],
  },
  'OWASP WSTG 4.2': {
    themeNos: ['13', '24', '25', '30', '2', '3', '4', '5', '6', '7', '9', '10', '11', '14', '15', '16', '18', '20', '21', '23', '26', '27', '29'],
  },
  'デジタル庁 DS-221': {
    themeNos: ['13', '24', '25', '30', '3', '4', '5', '6', '7', '10', '15', '16', '20', '21', '23', '29'],
  },
  'IPA/NISC/WebAppPentestGuidelines': {
    themeNos: ['13', '24', '25', '30', '2', '3', '4', '5', '6', '7', '9', '10', '11', '14', '15', '16', '18', '20', '21', '22', '23', '26', '27', '29'],
  },
};

export interface GuidelineThemeRoutePlan extends Required<GuidelineAutomationDisclosure> {
  readonly themeNo: ZapUnsupportedThemeNo;
  readonly mode: 'automatic' | 'needs-input';
  readonly guidelineIds: readonly SupportedHttpGuideline[];
}

export function resolveGuidelineThemeRoutes(guidelines: readonly string[]): readonly GuidelineThemeRoutePlan[] {
  const selected = SUPPORTED_HTTP_GUIDELINES.filter((guideline) => guidelines.includes(guideline));
  const routes = new Map<ZapUnsupportedThemeNo, SupportedHttpGuideline[]>();
  for (const guideline of selected) {
    for (const themeNo of PROFILES[guideline].themeNos) {
      const sources = routes.get(themeNo) ?? [];
      if (!sources.includes(guideline)) sources.push(guideline);
      routes.set(themeNo, sources);
    }
  }
  return [...routes.entries()]
    .sort(([left], [right]) => Number.parseInt(left, 10) - Number.parseInt(right, 10))
    .map(([themeNo, guidelineIds]) => {
      const policy = guidelineAutomationPolicy(themeNo);
      const automatic = policy.connection === 'active-scan';
      return {
        themeNo, mode: automatic ? 'automatic' as const : 'needs-input' as const,
        guidelineIds,
        automationPolicyVersion: GUIDELINE_AUTOMATION_POLICY_VERSION,
        automationClass: policy.automationClass,
        missingInputCodes: automatic ? [] : policy.requiredInputCodes,
        limitationCodes: automatic ? policy.limitationCodes : [...policy.limitationCodes, 'automatic-route-not-connected'],
      };
    });
}
