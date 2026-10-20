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
    assert.equal(result.byteFrequencyBuckets?.length, 16);
    assert.ok((result.byteFrequencyBuckets?.reduce((sum, count) => sum + count, 0) ?? 0) > 0);
    assert.equal(result.tokenLengthBucketMinimums?.length, 16);
    assert.equal(result.tokenByteLengthBuckets?.reduce((sum, count) => sum + count, 0), 100);
    assert.equal(result.tokenCharacterLengthBuckets?.reduce((sum, count) => sum + count, 0), 100);
    assert.equal(JSON.stringify(result).includes('sample-'), false, 'token 原文は応答に出ない');
    assert.equal(service.listSequencerSessions().length, 1);
    assert.deepEqual(service.listSequencerSessions()[0]?.byteFrequencyBuckets, result.byteFrequencyBuckets);
    assert.deepEqual(service.listSequencerSessions()[0]?.tokenByteLengthBuckets, result.tokenByteLengthBuckets);

    const hidden = await service.runSequencerSession(operator, {
      targetUrl: 'http://fixture.target.test/session-token',
      samples: 30,
      tokenSource: 'hidden',
      tokenFieldName: 'csrf_token',
    });
    assert.equal(hidden.verdict, 'assessed');
    assert.equal(hidden.sampleCount, 30);
    assert.equal(hidden.tokenSource, 'hidden');
    assert.equal(hidden.tokenFieldName, 'csrf_token');
    assert.equal(JSON.stringify(hidden).includes('sample-'), false);

    const bearer = await service.runSequencerSession(operator, {
      targetUrl: 'http://fixture.target.test/session-token',
      samples: 30,
      tokenSource: 'bearer',
    });
    assert.equal(bearer.verdict, 'assessed');
    assert.equal(bearer.sampleCount, 30);
    assert.equal(bearer.tokenSource, 'bearer');
    assert.equal(JSON.stringify(bearer).includes('sample-'), false);

    const custom = await service.runSequencerSession(operator, {
      targetUrl: 'http://fixture.target.test/session-token',
      samples: 30,
      tokenSource: 'custom',
      tokenStartDelimiter: 'token="',
      tokenEndDelimiter: '"',
    });
    assert.equal(custom.verdict, 'assessed');
    assert.equal(custom.sampleCount, 30);
    assert.equal(custom.tokenSource, 'custom');
    assert.equal(custom.tokenStartDelimiter, 'token="');
    assert.equal(custom.tokenEndDelimiter, '"');
    assert.equal(JSON.stringify(custom).includes('sample-'), false);

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

  test('cancel は transport へ伝播し、停止後の追加送信とsession完了記録を作らない', async () => {
    const cancellation = new AbortController();
    let requests = 0;
    const sequencerTransport: SequencerTransportPort = {
      async collect(input) {
        for (let index = 0; index < input.samples; index += 1) {
          input.signal?.throwIfAborted();
          requests += 1;
          input.onResponse({
            requestUrl: input.targetUrl,
            status: 200,
            contentType: 'text/plain',
            body: `token=cancel-sample-${index.toString(36)}`,
          });
          cancellation.abort();
        }
      },
    };
    const { service, operator } = await bootstrapFlow({ sequencerTransport });

    await assert.rejects(
      service.runSequencerSession(operator, {
        targetUrl: 'http://fixture.target.test/cancel-token',
        samples: 30,
        signal: cancellation.signal,
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'Cancelled');
        return true;
      },
    );
    assert.equal(requests, 1, 'cancel後に次のrequestを発行しない');
    assert.equal(service.listSequencerSessions().length, 0, '中断した採取を完了sessionとして保存しない');
    assert.equal(JSON.stringify(service.events()).includes('SequencerSessionCompleted'), false);
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
