import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_CREDENTIAL_PAIRS_MAX,
  INPUT_ROBUSTNESS_PAYLOADS,
  LOCKOUT_MAX_FAILURES,
  PASSWORD_POLICY_CONTROL,
  RESET_TOKEN_PATTERNS,
  WEAK_PASSWORD_CANDIDATES,
  ZAP_UNSUPPORTED_IMPLEMENTED_THEMES,
  assertRequestBudget,
  countNucleiMatches,
  findMixedContent,
  findSerializationSignature,
  findSensitiveUrlParamNames,
  forgeResetToken,
  judgeCorsPreflight,
  judgeCorsResponse,
  judgeInputRobustness,
  judgeIdorAccess,
  judgeLockout,
  judgeMassAssignment,
  judgeNucleiSpot,
  judgePasswordEcho,
  judgePiiExposure,
  judgePlainHttp,
  judgeReplay,
  judgeSensitiveCache,
  judgeUserEnumeration,
  mergeJsonFields,
  normalizeEnumerationResponse,
  parseDefaultCredentialPairs,
  parseExtraFieldsJson,
  planIdorProbes,
  planLockoutSequence,
  planReplayCount,
  requireImplementedTheme,
  substituteObjectParam,
  summarizeThemeOutcomes,
  validateSpotTemplateIds,
} from '@scopepilot2/core';

