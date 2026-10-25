import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoginExecutionInput, LoginExecutorPort, LoginSessionCookie } from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

/** Repeater の service 経路 (design/f04)。hash 一致送信・不一致不送信・scope 拒否。 */
describe('repeater flow (service)', () => {
  test('draft を作成・編集し、表示 hash 一致でだけ送信される', async () => {
    const { service, operator } = await bootstrapFlow();
    const draft = service.createRepeaterDraft(operator, { targetUrl: 'http://fixture.target.test/page', protocol: 'http/1.1' });
    assert.equal(draft.revision, 1);
    assert.ok(draft.planHash.length > 0);

    const edited = service.editRepeaterDraft(operator, draft.draftId, { headers: [['X-Test', '1']], body: 'hello' });
    assert.equal(edited.revision, 2);
    assert.notEqual(edited.planHash, draft.planHash, '編集で hash が変わる');

    // 古い hash では送信されない (F02-UT-003 と同じ意味論の service 経路)。
    const stale = await service.sendRepeaterDraft(operator, draft.draftId, draft.planHash);
    assert.equal(stale.sent, false);
    assert.match(stale.reason ?? '', /does not match/);
    assert.equal(service.repeaterAttemptLog().length, 0, '不一致時は attempt も残らない');

    // 現行 hash では送信され、応答 summary と attempt が返る。
    const sent = await service.sendRepeaterDraft(operator, draft.draftId, edited.planHash);
    assert.equal(sent.sent, true);
    assert.equal(sent.response?.status, 200);
    assert.equal(sent.attempt?.outcome, 'responded');
    assert.equal(service.repeaterAttemptLog().length, 1);
  });

  test('scope 外 URL の draft は作成を拒否される', async () => {
    const { service, operator } = await bootstrapFlow();
    assert.throws(
      () => service.createRepeaterDraft(operator, { targetUrl: 'http://elsewhere.example/x', protocol: 'http/1.1' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        return true;
      },
    );
  });

  test('role 指定の送信は session cookie を適用する。未登録 role は拒否 (design/08)', async () => {
    const executor = new (class implements LoginExecutorPort {
      readonly engineVersion = 'fake-login-1';
      nextCookies: readonly LoginSessionCookie[] = [{ name: 'PHPSESSID', value: 'session-value', domain: 'fixture.target.test', path: '/' }];
      async execute(
        input: LoginExecutionInput,
      ): Promise<{ authenticated: boolean; finalUrl: string; cookies: readonly LoginSessionCookie[] }> {
        assert.equal(input.secretValues['vault://admin-pass'], 'password123');
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

    const draft = service.createRepeaterDraft(operator, { targetUrl: 'http://fixture.target.test/page', protocol: 'http/1.1' });
    const sent = await service.sendRepeaterDraft(operator, draft.draftId, draft.planHash, 'admin');
    assert.equal(sent.sent, true);
    assert.deepEqual(sent.sessionCookieNames, ['PHPSESSID'], '適用 cookie は名前のみ応答に出る');
    assert.equal(JSON.stringify(sent).includes('session-value'), false, 'cookie 値は応答に出ない');

    // role 未指定の送信には session が付かない。
    const plain = await service.sendRepeaterDraft(operator, draft.draftId, draft.planHash);
    assert.equal(plain.sent, true);
    assert.equal(plain.sessionCookieNames, undefined);

    // 未登録 role は拒否。
    await assert.rejects(service.sendRepeaterDraft(operator, draft.draftId, draft.planHash, 'ghost'), /no session for role/);

    // 別 origin の domain を持つ cookie は適用対象から除外される。
    executor.nextCookies = [{ name: 'OTHER', value: 'v', domain: 'elsewhere.example', path: '/' }];
    await service.runLogin(operator, {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      secretValues: { 'vault://admin-user': 'admin', 'vault://admin-pass': 'password123' },
      expectedUrlPrefix: 'http://fixture.target.test/',
    });
    const filtered = await service.sendRepeaterDraft(operator, draft.draftId, draft.planHash, 'admin');
    assert.equal(filtered.sent, true);
    assert.deepEqual(filtered.sessionCookieNames, [], '別 Origin の cookie は適用しない');
  });
});
