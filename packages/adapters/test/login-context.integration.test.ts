import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { PlaywrightLoginExecutor } from '../src/login-executor.ts';
import { PlaywrightInteractiveBrowser } from '../src/interactive-browser.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TCP address expected');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('live browser login enforces context for form submits, subrequests and redirects', { skip: process.env['SCOPEPILOT_PLAYWRIGHT_IT'] !== '1' }, async () => {
  let deniedHits = 0;
  const denied = createServer((_request, response) => { deniedHits += 1; response.end('outside'); });
  const deniedOrigin = await listen(denied);
  const target = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/redirect') { response.writeHead(302, { Location: `${deniedOrigin}/outside` }); response.end(); return; }
    if (request.url === '/chain') { response.writeHead(302, { Location: '/redirect' }); response.end(); return; }
    if (request.url === '/allowed') { response.writeHead(302, { Location: '/home' }); response.end(); return; }
    if (request.url === '/home') { response.setHeader('Set-Cookie', 'sid=private-session; Path=/'); response.end('Welcome'); return; }
    response.end(`<form method="post" action="/home"><input id="user"><input id="pass" type="password"><button type="submit">Login</button></form><img src="${deniedOrigin}/pixel"><script>fetch('${deniedOrigin}/request').catch(()=>{})</script>`);
  });
  const origin = await listen(target);
  const executor = new PlaywrightLoginExecutor();
  const scope = { allowedOrigins: [origin, deniedOrigin], deniedOrigins: [deniedOrigin] };
  try {
    const login = await executor.execute({ scope, baseUrl: origin, expectedUrlPrefix: `${origin}/home`, secretValues: { user: 'alice', pass: 'private-password' }, steps: [
      { kind: 'navigate', target: '/' }, { kind: 'fill', target: '#user', secretReference: 'user' },
      { kind: 'fill', target: '#pass', secretReference: 'pass' }, { kind: 'click', target: 'button' }, { kind: 'assert', target: 'Welcome' },
    ] });
    assert.equal(login.authenticated, true);
    assert.equal(login.cookies[0]?.name, 'sid');
    assert.equal(deniedHits, 0);
    const allowed = await executor.execute({ scope, baseUrl: origin, expectedUrlPrefix: `${origin}/home`, secretValues: {}, steps: [{ kind: 'navigate', target: '/allowed' }, { kind: 'assert', target: 'Welcome' }] });
    assert.equal(allowed.authenticated, true);
    await executor.execute({ scope, baseUrl: origin, expectedUrlPrefix: origin, secretValues: {}, steps: [{ kind: 'navigate', target: '/chain' }] }).catch(() => null);
    assert.equal(deniedHits, 0);
    const redirected = await executor.execute({ scope, baseUrl: origin, expectedUrlPrefix: origin, secretValues: {}, steps: [{ kind: 'navigate', target: '/redirect' }] }).catch(() => null);
    assert.notEqual(redirected?.authenticated, true);
    assert.equal(deniedHits, 0);
    const verifier = new PlaywrightInteractiveBrowser();
    const verified = await verifier.execute({ targetUrl: `${origin}/allowed`, scope, browserSession: login.browserState!, steps: [{ kind: 'navigate', target: `${origin}/allowed` }, { kind: 'assert', target: 'Welcome' }] });
    assert.equal(verified.assertions[0]?.passed, true);
    await verifier.execute({ targetUrl: `${origin}/chain`, scope, steps: [{ kind: 'navigate', target: `${origin}/chain` }] }).catch(() => null);
    assert.equal(deniedHits, 0);
  } finally {
    await executor.close();
    await close(target); await close(denied);
  }
});
