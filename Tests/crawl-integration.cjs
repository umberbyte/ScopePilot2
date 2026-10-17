const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const root = process.argv[2], run = process.argv[3];
const { chromium } = require(path.join(root, 'tools/playwright-runtime/node_modules/playwright'));
const policy = require(path.join(root, 'tools/crawl-policy'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 400; i++) { const value = fn(); if (value) return value; await sleep(100); } throw Error('Timed out'); }
function json(name) { try { return JSON.parse(fs.readFileSync(path.join(run, name))); } catch { return null; } }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
const requested = [], formBodies = [], modules = Array.from({ length: 18 }, (_, i) => `/module-${i}/`);
const logout = '<a href="/logout">Logout</a>';
let origin;
const site = http.createServer(async (req, res) => {
  requested.push(req.method + ' ' + req.url);
  if (req.url === '/robots.txt' || req.url === '/sitemap.xml') { res.writeHead(404); res.end(); return; }
  if (req.url === '/login' && req.method === 'POST') {
    for await (const chunk of req) { /* Only local fixture credentials, never recorded. */ }
    res.writeHead(302, { 'Set-Cookie': 'fixtureSession=ok; HttpOnly; Path=/', Location: '/' }); res.end(); return;
  }
  if (req.url === '/login') { res.end('<title>Login</title><form action="/login" method="post"><input name="username"><input name="password" type="password"><button>Login</button></form>'); return; }
  if (!(req.headers.cookie || '').includes('fixtureSession=ok')) { res.writeHead(302, { Location: '/login' }); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/') res.end('<title>Home</title>' + logout + modules.map((u, i) => `<a href="${u}">Feature ${i}</a>`).join('') + '<a href="/reset">Reset DB</a>' + '<a href="/download">Reset</a>');
  else if (modules.includes(req.url)) res.end('<title>Feature</title>' + logout + '<a href="/nested">Details</a><form action="/mutation" method="post"><input name="username"><input type="password" name="password"><button>Change</button></form>');
  else if (req.url === '/nested') res.end('<title>Details</title>' + logout + '<form action="/search" method="post"><input name="query"><button>Search</button></form>');
  else if (req.url === '/search' && req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    formBodies.push(Buffer.concat(chunks).toString('utf8'));
    res.end('<title>Search</title>done'); return;
  }
  else { res.writeHead(404); res.end(); }
});
const proxy = http.createServer((req, res) => {
  const u = new URL(req.url);
  if (u.origin !== origin) { res.writeHead(403); res.end(); return; }
  const next = http.request(u, { method: req.method, headers: req.headers }, incoming => { res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res); });
  next.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(next);
});
let worker, mcp, attached;
(async () => {
  assert.equal(policy.reason('http://fixture/module-upload/', 'File Upload'), null);
  assert.equal(policy.reason('http://fixture/normal', 'Reset DB'), 'state-changing-link');
  assert.equal(policy.outcome({ pages: 0 }), 'failed');
  assert.equal(policy.isLogin({ url: 'http://fixture/normal', title: 'Feature', password: true, user: true, authenticatedIndicator: true }), false);
  origin = await listen(site); const proxyUrl = await listen(proxy);
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'engagement.json'), JSON.stringify({ StartUrl: origin + '/', allowedOrigins: [origin], supportingOrigins: [], activeRole: '未認証', forbiddenActions: ['ログアウト'], limits: { MaxPages: 100, MaxRequests: 500, MaxMinutes: 5 } }));
  fs.writeFileSync(path.join(run, 'exploration-proxy.json'), JSON.stringify({ provider: 'Fixture', url: proxyUrl }));
  worker = spawn(process.execPath, [path.join(root, 'tools/fast-crawl.js'), run, '--interactive', '--headless'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', done = false;
  worker.stdout.on('data', b => { output += b.toString(); if (output.includes('CRAWL_DONE ')) done = true; });
  worker.stderr.on('data', b => { output += b.toString(); });
  worker.on('exit', code => { if (!done) output += `EARLY_EXIT ${code}`; });
  const pending = await until(() => json('human-intervention.json'));
  fs.writeFileSync(path.join(run, 'resume.signal'), JSON.stringify({ requestId: 'STALE-ID', activeRole: 'User' }));
  await sleep(500);
  assert.equal(json('human-intervention.json').requestId, pending.requestId);
  const runtime = json('browser-runtime.json');
  attached = await chromium.connectOverCDP(runtime.cdpEndpoint);
  const page = attached.contexts()[0].pages().find(p => p.url().includes('/login'));
  await page.locator('[name=username]').fill('fixture-user');
  await page.locator('[name=password]').fill('fixture-password');
  await page.locator('button').click();
  await page.waitForURL(origin + '/');
  fs.writeFileSync(path.join(run, 'resume.signal'), JSON.stringify({ requestId: pending.requestId, activeRole: 'User', confirmedAt: new Date(), verifyNavigation: true }));
  try { await until(() => done || output.includes('EARLY_EXIT') ? true : false); } catch (e) { throw Error(e.message + '\n' + output); }
  assert.ok(done, output);
  const summary = json('fast-crawl-summary.json');
  assert.equal(summary.status, 'completed', output);
  assert.equal(summary.activeRole, 'User');
  assert.equal(summary.visitedPageCount, 21); // login + authenticated home + 18 visible features + nested page
  for (const url of modules) assert.ok(requested.includes('GET ' + url), url);
  assert.ok(requested.includes('GET /nested'));
  assert.ok(!requested.some(x => /reset|download|mutation|logout/.test(x)));
  assert.equal(json('authentication-navigation.json').status, 'authenticated');
  assert.ok(!fs.existsSync(path.join(run, 'human-intervention.json')));
  assert.ok(json('crawl-coverage.json').pages.some(x => x.url.endsWith('/reset') && x.status === 'skipped'));
  // MCP must inspect this existing browser without creating a second login session.
  mcp = spawn(process.execPath, [path.join(root, 'tools/playwright-runtime/node_modules/@playwright/mcp/cli.js'), '--cdp-endpoint', runtime.cdpEndpoint, '--output-dir', path.join(run, 'mcp')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  readline.createInterface({ input: mcp.stdout }).on('line', line => { try { const j = JSON.parse(line); if (j.id) replies.set(j.id, j); } catch { } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }) + '\n');
  assert.ok((await until(() => replies.get(1))).result);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } }) + '\n');
  const snapshot = await until(() => replies.get(2));
  assert.ok(!snapshot.result.isError, JSON.stringify(snapshot));
  assert.ok(JSON.stringify(snapshot).includes('Logout'));
  mcp.kill();
  await attached.close(); attached = null;
  worker.stdin.write('close\n');
  await new Promise(resolve => worker.once('exit', resolve));
  assert.ok(fs.existsSync(path.join(run, 'fast-capture.har')));
  assert.equal(json('browser-runtime.json').status, 'stopped');
  const observations = fs.readFileSync(path.join(run, 'observed-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(observations.some(x => x.url === origin + '/' && x.role === 'User'));
  assert.ok(observations.some(x => x.method === 'POST' && x.role === '未認証'));
  assert.ok(!JSON.stringify(observations).includes('fixture-password'));
  console.log('PASS: manual login, matching resume, 18 visible features, nested page, skip mutation, same-session MCP, HAR flush');

  // Phase 2: opt-in form submission records one harmless POST and still skips credential forms.
  const run2 = run + '-forms';
  const json2 = name => { try { return JSON.parse(fs.readFileSync(path.join(run2, name))); } catch { return null; } };
  fs.mkdirSync(run2, { recursive: true });
  fs.writeFileSync(path.join(run2, 'engagement.json'), JSON.stringify({ StartUrl: origin + '/', allowedOrigins: [origin], supportingOrigins: [], activeRole: '未認証', forbiddenActions: ['ログアウト'], crawlFormSubmissions: true, limits: { MaxPages: 100, MaxRequests: 500, MaxMinutes: 5 } }));
  fs.writeFileSync(path.join(run2, 'exploration-proxy.json'), JSON.stringify({ provider: 'Fixture', url: proxyUrl }));
  worker = spawn(process.execPath, [path.join(root, 'tools/fast-crawl.js'), run2, '--interactive', '--headless'], { stdio: ['pipe', 'pipe', 'pipe'] });
  output = ''; done = false;
  worker.stdout.on('data', b => { output += b.toString(); if (output.includes('CRAWL_DONE ')) done = true; });
  worker.stderr.on('data', b => { output += b.toString(); });
  const pending2 = await until(() => json2('human-intervention.json'));
  attached = await chromium.connectOverCDP(json2('browser-runtime.json').cdpEndpoint);
  const page2 = attached.contexts()[0].pages().find(p => p.url().includes('/login'));
  await page2.locator('[name=username]').fill('fixture-user');
  await page2.locator('[name=password]').fill('fixture-password');
  await page2.locator('button').click();
  await page2.waitForURL(origin + '/');
  fs.writeFileSync(path.join(run2, 'resume.signal'), JSON.stringify({ requestId: pending2.requestId, activeRole: 'User', confirmedAt: new Date(), verifyNavigation: true }));
  try { await until(() => done || output.includes('EARLY_EXIT') ? true : false); } catch (e) { throw Error(e.message + '\n' + output); }
  assert.ok(done, output);
  const summary2 = json2('fast-crawl-summary.json');
  assert.equal(summary2.status, 'completed', output);
  assert.equal(summary2.visitedPageCount, 21);
  assert.ok(summary2.formSubmissions.enabled, 'form submissions must be reported');
  assert.ok(summary2.formSubmissions.succeeded >= 1, JSON.stringify(summary2.formSubmissions));
  assert.ok(requested.includes('POST /search'), 'POST /search must be sent once');
  assert.ok(!requested.includes('POST /mutation'), 'credential form must never be submitted');
  assert.ok(formBodies.some(body => body.includes('query=') && body.includes('ScopePilot')), formBodies.join(' | '));
  assert.ok(summary2.formSubmissions.skipped.some(x => x.url.endsWith('/mutation') && x.reason === 'credential-or-upload-form'), JSON.stringify(summary2.formSubmissions.skipped));
  const observations2 = fs.readFileSync(path.join(run2, 'observed-requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(observations2.some(x => x.method === 'POST' && x.url === origin + '/search' && x.role === 'User'), JSON.stringify(observations2));
  worker.stdin.write('close\n');
  await new Promise(resolve => worker.once('exit', resolve));
  assert.ok(fs.existsSync(path.join(run2, 'fast-capture.har')));
  console.log('PASS: opt-in form submission records one harmless POST and skips credential forms');
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => {
  if (mcp) mcp.kill(); if (attached) await attached.close().catch(() => {});
  if (worker && worker.exitCode === null) {
    worker.stdin.write('close\n');
    await Promise.race([new Promise(resolve => worker.once('exit', resolve)), sleep(6000)]);
    if (worker.exitCode === null) worker.kill();
  }
  proxy.closeAllConnections(); site.closeAllConnections(); proxy.close(); site.close();
});
