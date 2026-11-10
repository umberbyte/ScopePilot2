import type { BrowserContext, Page } from 'playwright';
import { ScopePolicy } from '@scopepilot2/core';

/** Chromium-only auth contexts; no popup/worker can acquire a separate unguarded page. */
export async function enforceAuthenticationContext(context: BrowserContext, page: Page, scope: { readonly allowedOrigins: readonly string[]; readonly deniedOrigins: readonly string[] }): Promise<void> {
  await context.route('**/*', async (route) => {
    let allowed = false;
    try { allowed = route.request().frame().page() === page && ScopePolicy.decide(scope, route.request().url()).allowed; } catch { /* deny requests without a guarded frame */ }
    if (allowed) await route.continue();
    else await route.abort('blockedbyclient');
  });
  await context.routeWebSocket(/.*/, async (socket) => {
    const target = socket.url().replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
    if (ScopePolicy.decide(scope, target).allowed) socket.connectToServer();
    else await socket.close({ code: 1008, reason: 'blocked by scope' });
  });
  // Playwright routing only pauses the first URL in an HTTP redirect chain.
  // A separate Chromium request-stage interceptor checks every redirect hop.
  const session = await context.newCDPSession(page);
  session.on('Fetch.requestPaused', (event) => {
    let allowed = false;
    try { allowed = ScopePolicy.decide(scope, event.request.url).allowed; } catch { /* deny malformed URLs */ }
    void session.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed
      ? { requestId: event.requestId }
      : { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
  });
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}
