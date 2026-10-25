/**
 * ワークフロー診断回帰テスト用の DVWA 互換サーバー。旧 C# 実装の FakeDvwaServer と同じ挙動
 * （18分類の脆弱な挙動と high/impossible での保護挙動、実DVWAと同一の暗号仕様、
 * reCAPTCHAキー未設定時に結果表示を消してパスワード変更だけ実行する挙動）を模倣する。
 */
import { createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';

const USER_TOKEN = '0123456789abcdef0123456789abcdef';
const PASSWD_CONTENT = 'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n';
const XOR_KEY = 'wachtwoord';
const ECB_KEY = 'ik ben een aardb'; // PHP openssl は aes-128 の鍵を先頭16バイトへ切詰め
const CBC_KEY = 'rainbowclimbingh';
const CBC_IV = '1234567812345678';
const EXPIRED_EX = '1723620672';

export interface FakeDvwaServer {
  readonly baseUrl: string;
  readonly securityLevel: string;
  setSecurityLevel(level: string): void;
  close(): Promise<void>;
}

interface FakeUser {
  id: number;
  firstName: string;
  surname: string;
  level: number;
}

export async function startFakeDvwaServer(username = 'admin', password = 'SecretPass123'): Promise<FakeDvwaServer> {
  let securityLevel = 'low';
  let loginAttempted = false;
  let currentPassword = password;
  let weakSessionCounter = 0;
  const uploads = new Map<string, { mime: string; bytes: Buffer }>();
  const guestbook: { name: string; message: string }[] = [];
  const users: FakeUser[] = [
    { id: 1, firstName: 'admin', surname: 'admin', level: 0 },
    { id: 2, firstName: 'Gordon', surname: 'Brown', level: 1 },
    { id: 3, firstName: 'Hack', surname: 'Me', level: 1 },
  ];

  const write = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'text/html; charset=UTF-8', ...headers });
    res.end(body);
  };
  const writeJson = (res: ServerResponse, status: number, value: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const redirect = (res: ServerResponse, location: string): void => {
    res.writeHead(302, { location });
    res.end();
  };

  const readBody = async (req: IncomingMessage): Promise<Buffer> =>
    await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
      req.on('error', reject);
    });

  const parseForm = (body: string): Record<string, string> => {
    const form: Record<string, string> = {};
    for (const part of body.split('&')) {
      if (part === '') {
        continue;
      }
      const [key, ...rest] = part.split('=');
      if (key === undefined) {
        continue;
      }
      form[decodeURIComponent(key)] = decodeURIComponent(rest.join('=').replaceAll('+', ' '));
    }
    return form;
  };

  const parseMultipart = (body: Buffer, boundary: string): { name: string; mime: string; bytes: Buffer } | undefined => {
    const text = body.toString('latin1');
    for (const part of text.split(`--${boundary}`)) {
      if (!part.includes('filename=')) {
        continue;
      }
      const separator = part.indexOf('\r\n\r\n');
      if (separator < 0) {
        continue;
      }
      const header = part.slice(0, separator);
      const content = part.slice(separator + 4).replace(/\r\n$/, '');
      const name = /filename="([^"]+)"/.exec(header)?.[1];
      const mime = /Content-Type:\s*([^\r\n]+)/.exec(header)?.[1]?.trim();
      if (name === undefined) {
        continue;
      }
      return { name, mime: mime ?? 'application/octet-stream', bytes: Buffer.from(content, 'latin1') };
    }
    return undefined;
  };

  const isAuthenticated = (req: IncomingMessage): boolean => (req.headers['cookie'] ?? '').toString().includes('PHPSESSID=');

  const xor = (value: Buffer, key: string): Buffer => {
    const output = Buffer.alloc(value.length);
    for (let index = 0; index < value.length; index += 1) {
      output[index] = value[index]! ^ key.charCodeAt(index % key.length);
    }
    return output;
  };
  const ecbEncrypt = (plaintext: string): string => {
    const cipher = createCipheriv('aes-128-ecb', Buffer.from(ECB_KEY, 'ascii'), null);
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('hex');
  };
  const ecbDecrypt = (hex: string): string | undefined => {
    try {
      const decipher = createDecipheriv('aes-128-ecb', Buffer.from(ECB_KEY, 'ascii'), null);
      return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8');
    } catch {
      return undefined;
    }
  };
  const cbcEncrypt = (plaintext: string): string => {
    const cipher = createCipheriv('aes-128-cbc', Buffer.from(CBC_KEY, 'ascii'), Buffer.from(CBC_IV, 'ascii'));
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
  };
  const cbcDecrypt = (cipherText: Buffer, iv: Buffer): string | undefined => {
    try {
      const decipher = createDecipheriv('aes-128-cbc', Buffer.from(CBC_KEY, 'ascii'), iv);
      return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
    } catch {
      return undefined;
    }
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/+$/, '');
      const query = Object.fromEntries(url.searchParams.entries());
      const rawBody = await readBody(req);
      const contentType = (req.headers['content-type'] ?? '').toString();
      const form = contentType.startsWith('application/x-www-form-urlencoded') ? parseForm(rawBody.toString('utf8')) : {};

      if (path === '/login.php') {
        if (req.method === 'GET') {
          write(res, 200, `<html><form><input type='hidden' name='user_token' value='${USER_TOKEN}' /><input name='username' /><input name='password' /></form></html>`);
          return;
        }
        loginAttempted = true;
        const ok =
          form['username'] === username &&
          form['password'] === currentPassword &&
          form['Login'] === 'Login' &&
          form['user_token'] !== undefined;
        if (ok) {
          res.writeHead(302, { location: 'index.php', 'set-cookie': 'PHPSESSID=sp-session-1; path=/' });
          res.end();
          return;
        }
        write(res, 200, '<html><body>Login failed</body></html>');
        return;
      }
      if (path === '/index.php') {
        if (!isAuthenticated(req)) {
          redirect(res, 'login.php');
          return;
        }
        write(res, 200, '<html><body>Welcome to DVWA <a href=\'logout.php\'>Logout</a></body></html>');
        return;
      }
      if (path === '/security.php') {
        if (req.method === 'POST' && form['user_token'] !== undefined) {
          if (form['security'] !== undefined && ['low', 'medium', 'high', 'impossible'].includes(form['security'])) {
            securityLevel = form['security'];
          }
          redirect(res, 'security.php');
          return;
        }
        const options = ['low', 'medium', 'high', 'impossible']
          .map((level) => `<option value='${level}'${level === securityLevel ? " selected='selected'" : ''}>${level}</option>`)
          .join('');
        write(res, 200, `<html><form method='post'><input type='hidden' name='user_token' value='${USER_TOKEN}' /><select name='security'>${options}</select><input type='submit' name='seclev_submit' value='Submit' /></form></html>`);
        return;
      }
      if (path.startsWith('/hackable/uploads/')) {
        const name = path.slice('/hackable/uploads/'.length);
        const upload = uploads.get(name);
        if (upload === undefined) {
          write(res, 404, 'Not Found');
          return;
        }
        if (name.endsWith('.php')) {
          // PHPとして実行された結果を模倣する（echo の引数を出力）。
          const echo = /echo\s+"([^"]+)"/.exec(upload.bytes.toString('utf8'));
          write(res, 200, echo?.[1] ?? '');
          return;
        }
        res.writeHead(200, { 'content-type': upload.mime });
        res.end(upload.bytes);
        return;
      }
      if (path.startsWith('/vulnerabilities/') && !isAuthenticated(req)) {
        redirect(res, 'login.php');
        return;
      }

      switch (path) {
        case '/vulnerabilities/brute': {
          const challenged = query['username'] !== undefined || form['username'] !== undefined;
          write(res, 200, `<html><body>${challenged ? '<pre>Username and/or password incorrect.</pre>' : '<form>Brute Force</form>'}</body></html>`);
          return;
        }
        case '/vulnerabilities/csrf': {
          if (query['Change'] === undefined) {
            write(res, 200, "<html><form>password_new password_conf</form></html>");
            return;
          }
          if (securityLevel === 'low' || securityLevel === 'medium') {
            if (query['password_new'] !== undefined && query['password_new'] === query['password_conf'] && query['password_new'] !== '') {
              currentPassword = query['password_new'];
            }
            write(res, 200, '<html><pre>Password Changed.</pre></html>');
            return;
          }
          write(res, 200, '<html><pre>Your CSRF token is incorrect.</pre></html>');
          return;
        }
        case '/vulnerabilities/upload': {
          if (!contentType.startsWith('multipart/form-data') || req.method !== 'POST') {
            write(res, 200, "<html><form><input type='file' name='uploaded' /></form></html>");
            return;
          }
          const boundary = contentType.split('boundary=')[1] ?? '';
          const file = parseMultipart(rawBody, boundary);
          if (file === undefined) {
            write(res, 200, '<html><pre>Your image was not uploaded.</pre></html>');
            return;
          }
          const accepted =
            securityLevel === 'low'
              ? true
              : securityLevel === 'medium'
                ? file.mime === 'image/jpeg'
                : securityLevel === 'high'
                  ? file.mime === 'image/jpeg' && file.bytes.subarray(0, 6).toString('latin1') === 'GIF89a'
                  : false;
          if (!accepted) {
            write(res, 200, '<html><pre>Your image was not uploaded.</pre></html>');
            return;
          }
          uploads.set(file.name, { mime: file.mime, bytes: file.bytes });
          write(res, 200, `<html><pre>../../hackable/uploads/${file.name} succesfully uploaded!</pre></html>`);
          return;
        }
        case '/vulnerabilities/captcha': {
          if (form['Change'] === undefined) {
            write(res, 200, "<html><form><input name='password_new' /><input name='g-recaptcha-response' /></form></html>");
            return;
          }
          const changed =
            securityLevel === 'low'
              ? true
              : securityLevel === 'medium'
                ? form['step'] === '2' && form['passed_captcha'] === 'true'
                : securityLevel === 'high'
                  ? form['g-recaptcha-response'] === 'DEVELOPER-ONLY'
                  : false;
          if (changed && form['password_new'] !== undefined && form['password_new'] === form['password_conf'] && form['password_new'] !== '') {
            currentPassword = form['password_new'];
          }
          // 実機のDVWAはreCAPTCHAキー未設定の場合、結果表示を警告で置き換える（変更自体は実行される）。
          const suppressed = changed && securityLevel === 'low';
          write(
            res,
            200,
            changed
              ? suppressed
                ? '<html><em>Please register for a key</em> from reCAPTCHA</html>'
                : '<html><pre>Password Changed.</pre></html>'
              : '<html><pre>You have not passed the CAPTCHA.</pre></html>',
          );
          return;
        }
        case '/vulnerabilities/weak_id': {
          if (req.method !== 'POST') {
            write(res, 200, "<html><form method='post'><input type='submit' name='generate' /></form></html>");
            return;
          }
          weakSessionCounter += 1;
          const value =
            securityLevel === 'medium'
              ? String(Math.floor(Date.now() / 1000))
              : securityLevel === 'high'
                ? createHash('md5').update(String(weakSessionCounter), 'ascii').digest('hex')
                : String(weakSessionCounter);
          write(res, 200, '<html><body>Session set</body></html>', { 'set-cookie': `dvwaSession=${value}` });
          return;
        }
        case '/vulnerabilities/xss_r': {
          const name = query['name'];
          if (name === undefined) {
            write(res, 200, "<html><form><input name='name' /></form></html>");
            return;
          }
          const output =
            securityLevel === 'medium'
              ? name.split('<script>').join('').split('</script>').join('')
              : securityLevel === 'high' || securityLevel === 'impossible'
                ? escapeHtml(name)
                : name;
          write(res, 200, `<html><pre>Hello ${output}</pre></html>`);
          return;
        }
        case '/vulnerabilities/xss_s': {
          if (req.method === 'POST' && form['btnSign'] !== undefined) {
            guestbook.push({ name: form['txtName'] ?? '', message: form['mtxMessage'] ?? '' });
          }
          let body = "<html><div id='guestbook'>";
          for (const entry of guestbook) {
            const renderedName = securityLevel === 'high' || securityLevel === 'impossible' ? escapeHtml(entry.name) : entry.name;
            const renderedMessage =
              securityLevel === 'medium'
                ? entry.message.split('<script>').join('').split('</script>').join('')
                : securityLevel === 'high' || securityLevel === 'impossible'
                  ? escapeHtml(entry.message)
                  : entry.message;
            body += `<div class='name'>${renderedName}</div><div class='message'>${renderedMessage}</div>`;
          }
          body += "</div><form method='post'><input name='txtName' /><textarea name='mtxMessage'></textarea><input type='submit' name='btnSign' value='Sign' /></form></html>";
          write(res, 200, body);
          return;
        }
        case '/vulnerabilities/xss_d': {
          const page =
            securityLevel === 'high'
              ? "<html><select name='default'></select><script>var config = JSON.parse('{}'); setTimeout(function () { init(config); }, 0);</script></html>"
              : "<html><select name='default'></select><script>if (window.location.search) { var lang = location.href.substring(location.href.indexOf('default=') + 8); document.write(decodeURIComponent(lang)); }</script></html>";
          write(res, 200, page);
          return;
        }
        case '/vulnerabilities/csp': {
          const policy =
            "script-src 'self' https://pastebin.com hastebin.com www.toptal.com example.com code.jquery.com https://ssl.google-analytics.com unpkg.com cdn.jsdelivr.net digi.ninja;";
          if (req.method === 'POST' && form['include'] !== undefined) {
            write(res, 200, `<html><script src='${form['include']}'></script></html>`, { 'content-security-policy': policy });
            return;
          }
          write(res, 200, "<html><form method='post'><input name='include' id='include' /></form></html>", {
            'content-security-policy': policy,
          });
          return;
        }
        case '/vulnerabilities/javascript': {
          if (Object.keys(form).length === 0) {
            write(
              res,
              200,
              "<html><script>function generate_token() { var phrase = document.getElementById('phrase').value; document.getElementById('token').value = md5(rot13(phrase)); }</script><form method='post'><input name='phrase' id='phrase' value='changeit' /><input type='hidden' name='token' id='token' value='' /><input type='submit' name='change' value='Change' /></form></html>",
            );
            return;
          }
          const phrase = form['phrase'] ?? '';
          const token = form['token'] ?? '';
          const expected =
            securityLevel === 'medium'
              ? `XX${phrase}XX`.split('').reverse().join('')
              : securityLevel === 'high'
                ? sha256Hex(`${sha256Hex(`XX${phrase.split('').reverse().join('')}`)}ZZ`)
                : md5Hex(rot13(phrase));
          write(res, 200, phrase === 'success' && token === expected ? "<html><p style='color:red'>Well done!</p></html>" : '<html><p>Invalid token.</p></html>');
          return;
        }
        case '/vulnerabilities/authbypass/get_user_data.php': {
          if (securityLevel === 'impossible' && username !== 'admin') {
            writeJson(res, 200, { result: 'fail', error: 'Access denied' });
            return;
          }
          writeJson(
            res,
            200,
            users.map((u) => ({ user_id: String(u.id), first_name: u.firstName, surname: u.surname })),
          );
          return;
        }
        case '/vulnerabilities/authbypass/change_user_details.php': {
          if (req.method !== 'POST') {
            writeJson(res, 200, { result: 'fail', error: 'Only POST requests are accepted' });
            return;
          }
          try {
            const data = JSON.parse(rawBody.toString('utf8')) as { id?: number; first_name?: string; surname?: string };
            const user = users.find((u) => u.id === data.id);
            if (user === undefined) {
              writeJson(res, 200, { result: 'fail', error: 'not found' });
              return;
            }
            user.firstName = data.first_name ?? user.firstName;
            user.surname = data.surname ?? user.surname;
            writeJson(res, 200, { result: 'ok' });
          } catch {
            writeJson(res, 200, { result: 'fail', error: 'Invalid format' });
          }
          return;
        }
        case '/vulnerabilities/bac':
        case '/vulnerabilities/bac/index.php': {
          write(res, 200, "<html><div class='log-container'><h3>Access Log</h3><table><tr><td>user_id: 2</td><td>target_id: 1</td><td>ip_address: 10.0.0.9</td><td>action: view</td></tr></table></div></html>");
          return;
        }
        case '/vulnerabilities/open_redirect/source/low.php':
        case '/vulnerabilities/open_redirect/source/medium.php':
        case '/vulnerabilities/open_redirect/source/high.php': {
          const target = query['redirect'] ?? '';
          if (target === '') {
            write(res, 500, 'Missing redirect target.');
            return;
          }
          const level = path.endsWith('/low.php') ? 'low' : path.endsWith('/medium.php') ? 'medium' : 'high';
          const allowed =
            level === 'low' ? true : level === 'medium' ? !/https?:\/\//i.test(target) : target.includes('info.php');
          if (allowed) {
            redirect(res, target);
            return;
          }
          write(res, 500, level === 'medium' ? 'Absolute URLs not allowed.' : 'You can only redirect to the info page.');
          return;
        }
        case '/vulnerabilities/fi':
        case '/vulnerabilities/fi/index.php': {
          const page = query['page'] ?? '';
          if (page === '') {
            write(res, 200, "<html><a href='?page=include.php'>include</a></html>");
            return;
          }
          let processed = page;
          if (securityLevel === 'medium') {
            processed = processed.split('../').join('').split('..\\').join('');
          } else if (
            (securityLevel === 'high' && !processed.startsWith('file') && processed !== 'include.php') ||
            securityLevel === 'impossible'
          ) {
            write(res, 200, '<html>ERROR: File not found!</html>');
            return;
          }
          if (processed.startsWith('php://filter/convert.base64-encode/resource=')) {
            const resource = resolveLocalFile(processed.slice('php://filter/convert.base64-encode/resource='.length));
            write(res, 200, resource === undefined ? '<html>ERROR: File not found!</html>' : Buffer.from(resource, 'utf8').toString('base64'));
            return;
          }
          if (processed.startsWith('file://')) {
            processed = processed.slice('file://'.length);
          }
          const content = resolveLocalFile(processed);
          write(res, 200, content === undefined ? '<html>ERROR: File not found!</html>' : `<html><pre>${content}</pre></html>`);
          return;
        }
        case '/vulnerabilities/sqli':
        case '/vulnerabilities/sqli_blind': {
          const blind = path.endsWith('blind');
          const id = query['id'] ?? form['id'] ?? '';
          if (id === '') {
            write(res, 200, "<html><form><input name='id' /><input type='submit' name='Submit' /></form></html>");
            return;
          }
          if (securityLevel === 'high' || securityLevel === 'impossible') {
            write(res, 200, blind ? '<html><pre>User ID is MISSING from the database.</pre></html>' : '<html></html>');
            return;
          }
          if (/^\d+$/.test(id)) {
            write(res, 200, blind ? '<html><pre>User ID exists in the database.</pre></html>' : "<html><pre>ID: 1</pre><pre>First name: admin</pre><pre>Surname: admin</pre></html>");
            return;
          }
          if (id.includes("'") && id.toUpperCase().includes('AND')) {
            const truthy = id.includes("'1'='1") || id.includes('1=1');
            write(
              res,
              200,
              truthy
                ? blind
                  ? '<html><pre>User ID exists in the database.</pre></html>'
                  : '<html><pre>First name: admin</pre><pre>Surname: admin</pre></html>'
                : blind
                  ? '<html><pre>User ID is MISSING from the database.</pre></html>'
                  : '<html></html>',
            );
            return;
          }
          if (id.includes("'")) {
            write(res, 200, blind ? '<html><pre>User ID is MISSING from the database.</pre></html>' : '<html><pre>You have an error in your SQL syntax; check the manual...</pre></html>');
            return;
          }
          write(res, 200, blind ? '<html><pre>User ID is MISSING from the database.</pre></html>' : '<html></html>');
          return;
        }
        case '/vulnerabilities/cryptography': {
          if (securityLevel === 'low') {
            let body = "<html><form method='post'><textarea name='message'></textarea><input type='radio' name='direction' value='encode' checked='checked' /><input type='submit' /></form>";
            if (req.method === 'POST') {
              const encoded = xor(Buffer.from(form['message'] ?? '', 'utf8'), XOR_KEY).toString('base64');
              body += `<textarea readonly='readonly' id='encoded' name='encoded'>${encoded}</textarea>`;
            } else {
              const intercepted = xor(Buffer.from('the password is Olifant', 'utf8'), XOR_KEY).toString('base64');
              body += `<p>You have intercepted the following message, decode it and log in below.</p><textarea readonly='readonly' id='encoded' name='encoded'>${intercepted}</textarea>`;
            }
            body += "<form method='post'><input type='password' name='password' /><input type='submit' value='Login' /></form></html>";
            write(res, 200, body);
            return;
          }
          if (securityLevel === 'medium') {
            if (req.method === 'POST') {
              const token = form['token'] ?? '';
              let verdict: string;
              if (token.length % 32 !== 0) {
                verdict = 'Token is in wrong format';
              } else {
                const decrypted = ecbDecrypt(token);
                if (decrypted === undefined) {
                  verdict = 'Decryption failed';
                } else {
                  try {
                    const parsed = JSON.parse(decrypted) as { user?: string; ex?: number; level?: string };
                    verdict =
                      parsed.user === 'sweep' && (parsed.ex ?? 0) > Math.floor(Date.now() / 1000) && parsed.level === 'admin'
                        ? 'Welcome administrator Sweep'
                        : 'Login successful but not as the right user.';
                  } catch {
                    verdict = 'Could not decode JSON object.';
                  }
                }
              }
              write(res, 200, `<html><div class='message'>${verdict}</div><form method='post'><textarea name='token'></textarea><input type='submit' /></form></html>`);
              return;
            }
            const validEx = String(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
            const sooty = ecbEncrypt(`{"user":"sooty","ex":${EXPIRED_EX},"level":"admin","bio":"Izzy wizzy let's get busy"}`);
            const sweep = ecbEncrypt(`{"user":"sweep","ex":${EXPIRED_EX},"level":"admin","bio":"Sweep the chimney"}`);
            const soo = ecbEncrypt(`{"user" : "soo","ex":${validEx},"level": "user","bio": "I won The Weakest Link"}`);
            write(
              res,
              200,
              `<html><p>Sooty (admin), session expired</p><textarea>${sooty}</textarea><p>Sweep (user), session expired</p><textarea>${sweep}</textarea><p>Soo (user), session valid</p><textarea>${soo}</textarea><form method='post'><textarea name='token'></textarea><input type='submit' /></form></html>`,
            );
            return;
          }
          if (securityLevel === 'high') {
            const tokenJson = `{"token": "${cbcEncrypt('userid:2')}", "iv": "${Buffer.from(CBC_IV, 'ascii').toString('base64')}"}`;
            write(res, 200, `<html><p>You have managed to steal the following token</p><textarea>${tokenJson}</textarea><form><textarea id='token'>${tokenJson}</textarea></form></html>`);
            return;
          }
          write(res, 200, '<html><p>Cryptography impossible</p></html>');
          return;
        }
        case '/vulnerabilities/cryptography/source/check_token_high.php': {
          if (req.method !== 'POST') {
            writeJson(res, 200, { status: 405, message: 'Method not supported' });
            return;
          }
          if (contentType !== 'application/json') {
            writeJson(res, 200, { status: 527, message: 'Content type must be application/json' });
            return;
          }
          let data: { token?: string; iv?: string };
          try {
            data = JSON.parse(rawBody.toString('utf8')) as { token?: string; iv?: string };
          } catch {
            writeJson(res, 200, { status: 522, message: 'Data in wrong format' });
            return;
          }
          if (data.token === undefined) {
            writeJson(res, 200, { status: 523, message: 'Missing token' });
            return;
          }
          if (data.iv === undefined) {
            writeJson(res, 200, { status: 524, message: 'Missing IV' });
            return;
          }
          const decrypted = cbcDecrypt(Buffer.from(data.token, 'base64'), Buffer.from(data.iv, 'base64'));
          if (decrypted === undefined) {
            writeJson(res, 200, { status: 526, message: 'Unable to decrypt token' });
            return;
          }
          const match = /^userid:(\d+)$/.exec(decrypted);
          if (match === null) {
            writeJson(res, 200, { status: 527, message: 'No user specified' });
            return;
          }
          const known: Record<string, { name: string; level: string }> = {
            '1': { name: 'Geoffery', level: 'admin' },
            '2': { name: 'Bungle', level: 'user' },
            '3': { name: 'Zippy', level: 'user' },
            '4': { name: 'George', level: 'user' },
          };
          const user = known[match[1] ?? ''];
          if (user === undefined) {
            writeJson(res, 200, { status: 525, message: 'User not found' });
            return;
          }
          writeJson(res, 200, { status: 200, user: user.name, level: user.level });
          return;
        }
        case '/vulnerabilities/api/v1/user': {
          writeJson(
            res,
            200,
            users.map((u) => ({ id: u.id, name: u.firstName, level: u.level, password: 'a'.repeat(64) })),
          );
          return;
        }
        case '/vulnerabilities/api/v2/user': {
          if (req.method === 'GET') {
            writeJson(res, 200, users.map((u) => ({ id: u.id, name: u.firstName, level: u.level })));
            return;
          }
          write(res, 405, 'Method not allowed');
          return;
        }
        default: {
          const apiUser = /^\/vulnerabilities\/api\/v2\/user\/(\d+)$/.exec(path);
          if (apiUser !== null) {
            const userId = Number(apiUser[1]);
            const user = users.find((u) => u.id === userId);
            if (req.method !== 'PUT' && req.method !== 'PATCH') {
              write(res, 405, 'Method not allowed');
              return;
            }
            if (user === undefined) {
              write(res, 404, 'User not found.');
              return;
            }
            try {
              const data = JSON.parse(rawBody.toString('utf8')) as { name?: string; level?: number };
              if (data.name !== undefined) {
                user.firstName = data.name;
              }
              // マスアサインメント脆弱性: リクエストに level が含まれていると権限まで書き換わる。
              if (data.level !== undefined) {
                user.level = data.level;
              }
              writeJson(res, 200, { id: user.id, name: user.firstName, level: user.level });
            } catch {
              write(res, 422, 'Invalid user object provided');
            }
            return;
          }
          if (path === '/vulnerabilities/api/v2/health/connectivity') {
            if (req.method !== 'POST') {
              write(res, 405, 'Method not allowed');
              return;
            }
            try {
              const data = JSON.parse(rawBody.toString('utf8')) as { target?: string };
              if (data.target === undefined) {
                writeJson(res, 500, { status: 'Target not specified' });
                return;
              }
              const target = data.target;
              // OSコマンドインジェクションを模倣する: シェル演算子以降をコマンドとして解釈し、
              // 実行結果（echo）と終了コード（true/false）を応答へ反映する。
              const output = [`PING ${target.split(' ')[0] ?? ''}: 56 data bytes`, '64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.1 ms'];
              let exitCode = target.includes('scopepilot-probe.invalid') ? 1 : 0;
              for (const separator of ['&&', ';', '|', '\n']) {
                const index = target.indexOf(separator);
                if (index < 0) {
                  continue;
                }
                const command = target.slice(index + separator.length).trim();
                if (command === 'true') {
                  exitCode = 0;
                  break;
                }
                if (command === 'false') {
                  exitCode = 1;
                  break;
                }
                if (command.startsWith('echo ')) {
                  output.push(command.slice(5).trim());
                  break;
                }
                exitCode = 1;
                break;
              }
              if (exitCode === 0) {
                writeJson(res, 200, { status: 'OK', reply: output });
              } else {
                writeJson(res, 500, { status: 'Connection failed' });
              }
              return;
            } catch {
              write(res, 500, 'Words not specified');
            }
            return;
          }
          const domScript = /^\/vulnerabilities\/xss_d\/source\/(low|medium|high)\.js$/.exec(path);
          if (domScript !== null) {
            const script =
              domScript[1] === 'low'
                ? "var lang = location.href.substring(location.href.indexOf('default=') + 8);\ndocument.write('<option>' + decodeURIComponent(lang) + '</option>');"
                : domScript[1] === 'medium'
                  ? 'document.write(document.location.hash.substring(1));'
                  : "var config = JSON.parse('{}');\nsetTimeout(function () { init(config); }, 0);";
            write(res, 200, script, { 'content-type': 'application/javascript' });
            return;
          }
          write(res, 404, 'Not Found');
        }
      }
    })().catch(() => {
      try {
        write(res, 500, 'server error');
      } catch {
        // 応答済みの場合は無視する。
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('failed to listen');
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    get securityLevel(): string {
      return securityLevel;
    },
    setSecurityLevel(level: string): void {
      securityLevel = level;
    },
    get loginAttempted(): boolean {
      return loginAttempted;
    },
    get currentPassword(): string {
      return currentPassword;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      server.closeAllConnections?.();
    },
  } as FakeDvwaServer & { loginAttempted: boolean; currentPassword: string };
}

function resolveLocalFile(path: string): string | undefined {
  // ディレクトリ巡回（../）を解決したうえで、既知のローカルファイルに一致するか判定する。
  const stack: string[] = [];
  for (const segment of path.split('/').filter((s) => s !== '')) {
    if (segment === '..') {
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  const normalized = `/${stack.join('/')}`;
  return normalized === '/etc/passwd' ? PASSWD_CONTENT : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function md5Hex(value: string): string {
  return createHash('md5').update(value, 'ascii').digest('hex');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('hex');
}

function rot13(value: string): string {
  return value.replace(/[a-zA-Z]/g, (ch) => {
    const base = ch <= 'Z' ? 65 : 97;
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
  });
}
