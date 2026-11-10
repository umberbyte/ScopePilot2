import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { canonicalJson } from '@scopepilot2/contracts';
import { analyzeClientAsset, assetHash, reviewJwt, validateComponentDatabase } from '../../../src/domain/client-review.ts';
import { discoveryFingerprint, extractAssetReferences, rankCandidates } from '../../../src/domain/exploration-discovery.ts';

const url = 'https://owned.test/main.js';
const analyze = (body: string) => analyzeClientAsset({ url, sourceUrl: 'https://owned.test/', contentType: 'application/javascript', body });
test('dependency declarations, typo candidates, unsafe call and pinned local ranges keep separate provenance', () => {
  const entries = [{ id: 'OWNED-1', name: 'jquery', introduced: '1.0.0', fixed: '3.5.0' }];
  const database = { source: 'owned-fixture', version: '1', entries, sha256: assetHash(canonicalJson(entries)) };
  const result = analyzeClientAsset({ url, sourceUrl: url, contentType: 'application/json', body: JSON.stringify({ dependencies: { jquery: '3.4.1', react: '^18.0.0', lodas: '1.0.0' } }), database })!;
  assert.ok(result.signals.some((s) => s.kind === 'component-db'));
  assert.ok(result.signals.some((s) => s.kind === 'typosquatting'));
  assert.equal(result.signals.find((s) => s.component?.name === 'react')?.component?.version, undefined);
  assert.ok(analyze('$(input).html(value)')!.signals.some((s) => s.kind === 'unsafe-api'));
  assert.throws(() => validateComponentDatabase({ ...database, version: '2', sha256: 'tampered' }));
  const fixed = analyzeClientAsset({ url, sourceUrl: url, contentType: 'text/plain', body: 'jquery v3.5.0', database })!;
  assert.equal(fixed.signals.some((s) => s.kind === 'component-db'), false);
});
test('source maps keep unknown versions; malformed and binary/oversized/cross-origin assets are excluded', () => {
  const map = analyze(JSON.stringify({ sources: ['webpack:///node_modules/@example/lib/index.js'] }))!;
  assert.equal(map.signals[0]?.component?.name, '@example/lib');
  assert.equal(map.signals[0]?.component?.version, undefined);
  assert.deepEqual(analyze('ordinary application text')!.signals, []);
  assert.equal(analyze('x'.repeat(1024 * 1024 + 1)), null);
  assert.equal(analyze('\0binary'), null);
  assert.equal(analyzeClientAsset({ url: 'https://other.test/a.js', sourceUrl: url, contentType: 'text/plain', body: 'jquery v1.0.0' }), null);
  assert.equal(analyzeClientAsset({ url: 'https://owned.test/a.exe', sourceUrl: url, contentType: 'text/plain', body: 'jquery v1.0.0' }), null);
});
test('secret canaries and JWT claims are redacted, plain strings and placeholders are negative controls', () => {
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
  const token = `${Buffer.from('{"alg":"none","kid":"secret-kid"}').toString('base64url')}.${Buffer.from('{"sub":"private-person"}').toString('base64url')}.`;
  const result = analyze(`${secret} ${token}`)!;
  assert.ok(result.signals.some((s) => s.kind === 'secret'));
  assert.ok(result.signals.some((s) => s.ruleId === 'jwt-none'));
  for (const value of [secret, token, 'private-person', 'secret-kid']) assert.equal(JSON.stringify(result).includes(value), false);
  assert.deepEqual(analyze(`ghp_${'a'.repeat(36)}`)!.signals, []);
  assert.deepEqual(reviewJwt('not-a-token'), []);
});
test('weak public key inspection records properties without key bytes', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const result = analyze(pem)!;
  assert.equal(result.signals[0]?.ruleId, 'weak-rsa-key');
  assert.equal(JSON.stringify(result).includes('BEGIN PUBLIC KEY'), false);
});
test('wildcard path echoes share a negative fingerprint without storing text', () => {
  assert.equal(discoveryFingerprint('Missing /admin/', 'https://owned.test/admin/'), discoveryFingerprint('Missing /.scopepilot-missing-7d4f92c1', 'https://owned.test/.scopepilot-missing-7d4f92c1'));
});

test('bounded references reject out-of-origin, wildcard, embedded code, and data URLs', () => {
  const links = extractAssetReferences('Disallow: /hidden\nDisallow: /*\nSitemap: https://other.test/map\n', 'https://owned.test/robots.txt');
  assert.deepEqual(links, [{ url: 'https://owned.test/hidden', source: 'robots' }]);
  assert.deepEqual(extractAssetReferences('//# sourceMappingURL=data:application/json,secret', url), []);
  assert.ok(extractAssetReferences('import("./chunk.js"); //# sourceMappingURL=main.js.map', url).length === 2);
  assert.equal(extractAssetReferences('<loc>/a</loc>'.repeat(500), url).length, 1);
});
test('ranking is stable, generic, explained and penalises transport and state changes', () => {
  const base = { candidateId: 'a', url, method: 'GET', category: 'api-endpoint' as const, guidelineBasis: ['script-api-call'], confidence: 0.8, observationUrl: url };
  const ranked = rankCandidates([{ ...base, candidateId: 'script', url: 'https://owned.test/api/items' }, { ...base, candidateId: 'observed', url: 'https://owned.test/api/items', guidelineBasis: ['observed-http:fetch'] }, { ...base, candidateId: 'write', method: 'DELETE' }, { ...base, candidateId: 'transport', url: 'https://owned.test/socket.io/' }]);
  assert.equal(ranked[0]?.candidateId, 'observed');
  assert.equal(ranked.at(-1)?.candidateId, 'transport');
  assert.ok(ranked.every((c) => c.scoreSignals?.length && c.provenance?.length));
  assert.deepEqual(rankCandidates([base, { ...base, candidateId: 'b' }]).map((c) => c.candidateId), ['a', 'b']);
});

test('weak JWT signing key and key confusion are offline observations; valid RSA signature stays distinct', async () => {
  const { createHmac, sign } = await import('node:crypto');
  const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
  const payload = Buffer.from('{"exp":2000000000}').toString('base64url');
  const message = `${header}.${payload}`;
  const token = `${message}.${createHmac('sha256', 'secret').update(message).digest('base64url')}`;
  assert.ok(reviewJwt(token).some((signal) => signal.ruleId === 'jwt-weak-key'));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const confusing = `${message}.${createHmac('sha256', pem).update(message).digest('base64url')}`;
  assert.ok(reviewJwt(confusing, pem).some((signal) => signal.ruleId === 'jwt-key-confusion'));
  const rsa = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${payload}`;
  assert.ok(reviewJwt(`${rsa}.${sign('RSA-SHA256', Buffer.from(rsa), privateKey).toString('base64url')}`, pem).some((signal) => signal.ruleId === 'jwt-signature' && signal.detail.startsWith('Signature matches')));
});
test('prerelease banners are not asserted as exact stable versions; header signatures use only named products', () => {
  assert.deepEqual(analyze('jquery v3.4.1-beta')!.signals, []);
  const result = analyzeClientAsset({ url, sourceUrl: url, contentType: 'text/plain', body: 'ordinary', headers: { server: 'nginx/1.2.3', 'x-powered-by': 'PHP/8.2.0' } })!;
  assert.equal(result.signals.filter((signal) => signal.kind === 'dependency').length, 2);
});
