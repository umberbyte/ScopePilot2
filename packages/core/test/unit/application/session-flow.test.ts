import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

/** session 管理の service 経路 (design/f09)。flow 登録検証・refresh・cookie jar 非共有。 */
describe('session management (service)', () => {
  test('login flow を登録し refresh で revision が進む。secret 値は受け付けない', async () => {
    const { service, operator } = await bootstrapFlow();
    const registered = service.registerLoginFlow(operator, {
      role: 'admin',
      flowVersion: 'flow-1',
      steps: [
        { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
        { kind: 'fill', target: '#username', secretReference: 'vault://admin-user' },
        { kind: 'click', target: 'input[type=submit]' },
      ],
    });
    assert.equal(registered.stepCount, 3);
    assert.deepEqual(registered.secretReferences, [{ flowVersion: 'flow-1', secretReference: 'vault://admin-user' }]);

    // secret 値の持ち込み (secretValue) は最初から拒否。
    assert.throws(
      () =>
        service.registerLoginFlow(operator, {
          role: 'admin2',
          flowVersion: 'flow-2',
          steps: [{ kind: 'fill', target: '#user', secretReference: 'vault://x' }, { kind: 'click', secretValue: 'password123' } as never],
        }),
      /inline secret values are not accepted/,
    );

    const refreshed = await service.refreshSession(operator, 'admin');
    assert.equal(refreshed.outcome, 'refreshed');
    assert.equal(refreshed.sessionRevision, 1);
    assert.deepEqual(
      service.listSessions().map((session) => ({ role: session.role, revision: session.sessionRevision, stepCount: session.stepCount })),
      [{ role: 'admin', revision: 1, stepCount: 3 }],
    );
  });

  test('role 間で cookie jar を共有しない (F09-UT-005 の経路)', async () => {
    const { service, operator } = await bootstrapFlow();
    service.registerLoginFlow(operator, { role: 'admin', flowVersion: 'f', steps: [{ kind: 'navigate' }] });
    service.registerLoginFlow(operator, { role: 'guest', flowVersion: 'f', steps: [{ kind: 'navigate' }] });

    const first = service.assignRoleCookies(operator, 'admin', ['PHPSESSID', 'admin_csrf']);
    assert.equal(first.shared, false);
    // guest が admin と同名 cookie を使うと共有警告。
    const shared = service.assignRoleCookies(operator, 'guest', ['PHPSESSID']);
    assert.equal(shared.shared, true);
    // 独自 cookie なら共有なし。
    const separate = service.assignRoleCookies(operator, 'guest', ['guest_sid']);
    assert.equal(separate.shared, false);

    // 未登録 role への refresh は 400。
    await assert.rejects(service.refreshSession(operator, 'unknown-role'), /is not registered/);
  });
});
