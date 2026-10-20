/**
 * Sequencer。`docs/detailed-design/f07-sequencer.md` §3〜§6。
 * 最小 30・既定 100・最大 10,000 sample。統計は観測に対するもので、
 * 暗号学的安全性を断定しない。token 原本は secret 扱いで report には統計だけを載せる。
 */
import { domainError } from '@scopepilot2/contracts';

export const SEQUENCER_MIN_SAMPLES = 30;
export const SEQUENCER_DEFAULT_SAMPLES = 100;
export const SEQUENCER_MAX_SAMPLES = 10000;

/** 29 / 10,001 sample は境界外として拒否する (F07-UT-001)。 */
export function createSamplePlan(requested: number): { target: number } {
  if (!Number.isInteger(requested) || requested < SEQUENCER_MIN_SAMPLES || requested > SEQUENCER_MAX_SAMPLES) {
    throw domainError('ValidationFailed', `sample plan must be an integer between ${SEQUENCER_MIN_SAMPLES} and ${SEQUENCER_MAX_SAMPLES}`);
  }
  return { target: requested };
}

export type SampleOutcome =
  | { readonly kind: 'collected'; readonly token: string }
  | { readonly kind: 'missing'; readonly reason: string };

export type SequencerExtractor =
  | { readonly source: 'body' }
  | { readonly source: 'cookie'; readonly cookieName: string }
  | { readonly source: 'hidden'; readonly fieldName: string };

const COOKIE_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HIDDEN_FIELD_NAME = /^[0-9A-Za-z_.:[\]-]+$/;
const MAX_HIDDEN_INPUTS = 1024;
const MAX_INPUT_TAG_LENGTH = 8192;

/** 抽出条件をboundedに固定し、未使用fieldを暗黙に無視しない。 */
export function createSequencerExtractor(
  source: 'body' | 'cookie' | 'hidden',
  cookieName?: string,
  fieldName?: string,
): SequencerExtractor {
  if (source === 'body') {
    if (cookieName !== undefined || fieldName !== undefined) {
      throw domainError('ValidationFailed', 'tokenCookieName and tokenFieldName are not supported when tokenSource is body');
    }
    return { source };
  }
  if (source === 'cookie') {
    if (fieldName !== undefined) {
      throw domainError('ValidationFailed', 'tokenFieldName is only supported when tokenSource is hidden');
    }
    if (cookieName === undefined || cookieName.length === 0 || cookieName.length > 128 || !COOKIE_NAME_TOKEN.test(cookieName)) {
      throw domainError('ValidationFailed', 'tokenCookieName must be a valid cookie name of at most 128 characters');
    }
    return { source, cookieName };
  }
  if (cookieName !== undefined) {
    throw domainError('ValidationFailed', 'tokenCookieName is only supported when tokenSource is cookie');
  }
  if (fieldName === undefined || fieldName.length === 0 || fieldName.length > 128 || !HIDDEN_FIELD_NAME.test(fieldName)) {
    throw domainError('ValidationFailed', 'tokenFieldName must be a valid form field name of at most 128 characters');
  }
  return { source, fieldName };
}

/** token 欠落は missing outcome として数える (F07-UT-002)。 */
export function extractToken(response: { body: string }, pattern: RegExp): SampleOutcome {
  const match = pattern.exec(response.body);
  if (match === null || match[1] === undefined || match[1] === '') {
    return { kind: 'missing', reason: 'token pattern not found in response body' };
  }
  return { kind: 'collected', token: match[1] };
}

