/**
 * ワークフロー診断の HTTP 輸送実装。`core/domain/workflow-scan.ts` の輸送契約に対し、
 * Node の fetch（手動リダイレクト）で動く。Cookie 管理・要求数上限・証跡ログの伏せ字を担う。
 * design/22-execution-control: ここで発信する通信は ScopePilot 自身の送信のため、
 * baseUrl の Origin 固定（送信前 scope 強制）と要求数上限を輸送層で保証する。
 */
import type {
  WorkflowScanRequestLogEntry,
  WorkflowScanRequestSpec,
  WorkflowScanHttpResponse,
  WorkflowScanTransport,
} from '@scopepilot2/core';

export interface NodeWorkflowScanTransportOptions {
  readonly baseUrl: string;
  readonly maxRequests?: number;
  readonly requestTimeoutMs?: number;
  /** 証跡ログへ出してはならない値（パスワード・一時パスワード等）。 */
  readonly redactionValues?: readonly string[];
  readonly signal?: AbortSignal;
}

const MAX_BODY_LOG = 600;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class NodeWorkflowScanTransport implements WorkflowScanTransport {
  readonly baseUrl: string;
  private readonly maxRequests: number;
  private readonly requestTimeoutMs: number;
  private readonly redactionValues: string[];
  private readonly signal: AbortSignal | undefined;
  private readonly cookies = new Map<string, string>();
  private readonly log: WorkflowScanRequestLogEntry[] = [];
  private count = 0;

  constructor(options: NodeWorkflowScanTransportOptions) {
    this.baseUrl = options.baseUrl.trimEnd().replace(/\/$/, '');
    this.maxRequests = options.maxRequests ?? 2000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.redactionValues = [...(options.redactionValues ?? [])]
      .filter((value) => value.trim() !== '')
      .sort((a, b) => b.length - a.length);
    this.signal = options.signal;
  }

  get requestCount(): number {
    return this.count;
  }

  takeRequestLog(): WorkflowScanRequestLogEntry[] {
    const entries = [...this.log];
    this.log.length = 0;
    return entries;
  }

  async request(spec: WorkflowScanRequestSpec): Promise<WorkflowScanHttpResponse> {
    if (this.count >= this.maxRequests) {
      throw new Error(`workflow scan request limit reached (${String(this.maxRequests)})`);
    }
    const target = new URL(spec.path.replace(/^\//, ''), `${this.baseUrl}/`);
    if (target.origin !== new URL(`${this.baseUrl}/`).origin) {
      throw new Error(`workflow scan request out of scope: ${target.origin}`);
    }
    this.count += 1;
    let body: string | undefined;
    let contentType: string | undefined;
    if (spec.form !== undefined) {
      body = new URLSearchParams(spec.form).toString();
      contentType = 'application/x-www-form-urlencoded';
    } else if (spec.json !== undefined) {
      body = spec.json;
      contentType = 'application/json';
    } else if (spec.multipart !== undefined) {
      const built = buildMultipart(spec.multipart);
      body = built.body;
      contentType = built.contentType;
    }
    const headers: Record<string, string> = {};
    if (contentType !== undefined) {
      headers['content-type'] = contentType;
    }
    if (this.cookies.size > 0) {
      headers['cookie'] = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    headers['referer'] = `${this.baseUrl}/index.php`;
    headers['user-agent'] = 'ScopePilot2-WorkflowScan/1.0';
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signals = this.signal === undefined ? [timeout] : [timeout, this.signal];
    const response = await fetch(target, {
      method: spec.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      signal: AbortSignal.any(signals),
    });
    const bodyText = (await readBounded(response, MAX_RESPONSE_BYTES)) ?? '';
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(';', 2)[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator > 0) {
        this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
    const result: WorkflowScanHttpResponse = {
      status: response.status,
      body: bodyText,
      location: response.headers.get('location') ?? '',
      contentType: response.headers.get('content-type') ?? '',
      contentSecurityPolicy: response.headers.get('content-security-policy') ?? '',
      setCookies: response.headers.getSetCookie().map((value) => (value.split(';', 2)[0] ?? '').trim()),
    };
    this.log.push({
      method: spec.method,
      url: this.redact(`${target.pathname}${target.search}`),
      status: result.status,
      location: this.redact(result.location),
      requestPreview: this.preview(body ?? ''),
      responsePreview: this.preview(bodyText),
    });
    return result;
  }

  private preview(value: string): string {
    const text = value.length > MAX_BODY_LOG ? `${value.slice(0, MAX_BODY_LOG)}…(切り詰め)` : value;
    return this.redact(text).replace(/\r?\n/g, ' ');
  }

  /** クエリ文字列・リダイレクト先にも認証情報が現れるため、長さに関係なく伏せ字化する。 */
  private redact(value: string): string {
    let text = value;
    for (const secret of this.redactionValues) {
      text = text.split(secret).join('*****');
    }
    return text;
  }
}

function buildMultipart(part: {
  readonly fieldName: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly fields: Readonly<Record<string, string>>;
}): { body: string; contentType: string } {
  const boundary = `scopepilot-${Math.random().toString(16).slice(2, 18)}`;
  const head: string[] = [];
  for (const [name, value] of Object.entries(part.fields)) {
    head.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  head.push(`--${boundary}\r\nContent-Disposition: form-data; name="${part.fieldName}"; filename="${part.fileName}"\r\n`);
  head.push(`Content-Type: ${part.contentType}\r\n\r\n`);
  const textEncoder = new TextEncoder();
  const headBytes = textEncoder.encode(head.join(''));
  const tailBytes = textEncoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(headBytes.length + part.bytes.length + tailBytes.length);
  body.set(headBytes, 0);
  body.set(part.bytes, headBytes.length);
  body.set(tailBytes, headBytes.length + part.bytes.length);
  return {
    body: new TextDecoder('latin1').decode(body),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function readBounded(response: Response, limit: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return response.text();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done === true) {
      break;
    }
    if (value !== undefined) {
      chunks.push(value);
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        break;
      }
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}
