import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
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
});
