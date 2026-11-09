import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  HighlightColor,
  PageNumber,
  PageOrientation,
  Packer,
  Paragraph,
  ShadingType,
  SectionType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType,
} from 'docx';
import type { Finding, ReportModel } from '@scopepilot2/contracts';
import type { StoredEvidence } from '@scopepilot2/core';

export interface ReportProfile {
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

export const DEFAULT_REPORT_PROFILE: ReportProfile = {
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

export function normalizeReportProfile(value: unknown): ReportProfile {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  type TextKey = Exclude<keyof ReportProfile, 'evidenceBodyMode' | 'highlightEvidence'>;
  const placeholderValues = new Set(['ぬるぽ', 'ほげふが', 'テスト発行者']);
  const text = (key: TextKey): string => {
    const normalized = typeof source[key] === 'string' ? (source[key] as string).trim() : DEFAULT_REPORT_PROFILE[key];
    return placeholderValues.has(normalized) ? '' : normalized;
  };
  return {
    systemName: text('systemName'),
    clientName: text('clientName'),
    serviceProvider: text('serviceProvider'),
    version: text('version'),
    documentStatus: text('documentStatus'),
    classification: text('classification'),
    author: text('author'),
    reviewer: text('reviewer'),
    approver: text('approver'),
    distribution: text('distribution'),
    assessmentType: text('assessmentType'),
    sourceIps: text('sourceIps'),
    exclusions: text('exclusions'),
    assumptions: text('assumptions'),
    conclusion: text('conclusion'),
    priorities: text('priorities'),
    majorLimitations: text('majorLimitations'),
    contact: text('contact'),
    evidenceBodyMode: source.evidenceBodyMode === 'omit' || source.evidenceBodyMode === 'full'
      ? source.evidenceBodyMode
      : 'relevant',
    highlightEvidence: typeof source.highlightEvidence === 'boolean' ? source.highlightEvidence : true,
  };
}

export interface AssuranceReportDocument {
  readonly formatVersion: '2';
  readonly templateId: 'scopepilot2-assurance-ja-v2';
  readonly modelHash: string;
  readonly report: {
    readonly id: string;
    readonly version: string;
    readonly status: string;
    readonly classification: string;
    readonly generatedAt: string;
    readonly author: string;
    readonly reviewer: string;
    readonly approver: string;
    readonly distribution: readonly string[];
  };
  readonly engagement: {
    readonly caseId: string;
    readonly name: string;
    readonly systemName: string;
    readonly clientName: string;
    readonly serviceProvider: string;
  };
  readonly assessment: {
    readonly type: string;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly methods: readonly string[];
    readonly sourceIps: readonly string[];
    readonly allowedOrigins: readonly string[];
    readonly deniedOrigins: readonly string[];
    readonly roles: readonly string[];
    readonly authentication: string;
    readonly scanPolicies: readonly string[];
    readonly forbiddenActions: readonly string[];
    readonly exclusions: readonly string[];
    readonly assumptions: readonly string[];
    readonly requestLimits: { readonly maxRequests: number; readonly maxPages: number; readonly maxDurationMinutes: number };
  };
  readonly summary: {
    readonly conclusion: string;
    readonly highestSeverity: string;
    readonly severityCounts: Readonly<Record<string, number>>;
    readonly priorities: readonly string[];
    readonly majorLimitations: readonly string[];
  };
  readonly assets: readonly { readonly id: string; readonly name: string; readonly fqdn: string; readonly urls: readonly string[] }[];
  readonly coverageSummary: { readonly exploredUrlCount: number; readonly scannedUrlCount: number; readonly delegatedStepCount: number };
  readonly urlCoverage: readonly {
    readonly url: string;
    readonly statusCode: number | null;
    readonly contentType: string;
    readonly depth: number;
    readonly discoveredFrom: string;
    readonly scanStatus: '診断対象' | '対象外';
    readonly exclusionReason: string;
  }[];
  readonly coverage: readonly {
    readonly controlId: string;
    readonly title: string;
    readonly status: string;
    readonly method: string;
    readonly roles: readonly string[];
    readonly targets: readonly string[];
    readonly limitations: string;
  }[];
  readonly findings: readonly {
    readonly id: string;
    readonly title: string;
    readonly severity: string;
    readonly automatedRationale: string;
    readonly confidence: string;
    readonly source: string;
    readonly method: string;
    readonly cwe: readonly string[];
    readonly owaspTop10: readonly string[];
    /** 互換用の代表URL。表示には `urls` を使用する。 */
    readonly url: string;
    /** 同一現象として統合した全対象URL（重複なし）。 */
    readonly urls: readonly string[];
    readonly parameter: string;
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
    readonly occurrences: number;
    readonly evidenceIds: readonly string[];
    /** 統合前の指摘ID。証跡索引を代表指摘へ結び直すためにも保持する。 */
    readonly sourceFindingIds: readonly string[];
    readonly technicalEvidence: {
      readonly request: string;
      readonly response: string;
      readonly collectionStatus: string;
      readonly source: string;
      readonly attackInput: string;
      readonly observedEvidence: string;
      readonly focusSummary: string;
      readonly highlightTerms: readonly string[];
      /** Requestに実在する診断入力・パラメータだけを強調する。 */
      readonly requestHighlightTerms?: readonly string[];
      /** Responseに実在する診断入力・観測根拠だけを強調する。 */
      readonly responseHighlightTerms?: readonly string[];
      readonly bodyMode: ReportProfile['evidenceBodyMode'];
      readonly requestBodyOmittedChars: number;
      readonly responseBodyOmittedChars: number;
      readonly highlightEnabled: boolean;
      readonly responseDeficiencies: readonly string[];
      readonly responseStatusCode: number | null;
      readonly measuredValues: readonly { readonly label: string; readonly value: string }[];
    };
    /** URLごとの診断時HTTP通信。統合後も個々の再現根拠を失わない。 */
    readonly technicalEvidenceByUrl: readonly {
      readonly findingId: string;
      readonly url: string;
      readonly method: string;
      readonly parameter: string;
      readonly automatedRationale: string;
      readonly evidenceIds: readonly string[];
      readonly technicalEvidence: AssuranceReportDocument['findings'][number]['technicalEvidence'];
    }[];
    readonly summary: string;
    readonly conditions: string;
    readonly cause: string;
    readonly reproduction: { readonly prerequisites: string; readonly steps: readonly string[]; readonly actual: string };
    readonly remediation: { readonly immediate: string; readonly permanent: string };
    readonly verificationCriteria: string;
  }[];
  readonly evidence: readonly {
    readonly id: string;
    readonly type: string;
    readonly sha256: string;
    readonly capturedAt: string;
    readonly redactionStatus: string;
    readonly relatedFindingIds: readonly string[];
  }[];
  readonly specialNotes: readonly string[];
}

export interface ReportFindingFamily {
  readonly id: string;
  readonly title: string;
  readonly severity: string;
  readonly concreteRisk: string;
  readonly verificationStatus: string;
  readonly affectedUrlCount: number;
  readonly findingIds: readonly string[];
  readonly sourceFindingIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly remediationSummary: string;
  readonly annexReference: string;
}

const markdownCodeBlock = (value: string): string => value
  .replaceAll('\r\n', '\n')
  .replaceAll('\r', '\n')
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n');

/**
 * 既存の診断Markdownへ、再現に必要な実HTTP通信を指摘単位で直接追記する。
 * indented code blockを使い、HTTP本文中のbacktickをMarkdown構造として解釈させない。
 */
export function appendAssuranceHttpEvidenceMarkdown(
  content: string,
  report: AssuranceReportDocument,
): string {
  const sections = report.findings.map((finding) => [
    `### ${finding.id} ${finding.title.replace(/[\r\n]+/gu, ' ')}`,
    '',
    '**該当URL**',
    '',
    ...finding.urls.map((url) => `- ${url}`),
    '',
    '**概要と成立条件**',
    '',
    finding.summary,
    '',
    finding.conditions,
    '',
    `**自動判定根拠**: ${finding.automatedRationale}`,
    '',
    `**CWE**: ${finding.cwe.join(' / ')}`,
    '',
    `**OWASP Top 10**: ${finding.owaspTop10.join(' / ')}`,
    '',
    '**原因**',
    '',
    finding.cause,
    '',
    '**再現手順**',
    '',
    finding.reproduction.prerequisites,
    '',
    ...finding.reproduction.steps.map((step, index) => `${String(index + 1)}. ${step}`),
    '',
    ...finding.technicalEvidenceByUrl.flatMap((entry, evidenceIndex) => [
      `**診断時HTTP証跡 ${String(evidenceIndex + 1)} / ${String(finding.technicalEvidenceByUrl.length)}: ${entry.url}**`,
      '',
      `証跡単位の自動判定根拠: ${entry.automatedRationale}`,
      `HTTPメソッド・パラメータ: ${entry.method} / ${entry.parameter}`,
      '',
      `**着目箇所**: <mark>${entry.technicalEvidence.focusSummary.replace(/[\r\n]+/gu, ' ')}</mark>`,
      '',
      '**再現用 Request**',
      '',
      `証拠ID: ${entry.evidenceIds.join(' / ') || '未記録'}`,
      `レスポンスステータス: ${entry.technicalEvidence.responseStatusCode === null ? '取得不可' : String(entry.technicalEvidence.responseStatusCode)}`,
      ...entry.technicalEvidence.measuredValues.map((item) => `実測値 ${item.label}: ${item.value.replace(/[\r\n]+/gu, ' ')}`),
      '',
      markdownCodeBlock(entry.technicalEvidence.request),
      '',
      '**観測した Response**',
      '',
      markdownCodeBlock(entry.technicalEvidence.response),
      '',
    ]),
    '',
    `**確認結果**: ${finding.reproduction.actual}`,
    '',
    '**改善策**',
    '',
    `暫定対策: ${finding.remediation.immediate}`,
    '',
    `恒久対策: ${finding.remediation.permanent}`,
    '',
    '**修正確認条件**',
    '',
    finding.verificationCriteria,
    '',
  ].join('\n'));
  // buildReportModel由来の未統合な「所見」章は除き、統合済みの指摘詳細だけを出力する。
  const base = content.replace(/(?:^|\n)## 所見 \(\d+件\)[\s\S]*$/u, '').trimEnd();
  return `${base}\n\n## 指摘の再現情報（同一現象をURL単位で統合）\n\n${sections.join('\n\n')}\n`;
}

const splitLines = (value: string): readonly string[] => value
  .split(/[\r\n]+/u)
  .map((entry) => entry.trim())
  .filter(Boolean);

export const AUTOMATED_ASSESSMENT_ASSUMPTION = 'ご依頼いただいたものはツールによる自動診断であり、手動での診断は作業範囲外となります。';

const valueOr = (value: string, fallback = '未入力'): string => value.trim() === '' ? fallback : value.trim();

function maskUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) parsed.searchParams.set(key, '[redacted]');
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return raw.replace(/([?&][^=&#\s]+)=([^&#\s]+)/gu, '$1=[redacted]').replace(/#.*$/u, '');
  }
}

type UnknownRecord = Record<string, unknown>;

const MAX_REPORT_HTTP_CHARS = 48_000;

function recordOf(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as UnknownRecord : null;
}

function stringField(record: UnknownRecord, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function stringListField(record: UnknownRecord, ...keys: readonly string[]): readonly string[] {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.split(/[\r\n]+/u).map((entry) => entry.trim()).filter(Boolean);
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());
  }
  return [];
}

function safeXmlText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '\uFFFD');
}

function prepareHttpForReport(header: string, bodyText: string): string {
  const normalizedHeader = safeXmlText(header).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const normalizedBody = safeXmlText(bodyText).replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimEnd();
  const combined = normalizedBody === '' ? normalizedHeader.trimEnd() : `${normalizedHeader.trimEnd()}\n\n${normalizedBody}`;
  if (combined.length <= MAX_REPORT_HTTP_CHARS) return combined;
  return `${combined.slice(0, MAX_REPORT_HTTP_CHARS)}\n[報告書掲載上限により以降を省略]`;
}

function prepareRawHttpForReport(value: string): string {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const separator = normalized.indexOf('\n\n');
  if (separator < 0) return prepareHttpForReport(normalized, '');
  return prepareHttpForReport(normalized.slice(0, separator), normalized.slice(separator + 2));
}

interface RawTechnicalEvidence {
  readonly request: string;
  readonly response: string;
  readonly collectionStatus: string;
  readonly source: string;
  readonly attackInput: string;
  readonly observedEvidence: string;
  readonly description: string;
  readonly solution: string;
  readonly references: readonly string[];
}

interface PresentedHttpEvidence {
  readonly text: string;
  readonly omittedBodyChars: number;
}

export interface ReportFindingNarrative {
  readonly findingId: string;
  readonly summary: string;
  readonly conditions: string;
  readonly cause: string;
  readonly reproductionSteps: readonly string[];
  readonly remediation: string;
  readonly verificationCriteria: string;
}

const MAX_RELEVANT_BODY_CHARS = 2_400;
const RELEVANT_BODY_CONTEXT_CHARS = 260;
const MAX_HIGHLIGHT_TERMS = 12;

function splitHttpEvidence(value: string): { readonly header: string; readonly body: string } {
  const normalized = safeXmlText(value).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const separator = normalized.indexOf('\n\n');
  return separator < 0
    ? { header: normalized.trimEnd(), body: '' }
    : { header: normalized.slice(0, separator).trimEnd(), body: normalized.slice(separator + 2).trimEnd() };
}

function redactSensitiveHttpHeaders(header: string): string {
  return header.split('\n').map((line) => {
    const separator = line.indexOf(':');
    if (separator < 0) return line;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (/^(?:authorization|proxy-authorization)$/iu.test(name)) return `${name}: [redacted]`;
    if (/^(?:x-csrf-token|x-xsrf-token)$/iu.test(name)) return `${name}: [redacted]`;
    if (/^cookie$/iu.test(name)) {
      const cookies = value.split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
        const equals = entry.indexOf('=');
        return equals < 0 ? `${entry}=[redacted]` : `${entry.slice(0, equals)}=[redacted]`;
      });
      return `${name}: ${cookies.join('; ')}`;
    }
    if (/^set-cookie$/iu.test(name)) {
      const [cookiePair, ...attributes] = value.split(';').map((entry) => entry.trim());
      const equals = cookiePair?.indexOf('=') ?? -1;
      const redactedPair = equals < 0 ? '[redacted]' : `${cookiePair!.slice(0, equals)}=[redacted]`;
      return `${name}: ${[redactedPair, ...attributes].join('; ')}`;
    }
    return line;
  }).join('\n');
}

function isAsciiWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/u.test(value);
}

function termMatchesAt(text: string, lowerText: string, index: number, term: string): boolean {
  const lowerTerm = term.toLocaleLowerCase();
  if (!lowerText.startsWith(lowerTerm, index)) return false;
  if (!/^[A-Za-z0-9_]+$/u.test(term)) return true;
  return !isAsciiWordCharacter(text[index - 1]) && !isAsciiWordCharacter(text[index + term.length]);
}

function matchingSpans(text: string, terms: readonly string[]): readonly { readonly start: number; readonly end: number }[] {
  const lowerText = text.toLocaleLowerCase();
  const ordered = [...terms].sort((left, right) => right.length - left.length);
  const spans: { start: number; end: number }[] = [];
  for (let index = 0; index < text.length;) {
    const matched = ordered.find((term) => termMatchesAt(text, lowerText, index, term));
    if (matched === undefined) {
      index += 1;
      continue;
    }
    spans.push({ start: index, end: index + matched.length });
    index += matched.length;
  }
  return spans;
}

function omissionMarker(characters: number): string {
  return `[Body省略: ${String(characters)}文字（原本は案件証跡に保管）]`;
}

function compactRelevantBody(bodyText: string, terms: readonly string[]): { readonly body: string; readonly omittedChars: number } {
  if (bodyText === '') return { body: '', omittedChars: 0 };
  if (bodyText.length <= MAX_RELEVANT_BODY_CHARS) return { body: bodyText, omittedChars: 0 };
  const matches = matchingSpans(bodyText, terms);
  if (matches.length === 0) return { body: omissionMarker(bodyText.length), omittedChars: bodyText.length };

  const windows = matches.slice(0, 6).map((match) => ({
    start: Math.max(0, match.start - RELEVANT_BODY_CONTEXT_CHARS),
    end: Math.min(bodyText.length, match.end + RELEVANT_BODY_CONTEXT_CHARS),
  })).sort((left, right) => left.start - right.start);
  const merged: { start: number; end: number }[] = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous !== undefined && window.start <= previous.end + 40) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }

  const segments: string[] = [];
  let cursor = 0;
  let includedChars = 0;
  for (const window of merged) {
    if (window.start > cursor) segments.push(omissionMarker(window.start - cursor));
    const fragment = bodyText.slice(window.start, window.end).trim();
    if (fragment !== '') segments.push(fragment);
    includedChars += window.end - window.start;
    cursor = window.end;
  }
  if (cursor < bodyText.length) segments.push(omissionMarker(bodyText.length - cursor));
  return { body: segments.join('\n'), omittedChars: Math.max(0, bodyText.length - includedChars) };
}

function presentHttpEvidence(
  value: string,
  bodyMode: ReportProfile['evidenceBodyMode'],
  terms: readonly string[],
): PresentedHttpEvidence {
  const split = splitHttpEvidence(value);
  const header = redactSensitiveHttpHeaders(split.header);
  const bodyText = split.body;
  if (bodyText === '' || bodyMode === 'full') return { text: bodyText === '' ? header : `${header}\n\n${bodyText}`, omittedBodyChars: 0 };
  if (bodyMode === 'omit') {
    return { text: `${header}\n\n${omissionMarker(bodyText.length)}`, omittedBodyChars: bodyText.length };
  }
  const compacted = compactRelevantBody(bodyText, terms);
  return {
    text: compacted.body === '' ? header : `${header}\n\n${compacted.body}`,
    omittedBodyChars: compacted.omittedChars,
  };
}

type HighlightEvidenceSource = Pick<RawTechnicalEvidence, 'request' | 'response' | 'attackInput' | 'observedEvidence'>;

