import { hashStable } from '@scopepilot2/contracts';
import { TokenIssuer, type BaselineFlowDeps } from '@scopepilot2/core';

/** Explicit adapters for simulation composition and unit test factories only. */
export function createFixtureToolAdapters() {
  const issuer = new TokenIssuer();
  return {
    repeaterTransport: { adapterKind: 'fixture', version: 'fixture-tools-v1', async send(input) {
      return { status: 200, headers: [['content-type', 'text/html']], body: Buffer.from(`<html><body>fixture response for ${new URL(input.targetUrl).pathname}</body></html>`), redirectLocations: [] };
    } },
    fuzzTransport: { adapterKind: 'fixture', version: 'fixture-tools-v1', async send(input) {
      const body = `resp:${input.combination[0] ?? ''}`;
      return { requestUrl: input.targetUrl, status: 200, contentType: 'text/plain', contentLength: body.length, bodyHash: hashStable('scopepilot2.fuzz.body', body) };
    } },
    sequencerTransport: { adapterKind: 'fixture', version: 'fixture-tools-v1', async collect(input) {
      const extractor = input.extractor ?? { source: 'body' as const };
      for (let index = 0; index < input.samples; index += 1) {
        if (input.signal?.aborted) throw new Error('cancelled');
        if (input.signal !== undefined) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (input.signal?.aborted) throw new Error('cancelled');
        }
        let token: string | undefined;
        if (input.targetUrl.includes('no-token') && index % 5 === 4) {
          token = undefined;
        } else if (input.targetUrl.includes('fixed')) {
          token = 'fixed-token-value';
        } else {
          token = `sample-${index.toString(36)}-${(index * 7 + 3).toString(36)}`;
        }
        const response = extractor.source === 'cookie'
          ? {
              body: 'cookie token response',
              ...(token === undefined ? {} : { setCookieHeaders: [`${extractor.cookieName}=${token}; Path=/; HttpOnly`] }),
            }
          : extractor.source === 'hidden'
            ? { body: token === undefined ? '<form></form>' : `<form><input value="${token}" name="${extractor.fieldName}" type="hidden"></form>` }
            : extractor.source === 'bearer'
              ? { body: 'bearer token response', ...(token === undefined ? {} : { authorizationHeader: `Bearer ${token}` }) }
              : extractor.source === 'custom'
                ? { body: token === undefined ? 'no token in this response' : `${extractor.startDelimiter}${token}${extractor.endDelimiter}` }
                : { body: token === undefined ? 'no token in this response' : `token=${token}` };
        input.onResponse({ ...response, requestUrl: input.targetUrl, status: 200, contentType: 'text/plain' });
      }
    } },
    oastProvider: { adapterKind: 'fixture', version: 'fixture-tools-v1', supportedProtocols: ['http', 'dns'], async startSession(input) { return issuer.issue(input.attemptId); } },
    webSocketTransport: { adapterKind: 'fixture', version: 'fixture-tools-v1', async exchange(input) {
      for (const message of input.messages) input.onSentFrame(message);
      return { sent: input.messages.length };
    } },
    advancedTransport: { adapterKind: 'fixture', version: 'fixture-tools-v1', async probe(input) {
      const h1 = input.requested === 'http/1.1' || input.targetUrl.includes('h1-only');
      return { offered: h1 ? ['http/1.1'] : ['h2'], alpn: input.requested === 'http/1.1' ? 'http/1.1 (explicit)' : h1 ? 'http/1.1' : 'h2', runtime: 'fixture-transport' };
    } },
  } satisfies Pick<BaselineFlowDeps, 'repeaterTransport' | 'fuzzTransport' | 'sequencerTransport' | 'oastProvider' | 'webSocketTransport' | 'advancedTransport'>;
}
