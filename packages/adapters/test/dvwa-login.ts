import { request as httpRequest } from 'node:http';
import type { BrowserCookie } from '../src/playwright-explorer.ts';

/**
 * DVWA form-login harness (acceptance IT 用)。
 *
 * 2 つの経路を提供する:
 * - direct: Playwright 探索に渡す session cookie を取得する (検証は cookie 付きで行う)。
 * - viaZapProxy: ZAP の proxy を通して login し、ZAP 自身の cookie jar に認証済み
 *   session を蓄積させる (ZAP に cookie 設定 API は無いため、proxy 経由の実通信で
 *   session を作るのが正規流儀。検証は cookie header なしで jar が保持していることを確かめる)。
 *
 * DVWA の login は CSRF token (user_token) 必須で、成功すると PHPSESSID が再発行される
 * (session_regenerate_id)。複数 Set-Cookie のうち最後の PHPSESSID が正本なので、
 * 全 Set-Cookie から最後の値を取る。秘密値 (password) は環境変数から渡す前提で
 * この file には持ち込まない (F21-UT-007)。
 */
export interface DvwaCredentials {
  readonly username: string;
  readonly password: string;
}

export interface DvwaSession {
  /** 認証済み PHPSESSID。 */
  readonly phpSessId: string;
  /** Playwright addCookies 形式 (domain/path 付き)。 */
  readonly browserCookies: readonly BrowserCookie[];
}

interface RawResponse {
  readonly status: number;
  readonly location: string | null;
  readonly setCookies: readonly string[];
  readonly body: string;
}

const USER_TOKEN = /name=['"]user_token['"][^>]*value=['"]([^'"]+)['"]/;

function lastPhpSessId(setCookies: readonly string[]): string {
  let sid = '';
  for (const cookie of setCookies) {
    const match = /PHPSESSID=([^;]+)/.exec(cookie);
    if (match !== null) {
      sid = match[1] ?? '';
    }
  }
  return sid;
}

async function fetchRaw(url: string, init: { method?: string; cookieHeader?: string; body?: string } = {}): Promise<RawResponse> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      ...(init.cookieHeader === undefined ? {} : { Cookie: init.cookieHeader }),
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const setCookies =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
  return {
    status: response.status,
    location: response.headers.get('location'),
    setCookies: setCookies.filter((cookie) => cookie !== ''),
    body: await response.text(),
  };
}

async function proxyFetchRaw(
  proxy: { readonly host: string; readonly port: number },
  base: string,
  path: string,
  init: { method?: string; cookieHeader?: string; body?: string } = {},
): Promise<RawResponse> {
  return await new Promise<RawResponse>((resolve, reject) => {
    const host = new URL(base).host;
    const req = httpRequest(
      {
        host: proxy.host,
        port: proxy.port,
        method: init.method ?? 'GET',
        path: `${base}${path}`,
        headers: {
          Host: host,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
          ...(init.cookieHeader === undefined ? {} : { Cookie: init.cookieHeader }),
        },
        setHost: false,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          const raw = res.headers['set-cookie'];
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers['location'] ?? null,
            setCookies: raw === undefined ? [] : raw,
            body: data,
          });
        });
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) {
      req.write(init.body);
    }
    req.end();
  });
}

interface LoginDeps {
  readonly get: (path: string, cookieHeader?: string) => Promise<RawResponse>;
  readonly post: (path: string, body: string, cookieHeader: string) => Promise<RawResponse>;
}

