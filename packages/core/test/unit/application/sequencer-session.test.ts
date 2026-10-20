import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoginExecutorPort, LoginSessionCookie, SequencerTransportPort } from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * Sequencer session の service 経路 (design/f07)。token 原文は応答・監査の
 * いずれにも出ない (F07-UT-006)。sample 不足は断定しない (F07-UT-005)。
 */
describe('sequencer session (service)', () => {
  test('sample を収集して統計を返す。token 原文は応答に出ない', async () => {
    const { service, operator } = await bootstrapFlow();
    const result = await service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/session-token', samples: 100 });
    assert.equal(result.verdict, 'assessed');
    assert.equal(result.sampleCount, 100);
    assert.equal(result.duplicates, 0);
    assert.equal(result.missing, 0);
    assert.ok((result.shannonEntropyBitsPerByte ?? 0) > 3, '変化する token は高い entropy');
    assert.ok((result.distinctByteValues ?? 0) > 10);
    assert.equal(JSON.stringify(result).includes('sample-'), false, 'token 原文は応答に出ない');
    assert.equal(service.listSequencerSessions().length, 1);

    // URL に fixed を含む対象は毎回同一 token — 重複が増える (entropy は byte 分布の
    // 統計のため繰り返しでは下がらない。低 entropy 自体は F07-UT-004 の domain UT で担保)。
    const fixed = await service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/fixed-token', samples: 40 });
    assert.equal(fixed.verdict, 'assessed');
    assert.equal(fixed.sampleCount, 40);
    assert.equal(fixed.duplicates, 39, '2 件目以降はすべて重複');

    // URL に no-token を含む対象は欠落が混入する (F07-UT-002 の service 経路)。
    const withMissing = await service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/no-token-page', samples: 40 });
    assert.equal(withMissing.missing, 8, '5 回に 1 回は token 欠落');
    assert.equal(withMissing.sampleCount, 32);

    // 監査は統計のみ。
    const eventsText = JSON.stringify(service.events());
    assert.ok(eventsText.includes('SequencerSessionCompleted'));
    assert.equal(eventsText.includes('sample-'), false);
  });

  test('sample 数は domain 境界 (30..10000) で検証される。scope 外は拒否', async () => {
    const { service, operator } = await bootstrapFlow();
    await assert.rejects(
      service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/x', samples: 29 }),
      /between 30 and 10000/,
    );
    await assert.rejects(
      service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/x', samples: 10001 }),
      /between 30 and 10000/,
    );
    // 最小より少ない採取数では断定しない (F07-UT-005)。
    const insufficient = await service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/no-token-page', samples: 30 });
    assert.equal(insufficient.sampleCount, 24);
    assert.equal(insufficient.verdict, 'insufficient');
    assert.equal(insufficient.minimum, 30);
    assert.equal(insufficient.shannonEntropyBitsPerByte, undefined);

    await assert.rejects(
      service.runSequencerSession(operator, { targetUrl: 'http://elsewhere.example/x', samples: 40 }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'OutOfScope');
        return true;
      },
    );
  });

  test('role 指定は対象URLに適用可能なcookieだけを実transportへ渡し、値を保存しない', async () => {
    const transportCalls: Parameters<SequencerTransportPort['collect']>[0][] = [];
    const sequencerTransport: SequencerTransportPort = {
      async collect(input) {
        transportCalls.push(input);
        for (let index = 0; index < input.samples; index += 1) {
          input.onResponse({
            requestUrl: input.targetUrl,
            status: 200,
            contentType: 'text/plain',
            body: `token=role-sample-${index.toString(36)}`,
            setCookieHeaders: [`SEQ_TOKEN=cookie-sample-${index.toString(36)}; Path=/; HttpOnly`],
          });
        }
      },
    };
    const cookies: readonly LoginSessionCookie[] = [
      { name: 'SEQ_SESSION', value: 'sequencer-secret', domain: 'fixture.target.test', path: '/tokens' },
      { name: 'OTHER_PATH', value: 'other-path-secret', domain: 'fixture.target.test', path: '/admin' },
      { name: 'OTHER_ORIGIN', value: 'other-origin-secret', domain: 'elsewhere.example', path: '/' },
    ];
    const loginExecutor: LoginExecutorPort = {
      engineVersion: 'fake-login-sequencer-1',
      async execute() {
        return { authenticated: true, finalUrl: 'http://fixture.target.test/tokens', cookies };
      },
    };
    const { service, operator } = await bootstrapFlow({ loginExecutor, sequencerTransport });
    service.registerLoginFlow(operator, {
      role: 'analyst',
      flowVersion: 'sequencer-flow-1',
      steps: [
        { kind: 'navigate', target: 'http://fixture.target.test/login' },
        { kind: 'assert', target: 'Authenticated' },
      ],
    });
    await service.runLogin(operator, {
      role: 'analyst',
      baseUrl: 'http://fixture.target.test',
      secretValues: {},
      expectedUrlPrefix: 'http://fixture.target.test/tokens',
    });

    const result = await service.runSequencerSession(operator, {
      targetUrl: 'http://fixture.target.test/tokens/sample',
      samples: 30,
      role: 'analyst',
      tokenSource: 'cookie',
      tokenCookieName: 'SEQ_TOKEN',
    });
    assert.deepEqual(transportCalls[0]?.sessionCookies, [
      { name: 'SEQ_SESSION', value: 'sequencer-secret', domain: 'fixture.target.test', path: '/tokens' },
    ]);
    assert.deepEqual(result.sessionCookieNames, ['SEQ_SESSION']);
    assert.equal(result.tokenSource, 'cookie');
    assert.equal(result.tokenCookieName, 'SEQ_TOKEN');
    assert.deepEqual(service.listSequencerSessions().at(-1)?.sessionCookieNames, ['SEQ_SESSION']);
    assert.equal(JSON.stringify(result).includes('sequencer-secret'), false);
    assert.equal(JSON.stringify(result).includes('cookie-sample-'), false);
    assert.equal(JSON.stringify(service.listSequencerSessions()).includes('sequencer-secret'), false);
    assert.equal(JSON.stringify(service.listSequencerSessions()).includes('cookie-sample-'), false);
    assert.equal(JSON.stringify(service.events()).includes('sequencer-secret'), false);
    assert.equal(JSON.stringify(service.events()).includes('cookie-sample-'), false);

    await assert.rejects(
      service.runSequencerSession(operator, { targetUrl: 'http://fixture.target.test/tokens', samples: 30, role: 'missing' }),
      /no session for role/,
    );
  });
});
