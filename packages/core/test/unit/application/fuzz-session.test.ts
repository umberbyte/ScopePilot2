import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoginExecutionInput, LoginExecutorPort, LoginSessionCookie } from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

/** fuzz session の service 経路 (design/f05)。組合せ上限・cluster 集約・供給元登録。 */
describe('fuzz session (service)', () => {
  test('payload 集合は供給元・版・license なしでは登録できない', async () => {
    const { service, operator } = await bootstrapFlow();
    assert.throws(
      () =>
        service.registerPayloadSet(operator, {
          name: 'sqli',
          source: '',
          version: '1',
          license: 'MIT',
          sha256: 'abc',
          values: ["' OR '1'='1"],
        }),
      /payload set field source is required/,
    );
    const registered = service.registerPayloadSet(operator, {
      name: 'sqli',
      source: 'fixture-handbook',
      version: '1.0.0',
      license: 'MIT',
      sha256: 'abc123',
      values: ["' OR '1'='1", "' OR '1'='2"],
    });
    assert.equal(registered.valueCount, 2);
    assert.deepEqual(
      service.listPayloadSets().map((set) => set.name),
      ['sqli'],
    );
  });

  test('fuzz session は組合せを実行し cluster 集約を返す。上限超過は送信前に拒否', async () => {
    const { service, operator } = await bootstrapFlow();
    const result = await service.runFuzzSession(operator, {
      targetUrl: 'http://fixture.target.test/fuzz',
      positions: [
        { name: 'user', values: ['admin', 'guest'] },
        { name: 'id', values: ['1', '2', '3'] },
      ],
    });
    assert.equal(result.total, 6);
    assert.equal(result.sent, 6);
    // fixture 応答は先頭 position の値だけで決まるため 2 cluster (各 3 member)。
    assert.equal(result.clusters.length, 2);
    assert.deepEqual(result.clusters[0]?.members.length, 3);
    assert.ok(result.clusters.every((cluster) => cluster.representative.length === 2));

    // 組合せ上限 (maxRequests) 超過は送信前に拒否 (F05-UT-001)。
    await assert.rejects(
      service.runFuzzSession(operator, {
        targetUrl: 'http://fixture.target.test/fuzz',
        positions: [
          { name: 'a', values: ['1', '2', '3', '4', '5'] },
          { name: 'b', values: ['1', '2', '3', '4', '5'] },
        ],
        maxRequests: 10,
      }),
      /combination count 25 exceeds plan limit 10/,
    );

    // scope 外 URL は拒否。
    await assert.rejects(
      service.runFuzzSession(operator, { targetUrl: 'http://elsewhere.example/fuzz', positions: [{ name: 'a', values: ['1'] }] }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        return true;
      },
    );
  });

  test('role 指定の fuzz は session cookie を適用する。未登録 role は拒否 (design/08)', async () => {
    const executor = new (class implements LoginExecutorPort {
      readonly engineVersion = 'fake-login-1';
      nextCookies: readonly LoginSessionCookie[] = [{ name: 'PHPSESSID', value: 'session-value', domain: 'fixture.target.test', path: '/' }];
      async execute(
        input: LoginExecutionInput,
      ): Promise<{ authenticated: boolean; finalUrl: string; cookies: readonly LoginSessionCookie[] }> {
        return { authenticated: true, finalUrl: 'http://fixture.target.test/', cookies: [...this.nextCookies] };
      }
    })();
    const { service, operator } = await bootstrapFlow({ loginExecutor: executor });
    service.registerLoginFlow(operator, {
      role: 'admin',
      flowVersion: 'f1',
      steps: [
        { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
        { kind: 'fill', target: '#u', secretReference: 'vault://admin-user' },
        { kind: 'fill', target: '#p', secretReference: 'vault://admin-pass' },
        { kind: 'click', target: 'input[type=submit]' },
        { kind: 'assert', target: 'Welcome' },
      ],
    });
    await service.runLogin(operator, {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });

    const result = await service.runFuzzSession(operator, {
      targetUrl: 'http://fixture.target.test/fuzz',
      positions: [{ name: 'user', values: ['admin', 'guest'] }],
      role: 'admin',
    });
    assert.equal(result.sent, 2);
    assert.deepEqual(result.sessionCookieNames, ['PHPSESSID'], '適用 cookie は名前のみ');
    assert.equal(JSON.stringify(result).includes('session-value'), false, 'cookie 値は応答に出ない');

    // role 未指定は session なし。
    const plain = await service.runFuzzSession(operator, {
      targetUrl: 'http://fixture.target.test/fuzz',
      positions: [{ name: 'user', values: ['admin', 'guest'] }],
    });
    assert.equal(plain.sessionCookieNames, undefined);

    // 未登録 role は拒否。
    await assert.rejects(
      service.runFuzzSession(operator, { targetUrl: 'http://fixture.target.test/fuzz', positions: [{ name: 'a', values: ['1'] }], role: 'ghost' }),
      /no session for role/,
    );

    // 別 origin の domain を持つ cookie は適用対象から除外される。
    executor.nextCookies = [{ name: 'OTHER', value: 'v', domain: 'elsewhere.example', path: '/' }];
    await service.runLogin(operator, {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });
    const filtered = await service.runFuzzSession(operator, {
      targetUrl: 'http://fixture.target.test/fuzz',
      positions: [{ name: 'a', values: ['1'] }],
      role: 'admin',
    });
    assert.deepEqual(filtered.sessionCookieNames, [], '別 Origin の cookie は適用しない');
  });
});
