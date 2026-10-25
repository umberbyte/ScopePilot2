import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { observeLoginPage } from '../../src/main/login-page-observer.ts';

describe('login page observer', () => {
  test('リダイレクト後のフォームを観測し、秘密値を含めず一意なselector候補を返す', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/') {
        response.writeHead(302, { Location: '/login' });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="ja"><head><title>管理画面ログイン</title></head><body>
        <form id="login-form" method="post" action="/session">
          <label for="account">ユーザー名</label><input id="account" name="account" autocomplete="username" value="do-not-leak">
          <label for="secret">パスワード</label><input id="secret" name="secret" type="password" autocomplete="current-password" value="do-not-leak-either">
          <input type="hidden" name="csrf" value="private-token">
          <button name="login" type="submit">ログイン</button>
        </form></body></html>`);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, 'object');
    const origin = `http://127.0.0.1:${(address as { port: number }).port}`;
    try {
      const snapshot = await observeLoginPage(`${origin}/`, [origin]);
      assert.equal(snapshot.finalUrl, `${origin}/login`);
      assert.equal(snapshot.title, '管理画面ログイン');
      assert.equal(snapshot.forms[0]?.method, 'POST');
      assert.equal(snapshot.controls.length, 3);
      assert.deepEqual(snapshot.controls.map((control) => control.label), ['ユーザー名', 'パスワード', '']);
      assert.ok(snapshot.controls[0]?.selectorCandidates.includes('#account'));
      assert.ok(snapshot.controls[1]?.selectorCandidates.includes('input[autocomplete="current-password"]'));
      assert.ok(snapshot.controls[2]?.selectorCandidates.includes('button[name="login"]'));
      assert.doesNotMatch(JSON.stringify(snapshot), /do-not-leak|private-token/u);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
