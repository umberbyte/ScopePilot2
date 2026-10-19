import { createServer, type Server } from 'node:http';

/**
 * 実 engine 結合テスト用の「所有している」テスト対象サーバー (design/22: 診断は
 * 許可を得た所有ターゲットに限定)。意図的に脆弱な静的ページを返す。
 * - `/`         リンク付き index (探索のリンク抽出用。javascript:void(0) を混ぜる)
 * - `/echo?x=`  x を HTML に無 escape で反映 (reflection)
 * - `/plain`    単純なページ
 * セキュリティ header を一切付けないため、ZAP の passive scan でも alert が出る。
 */
export interface VulnerableTarget {
  readonly server: Server;
  readonly base: string;
  readonly indexUrl: string;
  readonly echoUrl: string;
  readonly plainUrl: string;
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
      });
    });
  });
}
