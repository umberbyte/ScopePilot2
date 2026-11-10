import type { PageObservation, PassiveRule } from '@scopepilot2/contracts';
import type { ObservationFindingCandidate } from './finding-importer.ts';

export const PASSIVE_RULES: readonly PassiveRule[] = [
  { ruleId: 'passive-password-http', name: '暗号化されないパスワードフォーム', description: '観測ページまたは送信先が HTTP のパスワードフォームを候補として記録します。送信しません。', enabled: true, version: '1' },
  { ruleId: 'passive-password-get', name: 'GET のパスワードフォーム', description: 'GET メソッドのパスワードフォームを候補として記録します。送信しません。', enabled: true, version: '1' },
];

/** Uses observed form metadata only; no transport, body or credential values. */
export function passiveObservationCandidates(observation: PageObservation): readonly ObservationFindingCandidate[] {
  const candidates: ObservationFindingCandidate[] = [];
  for (const form of observation.forms) {
    if (!form.fields.some((field) => field.type.toLowerCase() === 'password')) continue;
    const observationUrl = observation.finalUrl ?? observation.url;
    let action: URL;
    try { action = new URL(form.actionUrl, observationUrl); } catch { continue; }
    for (const rule of PASSIVE_RULES) {
      const matches = rule.ruleId === 'passive-password-http'
        ? new URL(observationUrl).protocol === 'http:' || action.protocol === 'http:'
        : form.method.toUpperCase() === 'GET';
      if (!matches) continue;
      candidates.push({
        key: rule.ruleId, title: rule.name, url: observationUrl, method: 'GET', severity: 'medium',
        passive: { ruleId: rule.ruleId, ruleVersion: rule.version, observationUrl,
          detail: `${rule.description} 送信先 Origin: ${action.origin}。観測したフォームの method: ${form.method.toUpperCase()}。入力値・秘密値は保存していません。実影響は未確認です。` },
      });
    }
  }
  return [...new Map(candidates.map((candidate) => [candidate.key, candidate])).values()];
}
