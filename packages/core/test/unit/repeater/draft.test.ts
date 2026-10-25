import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applicableSessionCookies,
  applyEdit,
  DraftRegistry,
  recordSendAttempt,
  runRedirects,
  sendCommand,
  summarizeResponse,
} from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';
import { hashStable } from '@scopepilot2/contracts';

const scope = { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] };

function draft(registry: DraftRegistry, id = 'd1') {
  return registry.create({
    draftId: id,
    baseExchangeId: 'ev-1',
    protocol: 'http/1.1',
    requestBytes: 'GET / HTTP/1.1\nHost: fixture.target.test\n\n',
    targetUrl: 'http://fixture.target.test/',
  });
}

describe('applicableSessionCookies (design/08: 別 Origin への認証送信は拒否)', () => {
  test('対象 URL の host/path に一致する cookie だけを適用する', () => {
    const cookies = [
      { name: 'PHPSESSID', value: 'v1', domain: 'fixture.target.test', path: '/' },
      { name: 'OTHER', value: 'v2', domain: 'elsewhere.example', path: '/' },
      { name: 'PATHED', value: 'v3', domain: 'fixture.target.test', path: '/app/' },
      { name: 'DOTED', value: 'v4', domain: '.fixture.target.test', path: '/' },
    ];
    assert.deepEqual(
      applicableSessionCookies(cookies, 'http://fixture.target.test/app/page?q=1').map((cookie) => cookie.name),
      ['PHPSESSID', 'PATHED', 'DOTED'],
    );
    // 親 domain への host 一致 (sub.fixture.target.test は fixture.target.test の cookie を適用)。
    assert.deepEqual(
      applicableSessionCookies(cookies, 'http://sub.fixture.target.test/other').map((cookie) => cookie.name),
      ['PHPSESSID', 'DOTED'],
    );
  });
});

describe('RepeaterDraft', () => {
  test('[F04-UT-001] 21 tab 目の作成は拒否する', () => {
    const registry = new DraftRegistry();
    for (let index = 1; index <= 20; index += 1) {
      registry.create({ draftId: `d${index}`, baseExchangeId: 'ev', protocol: 'http/1.1', requestBytes: '', targetUrl: 'http://fixture.target.test/' });
    }
    assert.throws(() => registry.create({ draftId: 'd21', baseExchangeId: 'ev', protocol: 'http/1.1', requestBytes: '', targetUrl: 'http://fixture.target.test/' }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /tab limit/);
      return true;
    });
  });

  test('[F04-UT-002] header/body 編集は canonical bytes と新 revision を作る', () => {
    const registry = new DraftRegistry();
    const target = draft(registry);
    const first = applyEdit(target, { headers: [['X-Test', '1']], body: 'a' });
    const second = applyEdit(target, { headers: [['X-Test', '2']], body: 'a' });
    assert.equal(target.revision, 3);
    assert.equal(first.revision, 2);
    assert.notEqual(first.requestBytes, second.requestBytes);
    assert.match(first.requestBytes, /X-Test: 1/);
  });

  test('[F04-UT-003] confirmation hash 不一致は adapter を呼ばない', async () => {
    const registry = new DraftRegistry();
    const target = draft(registry);
    const calls: number[] = [];
    const result = await sendCommand(target, 'wrong-hash', { send: async () => { calls.push(1); } });
    assert.deepEqual(result, { sent: false });
    assert.equal(calls.length, 0);

    const correct = hashStable('scopepilot2.repeater.request', { bytes: target.requestBytes, revision: target.revision, target: target.targetUrl });
    const ok = await sendCommand(target, correct, { send: async () => { calls.push(1); } });
    assert.deepEqual(ok, { sent: true });
    assert.equal(calls.length, 1);
  });
});

describe('RedirectRunner', () => {
  test('[F04-UT-004] scope 外 Location は hop 前に停止する', () => {
    const result = runRedirects(
      [
        { location: 'http://fixture.target.test/next' },
        { location: 'http://elsewhere.example/leak' },
      ],
      scope,
    );
    assert.equal(result.outcome, 'stopped-out-of-scope');
    assert.equal(result.followed, 1);
    assert.match(result.lastReason ?? '', /not in allowed origins/);
  });

  test('[F04-UT-005] 11 hop 目は limit error として扱う', () => {
    const hops = Array.from({ length: 11 }, (_, i) => ({ location: `http://fixture.target.test/hop-${i}` }));
    const result = runRedirects(hops, scope);
    assert.equal(result.outcome, 'limit');
    assert.equal(result.followed, 10);
    assert.match(result.lastReason ?? '', /exceed 10/);
    assert.equal(runRedirects(hops.slice(0, 10), scope).outcome, 'completed');
  });
});

describe('ResponseSummary / SendAttempt', () => {
  test('[F04-UT-006] binary body は text 化せず metadata のみ', () => {
    const summary = summarizeResponse({
      status: 200,
      headers: [['Content-Type', 'application/octet-stream']],
      body: Buffer.from([0x00, 0x01, 0xff, 0xfe]),
    });
    assert.deepEqual(summary, { status: 200, contentType: 'application/octet-stream', bodyBytes: 4 });
    const text = summarizeResponse({ status: 200, headers: [['Content-Type', 'text/html']], body: Buffer.from('<html>') });
    assert.equal(text.bodyPreview, '<html>');
  });

  test('[F04-UT-007] timeout は response なしの attempt として保存し、成功 response を捏造しない', () => {
    const timeout = recordSendAttempt('d1', null);
    assert.equal(timeout.outcome, 'timeout');
    assert.equal(timeout.responseHash, undefined);
    const responded = recordSendAttempt('d1', Buffer.from('HTTP/1.1 200 OK'));
    assert.equal(responded.outcome, 'responded');
    assert.match(responded.responseHash ?? '', /^[0-9a-f]{64}$/);
  });
});
