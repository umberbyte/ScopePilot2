export interface RendererReportProfile {
  readonly systemName: string;
  readonly clientName: string;
  readonly serviceProvider: string;
  readonly version: string;
  readonly documentStatus: string;
  readonly classification: string;
  readonly author: string;
  readonly reviewer: string;
  readonly approver: string;
  readonly distribution: string;
  readonly assessmentType: string;
  readonly sourceIps: string;
  readonly exclusions: string;
  readonly assumptions: string;
  readonly conclusion: string;
  readonly priorities: string;
  readonly majorLimitations: string;
  readonly contact: string;
  readonly evidenceBodyMode: 'relevant' | 'omit' | 'full';
  readonly highlightEvidence: boolean;
}

export const INITIAL_RENDERER_REPORT_PROFILE: RendererReportProfile = {
  systemName: '',
  clientName: '',
  serviceProvider: '',
  version: '0.1',
  documentStatus: 'ドラフト',
  classification: '関係者限定',
  author: '',
  reviewer: '',
  approver: '',
  distribution: '',
  assessmentType: 'Web アプリケーション脆弱性診断',
  sourceIps: '',
  exclusions: '',
  assumptions: '',
  conclusion: '',
  priorities: '',
  majorLimitations: '',
  contact: '',
  evidenceBodyMode: 'relevant',
  highlightEvidence: true,
};

/** IPC の旧形式や不完全な保存データでも S07 を描画できる完全な状態にする。 */
export function normalizeRendererReportProfile(
  value: Partial<RendererReportProfile> | null | undefined,
): RendererReportProfile {
  const source = value ?? {};
  return {
    ...INITIAL_RENDERER_REPORT_PROFILE,
    ...source,
    evidenceBodyMode: source.evidenceBodyMode === 'omit' || source.evidenceBodyMode === 'full'
      ? source.evidenceBodyMode
      : 'relevant',
    highlightEvidence: typeof source.highlightEvidence === 'boolean' ? source.highlightEvidence : true,
  };
}