async function performLogin(deps: LoginDeps, base: string, credentials: DvwaCredentials): Promise<DvwaSession> {
  // 1. login 頁で CSRF token と初期 session を受け取る。
  const loginPage = await deps.get('/login.php');
  const initialSid = lastPhpSessId(loginPage.setCookies);
  const token = USER_TOKEN.exec(loginPage.body)?.[1] ?? '';
  if (initialSid === '' || token === '') {
    throw new Error('DVWA login page did not provide PHPSESSID/user_token (setup.php の DB 初期化が必要かも)');
  }

  // 2. 認証。成功すれば index.php への redirect と PHPSESSID 再発行。
  const form = new URLSearchParams({
    username: credentials.username,
    password: credentials.password,
    Login: 'Login',
    user_token: token,
  });
  const loginResult = await deps.post('/login.php', form.toString(), `PHPSESSID=${initialSid}`);
  let sid = lastPhpSessId(loginResult.setCookies) || initialSid;
  if (loginResult.location !== 'index.php') {
    throw new Error(`DVWA login failed (Location: ${loginResult.location ?? 'none'}). DB 未初期化または資格情報不一致の可能性`);
  }

  // 3. security level を low へ (脆弱実装を診断経路で通す。検出率保証が目的ではない)。
  const securityPage = await deps.get('/security.php', `PHPSESSID=${sid}`);
  const securityToken = USER_TOKEN.exec(securityPage.body)?.[1] ?? '';
  const hostname = new URL(base).hostname;
  const browserCookies: BrowserCookie[] = [{ name: 'PHPSESSID', value: sid, domain: hostname, path: '/' }];
  if (securityToken !== '') {
    const securityForm = new URLSearchParams({ security: 'low', sec: 'Submit', user_token: securityToken });
    const securityResult = await deps.post('/security.php', securityForm.toString(), `PHPSESSID=${sid}`);
    sid = lastPhpSessId(securityResult.setCookies) || sid;
    browserCookies[0] = { name: 'PHPSESSID', value: sid, domain: hostname, path: '/' };
    browserCookies.push({ name: 'security', value: 'low', domain: hostname, path: '/' });
  }

  return { phpSessId: sid, browserCookies };
}

/** 直接 login し、Playwright 探索用の session を返す。 */
export async function loginDvwaDirect(base: string, credentials: DvwaCredentials): Promise<DvwaSession> {
  const session = await performLogin(
    {
      get: (path, cookieHeader) => fetchRaw(`${base}${path}`, cookieHeader === undefined ? {} : { cookieHeader }),
      post: (path, body, cookieHeader) => fetchRaw(`${base}${path}`, { method: 'POST', body, cookieHeader }),
    },
    base,
    credentials,
  );
  const cookieHeader = session.browserCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const index = await fetchRaw(`${base}/index.php`, { cookieHeader });
  if (index.status !== 200 || !index.body.includes('Welcome')) {
    throw new Error(`direct session is not authenticated (index.php -> ${String(index.status)})`);
  }
  return session;
}

/**
 * ZAP proxy 経由で login し、ZAP の cookie jar に認証済み session を作る。
 * 検証は ZAP API (httpSessions/view/sessions) で jar 内に認証済み PHPSESSID が
 * あることを確認する。cookie header なしで proxy へ再取得する検証は行わない —
 * その要求自体が未認証 PHPSESSID の Set-Cookie を引き起こし、jar を上書きして
 * しまう (実測)。
 */
export async function loginDvwaViaZapProxy(
  base: string,
  credentials: DvwaCredentials,
  proxy: { readonly host: string; readonly port: number },
  zapApi: { readonly baseUrl: string; readonly apiKey?: string },
): Promise<DvwaSession> {
  const session = await performLogin(
    {
      get: (path, cookieHeader) => proxyFetchRaw(proxy, base, path, cookieHeader === undefined ? {} : { cookieHeader }),
      post: (path, body, cookieHeader) => proxyFetchRaw(proxy, base, path, { method: 'POST', body, cookieHeader }),
    },
    base,
    credentials,
  );
  const url = new URL(`${zapApi.baseUrl.replace(/\/$/, '')}/JSON/httpSessions/view/sessions/`);
  url.searchParams.set('site', base);
  if (zapApi.apiKey !== undefined && zapApi.apiKey !== '') {
    url.searchParams.set('apikey', zapApi.apiKey);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ZAP httpSessions view failed: HTTP ${String(response.status)}`);
  }
  const bodyText = await response.text();
  if (!bodyText.includes(session.phpSessId)) {
    throw new Error(`ZAP cookie jar does not hold the authenticated PHPSESSID (${session.phpSessId.slice(0, 8)}...)`);
  }
  return session;
}
