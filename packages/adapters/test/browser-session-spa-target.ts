import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const ACCESS_TOKEN = 'owned-fixture-access-token';
const SESSION_MARKER = 'owned-fixture-session-marker';

export interface BrowserSessionSpaTarget {
  readonly server: Server;
  readonly baseUrl: string;
  readonly loginUrl: string;
  readonly appUrl: string;
  readonly authorizedApiPaths: readonly string[];
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  // content-length を明示する (実環境の静的配信と同じ形式。chunked 応答は
  // 観測側の期限付き body 読み取りの対象外にする)。
  const buffer = Buffer.from(body, 'utf8');
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': buffer.byteLength,
  });
  response.end(buffer);
}

function loginPage(): string {
  return `<!doctype html>
<html><head><title>Owned SPA Login</title></head><body>
  <form id="login-form">
    <input name="email" type="email">
    <input name="password" type="password">
    <button type="submit">Sign in</button>
  </form>
  <script>
    document.querySelector('#login-form').addEventListener('submit', async event => {
      event.preventDefault();
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: document.querySelector('[name=email]').value,
          password: document.querySelector('[name=password]').value
        })
      });
      const result = await response.json();
      localStorage.setItem('access_token', result.accessToken);
      sessionStorage.setItem('session_marker', result.sessionMarker);
      location.assign('/app');
    });
  </script>
</body></html>`;
}

function appPage(pathname: string): string {
  const detailMatch = /^\/app\/detail\/(\d+)$/.exec(pathname);
  const apiPath = detailMatch !== null
    ? `/api/detail/${detailMatch[1]!}`
    : pathname === '/app/profile'
      ? '/api/profile'
      : pathname === '/app/orders'
        ? '/api/orders'
        : pathname === '/app/reports'
          ? '/api/reports'
          : '/api/me';
  // 一覧ページは件数分の個別 API (URL に識別子を含む形式) も取得する。
  // 実 SPA で一般的な「一覧 → 個別取得」の通信パターンを模している。
  const extraApiPaths = pathname === '/app/orders' ? ['/api/order/7/summary', '/api/order/11/summary'] : [];
  return `<!doctype html>
<html><head><title>Owned Bearer SPA</title></head><body>
  <main>
    <p id="state">Loading</p>
    <nav>
      <a href="/app/profile">Profile</a>
      <span role="link" data-to="/app/orders">Orders</span>
      <a href="/app#settings">Settings</a>
    </nav>
  </main>
  <script src="/assets/app.js"></script>
  <script>
    const accessToken = localStorage.getItem('access_token');
    const sessionMarker = sessionStorage.getItem('session_marker');
    if (!accessToken || !sessionMarker) {
      location.replace('/login');
    } else {
      fetch('${apiPath}', {
        headers: {
          authorization: 'Bearer ' + accessToken,
          'x-session-marker': sessionMarker
        }
      }).then(async response => {
        const state = document.querySelector('#state');
        state.textContent = response.ok ? 'Dashboard ready' : 'Unauthorized';
        state.dataset.ready = String(response.ok);
      });
      for (const extra of ${JSON.stringify(extraApiPaths)}) {
        fetch(extra, {
          headers: {
            authorization: 'Bearer ' + accessToken,
            'x-session-marker': sessionMarker
          }
        }).catch(() => undefined);
      }
    }
  </script>
</body></html>`;
}

function applicationScript(): string {
  return `globalThis.__ownedSpaRoutes = [
    { path: 'app/profile' },
    { path: 'app/orders' },
    { path: 'app/reports' },
    { path: 'app/detail/:id' }
  ];`;
}

function authorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${ACCESS_TOKEN}`
    && request.headers['x-session-marker'] === SESSION_MARKER;
}

export async function startBrowserSessionSpaTarget(): Promise<BrowserSessionSpaTarget> {
  const authorizedApiPaths: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
      send(response, 200, 'text/html; charset=utf-8', loginPage());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      send(response, 200, 'application/json', JSON.stringify({ accessToken: ACCESS_TOKEN, sessionMarker: SESSION_MARKER }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/assets/app.js') {
      send(response, 200, 'application/javascript; charset=utf-8', applicationScript());
      return;
    }
    if (request.method === 'GET' && /^\/app\/detail\/\d+$/.test(url.pathname)) {
      send(response, 200, 'text/html; charset=utf-8', appPage(url.pathname));
      return;
    }
    if (request.method === 'GET' && ['/app', '/app/profile', '/app/orders', '/app/reports'].includes(url.pathname)) {
      send(response, 200, 'text/html; charset=utf-8', appPage(url.pathname));
      return;
    }
    if (request.method === 'GET' && /^\/api\/order\/\d+\/summary$/.test(url.pathname)) {
      if (!authorized(request)) {
        send(response, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      send(response, 200, 'application/json', JSON.stringify({ orderId: Number(url.pathname.split('/')[2]), owner: 'fixture-user' }));
      return;
    }
    if (request.method === 'GET' && /^\/api\/detail\/\d+$/.test(url.pathname)) {
      if (!authorized(request)) {
        send(response, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      authorizedApiPaths.push(url.pathname);
      send(response, 200, 'application/json', JSON.stringify({ id: Number(url.pathname.split('/').at(-1)), owner: 'fixture-user' }));
      return;
    }
    if (request.method === 'GET' && ['/api/me', '/api/profile', '/api/reports'].includes(url.pathname)) {
      if (!authorized(request)) {
        send(response, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      authorizedApiPaths.push(url.pathname);
      send(response, 200, 'application/json', JSON.stringify({ path: url.pathname, owner: 'fixture-user' }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/orders') {
      if (!authorized(request)) {
        send(response, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      authorizedApiPaths.push(url.pathname);
      // 識別子 (orders[].id) を含む list 形式の応答。動的ルート具体化の観測源になる。
      send(response, 200, 'application/json', JSON.stringify({ orders: [{ id: 7 }, { id: 11 }], owner: 'fixture-user' }));
      return;
    }
    send(response, 404, 'text/plain; charset=utf-8', 'not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('owned SPA target did not bind to TCP');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    server,
    baseUrl,
    loginUrl: `${baseUrl}/login`,
    appUrl: `${baseUrl}/app`,
    authorizedApiPaths,
    close: async () => await new Promise<void>((resolve, reject) => server.close((cause) => cause === undefined ? resolve() : reject(cause))),
  };
}