/** Set-Cookieの先頭name=valueだけを読み、属性や他cookieをtokenへ混入させない。 */
export function extractCookieToken(response: { readonly setCookieHeaders?: readonly string[] }, cookieName: string): SampleOutcome {
  for (const header of response.setCookieHeaders ?? []) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator <= 0 || pair.slice(0, separator).trim() !== cookieName) {
      continue;
    }
    const token = pair.slice(separator + 1).trim();
    if (token !== '') {
      return { kind: 'collected', token };
    }
  }
  return { kind: 'missing', reason: `cookie '${cookieName}' not found in response` };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (entity, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replace(/&#(\d{1,7});/g, (entity, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function inputTags(body: string): readonly string[] {
  const tags: string[] = [];
  const lower = body.toLowerCase();
  let cursor = 0;
  while (tags.length < MAX_HIDDEN_INPUTS) {
    const start = lower.indexOf('<input', cursor);
    if (start === -1) {
      break;
    }
    const boundary = lower[start + 6];
    if (boundary !== undefined && !/[\s/>]/.test(boundary)) {
      cursor = start + 6;
      continue;
    }
    let quote: '"' | "'" | undefined;
    let end = start + 6;
    for (; end < body.length && end - start <= MAX_INPUT_TAG_LENGTH; end += 1) {
      const character = body[end];
      if (quote === undefined && (character === '"' || character === "'")) {
        quote = character;
      } else if (character === quote) {
        quote = undefined;
      } else if (quote === undefined && character === '>') {
        end += 1;
        break;
      }
    }
    if (end - start <= MAX_INPUT_TAG_LENGTH && body[end - 1] === '>') {
      tags.push(body.slice(start, end));
    }
    cursor = Math.max(end, start + 6);
  }
  return tags;
}

/** hidden inputの属性順や引用符に依存せず、指定nameの値だけをboundedに読む。 */
export function extractHiddenInputToken(response: { readonly body: string }, fieldName: string): SampleOutcome {
  const attributePattern = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const tag of inputTags(response.body)) {
    const attributes = new Map<string, string>();
    attributePattern.lastIndex = 6;
    for (let match = attributePattern.exec(tag); match !== null; match = attributePattern.exec(tag)) {
      const name = match[1]?.toLowerCase();
      if (name !== undefined && !attributes.has(name)) {
        attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
      }
    }
    if (attributes.get('type')?.toLowerCase() !== 'hidden' || attributes.get('name') !== fieldName) {
      continue;
    }
    const value = attributes.get('value');
    if (value !== undefined && value !== '') {
      return { kind: 'collected', token: decodeHtmlAttribute(value) };
    }
  }
  return { kind: 'missing', reason: `hidden field '${fieldName}' not found in response body` };
}

export function extractSequencerToken(
  response: { readonly body: string; readonly setCookieHeaders?: readonly string[] },
  extractor: SequencerExtractor,
  bodyPattern: RegExp,
): SampleOutcome {
  switch (extractor.source) {
    case 'body':
      return extractToken(response, bodyPattern);
    case 'cookie':
      return extractCookieToken(response, extractor.cookieName);
    case 'hidden':
      return extractHiddenInputToken(response, extractor.fieldName);
  }
}

export interface SampleCollection {
  readonly tokens: readonly string[];
  readonly duplicates: number;
  readonly missing: number;
}

/** duplicate token も sample と重複数として保持する (F07-UT-003)。 */
export class SampleCollector {
  private readonly collected: string[] = [];
  private duplicates = 0;
  private missing = 0;

  record(outcome: SampleOutcome): void {
    if (outcome.kind === 'missing') {
      this.missing += 1;
      return;
    }
    if (this.collected.includes(outcome.token)) {
      this.duplicates += 1;
    }
    this.collected.push(outcome.token);
  }

  snapshot(): SampleCollection {
    return { tokens: [...this.collected], duplicates: this.duplicates, missing: this.missing };
  }

  get size(): number {
    return this.collected.length;
  }
}

export interface EntropyResult {
  readonly shannonEntropyBitsPerByte: number;
  readonly distinctByteValues: number;
}

/** 固定 bytes には決定的な低 entropy を返す (F07-UT-007 ではなく F07-UT-004)。 */
export function analyzeEntropy(tokens: readonly string[]): EntropyResult {
  const bytes = tokens.join('');
  const counts = new Map<number, number>();
  for (const byte of Buffer.from(bytes, 'utf8')) {
    counts.set(byte, (counts.get(byte) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / bytes.length;
    entropy -= p * Math.log2(p);
  }
  return { shannonEntropyBitsPerByte: Number(entropy.toFixed(4)), distinctByteValues: counts.size };
}

export type SequencerAssessment =
  | { readonly verdict: 'insufficient'; readonly collected: number; readonly minimum: number }
  | { readonly verdict: 'assessed'; readonly entropy: EntropyResult };

/** sample 不足は断定せず insufficient を返す (F07-UT-005)。 */
export function assess(tokens: readonly string[]): SequencerAssessment {
  if (tokens.length < SEQUENCER_MIN_SAMPLES) {
    return { verdict: 'insufficient', collected: tokens.length, minimum: SEQUENCER_MIN_SAMPLES };
  }
  return { verdict: 'assessed', entropy: analyzeEntropy(tokens) };
}

/** report projection から token 原文を除外する (F07-UT-006)。 */
export function reportProjection(collection: SampleCollection): { sampleCount: number; duplicates: number; missing: number } {
  return { sampleCount: collection.tokens.length, duplicates: collection.duplicates, missing: collection.missing };
}
