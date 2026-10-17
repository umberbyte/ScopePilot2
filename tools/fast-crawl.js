const fs = require('fs');
const path = require('path');
const net = require('net');
const readline = require('readline');
const crypto = require('crypto');
const { chromium } = require('./playwright-runtime/node_modules/playwright');
const policy = require('./crawl-policy');
const runDirectory = process.argv[2];
if (!runDirectory) throw Error('run directory is required');
const interactive = process.argv.includes('--interactive');
const headless = !interactive || process.argv.includes('--headless');
const engagement = JSON.parse(fs.readFileSync(path.join(runDirectory, 'engagement.json'), 'utf8'));
const proxyRuntime = JSON.parse(fs.readFileSync(path.join(runDirectory, 'exploration-proxy.json'), 'utf8'));
const proxy = new URL(proxyRuntime.url);
if (proxy.protocol !== 'http:' || !(proxy.hostname.startsWith('127.') || ['localhost', '[::1]'].includes(proxy.hostname)) || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw Error('local HTTP exploration proxy is required');
const allowed = new Set(engagement.allowedOrigins.map(x => new URL(x).origin));
const supporting = new Set((engagement.supportingOrigins || []).map(x => new URL(x).origin));
const startUrl = policy.normalizeUrl(engagement.StartUrl);
if (!allowed.has(new URL(startUrl).origin)) throw Error('Start URL origin/port is outside allowed origins');
if (engagement.afterAuthenticationUrl && !allowed.has(new URL(engagement.afterAuthenticationUrl).origin)) throw Error('Authentication target is outside allowed origins');
const startedAt = new Date();
const deadline = Date.now() + Math.max(1, Math.floor(engagement.limits.MaxMinutes * 0.7)) * 60000;
const maxPages = engagement.limits.MaxPages, maxRequests = engagement.limits.MaxRequests;
if (!(maxPages > 0 && maxRequests > 0 && engagement.limits.MaxMinutes > 0)) throw Error('Invalid crawl limits');
const queue = [], queued = new Set(), visited = new Set(), pages = [], coverage = new Map(), requests = new Map(), requestRoles = new WeakMap(), skipped = [];
let currentRole = '未認証', manualAuthentication = false, authenticationBlocked = false, errorCount = 0, requestCount = 0, failureCode = null;
// Form submission is opt-in (engagement.crawlFormSubmissions): each selected form is submitted
// once with harmless placeholder values so its exchange lands in the HAR for review.
const formSubmissionLimit = engagement.crawlFormSubmissions ? Math.max(1, Math.min(25, maxPages)) : 0;
const submittedForms = new Set();
const formSubmissions = { enabled: !!engagement.crawlFormSubmissions, attempted: 0, succeeded: 0, skipped: [] };
let formSubmissionWindow = false;
let crawlComplete = false;
let context, browser, page, closeRequested = false, closeResolve;
const closeSignal = new Promise(resolve => { closeResolve = resolve; });
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => { if (line.trim() === 'close') { closeRequested = true; closeResolve(); } });
input.on('close', () => { if (interactive) { closeRequested = true; closeResolve(); } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function emit(type, value) { process.stdout.write(type + ' ' + JSON.stringify(value) + '\n'); }
function atomic(name, value) { const dest = path.join(runDirectory, name), tmp = dest + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8'); fs.renameSync(tmp, dest); }
function displayUrl(value) { const u = new URL(value); u.search = ''; u.hash = ''; u.username = ''; u.password = ''; return u.href; }
function key(url, role = currentRole) { return role + ' ' + url; }
function enqueue(value, from = '', label = '') {
  let url; try { url = policy.normalizeUrl(value); } catch { return; }
  const k = key(url);
  if (coverage.has(k)) return;
  const blocked = !allowed.has(new URL(url).origin) ? 'outside-origin' : policy.reason(url, label, engagement.forbiddenActions || []);
  coverage.set(k, { url, role: currentRole, discoveredFrom: from, label: label.slice(0, 160), status: blocked ? 'skipped' : 'queued', reason: blocked || '' });
  if (blocked) { skipped.push({ url, reason: blocked }); return; }
  queued.add(k); queue.push({ url, role: currentRole });
}
function persist() {
  const lines = [...requests.values()].map(x => JSON.stringify(x)).join('\n') + (requests.size ? '\n' : '');
  fs.writeFileSync(path.join(runDirectory, 'crawl-pages.jsonl'), pages.map(x => JSON.stringify(x)).join('\n') + (pages.length ? '\n' : ''), 'utf8');
  if (!crawlComplete) fs.writeFileSync(path.join(runDirectory, 'fast-observed-requests.jsonl'), lines, 'utf8');
  fs.writeFileSync(path.join(runDirectory, 'observed-requests.jsonl'), lines, 'utf8');
  atomic('crawl-coverage.json', { generatedAt: new Date(), pages: [...coverage.values()] });
}
async function inspect() {
  return await page.evaluate(() => {
    const forms = [...document.forms].map(f => ({ method: (f.method || 'GET').toUpperCase(), action: new URL(f.getAttribute('action') || location.href, location.href).href,
      fields: [...f.elements].map(e => e.name).filter(Boolean), hasPasswordField: [...f.elements].some(e => e.type === 'password'),
      hasFileField: [...f.elements].some(e => (e.type || '').toLowerCase() === 'file'),
      hasUserField: [...f.elements].some(e => e.type === 'email' || /user|email|login|account|identifier/i.test(`${e.name || ''} ${e.autocomplete || ''}`)) }));
    const links = [...document.querySelectorAll('a[href]')].map(a => ({ url: a.href, label: (a.textContent || '').trim() }));
    const authenticatedIndicator = links.some(l => /logout|log-out|signout|sign-out/i.test(l.url) || /ログアウト|\blog\s*out\b|\bsign\s*out\b/i.test(l.label)) || !!document.querySelector('[aria-label="User menu"], [data-authenticated="true"]');
    return { url: location.href, title: document.title, forms, links, password: forms.some(f => f.hasPasswordField), user: forms.some(f => f.hasUserField), authenticatedIndicator };
  });
}
function recordNavigation(state, status) {
  const value = { status, actualUrl: displayUrl(state.url), loginFormVisible: policy.isLogin(state), authenticatedIndicatorVisible: state.authenticatedIndicator, activeRole: currentRole, checkedAt: new Date() };
  atomic('authentication-navigation.json', value); emit('NAVIGATION', value);
}
async function authenticate(initial) {
  if (!interactive) { authenticationBlocked = true; return null; }
  manualAuthentication = true;
  try {
    while (Date.now() < deadline && !closeRequested) {
      const request = { requestId: crypto.randomUUID(), kind: 'authentication', reason: '認証画面が表示されています。', page: displayUrl(page.url()), instruction: '現在の探索ブラウザへユーザー名・パスワードを直接入力してログインし、ScopePilotで認証後のロールを選んで再開してください。' };
      atomic('human-intervention.json', request); emit('INTERVENTION', request);
      recordNavigation(await inspect(), 'waiting');
      let signal;
      while (Date.now() < deadline && !closeRequested) {
        try { const s = JSON.parse(fs.readFileSync(path.join(runDirectory, 'resume.signal'), 'utf8')); if (s.requestId === request.requestId && s.activeRole && !/未認証|^anonymous$|^guest$/i.test(s.activeRole)) { signal = s; break; } } catch { }
        await sleep(200);
      }
      if (!signal) { authenticationBlocked = true; return null; }
      let state;
      for (let i = 0; i < 20; i++) {
        if (page.isClosed()) { authenticationBlocked = true; return null; }
        for (const candidate of context.pages()) {
          if (candidate !== page && allowed.has(new URL(candidate.url()).origin)) {
            const old = page; page = candidate;
            const check = await inspect().catch(() => null);
            if (check && !policy.isLogin(check) && check.authenticatedIndicator) break;
            page = old;
          }
        }
        state = await inspect().catch(() => null);
        if (state && allowed.has(new URL(state.url).origin) && !policy.isLogin(state) && state.authenticatedIndicator) break;
        await sleep(500);
      }
      fs.rmSync(path.join(runDirectory, 'resume.signal'), { force: true });
      if (!state || !allowed.has(new URL(state.url).origin) || policy.isLogin(state) || !state.authenticatedIndicator) { recordNavigation(state || initial, 'failed'); continue; }
      currentRole = signal.activeRole;
      for (const [k, r] of [...requests]) if (r.method === 'GET' && r.url === policy.normalizeUrl(state.url)) {
        requests.delete(k); r.role = currentRole; requests.set(`${r.role} ${r.method} ${r.url}`, r);
      }
      if (engagement.afterAuthenticationUrl) {
        await page.goto(engagement.afterAuthenticationUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        state = await inspect();
        if (policy.isLogin(state) || !state.authenticatedIndicator || !allowed.has(new URL(state.url).origin)) { recordNavigation(state, 'failed'); continue; }
      }
      recordNavigation(state, 'authenticated');
      atomic('engagement.json', { ...engagement, activeRole: currentRole });
      fs.rmSync(path.join(runDirectory, 'human-intervention.json'), { force: true });
      return state;
    }
    authenticationBlocked = true; return null;
  } finally { manualAuthentication = false; }
}
async function submitForms(forms, pageUrl) {
  for (const form of forms) {
    if (submittedForms.size >= formSubmissionLimit) break;
    let actionKey;
    try { actionKey = form.method + ' ' + policy.normalizeUrl(form.action); } catch { continue; }
    if (submittedForms.has(actionKey)) continue;
    submittedForms.add(actionKey);
    const blocked = policy.reason(form.action);
    if (blocked) { formSubmissions.skipped.push({ url: form.action, reason: blocked }); continue; }
    if (form.hasPasswordField || form.hasFileField) { formSubmissions.skipped.push({ url: form.action, reason: 'credential-or-upload-form' }); continue; }
    formSubmissions.attempted++;
    try {
      formSubmissionWindow = true;
      const result = await page.evaluate(fixture => {
        function setValue(element, value) {
          const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor && descriptor.set) descriptor.set.call(element, value); else element.value = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const form = [...document.forms].find(f => (f.method || 'GET').toUpperCase() === fixture.method &&
          new URL(f.getAttribute('action') || location.href, location.href).href === fixture.action);
        if (!form) return 'form-not-found';
        if (form.querySelector('input[type=file]')) return 'credential-or-upload-form';
        for (const element of form.elements) {
          if (!element.name) continue;
          const type = (element.type || '').toLowerCase();
          if (['text', 'search', 'tel', 'url', ''].includes(type)) setValue(element, 'ScopePilot確認用入力');
          else if (type === 'email') setValue(element, 'scopepilot@example.invalid');
          else if (type === 'number') setValue(element, '1');
          else if (element.tagName === 'TEXTAREA') setValue(element, 'ScopePilot確認用入力');
        }
        const submitter = form.querySelector('button:not([type]), button[type=submit], input[type=submit]');
        if (submitter && form.requestSubmit) form.requestSubmit(submitter); else form.submit();
        return 'submitted';
      }, { method: form.method, action: form.action });
      if (result !== 'submitted') { formSubmissions.skipped.push({ url: form.action, reason: result }); continue; }
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => { });
      await page.waitForTimeout(250);
      formSubmissions.succeeded++;
      emit('FORM_SUBMITTED', { url: form.action, method: form.method, role: currentRole });
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
      await page.waitForTimeout(150);
    } catch (error) {
      formSubmissions.skipped.push({ url: form.action, reason: String(error.message || error).split('\n')[0].slice(0, 120) });
    } finally { formSubmissionWindow = false; }
  }
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function discoverSitemaps() {
  for (const origin of allowed) {
    if (Date.now() >= deadline) break;
    const candidates = new Set([`${origin}/sitemap.xml`]);
    try {
      const r = await context.request.get(`${origin}/robots.txt`, { timeout: 5000, maxRedirects: 0 });
      if (r.ok()) for (const line of (await r.text()).split(/\r?\n/)) { const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line); if (m) candidates.add(m[1]); }
    } catch { }
    for (const candidate of candidates) {
      if (!allowed.has(new URL(candidate).origin) || Date.now() >= deadline) continue;
      try {
        const r = await context.request.get(candidate, { timeout: 5000, maxRedirects: 0 });
        if (!r.ok()) continue;
        const body = await r.text();
        if (body.length > 2000000) continue;
        for (const m of body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) enqueue(m[1].trim().replace(/&amp;/g, '&'), candidate, 'sitemap');
      } catch { }
    }
  }
}
async function main() {
  try {
    const options = { channel: 'msedge', headless, ignoreHTTPSErrors: true, proxy: { server: proxyRuntime.url }, recordHar: { path: path.join(runDirectory, 'fast-capture.har'), mode: 'full', content: 'embed' } };
    if (interactive) {
      const port = await freePort();
      context = await chromium.launchPersistentContext(path.join(runDirectory, 'browser-profile'), { ...options, args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] });
      atomic('browser-runtime.json', { cdpEndpoint: `http://127.0.0.1:${port}`, status: 'ready' });
    } else {
      browser = await chromium.launch({ channel: 'msedge', headless: true, proxy: { server: proxyRuntime.url } });
      context = await browser.newContext({ ignoreHTTPSErrors: true, recordHar: options.recordHar });
    }
    await context.route('**/*', async route => {
      const r = route.request(); let u; try { u = new URL(r.url()); } catch { return route.abort('blockedbyclient'); }
      if (!allowed.has(u.origin) && !(manualAuthentication && supporting.has(u.origin))) return route.abort('blockedbyclient');
      if (requestCount >= maxRequests) return route.abort('blockedbyclient');
      if (!manualAuthentication && !formSubmissionWindow && !['GET', 'HEAD'].includes(r.method())) return route.abort('blockedbyclient');
      if (!manualAuthentication && r.isNavigationRequest() && policy.reason(r.url()) === 'state-changing-link') return route.abort('blockedbyclient');
      if (crawlComplete && r.isNavigationRequest() && r.frame() === r.frame().page().mainFrame() && !visited.has(key(policy.normalizeUrl(r.url())))) return route.abort('blockedbyclient');
      return route.continue();
    });
    context.on('request', r => { requestCount++; requestRoles.set(r, currentRole); });
    context.on('response', response => {
      const r = response.request(); let url; try { url = policy.normalizeUrl(response.url()); } catch { return; }
      if (!allowed.has(new URL(url).origin)) return;
      const role = requestRoles.get(r) || currentRole, k = `${role} ${r.method()} ${url}`;
      if (!requests.has(k)) requests.set(k, { method: r.method(), url, statusCode: response.status(), contentType: response.headers()['content-type'] || '', source: 'PlaywrightFastCrawler', role, pageTitle: '', observedAt: new Date().toISOString() });
    });
    page = context.pages()[0] || await context.newPage();
    enqueue(startUrl); await discoverSitemaps();
    // Document-derived crawl targets: the app already filtered them to allowed
    // origins; enqueue() re-applies origin/policy/limit checks like any link.
    for (const target of (engagement.documentHints && engagement.documentHints.crawlTargets) || [])
      enqueue(target, 'document-hint', '文書記載エンドポイント');
    while (queue.length && pages.length < maxPages && requestCount < maxRequests && Date.now() < deadline && !closeRequested) {
      const item = queue.shift(), k = key(item.url, item.role);
      if (visited.has(k)) continue;
      const row = coverage.get(k);
      try {
        const response = await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(150);
        let state = await inspect();
        if (!allowed.has(new URL(state.url).origin)) throw Error('redirected outside allowed origin');
        if (policy.isLogin(state)) {
          if (!pages.some(p => p.url === state.url && p.role === currentRole)) pages.push({ url: state.url, requestedUrl: item.url, statusCode: response?.status(), title: state.title, forms: state.forms, role: currentRole, discoveredLinks: state.links.length });
          row.status = 'authentication-required'; persist();
          const authenticated = await authenticate(state);
          if (!authenticated) break;
          state = authenticated;
          const unresolved = [...coverage.values()].filter(x => ['queued', 'authentication-required'].includes(x.status) && x.role !== currentRole);
          queue.length = 0;
          for (const x of unresolved) {
            x.status = 'requeued-after-authentication';
            if (!policy.isLogin({ url: x.url, title: '', password: false, user: false })) enqueue(x.url, x.discoveredFrom, x.label);
          }
        }
        const url = policy.normalizeUrl(state.url), finalKey = key(url);
        if (visited.has(finalKey)) { row.status = 'redirected'; row.finalUrl = url; continue; }
        const statusCode = requests.get(`${currentRole} GET ${url}`)?.statusCode ?? response?.status();
        visited.add(finalKey); row.status = statusCode >= 400 ? 'http-error' : 'visited'; row.finalUrl = url;
        const target = coverage.get(finalKey) || { url, role: currentRole, discoveredFrom: item.url };
        target.status = row.status; target.statusCode = statusCode; coverage.set(finalKey, target);
        if (statusCode >= 400) { errorCount++; target.reason = `HTTP ${statusCode}`; }
        pages.push({ url, requestedUrl: item.url, statusCode, title: state.title, forms: state.forms, role: currentRole, discoveredLinks: state.links.length });
        const r = requests.get(`${currentRole} GET ${url}`);
        if (r) { r.pageTitle = state.title; r.pageInspected = true; r.formCount = state.forms.length; r.formFieldNames = [...new Set(state.forms.flatMap(f => f.fields))].slice(0, 50); }
        for (const link of state.links) enqueue(link.url, url, link.label);
        if (formSubmissionLimit && !policy.isLogin(state)) await submitForms(state.forms, url);
        persist();
        process.stdout.write(`PAGE ${pages.length}/${maxPages} REQUESTS ${requests.size}/${maxRequests} QUEUED ${queue.length} ${displayUrl(url)}\n`);
      } catch (error) {
        errorCount++; row.status = 'error'; row.reason = String(error.message || error).split('\n')[0]; skipped.push({ url: item.url, reason: row.reason });
        process.stdout.write(`SKIP ${displayUrl(item.url)} ${row.reason}\n`);
        if (!pages.length && /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ECONNREFUSED/i.test(row.reason)) { failureCode = 'proxy-unavailable'; break; }
      }
    }
    persist();
    const stoppedBy = authenticationBlocked ? 'authentication-required' : closeRequested ? 'cancelled' : Date.now() >= deadline ? 'time-limit' : pages.length >= maxPages ? 'page-limit' : requestCount >= maxRequests ? 'request-limit' : 'queue-empty';
    const status = policy.outcome({ pages: pages.length, authenticationBlocked, errors: errorCount, remaining: queue.length, limit: stoppedBy !== 'queue-empty' });
    const summary = { status, failureCode, startedAt, finishedAt: new Date(), visitedPageCount: pages.length, discoveredUrlCount: queued.size, observedRequestCount: requests.size, actualRequestCount: requestCount, remainingQueueCount: queue.length, skippedCount: skipped.length, stoppedBy, activeRole: currentRole, authenticationBlocked, formSubmissions, pages, skipped: skipped.slice(0, 1000) };
    atomic('fast-crawl-summary.json', summary);
    crawlComplete = true;
    if (interactive) { emit('CRAWL_DONE', { exitCode: failureCode || !pages.length ? 2 : 0 }); await closeSignal; }
    else { process.stdout.write(`${status.toUpperCase()} PAGES ${pages.length} REQUESTS ${requests.size}\n`); process.exitCode = failureCode || !pages.length ? 2 : 0; }
  } finally {
    if (context) persist();
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    input.close();
    if (interactive && fs.existsSync(path.join(runDirectory, 'browser-runtime.json'))) atomic('browser-runtime.json', { status: 'stopped' });
  }
}
main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; input.close(); });