describe('zap-unsupported domain (Top10 対象テーマ共通)', () => {
  test('実装テーマ一覧は Top10 対象 15 テーマ (困難観点は除外済み)', () => {
    assert.deepEqual([...ZAP_UNSUPPORTED_IMPLEMENTED_THEMES], ['1', '2', '3', '4', '5', '7', '10', '11', '13', '18', '20', '21', '22', '23', '29']);
    assert.equal(requireImplementedTheme('13'), '13');
    assert.throws(() => requireImplementedTheme('6'), /not implemented/u);
    assert.throws(() => requireImplementedTheme('999'), /not implemented/u);
  });

  test('送信数が案件上限を超える計画は validation error', () => {
    assertRequestBudget(10, 10, '2');
    assert.throws(() => assertRequestBudget(11, 10, '2'), /exceeds the case limit/u);
  });

  test('テーマ2: 既定資格組は user:pass 形式・重複除去・上限検査 (空 password 可)', () => {
    const pairs = parseDefaultCredentialPairs(['admin:admin', 'admin:admin', 'admin:', 'root:toor']);
    assert.deepEqual(pairs, [
      { username: 'admin', password: 'admin' },
      { username: 'admin', password: '' },
      { username: 'root', password: 'toor' },
    ]);
    assert.throws(() => parseDefaultCredentialPairs(['no-separator']), /username:password/u);
    assert.throws(() => parseDefaultCredentialPairs(['   ']), /requires default credential pairs/u);
    const many = Array.from({ length: DEFAULT_CREDENTIAL_PAIRS_MAX + 1 }, (_, index) => `u${String(index)}:p`);
    assert.throws(() => parseDefaultCredentialPairs(many), /capped/u);
  });

  test('テーマ3: 弱いパスワード候補は IPA検出パターンを含む。応答露出は boolean 判定', () => {
    assert.ok(WEAK_PASSWORD_CANDIDATES.includes(''));
    assert.ok(WEAK_PASSWORD_CANDIDATES.includes('1234567'));
    assert.ok(WEAK_PASSWORD_CANDIDATES.includes('abcdefg'));
    assert.ok(WEAK_PASSWORD_CANDIDATES.includes('abcd123'));
    assert.equal(PASSWORD_POLICY_CONTROL, 'Rf@9yY8&wk');
    assert.equal(judgePasswordEcho(true), 'exposed');
    assert.equal(judgePasswordEcho(false), 'denied');
  });

  test('テーマ4: token 変種は 空・forge・省略 の3通り。forge 値は決定的', () => {
    assert.deepEqual([...RESET_TOKEN_PATTERNS], ['token-emptied', 'token-forged', 'token-omitted']);
    assert.equal(forgeResetToken(), forgeResetToken());
    assert.notEqual(forgeResetToken(), '');
  });

  test('テーマ5: 連続失敗回数は 1..20 に制限 (大量試験は対象外)', () => {
    assert.deepEqual(planLockoutSequence(3), ['wrong-1', 'wrong-2', 'wrong-3']);
    assert.throws(() => planLockoutSequence(0), /1..20/u);
    assert.throws(() => planLockoutSequence(LOCKOUT_MAX_FAILURES + 1), /1..20/u);
    assert.throws(() => planLockoutSequence(Number.NaN), /1..20/u);
    assert.equal(judgeLockout('authenticated'), 'exposed');
    assert.equal(judgeLockout('rejected'), 'denied');
    assert.equal(judgeLockout('errored'), 'inconclusive');
  });

  test('テーマ7: 応答差があれば列按可能 (exposed)。完全一致は denied', () => {
    const same = { status: 200, finalUrl: 'http://t.test/login', bodyHash: 'h1' };
    assert.equal(judgeUserEnumeration(same, same), 'denied');
    assert.equal(judgeUserEnumeration(same, { ...same, bodyHash: 'h2' }), 'exposed');
    assert.equal(judgeUserEnumeration(same, { ...same, status: 404 }), 'exposed');
    assert.equal(judgeUserEnumeration(same, { ...same, finalUrl: 'http://t.test/login?err=2' }), 'exposed');
    assert.equal(judgeUserEnumeration({ ...same, averageElapsedMs: 100 }, { ...same, averageElapsedMs: 450 }, 250), 'exposed');
    assert.equal(
      normalizeEnumerationResponse('<input name="csrf" value="abcdef1234567890">'),
      normalizeEnumerationResponse('<input name="csrf" value="fedcba0987654321">'),
    );
  });

  test('テーマ10: object param の差し替えと probe 計画 (他オブジェクトは最大3)', () => {
    const url = substituteObjectParam('http://t.test/item?id=1&lang=ja', 'id', '42');
    assert.equal(url, 'http://t.test/item?id=42&lang=ja');
    assert.equal(substituteObjectParam('http://t.test/item', 'id', '9'), 'http://t.test/item?id=9');
    const planned = planIdorProbes({ targetUrl: 'http://t.test/item?id=1', objectParam: 'id', ownValue: '1', otherValues: ['2', '3'] });
    assert.equal(planned.length, 5);
    assert.equal(planned[0]?.pattern, 'own-object-baseline');
    assert.ok(planned[1]?.pattern.startsWith('other-object-authorized:'));
    assert.ok(planned[2]?.pattern.startsWith('other-object-candidate:'));
    assert.throws(() => planIdorProbes({ targetUrl: 'http://t.test/item', objectParam: '', ownValue: '1', otherValues: ['2'] }), /objectParam/u);
    assert.throws(() => planIdorProbes({ targetUrl: 'http://t.test/item', objectParam: 'id', ownValue: '1', otherValues: [] }), /otherValues/u);
    assert.throws(() => planIdorProbes({ targetUrl: 'http://t.test/item', objectParam: 'id', ownValue: '1', otherValues: ['2', '3', '4', '5'] }), /otherValues/u);
    const authorized = { status: 200, finalUrl: 'http://t.test/item?id=2', bodyHash: 'other-object' };
    assert.equal(judgeIdorAccess({ authorized, candidate: authorized }), 'exposed');
    assert.equal(judgeIdorAccess({ authorized, candidate: { ...authorized, status: 403, bodyHash: 'denied' } }), 'denied');
    assert.equal(judgeIdorAccess({ authorized, candidate: { ...authorized, bodyHash: 'different' } }), 'inconclusive');
  });

  test('テーマ11: JSON body への field merge と判定 (拒否=denied・受理=疑い)', () => {
    assert.equal(mergeJsonFields('{"name":"a"}', { role: 'admin', price: 1 }), '{"name":"a","role":"admin","price":1}');
    assert.throws(() => mergeJsonFields('[1,2]', { role: 'admin' }), /JSON object/u);
    assert.throws(() => mergeJsonFields('{bad', {}), void 0);
    assert.deepEqual(Object.keys(parseExtraFieldsJson('{"role":"admin"}')), ['role']);
    assert.throws(() => parseExtraFieldsJson('{}'), /non-empty JSON object/u);
    assert.equal(judgeMassAssignment({ variantStatus: 400 }), 'denied');
    assert.equal(judgeMassAssignment({ variantStatus: 200 }), 'inconclusive');
    assert.equal(judgeMassAssignment({ variantStatus: 200, successMarker: 'updated', markerFound: true }), 'exposed');
    assert.equal(judgeMassAssignment({ variantStatus: 200, successMarker: 'updated', markerFound: false }), 'denied');
    assert.equal(judgeMassAssignment({ variantStatus: 200, successMarker: 'updated' }), 'inconclusive');
  });

  test('テーマ13: ACAO の origin 反射・wildcard+credentials が exposed。無反射は denied', () => {
    assert.equal(judgeCorsResponse({ requestOrigin: 'https://evil.example', acao: 'https://evil.example', acac: 'true', credentialsSent: true }), 'exposed');
    assert.equal(judgeCorsResponse({ requestOrigin: 'https://evil.example', acao: '*', acac: 'true', credentialsSent: true }), 'inconclusive');
    assert.equal(judgeCorsResponse({ requestOrigin: 'https://evil.example', acao: '*', acac: null, credentialsSent: true }), 'denied');
    assert.equal(judgeCorsResponse({ requestOrigin: 'https://evil.example', acao: 'https://evil.example', acac: 'true', credentialsSent: false }), 'inconclusive');
    assert.equal(judgeCorsResponse({ requestOrigin: 'https://evil.example', acao: 'https://good.example', acac: null, credentialsSent: true }), 'denied');
    assert.equal(judgeCorsResponse({ requestOrigin: 'https://evil.example', acao: null, acac: null, credentialsSent: true }), 'denied');
    assert.equal(judgeCorsPreflight({ requestOrigin: 'https://evil.example', requestMethod: 'GET', acao: 'https://evil.example', acaom: 'GET,POST' }), 'inconclusive');
    assert.equal(judgeCorsPreflight({ requestOrigin: 'https://evil.example', requestMethod: 'GET', acao: null, acaom: null }), 'denied');
    assert.equal(judgeCorsPreflight({ requestOrigin: 'https://evil.example', requestMethod: 'GET', acao: null, acaom: 'GET' }), 'inconclusive');
  });

  test('テーマ18: 直列化署名を検出し、snippet は固定長に切り詰める', () => {
    const found = findSerializationSignature('x rO0AB kB ....');
    assert.equal(found?.name, 'java-base64');
    assert.ok((found?.snippet.length ?? 0) <= 40);
    assert.equal(findSerializationSignature('<html>ok</html>'), null);
    assert.notEqual(findSerializationSignature('!!python/object new'), null);
    assert.equal(findSerializationSignature('payload=a:2:{i:0;s:1:"x";}')?.name, 'php-array');
  });

  test('テーマ20: 再送回数は 2..5。marker 全成立=exposed・全不成立=denied・無 marker は応答差で判断', () => {
    assert.equal(planReplayCount(2), 2);
    assert.throws(() => planReplayCount(1), /2..5/u);
    assert.throws(() => planReplayCount(6), /2..5/u);
    const hit = { status: 200, bodyHash: 'h1', markerFound: true };
    const miss = { status: 200, bodyHash: 'h1', markerFound: false };
    assert.equal(judgeReplay({ responses: [hit, hit, hit], successMarker: 'applied' }), 'exposed');
    assert.equal(judgeReplay({ responses: [miss, miss], successMarker: 'applied' }), 'denied');
    assert.equal(judgeReplay({ responses: [hit, miss], successMarker: 'applied' }), 'inconclusive');
    const identical = { status: 200, bodyHash: 'h1' };
    assert.equal(judgeReplay({ responses: [identical, identical] }), 'inconclusive');
    assert.equal(judgeReplay({ responses: [identical, { status: 200, bodyHash: 'h2' }] }), 'exposed');
  });

  test('テーマ21: 堃牢性 payload は境界値・型・長大文字列を含む。5xx のみ exposed', () => {
    assert.ok(INPUT_ROBUSTNESS_PAYLOADS.includes('-1'));
    assert.ok(INPUT_ROBUSTNESS_PAYLOADS.includes(''));
    assert.ok(INPUT_ROBUSTNESS_PAYLOADS.some((value) => value.length >= 500 && value.length < 1_000));
    assert.equal(judgeInputRobustness(500), 'exposed');
    assert.equal(judgeInputRobustness(503), 'exposed');
    assert.equal(judgeInputRobustness(400), 'denied');
    assert.equal(judgeInputRobustness(200), 'inconclusive');
  });

  test('テーマ22: スポット template id は 1..20・重複除去。match 行のみ計上', () => {
    assert.deepEqual(validateSpotTemplateIds(['tls-old ', 'tls-old', '']), ['tls-old']);
    assert.throws(() => validateSpotTemplateIds([]), /1..20/u);
    assert.throws(() => validateSpotTemplateIds(Array.from({ length: 21 }, (_, i) => `t${String(i)}`)), /1..20/u);
    const line = JSON.stringify({ 'template-id': 'tls-old', 'matched-at': 'http://t.test', info: { severity: 'high' } });
    assert.equal(countNucleiMatches([line, 'not-json', '{}']), 1);
    assert.equal(judgeNucleiSpot(1), 'exposed');
    assert.equal(judgeNucleiSpot(0), 'denied');
  });

  test('テーマ23: 平文 200 同一 URL=exposed。redirect・4xx=denied。混在は http:// 参照で判定', () => {
    assert.equal(judgePlainHttp({ status: 200, finalUrl: 'http://t.test/', targetUrl: 'http://t.test/' }), 'exposed');
    assert.equal(judgePlainHttp({ status: 301, finalUrl: 'https://t.test/', targetUrl: 'http://t.test/' }), 'denied');
    assert.equal(judgePlainHttp({ status: 404, finalUrl: 'http://t.test/', targetUrl: 'http://t.test/' }), 'denied');
    assert.equal(findMixedContent('<img src="http://t.test/a.png">'), true);
    assert.equal(findMixedContent('<img src="https://t.test/a.png">'), false);
    assert.equal(findMixedContent("<a href='http://t.test/x'>x</a>"), false);
    assert.equal(findMixedContent("<form action='http://t.test/login'>"), true);
  });

  test('テーマ29: PII 疑い node が1つでもあれば exposed', () => {
    assert.equal(judgePiiExposure(1), 'inconclusive');
    assert.equal(judgePiiExposure(1, 1), 'exposed');
    assert.equal(judgePiiExposure(0), 'denied');
    assert.deepEqual(findSensitiveUrlParamNames('https://t.test/page?token=x&lang=ja&password=y'), ['token', 'password']);
    assert.equal(judgeSensitiveCache('private, no-store'), 'denied');
    assert.equal(judgeSensitiveCache('private'), 'exposed');
    assert.equal(judgeSensitiveCache(null), 'exposed');
  });

  test('未実施観点が残る場合は検出なしでも pass にしない', () => {
    assert.equal(summarizeThemeOutcomes(['denied'], []).status, 'pass');
    assert.equal(summarizeThemeOutcomes(['denied'], ['not covered']).status, 'inconclusive');
    assert.equal(summarizeThemeOutcomes(['exposed'], ['not covered']).status, 'fail');
  });
});
