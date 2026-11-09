import type { UnsupportedAssessment } from '@scopepilot2/contracts';
import { SUPPORTED_HTTP_GUIDELINES } from './guideline-execution.ts';
import { guidelineAutomationPolicy } from './guideline-automation.ts';

export const UNSUPPORTED_ASSESSMENT_POLICY_VERSION = '2026-11-10.go-23.1';

/** 現行bundleは検査不能・スキップを明示し、送信計画や合否を生成しない。 */
export function resolveUnsupportedAssessments(guidelines: readonly string[]): readonly UnsupportedAssessment[] {
  const selected = SUPPORTED_HTTP_GUIDELINES.filter((guideline) => guidelines.includes(guideline));
  if (selected.length === 0) return [];
  const assessments: UnsupportedAssessment[] = [{
    routeId: guidelineAutomationPolicy('17').routeId,
    title: 'テーマ17 request smuggling / parser差異',
    themeNo: '17', guidelineIds: selected,
    policyVersion: UNSUPPORTED_ASSESSMENT_POLICY_VERSION,
    routeKind: 'unsupported', guarantee: 'Unsupported', assessment: 'not-assessed',
    reasonCode: 'RAW_TRANSPORT_AND_DUAL_PARSER_ORACLE_MISSING',
    detail: '検査不能・スキップ。専用raw transportと隔離した二段parser・誤配送oracleが未接続です。通常のHTTP client、ZAP、Repeaterの結果で合否を代用しません。テーマ単位の製品制約であり、各ガイドライン項目への対応を示すものではありません。',
    resumeConditions: [
      '対象から隔離したfrontend/backend二段parser fixture',
      'byte列を保持する専用transportと一意tokenによる誤配送oracle',
      'connection reuse・timeoutの上限、停止・証跡方針',
      '固定runtime bundleでの能力実証と公開前の方針review',
    ],
  }];
  if (selected.includes('OWASP ASVS 5.0')) assessments.push({
    routeId: 'asvs:10.2.3:unsupported',
    title: 'ASVS 10.2.3 OAuth scope最小化',
    itemId: '10.2.3', guidelineIds: ['OWASP ASVS 5.0'],
    policyVersion: UNSUPPORTED_ASSESSMENT_POLICY_VERSION,
    routeKind: 'unsupported', guarantee: 'Unsupported', assessment: 'not-assessed',
    reasonCode: 'OAUTH_SCOPE_POLICY_AND_COMPARISON_PRINCIPAL_MISSING',
    detail: '検査不能・スキップ。業務上必要なscopeはHTTP応答だけでは判断できません。現行bundleには承認済みOAuthScopePolicyの入力・評価経路がなく、テーマ17やJWT検査の結果で合否を代用しません。',
    resumeConditions: [
      'オーナー承認済みOAuthScopePolicy（client ID、flow、必要scope、禁止scope、resource、比較主体、根拠文書）',
      '実際の認可要求・grant/token scopeの観測とpolicyへの比較経路',
      'manual-reviewまたはconditional-automatic経路の実装・検証・方針review',
    ],
  });
  return assessments;
}
