import { createServer, type Server } from 'node:http';

/**
 * 実 engine 結合テスト用の「所有している」テスト対象サーバー (design/22: 診断は
 * 許可を得た所有ターゲットに限定)。意図的に脆弱な静的ページを返す。
 * - `/`         リンク付き index (探索のリンク抽出用。javascript:void(0) を混ぜる)
 * - `/echo?x=`  x を HTML に無 escape で反映 (reflection)
 * - `/plain`    単純なページ
 * - `/login`    認証 form (GET) と認証処理 (POST)。固定資格情報 admin/password123
 *              のみ受理し、成功で AUTHTOKEN cookie を発行して /authenticated/page へ。
 * - `/authenticated/page` AUTHTOKEN が無い場合は /login へ 302。ある場合のみ
 *              marker を含む本文を返す (認証経由での到達を外から区別できる)。
 * セキュリティ header を一切付けないため、ZAP の passive scan でも alert が出る。
 */
export interface VulnerableTarget {
  readonly server: Server;
  readonly base: string;
  readonly indexUrl: string;
  readonly echoUrl: string;
  readonly plainUrl: string;
  readonly loginUrl: string;
  readonly authenticatedUrl: string;
  readonly domUrl: string;
}

const INDEX_HTML = [
  '<!doctype html>',
  '<html><head><title>ScopePilot IT Target</title></head>',
  '<body>',
  '<a href="/echo?x=abc">echo</a>',
  '<a href="/plain">plain</a>',
  '<a href="javascript:void(0)">noop</a>',
  '</body></html>',
].join('\n');

const LOGIN_HTML = [
  '<!doctype html>',
  '<html><head><title>Login</title></head>',
  '<body>',
  '<form method="POST" action="/login">',
  '<input type="text" name="username">',
  '<input type="password" name="password">',
  '<button type="submit">Sign in</button>',
  '</form>',
  '</body></html>',
].join('\n');

const AUTHENTICATED_MARKER = 'authenticated-page-marker';

export function startVulnerableTarget(): Promise<VulnerableTarget> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (body: string): void => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(body);
    };
    if (url.pathname === '/') {
      send(INDEX_HTML);
      return;
    }
    if (url.pathname === '/echo') {
      const x = url.searchParams.get('x') ?? '';
      send(`<!doctype html><html><body>reflected: ${x}</body></html>`);
      return;
    }
    if (url.pathname === '/plain') {
      send('<!doctype html><html><body>plain page</body></html>');
      return;
    }
    if (url.pathname === '/dom-flow') {
      const external = url.searchParams.get('external');
      send([
        '<!doctype html><html><body><div id="output"></div>',
        external === null ? '' : `<img src="${external}">`,
        '<script>',
        "const marker = new URLSearchParams(location.search).get('marker') || '';",
        "document.getElementById('output').innerHTML = marker;",
        '</script></body></html>',
      ].join(''));
      return;
    }
    if (url.pathname === '/login' && request.method === 'GET') {
      send(LOGIN_HTML);
      return;
    }
    if (url.pathname === '/login' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const ok = params.get('username') === 'admin' && params.get('password') === 'password123';
        if (!ok) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end('<!doctype html><html><body>login failed</body></html>');
          return;
        }
        // HttpOnly を付けると browser context から読めないが login 実行器は
        // cookie を context から抽出するため、ここではあえて付けない
        // (実運用の HttpOnly は ZAP jar 経路で担保される)。
        response.writeHead(302, { 'Set-Cookie': `AUTHTOKEN=it-session-${Date.now()}; Path=/`, Location: '/authenticated/page' });
        response.end();
      });
      return;
    }
    if (url.pathname === '/authenticated/page') {
      const cookie = request.headers.cookie ?? '';
      if (!cookie.includes('AUTHTOKEN=')) {
        response.writeHead(302, { Location: '/login' });
        response.end();
        return;
      }
      send(`<!doctype html><html><head><title>Authenticated</title></head><body>${AUTHENTICATED_MARKER}<p>session only content</p></body></html>`);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body>not found</body></html>');
  });
  return new Promise<VulnerableTarget>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected TCP address');
      }
      const base = `http://127.0.0.1:${address.port}`;
      resolve({
        server,
        base,
        indexUrl: `${base}/`,
        echoUrl: `${base}/echo?x=abc`,
        plainUrl: `${base}/plain`,
        loginUrl: `${base}/login`,
        authenticatedUrl: `${base}/authenticated/page`,
        domUrl: `${base}/dom-flow?marker=scopepilot-dom-marker`,
      });
    });
  });
}

export const VULNERABLE_TARGET_CREDENTIALS = { username: 'admin', password: 'password123' } as const;
export const VULNERABLE_TARGET_AUTH_MARKER = AUTHENTICATED_MARKER;
