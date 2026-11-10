import { TokenIssuer } from '@scopepilot2/core';
import { hashStable } from '@scopepilot2/contracts';
import type { FuzzTransportPort, OastProviderPort, RepeaterTransportPort, SequencerTransportPort, WebSocketTransportPort } from '@scopepilot2/core';
/** Explicit deterministic adapters for simulation/test composition only. */
export function toolFixtures() {
    const repeaterTransport: RepeaterTransportPort = { adapterKind: 'fixture', async send({ targetUrl }) {
            return { status: 200, headers: [['content-type', 'text/html']], body: Buffer.from(`<html><body>fixture response for ${new URL(targetUrl).pathname}</body></html>`), redirectLocations: [] };
        } };
    const fuzzTransport: FuzzTransportPort = { adapterKind: 'fixture', async send({ targetUrl, combination }) {
            const body = `resp:${combination[0] ?? ''}`;
            return { requestUrl: targetUrl, status: 200, contentType: 'text/html', contentLength: body.length, bodyHash: hashStable('scopepilot2.fuzz.body', body) };
        } };
    const sequencerTransport: SequencerTransportPort = { adapterKind: 'fixture', async collect(input) {
            for (let index = 0; index < input.samples; index += 1) {
                if (input.signal !== undefined)
                    await new Promise<void>(resolve => setImmediate(resolve));
                if (input.signal?.aborted)
                    throw new Error('cancelled');
                const token = input.targetUrl.includes('no-token') && index % 5 === 4 ? undefined : input.targetUrl.includes('fixed') ? 'fixed-token-value' : `sample-${index.toString(36)}-${(index * 7 + 3).toString(36)}`;
                input.onResponse({ requestUrl: input.targetUrl, status: 200, contentType: 'text/html', body: token === undefined ? 'no token in this response' : `token=${token} <input value="${token}" name="csrf_token" type="hidden"> token="${token}"`, ...(token === undefined ? {} : { setCookieHeaders: [`SEQ_TOKEN=${token}; Path=/; HttpOnly`], authorizationHeader: `Bearer ${token}` }) });
            }
        } };
    const issuer = new TokenIssuer();
    const oastProvider: OastProviderPort = { adapterKind: 'fixture', supportedProtocols: ['http', 'dns'], async startSession({ attemptId }) { return issuer.issue(attemptId); } };
    const webSocketTransport: WebSocketTransportPort = { adapterKind: 'fixture', async exchange(input) {
            for (const message of input.messages)
                input.onSentFrame(message);
            return { sent: input.messages.length };
        } };
    return { repeaterTransport, fuzzTransport, sequencerTransport, oastProvider, webSocketTransport };
}