function evidenceHighlightTerms(
  parameter: string | undefined,
  evidence: HighlightEvidenceSource,
): { readonly request: readonly string[]; readonly response: readonly string[]; readonly all: readonly string[] } {
  const requestCandidates: string[] = [];
  const responseCandidates: string[] = [];
  const add = (target: string[], value: string): void => {
    const normalized = value.trim().replace(/[\r\n]+/gu, ' ');
    if (normalized.length < 2 || normalized.length > 256 || /^\[(?:伏せ字|Body省略)/u.test(normalized)) return;
    target.push(normalized);
  };
  add(requestCandidates, evidence.attackInput);
  add(responseCandidates, evidence.attackInput);
  if (evidence.observedEvidence.length <= 256) add(responseCandidates, evidence.observedEvidence);
  for (const match of evidence.observedEvidence.matchAll(/["'`]([^"'`\r\n]{2,128})["'`]/gu)) {
    add(responseCandidates, match[1] ?? '');
  }
  if (parameter !== undefined && parameter !== '' && parameter !== '未入力') {
    add(requestCandidates, parameter);
    for (const token of parameter.split(/[\s/,|]+/gu)) add(requestCandidates, token);
  }
  const finalize = (candidates: readonly string[], text: string): readonly string[] => [...new Map(
    candidates.map((value) => [value.toLocaleLowerCase(), value]),
  ).values()]
    .filter((value) => matchingSpans(text, [value]).length > 0)
    .sort((left, right) => right.length - left.length)
    .slice(0, MAX_HIGHLIGHT_TERMS);
  const request = finalize(requestCandidates, evidence.request);
  const response = finalize(responseCandidates, evidence.response);
  const all = [...new Map([...request, ...response].map((value) => [value.toLocaleLowerCase(), value])).values()]
    .sort((left, right) => right.length - left.length)
    .slice(0, MAX_HIGHLIGHT_TERMS);
  return { request, response, all };
}

function focusSummary(finding: Finding, evidence: RawTechnicalEvidence): string {
  const details = [
    finding.param === undefined ? '' : `パラメータ「${finding.param}」`,
    evidence.attackInput === '' ? '' : `診断入力「${evidence.attackInput.slice(0, 160)}」`,
    evidence.observedEvidence === '' ? '' : `観測根拠「${evidence.observedEvidence.slice(0, 240)}」`,
  ].filter(Boolean);
  return details.length > 0
    ? `着目箇所: ${details.join(' / ')}`
    : `着目箇所: 指摘「${finding.title}」に関係するリクエスト行、応答ステータスおよびヘッダー`;
}

function responseHeaderNames(response: string): ReadonlySet<string> {
  const header = splitHttpEvidence(response).header;
  return new Set(header.split('\n').slice(1).flatMap((line) => {
    const separator = line.indexOf(':');
    return separator <= 0 ? [] : [line.slice(0, separator).trim().toLocaleLowerCase()];
  }));
}

function responseDeficiencies(finding: Finding, evidence: RawTechnicalEvidence): readonly string[] {
  const text = `${finding.title} ${evidence.description} ${evidence.observedEvidence}`;
  const headers = responseHeaderNames(evidence.response);
  const deficiencies: string[] = [];
  const missing = /(?:missing|not set|absent|未設定|欠落|不足)/iu.test(text);
  if (missing && /(?:anti.?clickjack|clickjack|x-frame-options)/iu.test(text)
    && !headers.has('x-frame-options') && !/content-security-policy:[^\n]*frame-ancestors/iu.test(evidence.response)) {
    deficiencies.push('レスポンスに X-Frame-Options または Content-Security-Policy の frame-ancestors 指令がありません。');
  }
  const expectedHeaders: readonly (readonly [RegExp, string])[] = [
    [/(?:content.security.policy|\bCSP\b)/iu, 'Content-Security-Policy'],
    [/(?:strict.transport.security|\bHSTS\b)/iu, 'Strict-Transport-Security'],
    [/x-content-type-options/iu, 'X-Content-Type-Options'],
    [/referrer-policy/iu, 'Referrer-Policy'],
    [/(?:permissions-policy|feature-policy)/iu, 'Permissions-Policy'],
  ];
  if (missing) {
    for (const [pattern, name] of expectedHeaders) {
      if (pattern.test(text) && !headers.has(name.toLocaleLowerCase())) deficiencies.push(`レスポンスに ${name} ヘッダがありません。`);
    }
  }
  const setCookieLines = splitHttpEvidence(evidence.response).header.split('\n').filter((line) => /^set-cookie:/iu.test(line));
  if (/(?:cookie.*httponly|httponly.*cookie)/iu.test(text) && setCookieLines.some((line) => !/;\s*httponly(?:;|$)/iu.test(line))) {
    deficiencies.push('Set-Cookie ヘッダの対象Cookieに HttpOnly 属性がありません。');
  }
  if (/(?:cookie.*secure|secure.*cookie)/iu.test(text) && setCookieLines.some((line) => !/;\s*secure(?:;|$)/iu.test(line))) {
    deficiencies.push('Set-Cookie ヘッダの対象Cookieに Secure 属性がありません。');
  }
  if (/(?:cookie.*samesite|samesite.*cookie)/iu.test(text) && setCookieLines.some((line) => !/;\s*samesite=/iu.test(line))) {
    deficiencies.push('Set-Cookie ヘッダの対象Cookieに SameSite 属性がありません。');
  }
  return [...new Set(deficiencies)];
}

function presentTechnicalEvidence(
  finding: Finding,
  evidence: RawTechnicalEvidence,
  profile: ReportProfile,
): AssuranceReportDocument['findings'][number]['technicalEvidence'] {
  const highlightTerms = evidenceHighlightTerms(finding.param, evidence);
  const request = presentHttpEvidence(evidence.request, profile.evidenceBodyMode, highlightTerms.request);
  const response = presentHttpEvidence(evidence.response, profile.evidenceBodyMode, highlightTerms.response);
  const deficiencies = responseDeficiencies(finding, evidence);
  const responseHeader = splitHttpEvidence(response.text).header;
  const rawResponseBody = splitHttpEvidence(evidence.response).body;
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/mu.exec(responseHeader);
  const responseStatusCode = statusMatch === null ? null : Number(statusMatch[1]);
  const measuredValues: { label: string; value: string }[] = [];
  for (const headerName of ['Server', 'X-Powered-By']) {
    const match = new RegExp(`^${headerName}:\\s*(.+)$`, 'imu').exec(responseHeader);
    if (match?.[1] !== undefined) measuredValues.push({ label: headerName, value: match[1].trim() });
  }
  if (responseStatusCode !== null) measuredValues.push({ label: 'HTTP status', value: String(responseStatusCode) });
  measuredValues.push({ label: '受信Response body文字数（デコード後・省略前）', value: String(rawResponseBody.length) });
  if (evidence.observedEvidence !== '') measuredValues.push({ label: '検出値', value: evidence.observedEvidence });
  const sqlError = /(?:SQL syntax[^<\r\n]{0,300}|mysqli?_[a-z_]+\([^<\r\n]{0,300}|PDOException[^<\r\n]{0,300}|ORA-\d{4,5}[^<\r\n]{0,300}|PostgreSQL[^<\r\n]{0,300})/iu.exec(rawResponseBody)?.[0];
  if (sqlError !== undefined) measuredValues.push({ label: 'SQLエラー文字列', value: sqlError.trim() });
  const comments = [...rawResponseBody.matchAll(/<!--[\s\S]*?-->/gu)].map((match) => match[0].trim()).slice(0, 10);
  for (const [index, comment] of comments.entries()) measuredValues.push({ label: `HTMLコメント ${String(index + 1)}`, value: comment.slice(0, 2_000) });
  if (responseStatusCode !== null && responseStatusCode >= 400) {
    const plain = rawResponseBody.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (plain !== '') measuredValues.push({ label: 'エラー応答本文', value: plain.slice(0, 2_000) });
  }
  return {
    ...evidence,
    request: request.text,
    response: response.text,
    focusSummary: focusSummary(finding, evidence),
    highlightTerms: highlightTerms.all,
    requestHighlightTerms: highlightTerms.request,
    responseHighlightTerms: highlightTerms.response,
    bodyMode: profile.evidenceBodyMode,
    requestBodyOmittedChars: request.omittedBodyChars,
    responseBodyOmittedChars: response.omittedBodyChars,
    highlightEnabled: profile.highlightEvidence,
    responseDeficiencies: deficiencies,
    responseStatusCode,
    measuredValues,
  };
}

function findingMatchesRecord(finding: Finding, record: UnknownRecord): boolean {
  const pluginId = stringField(record, 'pluginId', 'plugin-id', 'template-id');
  const url = stringField(record, 'url', 'matched-at', 'matchedAt');
  const param = stringField(record, 'param');
  return (finding.enginePluginId === undefined || pluginId === finding.enginePluginId)
    && (url === '' || url === finding.url)
    && (finding.param === undefined || param === '' || param === finding.param);
}

function exchangeFromRecord(record: UnknownRecord): {
  request: string;
  response: string;
  attackInput: string;
  observedEvidence: string;
  captureError: string;
  recoveryStrategy: string;
  description: string;
  solution: string;
  references: readonly string[];
} {
  const nestedRequest = recordOf(record.request);
  const nestedResponse = recordOf(record.response);
  const nestedInfo = recordOf(record.info);
  const rawRequest = typeof record.request === 'string' ? record.request : '';
  const rawResponse = typeof record.response === 'string' ? record.response : '';
  const requestHeader = stringField(record, 'requestHeader', 'request-header') || (nestedRequest === null ? '' : stringField(nestedRequest, 'header', 'headers'));
  const requestBody = stringField(record, 'requestBody', 'request-body') || (nestedRequest === null ? '' : stringField(nestedRequest, 'body'));
  const responseHeader = stringField(record, 'responseHeader', 'response-header') || (nestedResponse === null ? '' : stringField(nestedResponse, 'header', 'headers'));
  const responseBody = stringField(record, 'responseBody', 'response-body') || (nestedResponse === null ? '' : stringField(nestedResponse, 'body'));
  return {
    request: requestHeader === '' && requestBody === '' ? prepareRawHttpForReport(rawRequest) : prepareHttpForReport(requestHeader, requestBody),
    response: responseHeader === '' && responseBody === '' ? prepareRawHttpForReport(rawResponse) : prepareHttpForReport(responseHeader, responseBody),
    attackInput: safeXmlText(stringField(record, 'attack', 'matched', 'matcher-name')),
    observedEvidence: safeXmlText(stringField(record, 'evidenceSummary', 'evidence', 'extracted-results')),
    captureError: stringField(record, 'httpExchangeCaptureError'),
    recoveryStrategy: stringField(record, 'recoveryStrategy'),
    description: stringField(record, 'description') || (nestedInfo === null ? '' : stringField(nestedInfo, 'description')),
    solution: stringField(record, 'solution', 'remediation') || (nestedInfo === null ? '' : stringField(nestedInfo, 'remediation', 'solution')),
    references: [...new Set([
      ...stringListField(record, 'reference', 'references'),
      ...(nestedInfo === null ? [] : stringListField(nestedInfo, 'reference', 'references')),
    ])],
  };
}

function extractFindingTechnicalEvidence(
  finding: Finding,
  evidenceContents: Readonly<Record<string, string>>,
): RawTechnicalEvidence {
  let partial: ReturnType<typeof exchangeFromRecord> | null = null;
  for (const evidenceId of finding.evidenceRefs) {
    const content = evidenceContents[evidenceId];
    if (content === undefined || content.trim() === '') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { parsed = content; }
    const root = recordOf(parsed);
    const candidates: UnknownRecord[] = [];
    if (root !== null) {
      if (Array.isArray(root.alerts)) candidates.push(...root.alerts.map(recordOf).filter((entry): entry is UnknownRecord => entry !== null));
      if (Array.isArray(root.lines)) {
        for (const line of root.lines) {
          if (typeof line !== 'string') continue;
          try {
            const lineRecord = recordOf(JSON.parse(line));
            if (lineRecord !== null) candidates.push(lineRecord);
          } catch { /* quarantine 済みの行は報告証跡にも使わない */ }
        }
      }
      candidates.push(root);
    }
    for (const candidate of candidates) {
      if (!findingMatchesRecord(finding, candidate)) continue;
      const exchange = exchangeFromRecord(candidate);
      if (exchange.request !== '' || exchange.response !== '') {
        partial = exchange;
        if (exchange.request !== '' && exchange.response !== '') {
          return {
            request: exchange.request,
            response: exchange.response,
            collectionStatus: exchange.recoveryStrategy === 'alert-endpoint'
              ? '旧診断データを補完するため、ZAP履歴に残る同一エンドポイント・同一診断項目の最新観測を使用しました。'
              : exchange.recoveryStrategy !== ''
                ? '旧診断データをZAPの保存済みHTTP履歴から自動補完しました。再送は行っていません。'
                : finding.source.kind === 'zap-alert'
                  ? 'ZAP message APIから診断時に取得しました。'
                  : '診断エンジンの結果から取得しました。',
            source: finding.source.kind,
            attackInput: exchange.attackInput,
            observedEvidence: exchange.observedEvidence,
            description: exchange.description,
            solution: exchange.solution,
            references: exchange.references,
          };
        }
      } else if (exchange.captureError !== '') {
        partial = exchange;
      }
    }
  }
  const request = partial?.request ?? '';
  const response = partial?.response ?? '';
  return {
    request,
    response,
    collectionStatus: partial?.captureError
      ? '警告は取得しましたが、関連するHTTPメッセージをZAPから取得できませんでした。'
      : 'この指摘に対応するHTTP通信は既存の証跡から特定できませんでした。再診断時に自動収集します。',
    source: finding.source.kind,
    attackInput: partial?.attackInput ?? '',
    observedEvidence: partial?.observedEvidence ?? '',
    description: partial?.description ?? '',
    solution: partial?.solution ?? '',
    references: partial?.references ?? [],
  };
}

const hasHttpRequestLine = (value: string): boolean => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s+\S+\s+HTTP\/\d(?:\.\d)?\s*$/mu.test(value);
const hasHttpResponseLine = (value: string): boolean => /^HTTP\/\d(?:\.\d)?\s+\d{3}(?:\s|$)/mu.test(value);

export function hasCompleteFindingHttpEvidence(
  finding: Finding,
  evidenceContents: Readonly<Record<string, string>>,
): boolean {
  const technicalEvidence = extractFindingTechnicalEvidence(finding, evidenceContents);
  if (!hasHttpRequestLine(technicalEvidence.request) || !hasHttpResponseLine(technicalEvidence.response)) return false;
  const firstLine = technicalEvidence.request.split(/\r?\n/u, 1)[0] ?? '';
  const match = /^\S+\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/u.exec(firstLine);
  if (match === null) return false;
  try {
    const actual = new URL(match[1]!, finding.url);
    const expected = new URL(finding.url);
    return expected.search === ''
      ? actual.origin === expected.origin && actual.pathname === expected.pathname
      : actual.toString() === expected.toString();
  } catch {
    return match[1] === finding.url;
  }
}

const severityLabel = (severity: Finding['severity']): string => ({
  high: 'High', medium: 'Medium', low: 'Low', info: 'Informational', unknown: '未評価',
})[severity];

const validationLabel = (finding: Finding): string => {
  if (finding.status === 'confirmed') return '確認済み';
  if (finding.status === 'rejected') return '誤検知';
  if (finding.status === 'merged') return '統合済み';
  return finding.source.unverified ? '推定' : '判定保留';
};

function taxonomyForFinding(finding: Finding): { readonly cwe: readonly string[]; readonly owaspTop10: readonly string[] } {
  const text = `${finding.title} ${finding.param ?? ''}`;
  const rules: readonly { pattern: RegExp; cwe: readonly string[]; owasp: readonly string[] }[] = [
    { pattern: /SQL.*(?:injection|インジェクション)/iu, cwe: ['CWE-89'], owasp: ['A05:2025 Injection'] },
    { pattern: /(?:OS command|command injection|コマンドインジェクション)/iu, cwe: ['CWE-78'], owasp: ['A05:2025 Injection'] },
    { pattern: /(?:cross.?site scripting|\bXSS\b|クロスサイトスクリプティング)/iu, cwe: ['CWE-79'], owasp: ['A05:2025 Injection'] },
    { pattern: /(?:template injection|SSTI|テンプレートインジェクション)/iu, cwe: ['CWE-1336'], owasp: ['A05:2025 Injection'] },
    { pattern: /(?:XSLT|XPath).*injection|XSLTインジェクション/iu, cwe: ['CWE-91'], owasp: ['A05:2025 Injection'] },
    { pattern: /(?:file inclusion|path traversal|directory traversal|ファイルインクルージョン|パストラバーサル)/iu, cwe: ['CWE-22', 'CWE-98'], owasp: ['A01:2025 Broken Access Control'] },
    { pattern: /(?:open redirect|external redirect|外部(?:への)?リダイレクト|オープンリダイレクト)/iu, cwe: ['CWE-601'], owasp: ['A01:2025 Broken Access Control'] },
    { pattern: /(?:CSRF|cross.?site request forgery)/iu, cwe: ['CWE-352'], owasp: ['A01:2025 Broken Access Control'] },
    { pattern: /(?:clickjacking|frame-ancestors|X-Frame-Options)/iu, cwe: ['CWE-1021'], owasp: ['A02:2025 Security Misconfiguration'] },
    { pattern: /(?:credentials?.*(?:URL|query)|(?:URL|query).*(?:credentials?|password|token)|URL内の認証情報)/iu, cwe: ['CWE-598'], owasp: ['A07:2025 Authentication Failures'] },
    { pattern: /(?:parameter tampering|パラメータ(?:の)?改ざん)/iu, cwe: ['CWE-20'], owasp: ['A10:2025 Mishandling of Exceptional Conditions'] },
    { pattern: /(?:buffer overflow|バッファオーバーフロー)/iu, cwe: ['CWE-120'], owasp: ['A10:2025 Mishandling of Exceptional Conditions'] },
    { pattern: /(?:suspicious comment|疑わしいコメント)/iu, cwe: ['CWE-615'], owasp: ['A02:2025 Security Misconfiguration'] },
    { pattern: /(?:DOM.*(?:flow|attribute|input)|user controlled HTML attribute|DOMフロー)/iu, cwe: ['CWE-79'], owasp: ['A05:2025 Injection'] },
    { pattern: /(?:content.security.policy|\bCSP\b|X-Content-Type-Options|security header)/iu, cwe: ['CWE-693'], owasp: ['A02:2025 Security Misconfiguration'] },
    { pattern: /(?:Server|X-Powered-By|information disclosure|情報露見|timestamp|タイムスタンプ)/iu, cwe: ['CWE-200'], owasp: ['A02:2025 Security Misconfiguration'] },
    { pattern: /(?:cookie|SameSite|HttpOnly|Secure attribute)/iu, cwe: ['CWE-614', 'CWE-1004'], owasp: ['A04:2025 Cryptographic Failures'] },
    { pattern: /(?:authentication|認証|default credential|brute force)/iu, cwe: ['CWE-287'], owasp: ['A07:2025 Authentication Failures'] },
  ];
  const matched = rules.find((rule) => rule.pattern.test(text));
  return matched === undefined ? { cwe: ['CWE未分類'], owaspTop10: ['OWASP Top 10未分類'] } : { cwe: matched.cwe, owaspTop10: matched.owasp };
}

function automatedValidation(finding: Finding, evidence: RawTechnicalEvidence): { readonly status: string; readonly rationale: string } {
  const wire = `${evidence.request}\n${evidence.response}\n${evidence.attackInput}\n${evidence.observedEvidence}\n${evidence.description}`;
  const phpOrLinux = /(?:X-Powered-By:\s*PHP|Server:.*(?:Apache|nginx|Debian|Ubuntu)|\bPHP\b)/iu.test(wire);
  const windowsPayload = /(?:start-sleep|timeout\s+\/T|powershell(?:\.exe)?|cmd(?:\.exe)?\s+\/c)/iu.test(wire);
  const nonPhpTemplatePayload = /(?:<#assign|freemarker|#set\s*\(|velocity|<%=|\bERB\b)/iu.test(wire);
  if (phpOrLinux && windowsPayload) return { status: '判定保留（技術スタック不整合）', rationale: 'Linux/PHP系の応答に対してWindows専用ペイロードが使用されているため、自動成立判定を採用しません。' };
  if (phpOrLinux && nonPhpTemplatePayload) return { status: '判定保留（技術スタック不整合）', rationale: 'PHP系の応答に対してJava/Ruby系テンプレート専用ペイロードが使用されているため、自動成立判定を採用しません。' };
  const timingPayload = /(?:\bsleep\s*\(|\bsleep\s+\d|benchmark\s*\(|pg_sleep|waitfor\s+delay|start-sleep|timeout\s+\/T)/iu.test(wire);
  const timingMeasured = /(?:elapsed|duration|response.?time|遅延|応答時間)[^\r\n]{0,40}\d+(?:\.\d+)?\s*(?:ms|msec|s|sec|秒)/iu.test(evidence.observedEvidence);
  if (timingPayload && !timingMeasured) return { status: '判定保留（時間計測値なし）', rationale: '時間ベースのペイロードですが、基準応答との差と実測遅延時間が証拠に記録されていないため、成立とは判定しません。' };
  const sqlFinding = /SQL.*(?:injection|インジェクション)/iu.test(finding.title);
  const sqlProof = /(?:SQL syntax|mysqli?|PDOException|ORA-\d{4,5}|PostgreSQL|true.+false|真条件.+偽条件|偽条件.+真条件)/isu.test(wire);
  const reflectedAttack = evidence.attackInput.length >= 2 && splitHttpEvidence(evidence.response).body.includes(evidence.attackInput);
  const controlParameter = /^(?:btn(?:sign|clear)?|submit|send|button|action)$/iu.test(finding.param ?? '');
  if (sqlFinding && !sqlProof && (reflectedAttack || controlParameter)) {
    return { status: '判定保留（SQL成立根拠不足）', rationale: '入力反射または操作用パラメータの応答差だけではSQL実行を証明できません。真条件・偽条件の対照差、DBエラー文字列、または再現性のある時間差が記録されるまで成立とは判定しません。' };
  }
  return { status: validationLabel(finding), rationale: evidence.observedEvidence || 'HTTPステータス、応答ヘッダー、応答本文および検出エンジンの観測値を根拠とします。' };
}

function highestSeverity(findings: readonly Finding[]): string {
  const order: readonly Finding['severity'][] = ['high', 'medium', 'low', 'info', 'unknown'];
  return severityLabel(order.find((candidate) => findings.some((finding) => finding.severity === candidate)) ?? 'unknown');
}

interface VulnerabilityGuidance {
  readonly matches: RegExp;
  readonly summary: string;
  readonly condition: string;
  readonly cause: string;
  readonly remediation: string;
  readonly verification: string;
}

const VULNERABILITY_GUIDANCE: readonly VulnerabilityGuidance[] = [
  {
    matches: /(?:IDOR|insecure direct object|broken access|他利用者|権限外|認可不備)/iu,
    summary: '利用者が指定できるオブジェクト識別子に対する認可確認が不足し、権限のない利用者でも他者または上位権限のデータへアクセスできる脆弱性です。',
    condition: '認証済み利用者がリクエスト中の識別子を別利用者の値へ変更した際に、サーバーがセッションの利用者と対象オブジェクトの所有者または権限を照合せず、同等の成功応答を返す場合に成立します。',
    cause: '対象レコードをリクエストの識別子だけで検索し、セッションから得た利用者IDやテナントIDを検索条件へ加えていない可能性があります。別の可能性として、ルーティングからサービス層へ至る途中で共通認可ガードを通していない、管理者用の許可分岐が通常利用者にも適用される、または画面側の非表示だけをアクセス制御としていることが考えられます。',
    remediation: '各リクエストで、セッションから確定した利用者IDと対象オブジェクトの所有者・テナント・必要ロールをサーバー側で照合してください。クライアントから渡された所有者IDやロールを認可根拠にせず、取得・更新・削除の各サービス処理へ共通の認可ガードを適用し、他者IDを指定した負のテストを追加してください。',
    verification: '同じセッションで他利用者の識別子を指定した全対象メソッドが403または404となり、応答本文に他利用者のデータが含まれないことを確認します。',
  },
  {
    matches: /(?:external service interaction|server.side request|\bSSRF\b|外部サービスインタラクション)/iu,
    summary: '利用者が制御できる値を使ってサーバーが外部宛てのHTTPリクエストを実行できるため、内部ネットワークや任意ホストへの到達に悪用される脆弱性です。',
    condition: 'URL、ホスト名、リダイレクト先などの入力が送信先制御へ到達し、許可済み宛先との照合や名前解決後IPの再検証がない場合に成立します。',
    cause: '利用者入力のURLやホスト名がHTTPクライアントへ直接渡され、スキーム・ホスト・ポートの許可リスト検証がない可能性があります。入力時だけ検証して接続直前の名前解決結果を確認していない、リダイレクト先を再検証していない、またはプロキシ設定により内部宛て通信が許可されていることも原因候補です。',
    remediation: 'サーバー側の送信先を必要なスキーム・ホスト・ポートの許可リストへ限定し、DNS解決後の全IPがプライベート、ループバック、リンクローカル、メタデータサービス等でないことを接続直前にも検証してください。リダイレクト追従時も各hopを再検証し、送信処理を外向き通信が制限されたネットワークへ分離してください。',
    verification: '許可外ドメイン、127.0.0.1、プライベートIP、DNSリバインディング相当の入力および許可外へのリダイレクトが送信前に拒否されることを確認します。',
  },
  {
    matches: /(?:SQL.?Injection|SQLインジェクション)/iu,
    summary: '入力値がSQL文の構造として解釈され、データの参照・改変や認証回避につながるSQLインジェクション脆弱性です。',
    condition: '外部入力を文字列連結してSQL文を組み立て、プレースホルダーによる値の分離が行われていない場合に成立します。',
    cause: '入力値をSQL文字列へ連結している、動的クエリの一部だけがプレースホルダー化されていない、またはORMのraw queryへ未検証値を渡している可能性があります。列名や並び順のように通常の値バインドが使えない要素を許可リスト化せず、そのままSQL構造へ組み込んでいることも考えられます。',
    remediation: '対象クエリをプレースホルダー付きのプリペアドステートメントへ変更し、値を必ずバインドしてください。列名やソート順などバインドできない要素は固定の許可リストから選択し、DB接続権限を機能に必要な範囲へ限定してください。',
    verification: '引用符、論理式、UNION、時間遅延を含む入力がSQL構造を変化させず、通常入力と同じエラー処理または検証拒否になることを確認します。',
  },
  {
    matches: /(?:cross.site scripting|\bXSS\b|クロスサイトスクリプティング|DOM.*(?:flow|attribute)|user controll(?:ed|able) HTML attribute|DOMフロー)/iu,
    summary: '利用者が入力した文字列がHTMLやJavaScriptの実行文脈へ安全に符号化されず出力され、閲覧者のブラウザーで任意スクリプトが実行される脆弱性です。',
    condition: '入力値がHTML本文、属性、URL、JavaScriptなどの出力文脈へ到達し、その文脈に対応するエスケープまたは安全なDOM APIが適用されない場合に成立します。',
    cause: '入力値をテンプレートの安全でない出力機能やinnerHTML等へ渡し、出力文脈に対応したエンコードを適用していない可能性があります。別の可能性として、サニタイザーの許可要素・属性が広すぎる、二重デコード後の値を再検証していない、またはHTML本文用の処理を属性・URL・JavaScript文脈へ誤用していることが考えられます。',
    remediation: '出力先の文脈ごとにHTML・属性・URL・JavaScript用のエンコードを適用し、DOM更新にはtextContent等の非解釈APIを使用してください。HTMLを許可する箇所は許可要素と属性を限定したサニタイザーを使い、補助防御としてnonce方式のContent-Security-Policyを設定してください。',
    verification: '各出力文脈へタグ、属性終端、イベントハンドラ、JavaScript URLを入力してもDOM上でコードとして解釈されず、文字列として表示または拒否されることを確認します。',
  },
  {
    matches: /(?:cross.site request forgery|\bCSRF\b|クロスサイトリクエストフォージェリ)/iu,
    summary: '状態を変更するリクエストが利用者の明示操作に由来することを検証せず、第三者サイトから認証済み操作を実行させられる脆弱性です。',
    condition: 'Cookie認証を使用する更新系リクエストが、セッションに結び付くCSRF token、Origin/Referer、SameSite Cookieなどを検証しない場合に成立します。',
    cause: '更新系エンドポイントにCSRF検証middlewareが適用されていない、tokenを発行していてもセッションとの対応や一致を検証していない、またはGET等の保護対象外メソッドで状態変更している可能性があります。CookieのSameSite設定が用途に対して緩すぎることや、Origin検証の許可条件が広すぎることも原因候補です。',
    remediation: '更新系リクエストへセッションごとに予測困難なCSRF tokenを発行し、サーバー側で一致を検証してください。併せてOriginを許可リスト照合し、セッションCookieにSecure・HttpOnly・適切なSameSite属性を設定してください。',
    verification: 'token欠落・改変および許可外Originからの更新要求が403等で拒否され、正規画面からの有効token付き要求だけが成功することを確認します。',
  },
  {
    matches: /(?:template injection|SSTI|テンプレートインジェクション|XSLT|XPath.*injection)/iu,
    summary: '外部入力がテンプレート式または変換式として評価され、情報参照や意図しない処理へ到達する可能性があります。',
    condition: '利用者入力をテンプレート本文、式、スタイルシートまたはXPathへ連結し、安全なデータ値として分離しない場合に成立します。',
    cause: '動的テンプレートや変換定義を利用者入力から組み立て、評価機能、拡張関数、外部参照を有効にしたまま実行している可能性があります。',
    remediation: 'テンプレート・XSLT・XPath自体を固定し、入力は変数または型付きパラメータとして渡してください。動的評価、拡張関数、外部文書・ネットワーク参照を無効化し、許可した識別子だけをサーバー側で対応付けてください。',
    verification: '式構文、外部参照、関数呼び出しを含む入力がデータとして扱われ、評価結果や外部通信が発生しないことを確認します。',
  },
  {
    matches: /(?:command injection|OS command|コマンドインジェクション)/iu,
    summary: '外部入力がOSコマンドの一部として解釈され、アプリケーション実行権限で任意コマンドを実行できる脆弱性です。',
    condition: 'シェルを介してコマンド文字列を組み立て、入力中の区切り文字や展開構文を無害化せず実行する場合に成立します。',
    cause: '入力値を含むコマンド文字列をshell経由で実行し、実行ファイルと引数をデータとして分離していない可能性があります。エスケープ処理がOSやshellの文法と一致していない、複数段のデコード後に危険文字が復元される、または許可値ではなく禁止文字だけで検証していることも考えられます。',
    remediation: 'シェル呼び出しを廃止して目的の処理をライブラリAPIで実装してください。外部プロセスが必要な場合は実行ファイルと引数を配列で固定し、入力を用途別の許可リストで検証し、専用の低権限アカウントとサンドボックスで実行してください。',
    verification: 'シェル区切り文字、コマンド置換、改行を含む入力が実行されず、許可された引数だけが子プロセスへ渡ることを監査ログと副作用の不在で確認します。',
  },
  {
    matches: /(?:path traversal|directory traversal|(?:local|remote)?\s*file inclusion|パストラバーサル|ディレクトリトラバーサル|ファイルインクルージョン)/iu,
    summary: 'ファイルパス入力の検証が不足し、許可されたディレクトリ外のファイルを参照または操作できる脆弱性です。',
    condition: '..、絶対パス、代替区切り文字、二重エンコード等を正規化した後の実パスが許可ルート内か確認されない場合に成立します。',
    cause: '利用者入力を基準ディレクトリへ文字列連結し、デコード・正規化後の実パスが許可ルート配下か確認していない可能性があります。検証前後で正規化回数が異なる、WindowsとPOSIXの区切り文字を片方しか扱わない、またはシンボリックリンク解決後のパスを再確認していないことも原因候補です。',
    remediation: '利用者入力をパスへ直接連結せず、公開済みIDからサーバー管理パスへ対応付けてください。やむを得ずパスを扱う場合はデコードと正規化後に実パスを取得し、固定ルート配下であることを確認してから開き、シンボリックリンク越しの逸脱も拒否してください。',
    verification: '..、絶対パス、URLエンコード、混在区切り、シンボリックリンクを使った入力で許可ルート外へ到達できないことを確認します。',
  },
  {
    matches: /(?:open redirect|external redirect|オープンリダイレクト|外部(?:への)?リダイレクト)/iu,
    summary: 'リダイレクト先を利用者が任意に指定でき、正規ドメインを起点として外部サイトへ誘導できる脆弱性です。',
    condition: '遷移先URLを絶対URLまたはスキーム相対URLとして受け取り、許可先との照合なしにLocationへ設定する場合に成立します。',
    cause: 'redirectやreturnUrl等の入力をLocationヘッダへ直接設定し、正規化後のscheme・host・portを許可リスト照合していない可能性があります。文字列の前方一致だけで同一ドメインと判定する、スキーム相対URLやuserinfoを考慮しない、またはデコード前の値だけを検証していることも考えられます。',
    remediation: '遷移先はサーバー側で定義した識別子または同一Originの相対パスに限定してください。URLを受け取る必要がある場合は正規化後のscheme・host・portを完全一致の許可リストで検証し、ユーザー情報部やスキーム相対表記を拒否してください。',
    verification: '外部URL、スキーム相対URL、userinfoを使ったURL、エンコードされたURLが拒否され、許可した相対パスだけへ遷移することを確認します。',
  },
  {
    matches: /(?:CORS|cross.origin resource sharing)/iu,
    summary: 'Cross-Origin Resource Sharingの許可判定が広すぎるため、許可していないOriginから応答を読み取られる可能性がある脆弱性です。',
    condition: 'Originを無条件に反射する、資格情報付きで広いOriginを許可する、またはpreflightのmethod・headerを過剰に許可する場合に成立します。',
    cause: 'CORS middlewareが要求OriginをそのままAccess-Control-Allow-Originへ反映する、許可Originを部分一致や緩い正規表現で判定する、または資格情報を許可したまま対象を広く設定している可能性があります。エンドポイントごとの必要method・headerを区別せず、共通設定で過剰に許可していることも原因候補です。',
    remediation: 'Access-Control-Allow-Originは業務上必要な完全一致Originだけを返し、要求Originをそのまま反射しないでください。資格情報が不要なAPIではAllow-Credentialsを付けず、methodとheaderもエンドポイントごとの必要最小限へ限定し、Vary: Originを設定してください。',
    verification: '許可Originだけが必要なmethod・headerで成功し、任意Origin、null Origin、類似ドメイン、資格情報付きのワイルドカード要求がブラウザーから読み取れないことを確認します。',
  },
  {
    matches: /(?:anti.?clickjack|clickjacking|クリックジャッキング|frame-ancestors|x-frame-options)/iu,
    summary: '第三者サイトのframe内に対象画面を表示でき、利用者のクリックを意図しない操作へ誘導される可能性があります。',
    condition: 'frame-ancestorsまたはX-Frame-Optionsによる埋め込み元制限が対象応答にない、あるいは許可範囲が広すぎる場合に成立します。',
    cause: '認証後画面を含む共通レスポンスへframe制御ヘッダを付与する設定がなく、一部の成功・エラー応答だけ設定対象外になっている可能性があります。',
    remediation: "原則としてContent-Security-Policyのframe-ancestors 'none'を全HTML応答へ付与してください。同一Originでの埋め込みが必要な画面だけ'self'を許可し、互換対策としてX-Frame-Options: DENYまたはSAMEORIGINも併用してください。",
    verification: '許可外Originのiframeから対象画面を読み込めず、必要な同一Origin埋め込みだけが維持されることをブラウザーと全応答ヘッダで確認します。',
  },
  {
    matches: /(?:content.security.policy|\bCSP\b|strict.transport.security|\bHSTS\b|anti.?clickjack|clickjacking|クリックジャッキング|frame-ancestors|x-frame-options|x-content-type-options|referrer-policy|permissions-policy|feature-policy|header (?:not set|missing)|missing .*header)/iu,
    summary: 'ブラウザーの防御動作を指定するHTTPレスポンスヘッダが欠落または不適切であり、本来ブラウザー側で制限できる読み込み・表示・通信が許可される状態です。',
    condition: '対象レスポンスに必要なセキュリティヘッダが含まれない、または値が対象ページの防御要件を満たさない場合に成立します。',
    cause: 'Webサーバー、リバースプロキシ、またはアプリケーションの共通レスポンス処理に対象ヘッダの設定がない可能性があります。設定自体は存在しても、対象パス、成功応答、エラー応答、リダイレクトの一部が適用条件から外れている、後段のproxyがヘッダを削除・上書きしている、または環境別設定が本番へ反映されていないことも考えられます。',
    remediation: '対象ヘッダをWebサーバーまたはアプリケーションの共通レスポンス処理で全対象ページへ付与し、エラー応答やリダイレクトにも適用してください。値は指摘されたヘッダの仕様に従い、レポートの不足内容に示す制御を有効にしてください。',
    verification: '対象URLの成功・エラー・リダイレクト応答を確認し、指摘されたヘッダが全応答に存在して期待する値を持つことを確認します。',
  },
  {
    matches: /(?:credentials?.*(?:URL|query)|(?:URL|query).*(?:credentials?|password|token)|URL内の認証情報)/iu,
    summary: '認証情報や秘密値がURLに含まれ、ブラウザー履歴、アクセスログ、Refererまたは監視基盤へ残る可能性があります。',
    condition: 'パスまたはクエリ文字列にパスワード、token、API key等を含めて送信する場合に成立します。',
    cause: '秘密値を通常のURLパラメータとして設計している、またはフォームの送信方式にGETを使用している可能性があります。',
    remediation: '秘密値をURLから除去し、TLS上のPOST本文またはAuthorizationヘッダで送信してください。アクセスログと分析基盤では機密フィールドを許可リスト方式で除外し、既に露出したtokenは失効・再発行してください。',
    verification: '認証操作後のURL、履歴、Referer、アクセスログに秘密値が残らず、秘密値を含む旧URLが無効であることを確認します。',
  },
  {
    matches: /(?:parameter tampering|パラメータ(?:の)?改ざん|buffer overflow|バッファオーバーフロー)/iu,
    summary: '入力値の型、範囲、長さまたは業務上の許可条件がサーバー側で十分に強制されていない可能性があります。',
    condition: '改変した識別子、境界外の数値、想定外の型、または過大な入力を処理した際に、未許可の状態遷移や異常応答が発生する場合に成立します。',
    cause: 'クライアント側制約へ依存し、サーバー側のスキーマ検証、範囲検証、認可または安全な上限処理が不足している可能性があります。',
    remediation: '各入力について型・形式・長さ・数値範囲・列挙値をサーバー側スキーマで許可リスト検証し、業務パラメータは認証主体と現在状態に照合してください。上限超過は処理前に拒否し、例外を共通処理で安全な4xxへ変換してください。',
    verification: '境界値、型違い、過大値、未許可IDを送信しても状態が変更されず、安全な4xx応答となり、正規入力の処理が維持されることを確認します。',
  },
  {
    matches: /(?:cookie.*(?:httponly|secure|samesite)|(?:httponly|secure|samesite).*cookie)/iu,
    summary: 'セッション等のCookieに必要な保護属性がなく、スクリプトからの参照、平文通信、またはクロスサイト送信を制限できない状態です。',
    condition: 'Set-Cookieで発行される対象Cookieに、用途に応じたHttpOnly・Secure・SameSite属性が設定されていない場合に成立します。',
    cause: 'Cookieを発行する処理でSecure・HttpOnly・SameSiteの既定値を設定していない、または環境別設定が安全でない値で上書きされている可能性があります。認証処理と更新処理で異なるCookie生成関数を使用し、一部経路だけ属性が欠落することや、TLS終端proxyを正しく認識できずSecure属性を外していることも原因候補です。',
    remediation: '認証・セッションCookieへSecureとHttpOnlyを付与し、通常はSameSite=LaxまたはStrictを設定してください。クロスサイト利用が必要なCookieだけをSameSite=None; Secureとし、DomainとPathを必要最小限へ限定してください。',
    verification: '対象の全Set-Cookieを確認し、必要な属性が毎回付与され、HTTP通信や不要なクロスサイト要求ではCookieが送信されないことを確認します。',
  },
  {
    matches: /(?:information disclosure|情報漏えい|情報露出|server leaks|version disclosure|directory browsing|suspicious comment|疑わしいコメント|timestamp|タイムスタンプ|X-Powered-By)/iu,
    summary: 'レスポンスに内部情報、構成情報、バージョン、または本来公開しないデータが含まれ、攻撃対象の特定や追加攻撃に利用できる状態です。',
    condition: '例外処理、デバッグ設定、ディレクトリ一覧、不要なレスポンスヘッダまたはAPIの過剰な項目返却によって情報が外部へ返る場合に成立します。',
    cause: '本番環境で詳細例外・デバッグ表示・ディレクトリ一覧が有効になっている、または内部モデルをレスポンスへ直接シリアライズしている可能性があります。公開用DTOの許可項目が定義されていない、共通エラーハンドラーを通らない経路がある、あるいはWebサーバーやframeworkの製品情報ヘッダを無効化していないことも考えられます。',
    remediation: '本番環境のデバッグ表示とディレクトリ一覧を無効化し、例外は一般化したエラーIDだけを返してください。レスポンスDTOとヘッダの許可項目を定義して内部パス・スタックトレース・製品版数・不要な個人情報を除外し、詳細はアクセス制御されたサーバーログへ記録してください。',
    verification: '通常・不正入力・存在しないパスの各応答に内部パス、スタックトレース、製品版数、ディレクトリ一覧、不要なデータが含まれないことを確認します。',
  },
  {
    matches: /(?:TLS|certificate|cipher|証明書|暗号スイート|mixed content|平文送信)/iu,
    summary: '通信路の暗号化または証明書検証が不十分で、盗聴、改ざん、またはなりすましを防止できない構成です。',
    condition: 'HTTPで到達できる、古いTLS版や弱い暗号を許可する、証明書チェーン・ホスト名・有効期限に問題がある、またはHTTPSページがHTTP資源を読み込む場合に成立します。',
    cause: 'TLS終端のWebサーバーやload balancerで旧プロトコル・弱い暗号が無効化されていない、証明書と中間証明書の配備が不完全、またはHTTP listenerをHTTPSへ強制転送していない可能性があります。HTTPSページのテンプレートや外部資源設定にhttp URLが残る、環境ごとのbase URL設定が誤っていることも原因候補です。',
    remediation: 'HTTPをHTTPSへ恒久リダイレクトし、TLS 1.2以上と推奨暗号スイートだけを有効化してください。信頼された認証局の証明書を完全な中間証明書チェーンで配備し、HTTPSページ内の全URLをHTTPSへ変更してください。',
    verification: 'HTTPからHTTPSへの遷移、TLSプロトコルと暗号スイート、証明書チェーン・ホスト名・期限、混在コンテンツの不在を再確認します。',
  },
];

function plainEngineText(value: string): string {
  return safeXmlText(value)
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/p\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&amp;/giu, '&')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function narrativeForFinding(
  finding: Finding,
  evidence: RawTechnicalEvidence,
  roles: readonly string[],
  aiNarrative: ReportFindingNarrative | undefined,
  affectedUrls: readonly string[] = [finding.url],
): Pick<AssuranceReportDocument['findings'][number], 'summary' | 'conditions' | 'cause' | 'reproduction' | 'remediation' | 'verificationCriteria'> {
  const description = plainEngineText(evidence.description);
  const engineSolution = plainEngineText(evidence.solution);
  const haystack = `${finding.title}\n${description}\n${evidence.observedEvidence}`;
  const guidance = VULNERABILITY_GUIDANCE.find((candidate) => candidate.matches.test(haystack));
  const deficiencies = responseDeficiencies(finding, evidence);
  const method = finding.method?.trim() || /^([A-Z]+)\s+/u.exec(evidence.request)?.[1] || 'GET';
  const url = safeXmlText(finding.url);
  const parameter = finding.param === undefined ? '' : `パラメータ「${safeXmlText(finding.param)}」`;
  const attack = evidence.attackInput === '' ? '' : `診断値「${safeXmlText(evidence.attackInput).slice(0, 300)}」`;
  const target = `${method} ${url}`;
  const fallbackSummary = description || `「${safeXmlText(finding.title)}」は、対象機能の入力または応答に必要なセキュリティ制御が不足している状態です。`;
  const summary = deficiencies.length > 0
    ? `${guidance?.summary ?? fallbackSummary} ${deficiencies.join('')}`
    : guidance?.summary ?? fallbackSummary;
  const conditionDetails = [parameter, attack].filter(Boolean).join('へ');
  const conditions = `${guidance?.condition ?? `${target}の処理で、指摘名に示す制御が適用されない場合に成立します。`} 対象は ${target}${conditionDetails === '' ? '' : ` で、${conditionDetails}を使用した場合`}です。`;
  const requestLine = splitHttpEvidence(evidence.request).header.split('\n')[0] || `${method} ${url}`;
  const statusLine = splitHttpEvidence(evidence.response).header.split('\n')[0] || 'HTTP応答';
  const rolesText = roles.length === 0 ? '対象機能を利用できる状態' : `対象ロール（${roles.join('、')}）`;
  const observed = [evidence.observedEvidence, ...deficiencies].filter(Boolean).join(' ');
  const multipleUrlNotice = affectedUrls.length > 1
    ? `同一現象をURL欄に列挙した${String(affectedUrls.length)}件で確認しました。`
    : '';
  const deterministicSteps = [
    affectedUrls.length > 1
      ? `${rolesText}で、URL欄に列挙した${String(affectedUrls.length)}件を順に開きます。`
      : `${rolesText}で、対象URL「${url}」を開きます。`,
    `${requestLine} を基準に、下記Requestと同じCookie、token、ヘッダおよびBodyを付けて送信します。`,
    ...(parameter === '' && attack === '' ? [] : [`${[parameter, attack].filter(Boolean).join('に')}を設定して同じリクエストを送信します。`]),
    deficiencies.length > 0
      ? `受信したResponseのヘッダを確認し、${deficiencies.join('')}ことを確認します。`
      : `受信したResponseを確認し、${observed || '指摘名に示す制御不備が再現する'}ことを確認します。`,
  ];
  const deterministicRemediation = guidance?.remediation || engineSolution
    || `対象機能「${safeXmlText(finding.title)}」の原因となる入力経路と制御点を特定し、${parameter || '外部入力'}を利用する直前にサーバー側の許可条件を強制してください。修正は共通処理へ集約し、今回のRequestを回帰テストとして固定してください。`;
  const deterministicCause = guidance?.cause
    || `対象機能で必要な入力検証または応答制御が、エンドポイント固有処理、共通middleware、Webサーバー、リバースプロキシのいずれかで未実装・未適用になっている可能性があります。適用対象パス、処理順序、環境別設定の不一致により、設定済みの制御がこの経路だけ迂回されていることも考えられます。`;
  const aiSteps = aiNarrative?.reproductionSteps.map((step) => step.trim()).filter(Boolean) ?? [];
  const genericAiText = aiNarrative === undefined ? '' : [
    aiNarrative.summary,
    aiNarrative.conditions,
    aiNarrative.cause,
    aiNarrative.remediation,
    aiNarrative.verificationCriteria,
  ].join('\n');
  const selectedAi = aiNarrative !== undefined
    && aiNarrative.summary.trim().length >= 20
    && aiNarrative.conditions.trim().length >= 20
    && aiNarrative.cause.trim().length >= 40
    && aiNarrative.remediation.trim().length >= 30
    && aiNarrative.verificationCriteria.trim().length >= 20
    && aiSteps.length >= 2
    && !/(?:診断エンジンが検出した候補|担当者が追記|原因となる制御を修正)/u.test(genericAiText)
    ? aiNarrative
    : undefined;
  const selectedConditions = selectedAi?.conditions.trim();
  const observedCauseBasis = deficiencies.length > 0
    ? deficiencies.join('')
    : evidence.observedEvidence !== ''
      ? `観測根拠は「${safeXmlText(evidence.observedEvidence).slice(0, 500)}」です。`
      : `指摘「${safeXmlText(finding.title)}」を ${String(finding.occurrences)} 回観測しました。`;
  const inferredCause = selectedAi?.cause.trim() || deterministicCause;
  const selectedSteps = selectedAi === undefined ? [] : aiSteps;
  const exactReproductionSteps = selectedAi === undefined ? deterministicSteps : [
    ...(!selectedSteps.some((step) => step.includes(url)) ? [deterministicSteps[0]!] : []),
    ...(!selectedSteps.some((step) => step.includes(requestLine)) ? [deterministicSteps[1]!] : []),
    ...selectedSteps,
  ];
  return {
    summary: selectedAi?.summary.trim() || summary,
    conditions: selectedConditions === undefined
      ? `${conditions}${multipleUrlNotice === '' ? '' : ` ${multipleUrlNotice}`}`
      : `${selectedConditions.includes(target) ? selectedConditions : `${selectedConditions} 対象は ${target} です。`}${multipleUrlNotice === '' ? '' : ` ${multipleUrlNotice}`}`,
    cause: `観測事実: ${requestLine} に対して ${statusLine} を受信しました。${observedCauseBasis} 推定原因: ${inferredCause} ソースコード、サーバー設定、proxy設定を直接確認した結果ではないため、実装・設定に関する記載は診断時通信からの推定です。`,
    reproduction: {
      prerequisites: `${rolesText}を用意し、診断対象への送信が許可された環境で実施します。`,
      steps: exactReproductionSteps,
      actual: `${statusLine}。${observed || `観測回数 ${String(finding.occurrences)} 回。`}${multipleUrlNotice === '' ? '' : ` ${multipleUrlNotice}`}`,
    },
    remediation: {
      immediate: deficiencies.length > 0
        ? '恒久対応までの間、リバースプロキシまたはWebサーバーの共通設定で不足するレスポンス制御を適用し、適用対象を監視してください。'
        : '恒久対応までの間、対象機能への到達条件を必要なロールとネットワークへ限定し、同じ検出条件を監視してください。',
      permanent: selectedAi?.remediation.trim() || deterministicRemediation,
    },
    verificationCriteria: `${selectedAi?.verificationCriteria.trim() || guidance?.verification
      || `修正後に同じ ${target} と診断入力で再現せず、正規入力による正常処理が維持されることを確認します。`}${affectedUrls.length > 1 ? ` URL欄の全${String(affectedUrls.length)}件で修正を確認します。` : ''}`,
  };
}

interface FindingObservation {
  readonly finding: Finding;
  readonly rawTechnicalEvidence: RawTechnicalEvidence;
  readonly technicalEvidence: AssuranceReportDocument['findings'][number]['technicalEvidence'];
}

/** URLそのものを除いて「同じ現象」を比較するための安定した文字列表現。 */
function normalizedPhenomenonText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, '<url>')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
}

function reportExclusionReason(url: string, reason: string): string {
  if (!/選択されなかった/u.test(reason)) return reason;
  if (/\.(?:css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|map)(?:[?#]|$)/iu.test(url)) {
    return '静的資産であり、アプリケーション処理の能動診断対象ではないため除外';
  }
  if (/(?:logout|logoff|signout|setup|install|security)(?:\.php)?(?:[/?#]|$)/iu.test(url)) {
    return 'セッション終了または環境・セキュリティ設定を変更し得る経路のため、安全制約により除外';
  }
  return '診断候補の選定で未採用（具体的な除外根拠が実行記録にないため、提出前の確認が必要）';
}

function findingPhenomenonKey(observation: FindingObservation): string {
  const { finding } = observation;
  const identity = finding.enginePluginId?.trim() || normalizedPhenomenonText(finding.title);
  return JSON.stringify([
    finding.source.kind,
    identity,
    normalizedPhenomenonText(finding.title),
    finding.severity,
  ]);
}

function groupFindingObservations(observations: readonly FindingObservation[]): readonly (readonly FindingObservation[])[] {
  const groups = new Map<string, FindingObservation[]>();
  for (const observation of observations) {
    const key = findingPhenomenonKey(observation);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function buildAssuranceReport(input: {
  readonly reportId: string;
  readonly modelHash: string;
  readonly model: ReportModel;
  readonly profile: ReportProfile;
  readonly startUrl: string;
  readonly forbiddenActions: readonly string[];
  readonly evidence: readonly StoredEvidence[];
  readonly evidenceContents?: Readonly<Record<string, string>>;
  readonly findingNarratives?: readonly ReportFindingNarrative[];
}): AssuranceReportDocument {
  const { model, profile } = input;
  const startedAt = [model.coverage.startedAt, ...model.findings.map((finding) => finding.firstSeenAt)]
    .filter((value): value is string => value !== null && value !== undefined).sort()[0] ?? null;
  const endedAt = [model.coverage.endedAt, ...model.findings.map((finding) => finding.lastSeenAt)]
    .filter((value): value is string => value !== null && value !== undefined).sort().at(-1) ?? model.generatedAt;
  const methods = [...new Set([
    ...(model.coverage.exploredUrlCount > 0 ? ['Web 探索'] : []),
    ...(model.coverage.scannedUrlCount > 0 ? ['能動診断'] : []),
    ...model.coverage.delegatedSteps.map((step) => `${step.engineKind}${step.engineVersion === undefined ? '' : ` ${step.engineVersion}`}`),
    ...model.findings.map((finding) => finding.source.kind),
  ])];
  const origins = model.assessmentScope.allowedOrigins;
  const assets = origins.map((origin, index) => {
    let fqdn = origin;
    try { fqdn = new URL(origin).hostname; } catch { /* 原値を証跡として残す */ }
    const urls = [maskUrl(input.startUrl), ...model.findings.map((finding) => maskUrl(finding.url))]
      .filter((url) => {
        try { return new URL(url).origin === origin; } catch { return false; }
      });
    return { id: `ASSET-${String(index + 1).padStart(3, '0')}`, name: fqdn, fqdn, urls: [...new Set(urls)] };
  });
  const observations: FindingObservation[] = model.findings.map((finding) => {
    const rawTechnicalEvidence = extractFindingTechnicalEvidence(finding, input.evidenceContents ?? {});
    const missing = [
      ...(!hasHttpRequestLine(rawTechnicalEvidence.request) ? ['Request'] : []),
      ...(!hasHttpResponseLine(rawTechnicalEvidence.response) ? ['Response'] : []),
    ];
    if (missing.length > 0) {
      throw new Error(
        `報告書を生成できません。指摘 ${finding.findingId} の診断時HTTP ${missing.join(' / ')}がありません。`
        + '実際の送受信内容を収集できる設定で再診断してください。',
      );
    }
    const technicalEvidence = presentTechnicalEvidence(finding, rawTechnicalEvidence, profile);
    return { finding, rawTechnicalEvidence, technicalEvidence };
  });
  const groupedObservations = groupFindingObservations(observations);
  const groupedRepresentativeFindings: Finding[] = [];
  const reportFindingIdBySourceId = new Map<string, string>();
  const findings = groupedObservations.map((group) => {
    const primary = group[0]!;
    const sourceFindings = group.map((observation) => observation.finding);
    const urls = [...new Set(sourceFindings.map((finding) => safeXmlText(finding.url)))];
    const evidenceIds = [...new Set(sourceFindings.flatMap((finding) => finding.evidenceRefs))];
    const sourceFindingIds = sourceFindings.map((finding) => finding.findingId);
    const firstSeenAt = sourceFindings.map((finding) => finding.firstSeenAt).sort()[0] ?? primary.finding.firstSeenAt;
    const lastSeenAt = sourceFindings.map((finding) => finding.lastSeenAt).sort().at(-1) ?? primary.finding.lastSeenAt;
    const occurrences = sourceFindings.reduce((sum, finding) => sum + finding.occurrences, 0);
    const mergedFinding: Finding = {
      ...primary.finding,
      evidenceRefs: evidenceIds,
      firstSeenAt,
      lastSeenAt,
      occurrences,
    };
    groupedRepresentativeFindings.push(mergedFinding);
    for (const sourceFindingId of sourceFindingIds) reportFindingIdBySourceId.set(sourceFindingId, primary.finding.findingId);
    const parameters = [...new Set(sourceFindings.map((finding) => finding.param?.trim()).filter((value): value is string => Boolean(value)))];
    const methodsForGroup = [...new Set(sourceFindings.map((finding) => finding.method?.trim() || '未入力'))];
    const technicalEvidenceByUrl = group.map((observation) => {
      const automated = automatedValidation(observation.finding, observation.rawTechnicalEvidence);
      return {
        findingId: observation.finding.findingId,
        url: safeXmlText(observation.finding.url),
        method: observation.finding.method?.trim() || '未入力',
        parameter: observation.finding.param?.trim() || '未入力',
        automatedRationale: automated.rationale,
        evidenceIds: [...observation.finding.evidenceRefs],
        technicalEvidence: observation.technicalEvidence,
      };
    });
    const narrative = narrativeForFinding(
      mergedFinding,
      primary.rawTechnicalEvidence,
      model.assessmentScope.authorization?.targetRoles ?? [],
      sourceFindingIds.map((findingId) => input.findingNarratives?.find((candidate) => candidate.findingId === findingId)).find((candidate) => candidate !== undefined),
      urls,
    );
    const automatedRationales = [...new Set(technicalEvidenceByUrl.map((entry) => entry.automatedRationale))];
    const automatedRationale = automatedRationales.join(' / ');
    const taxonomy = taxonomyForFinding(primary.finding);
    return {
      id: primary.finding.findingId,
      title: primary.finding.title,
      severity: severityLabel(primary.finding.severity),
      automatedRationale,
      confidence: primary.finding.source.unverified ? '要確認' : '確認済み',
      source: `${primary.finding.source.kind}${primary.finding.source.engineVersion === undefined ? '' : ` ${primary.finding.source.engineVersion}`}`,
      method: methodsForGroup.join(' / '),
      cwe: taxonomy.cwe,
      owaspTop10: taxonomy.owaspTop10,
      url: urls[0] ?? '',
      urls,
      parameter: parameters.length === 0 ? '未入力' : parameters.join(' / '),
      firstSeenAt,
      lastSeenAt,
      occurrences,
      evidenceIds,
      sourceFindingIds,
      technicalEvidence: primary.technicalEvidence,
      technicalEvidenceByUrl,
      ...narrative,
    };
  });
  const severityCounts: Record<string, number> = {};
  for (const finding of findings) {
    severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1;
  }
  const evidence = input.evidence.map((item) => ({
    id: item.evidenceId,
    type: item.metadata?.mediaType ?? item.label.split(':')[0] ?? '証跡',
    sha256: item.sha256,
    capturedAt: item.savedAt,
    redactionStatus: '原本は案件内保管 報告書には再現に必要な診断時通信を掲載',
    relatedFindingIds: [...new Set(model.findings
      .filter((finding) => finding.evidenceRefs.includes(item.evidenceId))
      .map((finding) => reportFindingIdBySourceId.get(finding.findingId) ?? finding.findingId))],
  })).filter((item) => item.relatedFindingIds.length > 0);
  const guidelineCoverage = (model.guidelines.length === 0 ? ['ScopePilot 診断計画'] : model.guidelines).map((guideline, index) => {
    const routes = (model.coverage.guidelineRoutes ?? []).filter((route) => route.guidelineIds.includes(guideline));
    const executed = routes.filter((route) => route.status === 'executed').length;
    const pending = routes.filter((route) => route.status === 'needs-input').length;
    const unavailable = routes.filter((route) => route.status === 'unavailable').length;
    const delegated = routes.filter((route) => route.status === 'delegated').length;
    const routeSummary = routes.length === 0
      ? ''
      : `ガイドライン診断経路: 実施 ${String(executed)} / 追加入力待ち ${String(pending)} / 実行不可 ${String(unavailable)} / 委譲中 ${String(delegated)}`;
    const status = routes.length === 0
      ? model.coverage.scannedUrlCount > 0 || model.coverage.exploredUrlCount > 0 ? '探索のみ' : '未実施'
      : executed === routes.length ? '実施済み'
        : executed > 0 ? '一部実施'
          : pending > 0 ? '追加入力待ち'
            : delegated > 0 ? '委譲実施'
              : '実行不可';
    return {
      controlId: `COV-${String(index + 1).padStart(3, '0')}`,
      title: guideline,
      status,
      method: routes.length === 0 ? '探索・汎用診断' : `ScopePilot theme ${routes.map((route) => route.themeNo).join(', ')}`,
      roles: model.assessmentScope.authorization?.targetRoles ?? [],
      targets: origins,
      limitations: [routeSummary, ...model.coverage.limitations].filter((value) => value !== '').join(' / '),
    };
  });
  const coverage = [
    ...guidelineCoverage,
    ...(model.coverage.guidelineRoutes ?? []).map((route, index) => ({
      controlId: `THEME-${String(index + 1).padStart(3, '0')}`,
      title: `ガイドライン代替診断 theme ${route.themeNo}`,
      status: route.status === 'executed' ? '実施済み' : route.status === 'delegated' ? '委譲実施' : route.status === 'needs-input' ? '追加入力待ち' : '実行不可',
      method: route.routeId,
      roles: model.assessmentScope.authorization?.targetRoles ?? [],
      targets: origins,
      limitations: route.detail,
    })),
    ...(model.coverage.diagnosticRoutes ?? []).map((route, index) => ({
      controlId: `AUTO-${String(index + 1).padStart(3, '0')}`,
      title: route.track,
      status: route.status === 'executed' ? '実施済み' : route.status === 'delegated' ? '委譲実施' : route.status === 'needs-input' ? '追加入力待ち' : '実行不可',
      method: route.track,
      roles: model.assessmentScope.authorization?.targetRoles ?? [],
      targets: [route.targetUrl],
      limitations: route.detail,
    })),
  ];
  const exploredUrls = model.coverage.exploredUrls ?? [];
  const excludedUrls = model.coverage.excludedUrls ?? [];
  const exploredUrlSet = new Set(exploredUrls.map((entry) => entry.url));
  const excludedUrlSet = new Set(excludedUrls.map((entry) => entry.url));
  const explicitlyScannedUrls = [...new Set(model.coverage.scannedUrls ?? [])];
  const selectedExploredUrls = explicitlyScannedUrls.length > 0
    ? explicitlyScannedUrls
    : [...exploredUrlSet].filter((url) => !excludedUrlSet.has(url));
  const baseUrlCoverage = [
    ...exploredUrls.map((entry) => {
      const excluded = excludedUrls.find((candidate) => candidate.url === entry.url);
      return {
        url: entry.url,
        statusCode: entry.statusCode,
        contentType: entry.contentType,
        depth: entry.depth,
        discoveredFrom: entry.discoveredFrom ?? '開始URL',
        scanStatus: excluded === undefined ? '診断対象' as const : '対象外' as const,
        exclusionReason: excluded === undefined ? '' : reportExclusionReason(entry.url, excluded.reason),
      };
    }),
    ...excludedUrls
      .filter((excluded) => !exploredUrlSet.has(excluded.url))
      .map((excluded) => ({
        url: excluded.url,
        statusCode: null,
        contentType: '未取得',
        depth: 0,
        discoveredFrom: 'scope判定',
        scanStatus: '対象外' as const,
        exclusionReason: reportExclusionReason(excluded.url, excluded.reason),
      })),
  ];
  const listedCoverageUrls = new Set(baseUrlCoverage.map((entry) => entry.url));
  const diagnosticOnlyUrls = [...new Map([
    ...(model.coverage.diagnosticRoutes ?? []).map((route) => [route.targetUrl, `診断経路: ${route.track}`] as const),
    ...model.findings.map((finding) => [finding.url, `診断証跡: ${finding.source.kind}`] as const),
  ]).entries()]
    .filter(([url]) => !listedCoverageUrls.has(url))
    .map(([url, discoveredFrom]) => ({
      url,
      statusCode: null,
      contentType: '診断時HTTP証跡を参照',
      depth: 0,
      discoveredFrom,
      scanStatus: '診断対象' as const,
      exclusionReason: '',
    }));
  return {
    formatVersion: '2',
    templateId: 'scopepilot2-assurance-ja-v2',
    modelHash: input.modelHash,
    report: {
      id: input.reportId,
      version: valueOr(profile.version),
      status: valueOr(profile.documentStatus),
      classification: valueOr(profile.classification),
      generatedAt: model.generatedAt,
      author: valueOr(profile.author),
      reviewer: valueOr(profile.reviewer),
      approver: valueOr(profile.approver),
      distribution: splitLines(profile.distribution),
    },
    engagement: {
      caseId: model.caseId,
      name: /^\d+$/u.test(model.assessmentScope.caseName.trim())
        ? valueOr(profile.systemName, '案件名未設定')
        : model.assessmentScope.caseName,
      systemName: valueOr(profile.systemName),
      clientName: valueOr(profile.clientName),
      serviceProvider: valueOr(profile.serviceProvider, 'ScopePilot2'),
    },
    assessment: {
      type: valueOr(profile.assessmentType),
      startedAt,
      endedAt,
      methods,
      sourceIps: splitLines(profile.sourceIps),
      allowedOrigins: origins,
      deniedOrigins: model.assessmentScope.deniedOrigins,
      roles: model.assessmentScope.authorization?.targetRoles ?? [],
      authentication: model.coverage.authenticationRole === null || model.coverage.authenticationRole === undefined
        ? '未認証（unauthenticated）'
        : /^(?:unauthenticated|未認証)$/iu.test(model.coverage.authenticationRole)
          ? '認証セッション使用（Cookie観測、role名は unauthenticated）'
          : `認証セッション使用（role: ${model.coverage.authenticationRole}）`,
      scanPolicies: (model.coverage.scanPolicies ?? []).map((policy) => policy === 'passive' ? '受動（探索・応答観測）' : '能動（ZAP Active Scan）'),
      forbiddenActions: input.forbiddenActions,
      exclusions: splitLines(profile.exclusions),
      assumptions: [...new Set([AUTOMATED_ASSESSMENT_ASSUMPTION, ...splitLines(profile.assumptions)])],
      requestLimits: model.assessmentScope.limits,
    },
    summary: {
      conclusion: valueOr(profile.conclusion, findings.length === 0
        ? '報告対象の所見はありません 未実施範囲と制約を併せて確認してください'
        : `${String(findings.length)} 件の所見を報告します 診断時証拠を確認し 対応優先度を決定してください`),
      highestSeverity: highestSeverity(groupedRepresentativeFindings),
      severityCounts,
      priorities: splitLines(profile.priorities),
      majorLimitations: [...splitLines(profile.majorLimitations), ...model.coverage.limitations],
    },
    assets,
    coverageSummary: {
      exploredUrlCount: exploredUrlSet.size || model.coverage.exploredUrlCount,
      scannedUrlCount: selectedExploredUrls.length || model.coverage.scannedUrlCount,
      delegatedStepCount: model.coverage.delegatedSteps.length,
    },
    urlCoverage: [...baseUrlCoverage, ...diagnosticOnlyUrls],
    coverage,
    findings,
    evidence,
    specialNotes: [
      '本報告書は記載された対象 期間 許可操作および送信上限の範囲で得られた結果を示します',
      '指摘がないことは未実施領域を含む安全性を証明するものではありません',
      '指摘ごとに再現に必要なRequestとResponseを掲載します Cookieやtokenの原値は案件内の証拠原本で保持し、報告書本文ではマスキングします',
      valueOr(profile.contact, '問い合わせ先は未入力です'),
    ],
  };
}

const NAVY = '1F4E78';
const PALE_BLUE = 'F3F7FA';
const BORDER = 'D9E2E8';
const GRAY = '5B6573';
const CONTENT_WIDTH = 9640;
const borders = {
  top: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  left: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  right: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
};

function cell(text: string, width: number, options: { header?: boolean; alternate?: boolean; center?: boolean } = {}): TableCell {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlignTable.CENTER,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    borders,
    ...(options.header ? { shading: { type: ShadingType.CLEAR, fill: NAVY, color: 'auto' } }
      : options.alternate ? { shading: { type: ShadingType.CLEAR, fill: PALE_BLUE, color: 'auto' } } : {}),
    children: lines.map((line) => new Paragraph({
      alignment: options.center || options.header ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing: { after: 0, line: 260 },
      children: [new TextRun({
        text: line || ' ',
        ...(options.header ? { bold: true } : {}),
        color: options.header ? 'FFFFFF' : '000000',
        size: 18,
        font: '游ゴシック',
      })],
    })),
  });
}

function table(headers: readonly string[], rows: readonly (readonly string[])[], widths: readonly number[]): Table {
  const materialized = rows.length === 0 ? [headers.map(() => '未入力')] : rows;
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((header, index) => cell(header, widths[index] ?? 1000, { header: true })) }),
      ...materialized.map((row, rowIndex) => new TableRow({
        // 長い行を分割不可にすると、反復ヘッダーだけが前ページへ残ることがある。
        // 短い行だけを一体化し、長文行はページをまたいで自然に分割させる。
        cantSplit: row.join('\n').length <= 800 && row.every((value) => value.split(/\r?\n/u).length <= 10),
        children: headers.map((_header, columnIndex) => cell(row[columnIndex] ?? '', widths[columnIndex] ?? 1000, {
          alternate: rowIndex % 2 === 1,
          center: columnIndex === 0 && widths[columnIndex]! < 2400,
        })),
      })),
    ],
  });
}

function heading(text: string, level: 1 | 2 | 3, pageBreakBefore = false): Paragraph {
  return new Paragraph({
    text,
    heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
    pageBreakBefore,
    keepNext: true,
  });
}

function body(text: string, options: { boldLead?: string; after?: number } = {}): Paragraph {
  const lead = options.boldLead;
  return new Paragraph({
    spacing: { after: options.after ?? 140, line: 320 },
    children: lead === undefined
      ? [new TextRun({ text, font: '游ゴシック', size: 21 })]
      : [new TextRun({ text: lead, bold: true, font: '游ゴシック', size: 21 }), new TextRun({ text, font: '游ゴシック', size: 21 })],
  });
}

function highlightedEvidenceRuns(
  line: string,
  terms: readonly string[],
  enabled: boolean,
  fallbackHighlight: boolean,
): TextRun[] {
  const base = { font: 'Consolas', size: 17, color: '111111' } as const;
  if (!enabled) return [new TextRun({ text: line || ' ', ...base })];
  const spans = matchingSpans(line, terms);
  if (spans.length === 0) {
    return [new TextRun({
      text: line || ' ',
      ...base,
      ...(fallbackHighlight ? { highlight: HighlightColor.YELLOW } : {}),
    })];
  }
  const runs: TextRun[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) runs.push(new TextRun({ text: line.slice(cursor, span.start), ...base }));
    runs.push(new TextRun({ text: line.slice(span.start, span.end), ...base, highlight: HighlightColor.YELLOW }));
    cursor = span.end;
  }
  if (cursor < line.length) runs.push(new TextRun({ text: line.slice(cursor), ...base }));
  return runs;
}

function evidenceFocusParagraph(text: string, enabled: boolean): Paragraph {
  return new Paragraph({
    spacing: { after: 120, line: 300 },
    children: [new TextRun({
      text,
      bold: true,
      font: '游ゴシック',
      size: 20,
      ...(enabled ? { highlight: HighlightColor.YELLOW } : {}),
    })],
  });
}

function httpEvidenceBlock(
  label: 'Request' | 'Response',
  text: string,
  terms: readonly string[],
  highlightEnabled: boolean,
): (Paragraph | Table)[] {
  const normalized = safeXmlText(text).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const anyTermMatched = matchingSpans(normalized, terms).length > 0;
  const evidenceCell = new TableCell({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    verticalAlign: VerticalAlignTable.TOP,
    margins: { top: 180, bottom: 180, left: 240, right: 240 },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 6, color: '7F7F7F' },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: '7F7F7F' },
      left: { style: BorderStyle.SINGLE, size: 6, color: '7F7F7F' },
      right: { style: BorderStyle.SINGLE, size: 6, color: '7F7F7F' },
    },
    shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' },
    children: [
      new Paragraph({
        keepNext: true,
        spacing: { after: 70 },
        children: [new TextRun({ text: `${label} :`, bold: true, font: 'Aptos', size: 21, color: '000000' })],
      }),
      ...normalized.split('\n').map((line, index) => new Paragraph({
        spacing: { after: 0, line: 245 },
        children: highlightedEvidenceRuns(line, terms, highlightEnabled, !anyTermMatched && index === 0),
      })),
    ],
  });
  return [
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: [CONTENT_WIDTH],
      layout: TableLayoutType.FIXED,
      borders,
      rows: [new TableRow({ cantSplit: normalized.length <= 5_000, children: [evidenceCell] })],
    }),
  ];
}

function bullets(items: readonly string[]): Paragraph[] {
  const materialized = items.length === 0 ? ['未入力'] : items;
  return materialized.map((item) => new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 80, line: 300 },
    children: [new TextRun({ text: item, font: '游ゴシック', size: 21 })],
  }));
}

function keyValue(rows: readonly (readonly [string, string])[]): Table {
  return table(['項目', '内容'], rows, [2500, 7140]);
}

function normalizedFindingFamilyTitle(title: string): string {
  return title
    .replace(/\s*[（(]検証レベル\s*[:：]\s*(?:low|medium|high)[）)]\s*$/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function severityRank(severity: string): number {
  return ({ High: 5, Medium: 4, Low: 3, Informational: 2, Unrated: 1 } as Readonly<Record<string, number>>)[severity] ?? 0;
}

function concreteAttackerOutcome(title: string): string {
  const value = title.normalize('NFKC').toLowerCase();
  if (/remote file|rfi|リモート.*ファイル|外部.*ファイル.*(?:読|取|include|インクル)/iu.test(value)) {
    return '成立した場合、攻撃者が外部のファイルやコードをサーバーに読み込ませ、サーバー上で任意のコードを実行できる可能性があります。';
  }
  if (/local file|lfi|ローカル.*ファイル|path traversal|ディレクトリ.*トラバーサル/iu.test(value)) {
    return '成立した場合、攻撃者がサーバー内の設定ファイル・認証情報・ソースコードなどを認証なしで読み取れる可能性があります。';
  }
  if (/os.*command|command injection|コマンド.*インジェクション|コマンド実行/iu.test(value)) {
    return '成立した場合、攻撃者がWebサーバーの実行権限で任意のOSコマンドを実行し、情報の窃取・改ざんや他システムへの侵入拠点化を行える可能性があります。';
  }
  if (/sql.*injection|sql.*インジェクション/iu.test(value)) {
    return '成立した場合、攻撃者がデータベース内の情報を認証なしで読み取り・改ざんでき、実装によってはログインを回避して他人になりすませる可能性があります。';
  }
  if (/server.side template|ssti|template injection|テンプレート.*インジェクション/iu.test(value)) {
    return '成立した場合、攻撃者がサーバー側テンプレートの権限で機密情報を読み取り、任意のコードを実行できる可能性があります。';
  }
  if (/stored.*xss|persistent.*xss|格納.*xss|保存.*xss/iu.test(value)) {
    return '成立した場合、保存された悪意あるスクリプトが閲覧者（管理者を含む）のブラウザーで実行され、本人として操作されたり、セッションを奪われたりする可能性があります。';
  }
  if (/cross.site scripting|\bxss\b|クロスサイト.*スクリプ|dom.*xss/iu.test(value)) {
    return '成立した場合、誘導された利用者のブラウザーで任意のスクリプトが実行され、利用者本人として操作されたり、セッションを奪われたりする可能性があります。';
  }
  if (/authentication bypass|auth.*bypass|認証.*回避|認証.*バイパス/iu.test(value)) {
    return '成立した場合、攻撃者が有効なアカウントを持たなくても認証を回避し、ログイン後の機能を利用できる可能性があります。';
  }
  if (/weak.*crypt|xor|\becb\b|暗号|ハッシュ/iu.test(value)) {
    return '成立した場合、攻撃者が保護対象の値を復号・推測・偽造し、認証情報の取得、他人へのなりすまし、または権限の不正取得に利用できる可能性があります。';
  }
  if (/client.side.*(?:security|token)|クライアント側.*(?:セキュリティ|トークン)/iu.test(value)) {
    return '成立した場合、攻撃者がクライアント側だけの制御やトークン生成規則を再現・迂回し、認証なしで保護機能を利用したり、他人になりすましたりできる可能性があります。';
  }
  if (/session|セッション.*(?:予測|固定|漏えい|id)|cookie.*(?:予測|固定)/iu.test(value)) {
    return '成立した場合、攻撃者が他人のセッションを取得または固定し、その利用者になりすましてログイン後の機能を操作できる可能性があります。';
  }
  if (/authorization|access control|idor|認可|権限|他人|他利用者/iu.test(value)) {
    return '成立した場合、攻撃者が権限のない他利用者の情報を閲覧・変更したり、本来許可されていない機能を利用したりできる可能性があります。';
  }
  if (/csrf|cross.site request forgery/iu.test(value)) {
    return '成立した場合、攻撃者がログイン中の利用者を誘導し、パスワード変更・設定変更・登録処理などを本人の意思に反して実行させられる可能性があります。';
  }
  if (/upload|アップロード/iu.test(value)) {
    return '成立した場合、攻撃者が悪意あるファイルを保存・公開でき、実行可能な配置であればサーバー上で任意のコードを実行できる可能性があります。';
  }
  if (/open redirect|external redirect|外部リダイレクト|オープンリダイレクト/iu.test(value)) {
    return '成立した場合、正規サイトのURLから偽サイトへ利用者を転送し、フィッシングによる認証情報の窃取に悪用できる可能性があります。';
  }
  if (/clickjacking|クリックジャッキング/iu.test(value)) {
    return '成立した場合、攻撃者が画面を透明な枠などで重ね、ログイン中の利用者に意図しないボタン操作や設定変更を実行させられる可能性があります。';
  }
  if (/content security policy|\bcsp\b/iu.test(value)) {
    return 'この設定不足だけで直ちに侵害は成立しませんが、別のスクリプト注入が存在する場合に、任意スクリプトの実行や情報窃取を防ぐ力が弱くなります。';
  }
  if (/captcha|rate limit|throttl|brute force|ブルートフォース|総当たり/iu.test(value)) {
    return '成立した場合、攻撃者がログイン等を自動で繰り返し試行し、パスワードを推測して他人になりすませる可能性があります。';
  }
  if (/buffer overflow|バッファ.*オーバーフロー/iu.test(value)) {
    return '成立した場合、攻撃者が処理を異常終了させてサービスを停止でき、影響する実装によっては任意のコードを実行できる可能性があります。';
  }
  if (/xslt|xml.*transform/iu.test(value)) {
    return '成立した場合、XSLT処理系の機能を悪用してサーバー内ファイルの読み取り、内部ネットワークへの通信、または任意コード実行を行える可能性があります。';
  }
  if (/parameter tamper|mass assignment|パラメーター.*改ざん/iu.test(value)) {
    return '成立した場合、攻撃者が送信値を改ざんし、価格・権限・所有者など本来変更できない状態を変更したり、許可されていない機能を利用したりできる可能性があります。';
  }
  if (/sensitive|information disclosure|deprecated|機密|情報漏えい|情報公開/iu.test(value)) {
    return '成立した場合、攻撃者が認証なしで内部情報・識別子・秘密値などを取得し、追加攻撃や他人へのなりすましに利用できる可能性があります。';
  }
  return '成立した場合、攻撃者が本来許可されていない情報の取得または機能の利用を行える可能性があります。具体的な到達範囲は技術証跡別冊の通信内容と修正確認で確定してください。';
}

function findingVerificationStatus(findings: readonly AssuranceReportDocument['findings'][number][]): string {
  const confidence = findings.map((finding) => finding.confidence).join(' / ');
  const collectionStatus = findings.map((finding) => finding.technicalEvidence.collectionStatus).join(' / ');
  if (/要確認|未確認|candidate|unverified/iu.test(confidence)) {
    return /再送は行っていません|保存済みHTTP履歴/iu.test(collectionStatus)
      ? '候補（要確認）。保存済みHTTP通信で兆候を観測していますが、再送による成立確認と業務影響の確認は未実施です。'
      : '候補（要確認）。自動診断で兆候を観測していますが、脆弱性の成立と業務影響は未確認です。';
  }
  if (/確認済み|confirmed|verified/iu.test(confidence)) {
    return '技術的な成立を確認済みです。記載した攻撃者の到達範囲は、確認した条件に基づきます。';
  }
  return '通信上の兆候を観測済みです。脆弱性の成立と業務影響は、技術証跡別冊を参照して確認してください。';
}

export function buildReportFindingFamilies(report: AssuranceReportDocument): readonly ReportFindingFamily[] {
  const groups = new Map<string, AssuranceReportDocument['findings'][number][]>();
  for (const finding of report.findings) {
    const title = normalizedFindingFamilyTitle(finding.title);
    const current = groups.get(title) ?? [];
    current.push(finding);
    groups.set(title, current);
  }
  return [...groups.entries()]
    .sort((left, right) => {
      const leftSeverity = Math.max(...left[1].map((finding) => severityRank(finding.severity)));
      const rightSeverity = Math.max(...right[1].map((finding) => severityRank(finding.severity)));
      return rightSeverity - leftSeverity || left[0].localeCompare(right[0], 'ja');
    })
    .map(([title, findings], index) => {
      const representative = [...findings].sort((left, right) => severityRank(right.severity) - severityRank(left.severity))[0]!;
      const urls = new Set(findings.flatMap((finding) => finding.urls));
      const findingIds = findings.map((finding) => finding.id);
      return {
        id: `RISK-${String(index + 1).padStart(3, '0')}`,
        title,
        severity: representative.severity,
        concreteRisk: concreteAttackerOutcome(title),
        verificationStatus: findingVerificationStatus(findings),
        affectedUrlCount: urls.size,
        findingIds,
        sourceFindingIds: [...new Set(findings.flatMap((finding) => finding.sourceFindingIds))],
        evidenceIds: [...new Set(findings.flatMap((finding) => finding.evidenceIds))],
        remediationSummary: representative.remediation.permanent,
        annexReference: findingIds.join(' / '),
      };
    });
}

const dateTime = (value: string | null): string => value === null ? '未入力' : value.replace('T', ' ').replace(/\.\d{3}Z$/u, 'Z');

function compactCell(text: string, width: number, options: { header?: boolean; alternate?: boolean; center?: boolean } = {}): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlignTable.CENTER,
    margins: { top: 70, bottom: 70, left: 90, right: 90 },
    borders,
    ...(options.header ? { shading: { type: ShadingType.CLEAR, fill: NAVY, color: 'auto' } }
      : options.alternate ? { shading: { type: ShadingType.CLEAR, fill: PALE_BLUE, color: 'auto' } } : {}),
    children: text.replaceAll('\r\n', '\n').split('\n').map((line) => new Paragraph({
      alignment: options.center || options.header ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing: { after: 0, line: 235 },
      children: [new TextRun({
        text: line || ' ',
        ...(options.header ? { bold: true } : {}),
        color: options.header ? 'FFFFFF' : '000000',
        size: 17,
        font: 'Yu Gothic',
      })],
    })),
  });
}

function compactTable(headers: readonly string[], rows: readonly (readonly string[])[], widths: readonly number[]): Table {
  const materialized = rows.length === 0 ? [headers.map(() => '該当なし')] : rows;
  return new Table({
    width: { size: widths.reduce((sum, width) => sum + width, 0), type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((header, index) => compactCell(header, widths[index] ?? 1000, { header: true })) }),
      ...materialized.map((row, rowIndex) => new TableRow({
        cantSplit: true,
        children: headers.map((_header, columnIndex) => compactCell(row[columnIndex] ?? '', widths[columnIndex] ?? 1000, {
          alternate: rowIndex % 2 === 1,
          center: columnIndex === 0 || columnIndex === 1,
        })),
      })),
    ],
  });
}

export async function renderExecutiveReport(report: AssuranceReportDocument): Promise<Buffer> {
  const families = buildReportFindingFamilies(report);
  const reportFooter = (): Footer => new Footer({ children: [new Paragraph({
    children: [
      new TextRun({ text: `${report.report.id}  |  ${report.report.classification}`, size: 16, color: GRAY, font: 'Yu Gothic' }),
      new TextRun({ text: '                                  Page ', size: 16, color: GRAY, font: 'Aptos' }),
      new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GRAY, font: 'Aptos' }),
    ],
  })] });
  const cover: (Paragraph | Table)[] = [
    new Paragraph({ spacing: { before: 2300, after: 280 }, children: [new TextRun({ text: 'ウェブアプリケーション脆弱性診断結果報告書', bold: true, size: 42, font: 'Yu Gothic', color: NAVY })] }),
    new Paragraph({ spacing: { after: 900 }, children: [new TextRun({ text: '第一部　意思決定・対応用サマリー', bold: true, size: 30, font: 'Yu Gothic' })] }),
    new Paragraph({ spacing: { after: 500 }, children: [new TextRun({ text: report.engagement.systemName || report.engagement.name, size: 30, font: 'Yu Gothic' })] }),
    keyValue([
      ['報告書ID', report.report.id],
      ['版', report.report.version],
      ['生成日時', dateTime(report.report.generatedAt)],
      ['機密区分', report.report.classification],
      ['第一部の指摘系統数', String(families.length)],
      ['第二部との対応', '各行の「技術証跡別冊」欄に、第二部の指摘IDを記載'],
    ]),
    body('本書は人が判断・対応するための第一部です。個々のHTTP Request/Response、全URL、証跡ハッシュ、再現手順は削除せず第二部「技術証跡別冊」に収録しています。二部を合わせて正式な診断成果物とします。'),
  ];
  const overview: (Paragraph | Table)[] = [
    heading('1  結論と読み方', 1),
    body(report.summary.conclusion),
    body('「攻撃者ができること」は、脆弱性が成立した場合に到達し得る具体的な結果です。「確認状態」が候補（要確認）の項目は、その結果まで実証したという意味ではありません。兆候・成立確認・業務影響を区別して判断してください。'),
    keyValue([
      ['最高深刻度', report.summary.highestSeverity],
      ['第一部の指摘系統', `${String(families.length)} 系統（第二部の ${String(report.findings.length)} 指摘を統合）`],
      ['対象URL', `${String(report.coverageSummary.exploredUrlCount)} 探索 / ${String(report.coverageSummary.scannedUrlCount)} 診断`],
      ['証跡', `${String(report.evidence.length)} 件（第二部に索引とHTTP通信を収録）`],
    ]),
    heading('2  対象・前提・制約', 1),
    keyValue([
      ['対象システム', report.engagement.systemName],
      ['許可Origin', report.assessment.allowedOrigins.join('\n') || '未設定'],
      ['認証条件', report.assessment.authentication],
      ['診断方式', report.assessment.methods.join(' / ') || '未設定'],
      ['除外事項', report.assessment.exclusions.join('\n') || 'なし'],
      ['主要な制約', report.summary.majorLimitations.join('\n') || 'なし'],
    ]),
    heading('3  対応優先順位', 1),
    ...bullets(report.summary.priorities.length > 0 ? report.summary.priorities : [
      'Highの候補は、技術証跡別冊のRequest/Responseを確認し、管理された条件で成立確認を行う。',
      '任意コード実行・認証回避・他利用者データへのアクセスにつながる系統を優先する。',
      '修正後は第二部の再現条件と確認基準に従い、同一条件で再診断する。',
    ]),
  ];
  const familyRows = families.map((family) => [
    family.id,
    family.severity,
    family.title,
    family.concreteRisk,
    `${family.verificationStatus}\n対象URL: ${String(family.affectedUrlCount)} 件 / 元指摘: ${String(family.sourceFindingIds.length)} 件\n技術証跡別冊: ${family.annexReference}`,
  ] as const);
  const register: (Paragraph | Table)[] = [
    heading('4  脆弱性リスク一覧', 1),
    body('同一の脆弱性を検証レベル別・URL別に重複表示せず、系統単位で統合しています。情報は削除しておらず、元の指摘ID・全通信・全証跡は第二部で追跡できます。'),
  ];
  for (let offset = 0; offset < familyRows.length; offset += 6) {
    if (offset > 0) register.push(heading(`4  脆弱性リスク一覧（続き ${String(Math.floor(offset / 6) + 1)}）`, 2, true));
    register.push(compactTable(
      ['ID', '深刻度', '指摘系統', '攻撃者が具体的にできること', '確認状態・対象・技術証跡別冊'],
      familyRows.slice(offset, offset + 6),
      [760, 860, 1800, 3000, 3220],
    ));
  }
  const closing: (Paragraph | Table)[] = [
    heading('5  成果物の完全性と参照方法', 1),
    body('第一部は重複を統合した意思決定用サマリーです。第二部「技術証跡別冊」には、第一部から参照されるすべての指摘について、対象URL、HTTP Request/Response、観測根拠、再現手順、原因、対策、修正確認基準、証跡索引を収録しています。'),
    keyValue([
      ['第一部', '本書。20ページ以内を目標とし、具体的リスク・確認状態・対応優先度を提示'],
      ['第二部', '技術証跡別冊。情報を省略せず、監査・再現・修正確認に必要な詳細を保持'],
      ['構造化データ', '同一モデルのJSON。機械処理と差分確認に使用'],
      ['モデルハッシュ', report.modelHash],
    ]),
    ...bullets(report.specialNotes),
  ];
  const document = new Document({
    creator: 'ScopePilot2',
    title: 'ウェブアプリケーション脆弱性診断結果報告書 第一部',
    subject: report.engagement.name,
    description: '意思決定・対応用サマリー。完全な技術情報は第二部に収録。',
    evenAndOddHeaderAndFooters: true,
    styles: {
      default: {
        document: { run: { font: 'Yu Gothic', size: 20, color: '000000' }, paragraph: { spacing: { line: 300 } } },
        heading1: { run: { font: 'Yu Gothic', size: 30, bold: true, color: NAVY }, paragraph: { spacing: { before: 240, after: 150 }, keepNext: true } },
        heading2: { run: { font: 'Yu Gothic', size: 24, bold: true, color: NAVY }, paragraph: { spacing: { before: 200, after: 110 }, keepNext: true } },
        heading3: { run: { font: 'Yu Gothic', size: 21, bold: true, color: '000000' }, paragraph: { spacing: { before: 160, after: 90 }, keepNext: true } },
      },
    },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1020, right: 1080, bottom: 1020, left: 1080, header: 440, footer: 440, gutter: 0 }, pageNumbers: { start: 1 } } },
        footers: { default: reportFooter(), even: reportFooter() },
        children: [...cover, ...overview],
      },
      {
        properties: { type: SectionType.NEXT_PAGE, page: { size: { width: 11906, height: 16838, orientation: PageOrientation.PORTRAIT }, margin: { top: 900, right: 1080, bottom: 900, left: 1080, header: 400, footer: 400, gutter: 0 } } },
        footers: { default: reportFooter(), even: reportFooter() },
        children: register,
      },
      {
        properties: { type: SectionType.NEXT_PAGE, page: { size: { width: 11906, height: 16838, orientation: PageOrientation.PORTRAIT }, margin: { top: 1020, right: 1080, bottom: 1020, left: 1080, header: 440, footer: 440, gutter: 0 } } },
        footers: { default: reportFooter(), even: reportFooter() },
        children: closing,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(document));
}

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const htmlLines = (value: string): string => escapeHtml(value).replaceAll('\n', '<br>');

function htmlList(values: readonly string[], empty = 'なし'): string {
  if (values.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return `<ul>${values.map((value) => `<li>${htmlLines(value)}</li>`).join('')}</ul>`;
}

function htmlKeyValues(rows: readonly (readonly [string, string])[]): string {
  return `<dl class="key-values">${rows.map(([label, value]) => (
    `<div><dt>${escapeHtml(label)}</dt><dd>${htmlLines(value || '未入力')}</dd></div>`
  )).join('')}</dl>`;
}

function htmlTable(headers: readonly string[], rows: readonly (readonly string[])[], rowAttributes?: (index: number) => string): string {
  const body = rows.length === 0
    ? `<tr><td colspan="${String(headers.length)}" class="empty">該当なし</td></tr>`
    : rows.map((row, rowIndex) => `<tr${rowAttributes?.(rowIndex) ?? ''}>${headers.map((_header, columnIndex) => (
      `<td>${htmlLines(row[columnIndex] ?? '')}</td>`
    )).join('')}</tr>`).join('');
  return `<div class="table-scroll"><table><thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function highlightedEvidenceHtml(value: string, terms: readonly string[], enabled: boolean): string {
  if (!enabled) return escapeHtml(value);
  const spans = matchingSpans(value, terms);
  if (spans.length === 0) return escapeHtml(value);
  const fragments: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) fragments.push(escapeHtml(value.slice(cursor, span.start)));
    fragments.push(`<mark>${escapeHtml(value.slice(span.start, span.end))}</mark>`);
    cursor = span.end;
  }
  if (cursor < value.length) fragments.push(escapeHtml(value.slice(cursor)));
  return fragments.join('');
}

function resolvedHighlightTerms(
  evidence: AssuranceReportDocument['findings'][number]['technicalEvidence'],
  parameter: string,
): { readonly request: readonly string[]; readonly response: readonly string[] } {
  if (evidence.requestHighlightTerms !== undefined && evidence.responseHighlightTerms !== undefined) {
    return { request: evidence.requestHighlightTerms, response: evidence.responseHighlightTerms };
  }
  const derived = evidenceHighlightTerms(parameter === '未入力' ? undefined : parameter, evidence);
  return { request: derived.request, response: derived.response };
}

/**
 * 第二部を、外部依存のない単一HTMLとして生成する。
 * 固定ナビゲーションと指摘・HTTP証跡・証拠原本の相互リンクにより、件数が多くても参照位置を失わない。
 */
export function renderTechnicalAnnexHtml(report: AssuranceReportDocument): Buffer {
  const findingAnchor = (index: number): string => `finding-${String(index + 1)}`;
  const evidenceAnchor = (index: number): string => `evidence-${String(index + 1)}`;
  const findingIndexById = new Map(report.findings.flatMap((finding, index) => (
    [finding.id, ...finding.sourceFindingIds].map((id) => [id, index] as const)
  )));
  const evidenceIndexById = new Map(report.evidence.map((evidence, index) => [evidence.id, index] as const));
  const relatedFindingLinks = (ids: readonly string[]): string => ids.length === 0
    ? 'なし'
    : ids.map((id) => {
        const index = findingIndexById.get(id);
        return index === undefined ? escapeHtml(id) : `<a href="#${findingAnchor(index)}">${escapeHtml(id)}</a>`;
      }).join(' / ');
  const evidenceLinks = (ids: readonly string[]): string => ids.length === 0
    ? '未記録'
    : ids.map((id) => {
        const index = evidenceIndexById.get(id);
        return index === undefined ? escapeHtml(id) : `<a href="#${evidenceAnchor(index)}">${escapeHtml(id)}</a>`;
      }).join(' / ');

  const navigationFindings = report.findings.map((finding, index) => (
    `<li class="finding-nav-item" data-search="${escapeHtml(`${finding.id} ${finding.title}`.toLocaleLowerCase('ja'))}"><a href="#${findingAnchor(index)}"><span>${escapeHtml(finding.id)}</span>${escapeHtml(finding.title)}</a></li>`
  )).join('');
  const findingIndexRows = report.findings.map((finding, index) => [
    `<a href="#${findingAnchor(index)}">${escapeHtml(finding.id)}</a>`,
    escapeHtml(finding.title),
    escapeHtml(finding.severity),
    String(finding.urls.length),
    escapeHtml(finding.method),
  ] as const);
  const findingIndexTable = `<div class="table-scroll"><table><thead><tr><th scope="col">ID</th><th scope="col">指摘名</th><th scope="col">深刻度</th><th scope="col">対象URL数</th><th scope="col">HTTP</th></tr></thead><tbody>${findingIndexRows.map((row, index) => (
    `<tr class="finding-index-row" data-search="${escapeHtml(`${report.findings[index]?.id ?? ''} ${report.findings[index]?.title ?? ''}`.toLocaleLowerCase('ja'))}">${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`
  )).join('')}</tbody></table></div>`;

  const findingDetails = report.findings.length === 0
    ? '<p class="empty">報告対象の指摘はありません。</p>'
    : report.findings.map((finding, findingIndex) => {
        const exchanges = finding.technicalEvidenceByUrl.map((entry, exchangeIndex) => {
          const anchor = `${findingAnchor(findingIndex)}-http-${String(exchangeIndex + 1)}`;
          const highlightTerms = resolvedHighlightTerms(entry.technicalEvidence, entry.parameter);
          return `<section class="http-exchange" id="${anchor}" data-nav-target>
            <h4>診断時HTTP証跡 ${String(exchangeIndex + 1)} / ${String(finding.technicalEvidenceByUrl.length)}</h4>
            <p class="url">${escapeHtml(entry.url)}</p>
            <p class="focus"><strong>着目箇所:</strong> ${htmlLines(entry.technicalEvidence.focusSummary)}</p>
            ${htmlKeyValues([
              ['自動判定根拠', entry.automatedRationale],
              ['HTTP メソッド', entry.method],
              ['パラメータ', entry.parameter],
              ['レスポンスステータス', entry.technicalEvidence.responseStatusCode === null ? '取得不可' : String(entry.technicalEvidence.responseStatusCode)],
              ...entry.technicalEvidence.measuredValues.map((item) => [item.label, item.value] as const),
            ])}
            <p><strong>証拠ID:</strong> ${evidenceLinks(entry.evidenceIds)}</p>
            <h5>Request</h5>
            <pre>${highlightedEvidenceHtml(entry.technicalEvidence.request, highlightTerms.request, entry.technicalEvidence.highlightEnabled)}</pre>
            <h5>Response</h5>
            <pre>${highlightedEvidenceHtml(entry.technicalEvidence.response, highlightTerms.response, entry.technicalEvidence.highlightEnabled)}</pre>
            ${entry.technicalEvidence.responseDeficiencies.map((deficiency) => `<p class="focus"><strong>確認結果:</strong> ${htmlLines(deficiency)}</p>`).join('')}
            ${entry.technicalEvidence.attackInput !== '' || entry.technicalEvidence.observedEvidence !== '' ? htmlKeyValues([
              ['診断入力・攻撃文字列', entry.technicalEvidence.attackInput || '未入力'],
              ['観測した根拠', entry.technicalEvidence.observedEvidence || '未入力'],
            ]) : ''}
            <p class="back-link"><a href="#${findingAnchor(findingIndex)}">この指摘の先頭へ戻る</a></p>
          </section>`;
        }).join('');
        return `<article class="finding" id="${findingAnchor(findingIndex)}" data-nav-target>
          <header class="finding-header"><p class="eyebrow">指摘 ${String(findingIndex + 1)} / ${String(report.findings.length)}</p><h3>${escapeHtml(finding.id)}　${escapeHtml(finding.title)}</h3></header>
          ${htmlKeyValues([
            ['深刻度', finding.severity], ['確信度', finding.confidence], ['検出元', finding.source],
            ['CWE', finding.cwe.join(' / ') || '未分類'], ['OWASP Top 10', finding.owaspTop10.join(' / ') || '未分類'],
            ['HTTP メソッド', finding.method], ['パラメータ', finding.parameter],
            ['初回確認', dateTime(finding.firstSeenAt)], ['最終確認', dateTime(finding.lastSeenAt)], ['観測回数', String(finding.occurrences)],
          ])}
          <h4>対象URL</h4>${htmlList(finding.urls, '未入力')}
          <p><strong>証拠ID:</strong> ${evidenceLinks(finding.evidenceIds)}</p>
          <h4>概要と成立条件</h4><p>${htmlLines(finding.summary)}</p><p>${htmlLines(finding.conditions)}</p>
          <h4>自動判定根拠</h4><p>${htmlLines(finding.automatedRationale)}</p>
          <h4>原因</h4><p>${htmlLines(finding.cause)}</p>
          <h4>再現手順</h4><p>${htmlLines(finding.reproduction.prerequisites)}</p><ol>${finding.reproduction.steps.map((step) => `<li>${htmlLines(step)}</li>`).join('')}</ol>
          ${exchanges}
          <h4>実際の結果</h4><p>${htmlLines(finding.reproduction.actual)}</p>
          <h4>改善策</h4>${htmlKeyValues([['暫定対策', finding.remediation.immediate], ['恒久対策', finding.remediation.permanent]])}
          <h4>修正確認条件</h4><p>${htmlLines(finding.verificationCriteria)}</p>
          <p class="back-link"><a href="#finding-index">指摘索引へ戻る</a></p>
        </article>`;
      }).join('');

  const evidenceRows = report.evidence.map((item, index) => [
    item.id,
    item.type,
    item.sha256,
    dateTime(item.capturedAt),
    item.redactionStatus,
    item.relatedFindingIds.join(' / ') || 'なし',
  ] as const);
  const evidenceTable = `<div class="table-scroll"><table><thead><tr><th scope="col">証拠 ID</th><th scope="col">種類</th><th scope="col">SHA-256</th><th scope="col">取得日時</th><th scope="col">秘匿状態</th><th scope="col">関連指摘</th></tr></thead><tbody>${evidenceRows.length === 0 ? '<tr><td colspan="6" class="empty">該当なし</td></tr>' : evidenceRows.map((row, index) => (
    `<tr id="${evidenceAnchor(index)}" data-nav-target><td>${escapeHtml(row[0])}</td><td>${escapeHtml(row[1])}</td><td class="hash">${escapeHtml(row[2])}</td><td>${escapeHtml(row[3])}</td><td>${escapeHtml(row[4])}</td><td>${relatedFindingLinks(report.evidence[index]?.relatedFindingIds ?? [])}</td></tr>`
  )).join('')}</tbody></table></div>`;

  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
  <title>${escapeHtml(report.engagement.systemName || report.engagement.name)} | 第二部 技術証跡別冊</title>
  <style>
    :root { color-scheme: light; --navy: #17365d; --blue: #0f6cbd; --pale: #eff6fc; --line: #d1d7e0; --muted: #5b6472; --nav-width: 20rem; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; color: #17191c; background: #f5f6f8; font-family: "Yu Gothic", "Meiryo", system-ui, sans-serif; line-height: 1.65; }
    a { color: #075ea8; text-underline-offset: .18em; }
    .report-nav { position: fixed; inset: 0 auto 0 0; z-index: 20; width: var(--nav-width); overflow-y: auto; padding: 1.25rem 1rem 2rem; color: #fff; background: var(--navy); box-shadow: .2rem 0 1rem #0003; }
    .report-nav h2 { margin: 0 0 .2rem; font-size: 1.05rem; }
    .report-nav .report-id { margin: 0 0 1rem; color: #d7e8fa; font-size: .78rem; overflow-wrap: anywhere; }
    .report-nav label { display: block; margin: .75rem 0 .25rem; font-size: .78rem; font-weight: 700; }
    .report-nav input { width: 100%; min-height: 2.35rem; border: 1px solid #91bde5; border-radius: .25rem; padding: .4rem .55rem; font: inherit; }
    .report-nav ul { margin: .7rem 0 0; padding: 0; list-style: none; }
    .report-nav li { margin: .12rem 0; }
    .report-nav a { display: block; border-left: .2rem solid transparent; border-radius: .2rem; padding: .35rem .5rem; color: #fff; text-decoration: none; font-size: .84rem; line-height: 1.35; }
    .report-nav a:hover, .report-nav a:focus-visible, .report-nav a[aria-current="location"] { border-left-color: #7dc9ff; background: #ffffff1f; }
    .report-nav a span { display: inline-block; min-width: 4.8rem; color: #a9d7ff; font-weight: 700; }
    .finding-nav { border-top: 1px solid #ffffff42; padding-top: .55rem !important; }
    main { width: min(90rem, calc(100% - var(--nav-width))); margin-left: var(--nav-width); padding: 2.5rem clamp(1.25rem, 3vw, 3.5rem) 5rem; }
    .cover, .report-section, .finding { margin: 0 auto 1.5rem; border: 1px solid var(--line); border-radius: .5rem; padding: clamp(1.25rem, 3vw, 2.5rem); background: #fff; box-shadow: 0 .15rem .6rem #16233a10; }
    .cover { border-top: .45rem solid var(--navy); }
    .eyebrow { margin: 0 0 .25rem; color: var(--blue); font-size: .78rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; color: var(--navy); font-size: clamp(1.8rem, 4vw, 3.2rem); line-height: 1.25; }
    h2 { margin: 0 0 1rem; color: var(--navy); font-size: 1.65rem; }
    h3 { margin: 0; color: var(--navy); font-size: 1.35rem; }
    h4 { margin: 1.6rem 0 .55rem; color: #243b53; font-size: 1.05rem; }
    h5 { margin: 1.2rem 0 .45rem; font-size: .92rem; }
    [data-nav-target] { scroll-margin-top: 1rem; }
    .key-values { display: grid; grid-template-columns: repeat(auto-fit, minmax(19rem, 1fr)); gap: 0; margin: 1rem 0; border: 1px solid var(--line); border-radius: .35rem; overflow: hidden; }
    .key-values div { display: grid; grid-template-columns: minmax(7rem, 35%) 1fr; border-bottom: 1px solid var(--line); }
    .key-values div:last-child { border-bottom: 0; }
    .key-values dt, .key-values dd { margin: 0; padding: .55rem .7rem; overflow-wrap: anywhere; }
    .key-values dt { background: var(--pale); font-weight: 700; }
    .table-scroll { overflow-x: auto; margin: 1rem 0; }
    table { width: 100%; border-collapse: collapse; background: #fff; font-size: .88rem; }
    th, td { border: 1px solid var(--line); padding: .55rem .65rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { position: sticky; top: 0; z-index: 2; color: #fff; background: var(--navy); }
    tbody tr:nth-child(even) { background: #f7fafe; }
    .finding { border-top: .35rem solid var(--blue); }
    .finding-header { border-bottom: 1px solid var(--line); padding-bottom: .8rem; }
    .http-exchange { margin: 1.5rem 0; border: 1px solid #9cb8d3; border-radius: .4rem; padding: 1rem; background: #fbfdff; }
    .url { overflow-wrap: anywhere; color: var(--muted); font-family: Consolas, "Courier New", monospace; font-size: .86rem; }
    pre { max-height: 42rem; overflow: auto; margin: .4rem 0 1rem; border: 1px solid #c7cdd5; border-radius: .3rem; padding: .85rem; background: #f3f4f6; white-space: pre-wrap; overflow-wrap: anywhere; font: .82rem/1.5 Consolas, "Courier New", monospace; tab-size: 2; }
    mark, .focus { background: #fff3a3; }
    .focus { border-left: .25rem solid #e0b800; padding: .55rem .75rem; }
    .hash { font-family: Consolas, "Courier New", monospace; font-size: .78rem; }
    .empty { color: var(--muted); }
    .back-link { text-align: right; font-size: .82rem; }
    .is-filtered { display: none !important; }
    @media (max-width: 860px) {
      :root { --nav-width: 15rem; }
      main { padding: 1rem; }
      .key-values { grid-template-columns: 1fr; }
    }
    @media print {
      .report-nav { display: none; }
      main { width: auto; margin: 0; padding: 0; }
      .cover, .report-section, .finding { border: 0; box-shadow: none; break-inside: avoid-page; }
      .http-exchange { break-inside: auto; }
      pre { max-height: none; overflow: visible; }
      a { color: inherit; text-decoration: none; }
    }
  </style>
</head>
<body>
  <nav class="report-nav" aria-label="技術証跡別冊の固定ナビゲーション">
    <h2>第二部　技術証跡別冊</h2>
    <p class="report-id">${escapeHtml(report.report.id)}</p>
    <label for="finding-search">指摘を検索</label>
    <input id="finding-search" type="search" placeholder="IDまたは指摘名" autocomplete="off">
    <ul>
      <li><a href="#top">表紙</a></li>
      <li><a href="#document-control">1 文書管理</a></li>
      <li><a href="#summary">2 概要</a></li>
      <li><a href="#scope">3 診断条件と対象範囲</a></li>
      <li><a href="#coverage">4 診断カバレッジ</a></li>
      <li><a href="#method">5 評価方法</a></li>
      <li><a href="#finding-index">6 指摘索引</a></li>
      <li><a href="#finding-details">7 指摘事項詳細</a></li>
    </ul>
    <ul class="finding-nav" aria-label="指摘別索引">${navigationFindings || '<li>指摘なし</li>'}</ul>
    <ul>
      <li><a href="#remediation-plan">8 対応計画と再診断</a></li>
      <li><a href="#evidence-index">9 証拠索引</a></li>
      <li><a href="#notes">10 特記事項</a></li>
    </ul>
  </nav>
  <main>
    <header class="cover" id="top" data-nav-target>
      <p class="eyebrow">SCOPEPILOT2 ASSURANCE REPORT</p>
      <h1>第二部　技術証跡別冊</h1>
      <p>${escapeHtml(report.engagement.systemName || report.engagement.name)}</p>
      ${htmlKeyValues([
        ['レポート ID', report.report.id], ['案件名', report.engagement.name], ['提出先', report.engagement.clientName],
        ['診断区分', report.assessment.type], ['発行日', dateTime(report.report.generatedAt)],
        ['発行者', report.engagement.serviceProvider], ['機密区分', report.report.classification],
      ])}
    </header>
    <section class="report-section" id="document-control" data-nav-target><h2>1　文書管理</h2>${htmlKeyValues([
      ['版数', report.report.version], ['文書状態', report.report.status], ['作成者', report.report.author],
      ['レビュー担当', report.report.reviewer], ['承認者', report.report.approver],
      ['配布先', report.report.distribution.join(' / ') || '未入力'], ['正規モデル SHA-256', report.modelHash],
    ])}</section>
    <section class="report-section" id="summary" data-nav-target><h2>2　概要</h2><p>${htmlLines(report.summary.conclusion)}</p>${htmlKeyValues([
      ['最高深刻度', report.summary.highestSeverity], ['指摘総数', String(report.findings.length)],
      ['深刻度別', Object.entries(report.summary.severityCounts).map(([key, count]) => `${key} ${String(count)}`).join(' / ') || '0'],
    ])}<h3>優先対応事項</h3>${htmlList(report.summary.priorities)}<h3>重大な制約</h3>${htmlList(report.summary.majorLimitations)}</section>
    <section class="report-section" id="scope" data-nav-target><h2>3　診断条件と対象範囲</h2>${htmlKeyValues([
      ['診断期間', `${dateTime(report.assessment.startedAt)} ～ ${dateTime(report.assessment.endedAt)}`],
      ['診断方法', report.assessment.methods.join(' / ') || '未実施'], ['診断元 IP', report.assessment.sourceIps.join(' / ') || '未入力'],
      ['対象ロール', report.assessment.roles.join(' / ') || '未入力'], ['許可 Origin', report.assessment.allowedOrigins.join('\n') || '未入力'],
      ['禁止操作', report.assessment.forbiddenActions.join(' / ') || '未入力'], ['除外対象', report.assessment.exclusions.join(' / ') || 'なし'],
      ['前提条件', report.assessment.assumptions.join(' / ') || 'なし'],
      ['実行上限', `送信 ${String(report.assessment.requestLimits.maxRequests)} / ページ ${String(report.assessment.requestLimits.maxPages)} / 時間 ${String(report.assessment.requestLimits.maxDurationMinutes)} 分`],
    ])}<h3>対象資産</h3>${htmlTable(['ID', '名称', 'FQDN', '代表 URL'], report.assets.map((asset) => [asset.id, asset.name, asset.fqdn, asset.urls.join('\n') || '未入力']))}</section>
    <section class="report-section" id="coverage" data-nav-target><h2>4　診断カバレッジ</h2><p>実施済みと未実施を区別し、警告がないことを実施済みの根拠にしません。</p>${htmlKeyValues([
      ['探索 URL 数', String(report.coverageSummary.exploredUrlCount)], ['診断 URL 数', String(report.coverageSummary.scannedUrlCount)],
      ['外部エンジン委譲数', String(report.coverageSummary.delegatedStepCount)],
    ])}${htmlTable(['ID', '診断観点', '状態', '検証手段', '対象URL・ロール', '制約'], report.coverage.map((item) => [item.controlId, item.title, item.status, item.method, [...item.targets, ...item.roles].join('\n') || '未記録', item.limitations]))}</section>
    <section class="report-section" id="method" data-nav-target><h2>5　評価方法</h2>${htmlTable(['評価軸', '値', '意味'], [
      ['深刻度', 'High / Medium / Low / Informational / 未評価', '成立時の技術的・業務的な影響度'],
      ['対応状態', '未着手 / 対応中 / 対応済み / 受容 / 保留', '修正とリスク受容の管理状態'],
      ['再診断', '解消 / 一部解消 / 未解消 / 再診断不能 / 未実施', '修正確認の結果'],
    ])}</section>
    <section class="report-section" id="finding-index" data-nav-target><h2>6　指摘索引</h2><p>指摘IDまたは名称を選ぶと、該当する技術詳細へ直接移動します。</p>${findingIndexTable}</section>
    <section class="report-section" id="finding-details" data-nav-target><h2>7　指摘事項詳細</h2>${htmlKeyValues([
      ['認証条件', report.assessment.authentication], ['スキャンポリシー', report.assessment.scanPolicies.join(' / ') || '未実施'],
    ])}<h3>探索URLと診断対象判定</h3>${htmlTable(['URL', 'HTTP', '深さ', '判定', '対象外理由'], report.urlCoverage.map((item) => [item.url, item.statusCode === null ? '不明' : String(item.statusCode), String(item.depth), item.scanStatus, item.exclusionReason]))}</section>
    ${findingDetails}
    <section class="report-section" id="remediation-plan" data-nav-target><h2>8　対応計画と再診断</h2>${htmlTable(['指摘 ID', '対応方針', '担当', '期限', '状態', '再診断結果'], report.findings.map((finding) => [finding.id, '未入力', '未入力', '未入力', '未着手', '未実施']))}</section>
    <section class="report-section" id="evidence-index" data-nav-target><h2>9　証拠索引</h2><p>各指摘の本文には診断時の Request と Response を掲載します。この索引は原本の完全性確認に使用します。</p>${evidenceTable}</section>
    <section class="report-section" id="notes" data-nav-target><h2>10　特記事項</h2>${htmlList(report.specialNotes)}<p class="hash">ScopePilot2 report model hash: ${escapeHtml(report.modelHash)}</p></section>
  </main>
  <script>
    (() => {
      const search = document.getElementById('finding-search');
      const filter = () => {
        const query = search.value.trim().toLocaleLowerCase('ja');
        document.querySelectorAll('.finding-nav-item, .finding-index-row').forEach((item) => {
          item.classList.toggle('is-filtered', query !== '' && !item.dataset.search.includes(query));
        });
      };
      search.addEventListener('input', filter);
      const links = [...document.querySelectorAll('.report-nav a[href^="#"]')];
      const linksById = new Map(links.map((link) => [decodeURIComponent(link.hash.slice(1)), link]));
      const observer = new IntersectionObserver((entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
        if (!visible) return;
        links.forEach((link) => link.removeAttribute('aria-current'));
        linksById.get(visible.target.id)?.setAttribute('aria-current', 'location');
      }, { rootMargin: '0px 0px -78% 0px', threshold: 0 });
      document.querySelectorAll('[data-nav-target][id]').forEach((section) => observer.observe(section));
    })();
  </script>
</body>
</html>\n`;
  return Buffer.from(html, 'utf8');
}

export async function renderAssuranceReport(report: AssuranceReportDocument): Promise<Buffer> {
  const coverChildren: (Paragraph | Table)[] = [
    new Paragraph({ spacing: { before: 900, after: 140 }, children: [new TextRun({ text: 'SCOPEPILOT2  ASSURANCE REPORT', color: GRAY, bold: true, size: 18, font: 'Aptos' })] }),
    new Paragraph({ style: 'Title', children: [new TextRun('ウェブアプリケーション')], spacing: { before: 780, after: 80 } }),
    new Paragraph({ style: 'Title', children: [new TextRun('脆弱性診断報告書')], spacing: { after: 420 } }),
    new Paragraph({ spacing: { after: 320 }, children: [new TextRun({ text: '第二部　技術証跡別冊', bold: true, size: 28, font: 'Yu Gothic', color: NAVY })] }),
    body(report.engagement.systemName, { after: 360 }),
    keyValue([
      ['レポート ID', report.report.id],
      ['案件名', report.engagement.name],
      ['提出先', report.engagement.clientName],
      ['診断区分', report.assessment.type],
      ['発行日', dateTime(report.report.generatedAt)],
      ['発行者', report.engagement.serviceProvider],
      ['機密区分', report.report.classification],
    ]),
  ];
  const children: (Paragraph | Table)[] = [];

  children.push(heading('1  文書管理', 1));
  children.push(keyValue([
    ['版数', report.report.version], ['文書状態', report.report.status], ['作成者', report.report.author],
    ['レビュー担当', report.report.reviewer], ['承認者', report.report.approver],
    ['配布先', report.report.distribution.join(' / ') || '未入力'], ['正規モデル SHA-256', report.modelHash],
  ]));
  children.push(heading('改訂履歴', 2));
  children.push(table(['版数', '日付', '内容', '作成者'], [[report.report.version, dateTime(report.report.generatedAt), '初版', report.report.author]], [1100, 1900, 4500, 2140]));

  children.push(heading('2  経営層向け概要', 1, true));
  children.push(body(report.summary.conclusion));
  children.push(keyValue([
    ['最高深刻度', report.summary.highestSeverity],
    ['指摘総数', String(report.findings.length)],
    ['深刻度別', Object.entries(report.summary.severityCounts).map(([key, count]) => `${key} ${String(count)}`).join(' / ') || '0'],
  ]));
  children.push(heading('優先対応事項', 2), ...bullets(report.summary.priorities));
  children.push(heading('重大な制約', 2), ...bullets(report.summary.majorLimitations));

  children.push(heading('3  診断条件と対象範囲', 1, true));
  children.push(keyValue([
    ['診断期間', `${dateTime(report.assessment.startedAt)} ～ ${dateTime(report.assessment.endedAt)}`],
    ['診断方法', report.assessment.methods.join(' / ') || '未実施'],
    ['診断元 IP', report.assessment.sourceIps.join(' / ') || '未入力'],
    ['対象ロール', report.assessment.roles.join(' / ') || '未入力'],
    ['許可 Origin', report.assessment.allowedOrigins.join('\n') || '未入力'],
    ['禁止操作', report.assessment.forbiddenActions.join(' / ') || '未入力'],
    ['除外対象', report.assessment.exclusions.join(' / ') || 'なし'],
    ['前提条件', report.assessment.assumptions.join(' / ') || 'なし'],
    ['実行上限', `送信 ${String(report.assessment.requestLimits.maxRequests)} / ページ ${String(report.assessment.requestLimits.maxPages)} / 時間 ${String(report.assessment.requestLimits.maxDurationMinutes)} 分`],
  ]));
  children.push(heading('対象資産', 2));
  children.push(table(['ID', '名称', 'FQDN', '代表 URL'], report.assets.map((asset) => [asset.id, asset.name, asset.fqdn, asset.urls.join('\n') || '未入力']), [1200, 2200, 2300, 3940]));

  children.push(heading('4  診断カバレッジ', 1, true));
  children.push(body('実施済みと未実施を区別し 警告がないことを実施済みの根拠にしません'));
  children.push(keyValue([
    ['探索 URL 数', String(report.coverageSummary.exploredUrlCount)],
    ['診断 URL 数', String(report.coverageSummary.scannedUrlCount)],
    ['外部エンジン委譲数', String(report.coverageSummary.delegatedStepCount)],
    ['参照ガイドライン', [...new Set(report.coverage.filter((item) => item.controlId.startsWith('COV-')).map((item) => item.title))].join(' / ') || 'なし'],
  ]));
  children.push(table(['ID', '診断観点', '状態', '検証手段', '対象URL・ロール', '制約'], report.coverage.map((item) => [item.controlId, item.title, item.status, item.method, [...item.targets, ...item.roles].join('\n') || '未記録', item.limitations]), [900, 1800, 1000, 1500, 2400, 2040]));

  children.push(heading('5  評価方法', 1, true));
  children.push(body('深刻度と対応状態は別々の軸として管理します'));
  children.push(table(['評価軸', '値', '意味'], [
    ['深刻度', 'High / Medium / Low / Informational / 未評価', '成立時の技術的 業務的な影響度'],
    ['対応状態', '未着手 / 対応中 / 対応済み / 受容 / 保留', '修正とリスク受容の管理状態'],
    ['再診断', '解消 / 一部解消 / 未解消 / 再診断不能 / 未実施', '修正確認の結果'],
  ], [1800, 3300, 4540]));

  children.push(heading('6  指摘事項一覧', 1, true));
  children.push(table(['ID', '指摘名', '深刻度', '対象'], report.findings.map((finding) => [finding.id, finding.title, finding.severity, finding.urls.join('\n')]), [1200, 3000, 1400, 4040]));

  children.push(heading('7  指摘事項詳細', 1, true));
  if (report.findings.length === 0) children.push(body('報告対象の指摘はありません'));
  children.push(heading('診断条件の明細', 2));
  children.push(keyValue([
    ['認証条件', report.assessment.authentication],
    ['スキャンポリシー', report.assessment.scanPolicies.join(' / ') || '未実施'],
  ]));
  children.push(heading('探索URLと診断対象判定', 2));
  children.push(table(
    ['URL', 'HTTP', '深さ', '判定', '対象外理由'],
    report.urlCoverage.map((item) => [item.url, item.statusCode === null ? '不明' : String(item.statusCode), String(item.depth), item.scanStatus, item.exclusionReason]),
    [3900, 700, 600, 1100, 3340],
  ));
  for (const [index, finding] of report.findings.entries()) {
    children.push(heading(`${finding.id}  ${finding.title}`, 2, index > 0));
    children.push(keyValue([
      ['CWE', finding.cwe.join(' / ')],
      ['OWASP Top 10', finding.owaspTop10.join(' / ')],
      ['自動判定根拠', finding.automatedRationale],
    ]));
    children.push(keyValue([
      ['深刻度', finding.severity], ['確信度', finding.confidence], ['検出元', finding.source],
      ['URL', finding.urls.join('\n')], ['HTTP メソッド', finding.method], ['パラメータ', finding.parameter],
      ['初回確認', dateTime(finding.firstSeenAt)], ['最終確認', dateTime(finding.lastSeenAt)], ['観測回数', String(finding.occurrences)],
      ['証跡識別子', finding.evidenceIds.join(' / ') || '未入力'],
    ]));
    children.push(heading('概要と成立条件', 3), body(finding.summary), body(finding.conditions));
    children.push(heading('原因', 3), body(finding.cause));
    children.push(heading('再現手順', 3), body(finding.reproduction.prerequisites), ...finding.reproduction.steps.map((step, stepIndex) => body(`${String(stepIndex + 1)}. ${step}`)));
    for (const [evidenceIndex, entry] of finding.technicalEvidenceByUrl.entries()) {
      const highlightTerms = resolvedHighlightTerms(entry.technicalEvidence, entry.parameter);
      children.push(body(entry.url, { boldLead: `診断時HTTP証跡 ${String(evidenceIndex + 1)} / ${String(finding.technicalEvidenceByUrl.length)}  ` }));
      children.push(evidenceFocusParagraph(entry.technicalEvidence.focusSummary, entry.technicalEvidence.highlightEnabled));
      children.push(keyValue([
        ['自動判定根拠', entry.automatedRationale],
        ['HTTP メソッド', entry.method],
        ['パラメータ', entry.parameter],
        ['証拠ID', entry.evidenceIds.join(' / ') || '未記録'],
        ['レスポンスステータス', entry.technicalEvidence.responseStatusCode === null ? '取得不可' : String(entry.technicalEvidence.responseStatusCode)],
        ...entry.technicalEvidence.measuredValues.map((item) => [item.label, item.value] as const),
      ]));
      children.push(...httpEvidenceBlock(
        'Request',
        entry.technicalEvidence.request,
        highlightTerms.request,
        entry.technicalEvidence.highlightEnabled,
      ));
      children.push(...httpEvidenceBlock(
        'Response',
        entry.technicalEvidence.response,
        highlightTerms.response,
        entry.technicalEvidence.highlightEnabled,
      ));
      for (const deficiency of entry.technicalEvidence.responseDeficiencies) {
        children.push(evidenceFocusParagraph(`確認結果: ${deficiency}`, entry.technicalEvidence.highlightEnabled));
      }
      if (entry.technicalEvidence.attackInput !== '' || entry.technicalEvidence.observedEvidence !== '') {
        children.push(keyValue([
          ['診断入力・攻撃文字列', entry.technicalEvidence.attackInput || '未入力'],
          ['観測した根拠', entry.technicalEvidence.observedEvidence || '未入力'],
        ]));
      }
    }
    children.push(body(finding.reproduction.actual, { boldLead: '実際の結果  ' }));
    children.push(heading('改善策', 3), body(finding.remediation.immediate, { boldLead: '暫定対策  ' }), body(finding.remediation.permanent, { boldLead: '恒久対策  ' }));
    children.push(heading('修正確認条件', 3), body(finding.verificationCriteria));
  }

  children.push(heading('8  対応計画と再診断', 1, true));
  children.push(table(['指摘 ID', '対応方針', '担当', '期限', '状態', '再診断結果'], report.findings.map((finding) => [finding.id, '未入力', '未入力', '未入力', '未着手', '未実施']), [1200, 2800, 1400, 1300, 1200, 1740]));

  children.push(heading('9  証拠索引', 1, true));
  children.push(body('各指摘の本文には診断時のRequestとResponseを掲載します この索引は原本の完全性確認に使用します'));
  children.push(table(['証拠 ID', '種類', 'SHA-256', '関連指摘'], report.evidence.map((item) => [item.id, item.type, item.sha256, item.relatedFindingIds.join(' / ') || 'なし']), [1700, 1700, 3940, 2300]));

  children.push(heading('10  特記事項', 1, true), ...bullets(report.specialNotes));
  children.push(body(`ScopePilot2 report model hash  ${report.modelHash}`, { after: 0 }));

  const reportFooter = (): Footer => new Footer({ children: [new Paragraph({
    children: [
      new TextRun({ text: `${report.report.id}  |  取扱区分 ${report.report.classification}`, size: 16, color: GRAY, font: '游ゴシック' }),
      new TextRun({ text: '                                  Page ', size: 16, color: GRAY, font: 'Aptos' }),
      new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GRAY, font: 'Aptos' }),
    ],
  })] });
  const document = new Document({
    creator: 'ScopePilot2',
    title: 'ウェブアプリケーション脆弱性診断報告書',
    subject: report.engagement.name,
    description: 'ScopePilot2 の検証済み報告モデルから生成した日本語診断報告書',
    evenAndOddHeaderAndFooters: true,
    styles: {
      default: {
        document: { run: { font: '游ゴシック', size: 21, color: '000000' }, paragraph: { spacing: { line: 320 } } },
        title: { run: { font: '游ゴシック', size: 46, bold: true, color: '000000' }, paragraph: { spacing: { after: 160 }, keepNext: true } },
        heading1: { run: { font: '游ゴシック', size: 32, bold: true, color: '000000' }, paragraph: { spacing: { before: 280, after: 180 }, keepNext: true } },
        heading2: { run: { font: '游ゴシック', size: 25, bold: true, color: '000000' }, paragraph: { spacing: { before: 220, after: 120 }, keepNext: true } },
        heading3: { run: { font: '游ゴシック', size: 21, bold: true, color: '000000' }, paragraph: { spacing: { before: 180, after: 100 }, keepNext: true } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1020, right: 1080, bottom: 1020, left: 1080, header: 440, footer: 440, gutter: 0 },
            pageNumbers: { start: 1 },
          },
        },
        children: coverChildren,
      },
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1020, right: 1080, bottom: 1020, left: 1080, header: 440, footer: 440, gutter: 0 },
            pageNumbers: { start: 2 },
          },
        },
        footers: { default: reportFooter(), even: reportFooter() },
        children,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(document));
}
