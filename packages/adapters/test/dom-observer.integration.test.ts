import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, test } from 'node:test';
import { PlaywrightDomObserver } from '../src/dom-observer.ts';
import { startVulnerableTarget } from './vulnerable-target.ts';

const gated = process.env['SCOPEPILOT_PLAYWRIGHT_IT'] === '1' ? describe : describe.skip;

gated('PlaywrightDomObserver (real browser integration)', () => {
  test('init script observes an owned query source reaching innerHTML', { timeout: 120_000 }, async () => {
    const target = await startVulnerableTarget();
    let outOfScopeRequests = 0;
    const outOfScopeServer = createServer((_request, response) => {
      outOfScopeRequests += 1;
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve) => outOfScopeServer.listen(0, '127.0.0.1', resolve));
    const externalAddress = outOfScopeServer.address();
    if (externalAddress === null || typeof externalAddress === 'string') {
      throw new Error('expected out-of-scope server address');
    }
    try {
      const observer = new PlaywrightDomObserver({ settleMs: 25 });
      const result = await observer.observe({
        targetUrl: `${target.domUrl}&external=${encodeURIComponent(`http://127.0.0.1:${externalAddress.port}/pixel`)}`,
        scope: { allowedOrigins: [target.base], deniedOrigins: [] },
      });
      assert.ok(result.observations.some((event) => event.api === 'location.search' && event.marker === 'scopepilot-dom-marker'));
      assert.ok(result.observations.some((event) => event.api === 'innerHTML' && event.marker === 'scopepilot-dom-marker'));
      assert.deepEqual(result.nodes, [], 'raw DOM text is not exported by the initial real path');
      assert.equal(outOfScopeRequests, 0, 'out-of-scope subresources are aborted before network send');
    } finally {
      target.server.close();
      outOfScopeServer.close();
    }
  });
});
