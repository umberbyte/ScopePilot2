import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DomainError } from '@scopepilot2/contracts';
import { bootstrapFlow } from '../support/test-flow.ts';

describe('command pipeline revision guard (BaselineFlowService.updateCaseScope)', () => {
  test('[SYS-UT-002] 古い revision での更新は Conflict になり、state も event も追加しない', async () => {
    const { service, operator } = await bootstrapFlow();
    const first = service.updateCaseScope(operator, {
      expectedRevision: 1,
      allowedOrigins: ['http://fixture.target.test'],
      deniedOrigins: [],
      limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
    });
    assert.equal(first.revision, 2);
    const eventsAfterFirst = service.events().length;

    assert.throws(
      () =>
        service.updateCaseScope(operator, {
          expectedRevision: 1,
          allowedOrigins: ['http://fixture.target.test'],
          deniedOrigins: [],
          limits: { maxRequests: 4500, maxPages: 500, maxDurationMinutes: 60 },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as DomainError).code, 'Conflict');
        return true;
      },
    );

    assert.equal(service.currentCase().revision, 2);
    assert.equal(service.events().length, eventsAfterFirst, '失敗した command は event を追加しない');
  });
});
