import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readStaticAsset } from '../src/static-assets.ts';
import { PlaywrightExplorerAdapter } from '../src/playwright-explorer.ts';

async function fixture(run: (origin: string, hits: string[]) => Promise<void>) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === '/redirect.txt') { res.writeHead(302, { location: 'http://localhost:9/outside.txt' }); res.end(); return; }
    if (req.url === '/slow.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.flushHeaders(); return; }
    if (req.url === '/binary.exe') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(('ghp_' + '0123456789abcdefghijklmnopqrstuvwxyz')); return; }
    if (req.url === '/bomb.txt') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); res.end(gzipSync('a'.repeat(2 * 1024 * 1024))); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.url === '/robots.txt' ? 'Disallow: /unlinked\nSitemap: /sitemap.xml\n' : '//# sourceMappingURL=main.js.map\nimport("./chunk.js")');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`, hits); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('owned streaming asset fixture: references, provenance, redirects, MIME/extension, decompressed byte limit', async () => {
  await fixture(async (origin, hits) => {
    const scope = { allowedOrigins: [origin], deniedOrigins: [] };
    const result = await readStaticAsset({ url: `${origin}/robots.txt`, scope });
    assert.equal(result?.assets?.[0]?.url, `${origin}/robots.txt`);
    assert.ok(result?.discoveryLinks?.some((link) => link.url === `${origin}/unlinked`));
    assert.equal(await readStaticAsset({ url: `${origin}/redirect.txt`, scope }), null);
    assert.equal(await readStaticAsset({ url: `${origin}/bomb.txt`, scope }), null);
    assert.equal((await readStaticAsset({ url: `${origin}/binary.exe`, scope }))?.assets, undefined);
    const before = hits.length;
    assert.equal(await readStaticAsset({ url: `${origin}/robots.txt`, scope, control: { timeoutMs: 1000, consumeRequest: () => false } }), null);
    assert.equal(hits.length, before);
  });
});
test('owned streaming asset fixture stops an in-flight body and rejects denied origins without sending', async () => {
  await fixture(async (origin, hits) => {
    const scope = { allowedOrigins: [origin], deniedOrigins: [] };
    const controller = new AbortController();
    const running = readStaticAsset({ url: `${origin}/slow.txt`, scope, control: { signal: controller.signal, timeoutMs: 10000, consumeRequest: () => true } });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(running, /abort/i);
    const before = hits.length;
    assert.equal(await readStaticAsset({ url: `${origin}/robots.txt`, scope: { ...scope, deniedOrigins: [origin] } }), null);
    assert.equal(hits.length, before);
  });
});
test('explorer facade acquires static references without launching a browser', async () => {
  await fixture(async (origin) => {
    const explorer = new PlaywrightExplorerAdapter({ scope: { allowedOrigins: [origin], deniedOrigins: [] } });
    const observation = await explorer.observe(`${origin}/robots.txt`);
    assert.equal(observation?.discoveryLinks?.[0]?.source, 'robots');
    assert.equal(explorer.engineVersionLabel, 'playwright (未起動)');
    await explorer.close();
  });
});
