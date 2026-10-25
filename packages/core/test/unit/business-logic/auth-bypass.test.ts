import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AUTH_BYPASS_LOGIN_PATTERNS,
  AUTH_BYPASS_MAX_TARGETS,
  AUTH_BYPASS_PAGE_PATTERNS,
  derivePasswordVariant,
  judgeLoginVariant,
  judgePageProbe,
  planAuthBypassCheck,
  sessionCookiesForPattern,
  summarizeAuthBypassOutcomes,
} from '@scopepilot2/core';
import type { LoginSessionCookie } from '@scopepilot2/core';

const COOKIES: readonly LoginSessionCookie[] = [
  { name: 'PHPSESSID', value: 'session-value', domain: 'fixture.target.test', path: '/' },
  { name: 'tracking', value: 't-1', domain: 'fixture.target.test', path: '/' },
];

function cookiesOf(pattern: Parameters<typeof sessionCookiesForPattern>[1]): readonly LoginSessionCookie[] | undefined {
  return sessionCookiesForPattern(COOKIES, pattern, new Set(['PHPSESSID']));
}

describe('auth bypass domain (ZAP非対応テーマ1)', () => {
  test('計画は対象URLを重複除去し、ページ4通り+ログイン3通りの所要数を返す', () => {
    const plan = planAuthBypassCheck({
      targetUrls: ['http://fixture.target.test/member', 'http://fixture.target.test/member', 'http://fixture.target.test/profile'],
      includeLoginVariants: true,
    });
    assert.deepEqual(plan.targetUrls, ['http://fixture.target.test/member', 'http://fixture.target.test/profile']);
    assert.deepEqual(plan.pagePatterns, [...AUTH_BYPASS_PAGE_PATTERNS]);
    assert.deepEqual(plan.loginPatterns, [...AUTH_BYPASS_LOGIN_PATTERNS]);
    assert.equal(plan.totalRequests, 2 * 4 + 3);
  });

  test('対象URLが空または上限超過なら validation error', () => {
    assert.throws(() => planAuthBypassCheck({ targetUrls: ['  '], includeLoginVariants: false }), /at least one/u);
    const tooMany = Array.from({ length: AUTH_BYPASS_MAX_TARGETS + 1 }, (_, index) => `http://fixture.target.test/p${index}`);
    assert.throws(() => planAuthBypassCheck({ targetUrls: tooMany, includeLoginVariants: false }), /at most/u);
  });

  test('cookie 書き換えは把握済み認証用 cookie だけを対象にする (無差別削除しない)', () => {
    const baseline = cookiesOf('session-baseline');
    assert.deepEqual(baseline, COOKIES);

    const emptied = cookiesOf('auth-cookie-emptied');
    assert.equal(emptied?.find((cookie) => cookie.name === 'PHPSESSID')?.value, '');
    assert.equal(emptied?.find((cookie) => cookie.name === 'tracking')?.value, 't-1');

    const removed = cookiesOf('auth-cookie-removed');
    assert.deepEqual(removed?.map((cookie) => cookie.name), ['tracking']);

    assert.equal(cookiesOf('no-session'), undefined);
  });

  test('password 派生値は空文字と1文字追加のみ (omitted は値を派生しない)', () => {
    assert.equal(derivePasswordVariant('password-emptied', 'secret-password'), '');
    assert.equal(derivePasswordVariant('password-plus-one-char', 'secret-password'), 'secret-passwordA');
    assert.throws(() => derivePasswordVariant('password-omitted', 'x'), /does not derive/u);
  });

  test('marker が応答に現れたら exposed、同一応答 hash も exposed とする', () => {
    const markers = ['Logout'];
    const exposedByMarker = judgePageProbe({
      markers,
      baseline: { status: 200, bodyHash: 'h-auth', markersFound: true },
      variant: { status: 200, finalUrl: 'http://fixture.target.test/member', targetUrl: 'http://fixture.target.test/member', bodyHash: 'h-other', markersFound: true },
    });
    assert.equal(exposedByMarker, 'exposed');

    const exposedByHash = judgePageProbe({
      markers: [],
      baseline: { status: 200, bodyHash: 'h-auth', markersFound: null as unknown as boolean },
      variant: { status: 200, finalUrl: 'http://fixture.target.test/member', targetUrl: 'http://fixture.target.test/member', bodyHash: 'h-auth', markersFound: false },
    });
    assert.equal(exposedByHash, 'exposed');
  });

  test('401/403・リダイレクト・marker 不在は denied、判定材料不足は inconclusive', () => {
    const markers = ['Logout'];
    const denied403 = judgePageProbe({
      markers,
      baseline: { status: 200, bodyHash: 'h-auth', markersFound: true },
      variant: { status: 403, finalUrl: 'http://fixture.target.test/member', targetUrl: 'http://fixture.target.test/member', bodyHash: 'h-403', markersFound: false },
    });
    assert.equal(denied403, 'denied');

    const deniedRedirect = judgePageProbe({
      markers,
      baseline: { status: 200, bodyHash: 'h-auth', markersFound: true },
      variant: { status: 200, finalUrl: 'http://fixture.target.test/login.php', targetUrl: 'http://fixture.target.test/member', bodyHash: 'h-login', markersFound: false },
    });
    assert.equal(deniedRedirect, 'denied');

    const deniedByMarker = judgePageProbe({
      markers,
      baseline: { status: 200, bodyHash: 'h-auth', markersFound: true },
      variant: { status: 200, finalUrl: 'http://fixture.target.test/member', targetUrl: 'http://fixture.target.test/member', bodyHash: 'h-other', markersFound: false },
    });
    assert.equal(deniedByMarker, 'denied');

    const inconclusiveWithoutMarkers = judgePageProbe({
      markers: [],
      baseline: { status: 200, bodyHash: 'h-auth', markersFound: null as unknown as boolean },
      variant: { status: 200, finalUrl: 'http://fixture.target.test/member', targetUrl: 'http://fixture.target.test/member', bodyHash: 'h-other', markersFound: false },
    });
    assert.equal(inconclusiveWithoutMarkers, 'inconclusive');

    const inconclusiveBaseline = judgePageProbe({
      markers,
      baseline: { status: 200, bodyHash: 'h-auth', markersFound: false },
      variant: { status: 200, finalUrl: 'http://fixture.target.test/member', targetUrl: 'http://fixture.target.test/member', bodyHash: 'h-auth', markersFound: false },
    });
    assert.equal(inconclusiveBaseline, 'inconclusive');
  });

  test('ログイン変種は認証成功を exposed、失敗を denied とする', () => {
    assert.equal(judgeLoginVariant(true), 'exposed');
    assert.equal(judgeLoginVariant(false), 'denied');
  });

  test('全体結果は exposed 優先、inconclusive 残存は inconclusive', () => {
    assert.equal(summarizeAuthBypassOutcomes(['denied', 'exposed', 'denied']).status, 'fail');
    assert.equal(summarizeAuthBypassOutcomes(['denied', 'inconclusive']).status, 'inconclusive');
    assert.equal(summarizeAuthBypassOutcomes(['denied', 'denied']).status, 'pass');
    assert.equal(summarizeAuthBypassOutcomes([]).status, 'inconclusive');
  });
});
