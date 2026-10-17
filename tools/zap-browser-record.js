const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('./playwright-runtime/node_modules/playwright');

async function record(directory, { headless = false, fixture = false } = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'browser-config.json'), 'utf8'));
  const allowed = new Set(config.allowedOrigins.map(x => new URL(x).origin));
  const proxy = new URL(config.proxy);
  if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash)
    throw Error('A local ZAP proxy is required');
  const start = new URL(config.startUrl);
  if (!allowed.has(start.origin) || start.username || start.password) throw Error('Start URL is outside allowed origins');
  const limit = Math.min(50000, Math.max(1, config.maxRequests));
  const deadlineMs = Math.min(120, Math.max(1, config.maxMinutes)) * 60000;
  const browser = await chromium.launch({ channel: 'msedge', headless, proxy: { server: proxy.href }, args: ['--proxy-bypass-list=<-loopback>'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block',
    recordHar: { path: path.join(directory, 'browser.har'), mode: 'full', content: 'embed' } });
  const input = readline.createInterface({ input: process.stdin });
  let closeResolve, stopReason = 'browser_closed', count = 0, blocked = 0, stopRequested = false;
  const closing = new Promise(resolve => { closeResolve = resolve; });
  const stop = reason => { if (stopRequested) return; stopRequested = true; stopReason = reason; closeResolve(); };
  input.on('line', line => { if (line.trim() === 'close') stop('user_stopped'); });
  input.on('close', () => stop('input_closed'));
  const timer = setTimeout(() => stop('time_limit'), deadlineMs);
  const events = fs.createWriteStream(path.join(directory, 'browser-events.jsonl'));
  let eventSequence = 0;
  function event(kind, url) {
    try { const u = new URL(url); u.search = ''; u.hash = '';
      events.write(JSON.stringify({ stepId: `manual-${++eventSequence}`, kind, url: u.href, at: new Date().toISOString(), roleLabel: config.role, identityVerified: false }) + '\n');
    } catch { /* Internal browser URLs are not target evidence. */ }
  }
  await context.route('**/*', async route => {
    let url; try { url = new URL(route.request().url()); } catch { blocked++; return route.abort(); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !allowed.has(url.origin)) { blocked++; return route.abort(); }
    if (++count > limit) { stop('request_limit'); return route.abort(); }
    return route.continue();
  });
  await context.routeWebSocket(/.*/, socket => { blocked++; socket.close(); });
  context.on('response', response => event('response', response.url()));
  context.on('page', page => {
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) event('navigation', frame.url()); });
    page.on('close', () => { if (context.pages().length === 0) stop('browser_closed'); });
  });
  browser.on('disconnected', () => stop('browser_disconnected'));
  let traced = false, failed = false;
  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    traced = true;
    const page = await context.newPage();
    await page.goto(config.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    process.stdout.write('BROWSER_READY\n');
    if (fixture) { await page.waitForTimeout(500); stop('fixture_completed'); } else await closing;
  } catch { failed = true; stopReason = 'browser_error'; throw Error('Playwright browser recording failed; inspect local trace'); }
  finally {
    clearTimeout(timer); input.close();
    if (traced) { try { await context.tracing.stop({ path: path.join(directory, 'browser-trace.zip') }); } catch { failed = true; stopReason = 'trace_incomplete'; } }
    try { await context.close(); } catch { failed = true; stopReason = 'har_incomplete'; }
    await browser.close();
    await new Promise(resolve => events.end(resolve));
    fs.writeFileSync(path.join(directory, 'browser-summary.json'), JSON.stringify({ status: failed ? 'failed' : 'recorded', stopReason,
      requestCount: Math.min(count, limit), blockedRequests: blocked, roleLabel: config.role, identityVerified: false,
      limitations: ['Identity was not verified', 'Service Workers and WebSockets were blocked', 'TLS validation was disabled for the local proxy', 'No effect oracle was run'] }, null, 2));
  }
}

if (require.main === module) record(process.argv[2], { headless: process.argv.includes('--headless'), fixture: process.argv.includes('--fixture') })
  .catch(() => { process.stderr.write('Playwright記録に失敗しました。保存済み証拠と設定を確認してください。\n'); process.exitCode = 1; });
module.exports = { record };
