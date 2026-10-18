/**
 * Decoder・Comparer。`docs/detailed-design/f06-decoder-comparer.md`。
 * 標準 codec のみ (URL/Base64/hex/HTML entity/gzip)。任意 code execution は提供しない。
 * 圧縮 bomb は出力 byte 上限で停止し、部分値を成功扱いしない (F06-UT-003)。
 */
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { domainError, hashStable } from '@scopepilot2/contracts';

export type CodecName = 'base64' | 'url' | 'hex' | 'html-entity' | 'gzip' | 'deflate-raw';

export interface CodecLimits {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
}

export const CODEC_DEFAULT_LIMITS: CodecLimits = { maxInputBytes: 10 * 1024 * 1024, maxOutputBytes: 10 * 1024 * 1024 };

function decodeHtmlEntities(input: Buffer): Buffer {
  return Buffer.from(
    input.toString('utf8')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'),
    'utf8',
  );
}

function decodeWithLimits(name: CodecName, input: Buffer, limits: CodecLimits): Buffer {
  if (input.length > limits.maxInputBytes) {
    throw domainError('ValidationFailed', `${name}: input exceeds ${limits.maxInputBytes} bytes`);
  }
  let output: Buffer;
  switch (name) {
    case 'base64':
      output = Buffer.from(input.toString('utf8').replace(/\s+/g, ''), 'base64');
      break;
    case 'url':
      output = Buffer.from(decodeURIComponent(input.toString('utf8')), 'utf8');
      break;
    case 'hex':
      output = Buffer.from(input.toString('utf8').replace(/\s+/g, ''), 'hex');
      break;
    case 'html-entity':
      output = decodeHtmlEntities(input);
      break;
    case 'gzip':
      try {
        output = gunzipSync(input, { maxOutputLength: limits.maxOutputBytes });
      } catch (cause) {
        throw domainError('ValidationFailed', `gzip decode failed (input corrupt or output exceeds ${limits.maxOutputBytes} bytes): ${String(cause)}`);
      }
      break;
    case 'deflate-raw':
      try {
        output = inflateRawSync(input, { maxOutputLength: limits.maxOutputBytes });
      } catch (cause) {
        throw domainError('ValidationFailed', `deflate decode failed (input corrupt or output exceeds ${limits.maxOutputBytes} bytes): ${String(cause)}`);
      }
      break;
  }
  if (output.length > limits.maxOutputBytes) {
    // 上限超過は部分値を返さず失敗として扱う。
    throw domainError('ValidationFailed', `${name}: output exceeds ${limits.maxOutputBytes} bytes`);
  }
  return output;
}

/** 未登録 codec は validation error (F06-UT-001)。limits は全 codec へ適用する。 */
export class CodecRegistry {
  private readonly limits: CodecLimits;

  constructor(limits: CodecLimits = CODEC_DEFAULT_LIMITS) {
    this.limits = limits;
  }

  has(name: string): name is CodecName {
    return ['base64', 'url', 'hex', 'html-entity', 'gzip', 'deflate-raw'].includes(name);
  }

  decode(name: string, input: Buffer): Buffer {
    if (!this.has(name)) {
      throw domainError('ValidationFailed', `codec not registered: ${name}`);
    }
    return decodeWithLimits(name, input, this.limits);
  }
}

/** pipeline は宣言順に decode する (F06-UT-002)。 */
export function transformPipeline(registry: CodecRegistry, input: Buffer, names: readonly string[]): Buffer {
  let current = input;
  for (const name of names) {
    current = registry.decode(name, current);
  }
  return current;
}

export interface CompareOptions {
  readonly normalizeNewlines?: boolean;
  readonly ignoreHeaderOrder?: boolean;
}

export interface TextDiff {
  readonly equal: boolean;
  readonly leftLineCount: number;
  readonly rightLineCount: number;
  readonly differingLines: readonly { readonly line: number; readonly left: string; readonly right: string }[];
}

/** LF/CRLF 正規化 option で差分が変わる (F06-UT-004)。 */
export function compareText(left: string, right: string, options: CompareOptions = {}): TextDiff {
  const normalize = (value: string): string => (options.normalizeNewlines === true ? value.replace(/\r\n/g, '\n') : value);
  const leftLines = normalize(left).split('\n');
  const rightLines = normalize(right).split('\n');
  const differingLines: { line: number; left: string; right: string }[] = [];
  const max = Math.max(leftLines.length, rightLines.length);
  for (let line = 0; line < max; line += 1) {
    const l = leftLines[line] ?? '';
    const r = rightLines[line] ?? '';
    if (l !== r) {
      differingLines.push({ line: line + 1, left: l, right: r });
    }
  }
  return { equal: differingLines.length === 0, leftLineCount: leftLines.length, rightLineCount: rightLines.length, differingLines };
}

export interface HttpMessageShape {
  readonly startLine: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

/** raw 比較と header 順を無視した semantic 比較を分離して返す (F06-UT-005)。 */
export function compareHttpMessages(left: HttpMessageShape, right: HttpMessageShape): {
  readonly raw: TextDiff;
  readonly semantic: { readonly equal: boolean };
} {
  const render = (message: HttpMessageShape): string =>
    `${message.startLine}\n${message.headers.map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${message.body}`;
  const semanticKey = (message: HttpMessageShape): string =>
    `${message.startLine}\n${[...message.headers].sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)).map(([name, value]) => `${name.toLowerCase()}: ${value}`).join('\n')}\n\n${message.body}`;
  return {
    raw: compareText(render(left), render(right)),
    semantic: { equal: semanticKey(left) === semanticKey(right) },
  };
}

export interface BinaryCompareSummary {
  readonly equal: boolean;
  readonly leftBytes: number;
  readonly rightBytes: number;
  readonly firstDifferenceOffset: number | null;
  readonly commonPrefixBytes: number;
}

/** 大容量でも full matrix を作らず bounded な要約を返す (F06-UT-006)。 */
export function compareBinary(left: Buffer, right: Buffer): BinaryCompareSummary {
  const common = Buffer.compare(left.subarray(0, Math.min(left.length, right.length)), right.subarray(0, Math.min(left.length, right.length)));
  let firstDifferenceOffset: number | null = null;
  if (common !== 0) {
    const max = Math.min(left.length, right.length);
    for (let offset = 0; offset < max; offset += 1) {
      if (left[offset] !== right[offset]) {
        firstDifferenceOffset = offset;
        break;
      }
    }
    if (firstDifferenceOffset === null && left.length !== right.length) {
      firstDifferenceOffset = max;
    }
  }
  return {
    equal: common === 0 && left.length === right.length,
    leftBytes: left.length,
    rightBytes: right.length,
    firstDifferenceOffset,
    commonPrefixBytes: firstDifferenceOffset ?? Math.min(left.length, right.length),
  };
}

export interface DiffProvenance {
  readonly leftHash: string;
  readonly rightHash: string;
  readonly options: CompareOptions;
}

/** 比較結果は元 artifact hash と option を持つ (F06-UT-007)。 */
export function provenanceOf(left: Buffer, right: Buffer, options: CompareOptions): DiffProvenance {
  return {
    leftHash: hashStable('scopepilot2.artifact', new TextDecoder().decode(left)),
    rightHash: hashStable('scopepilot2.artifact', new TextDecoder().decode(right)),
    options,
  };
}
