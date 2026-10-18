import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  exchangeFingerprint,
  ImportCursor,
  importMessages,
  originTypeOf,
  planTrafficQuery,
  SiteMapProjector,
} from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

describe('MessageFingerprint', () => {
  test('[F03-UT-001] 同一 message の再取込は同一 fingerprint を返す', () => {
    const input = { engineInstance: 'zap-a', engineMessageId: '1042', direction: 'response' as const, rawHash: 'ab'.repeat(32) };
    const first = exchangeFingerprint(input);
    const second = exchangeFingerprint({ ...input });
    assert.equal(first, second);
    assert.notEqual(first, exchangeFingerprint({ ...input, direction: 'request' }));
    assert.notEqual(first, exchangeFingerprint({ ...input, rawHash: 'cd'.repeat(32) }));
  });
});

describe('ImportCursor', () => {
  test('[F03-UT-002] cursor 巻戻りは anomaly 記録と再走査指示を返す (自動削除しない)', () => {
    const cursor = new ImportCursor('zap-a', 100);
    assert.deepEqual(cursor.advance(150), { rescan: false });
    assert.deepEqual(cursor.advance(120), { rescan: true });
    const rollback = cursor.anomaliesRecorded().find((anomaly) => anomaly.kind === 'rollback');
    assert.deepEqual(rollback, { kind: 'rollback', from: 150, to: 120 });
    assert.equal(cursor.offset, 120, '巻戻り先へ合わせて再走査前提とする');
  });
});

describe('MessageImporter', () => {
  test('[F03-UT-003] 1 件 malformed は quarantine し他を継続する', () => {
    const result = importMessages([
      { evidenceId: 'ev-1', raw: 'GET / HTTP/1.1' },
      { evidenceId: 'ev-2', raw: null },
      { evidenceId: 'ev-3', raw: '' },
      { evidenceId: 'ev-4', raw: 'GET /a HTTP/1.1' },
    ]);
    assert.equal(result.imported.length, 2);
    assert.deepEqual(result.quarantined.map((entry) => entry.evidenceId), ['ev-2', 'ev-3']);
    assert.ok(result.quarantined.every((entry) => entry.reason.length > 0));
  });
});

describe('SiteMapProjector', () => {
  test('[F03-UT-004] query だけ異なる URL は同一 endpoint へ集約する', () => {
    const projector = new SiteMapProjector();
    projector.add({ url: 'http://a.test/items?page=1', method: 'GET', status: 200, contentType: 'text/html' });
    projector.add({ url: 'http://a.test/items?page=2&sort=desc', method: 'GET', status: 200, contentType: 'text/html' });
    projector.add({ url: 'http://a.test/items?page=3', method: 'POST', status: 200, contentType: 'text/html' });
    const endpoints = projector.list();
    assert.equal(endpoints.length, 2);
    const aggregated = endpoints.find((endpoint) => endpoint.method === 'GET');
    assert.equal(aggregated?.observedUrls, 2);
    assert.equal(aggregated?.path, '/items');
  });
});

describe('TrafficQuery', () => {
  test('[F03-UT-005] limit 501 は ValidationFailed', () => {
    assert.throws(() => planTrafficQuery(10, 501), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /between 1 and 500/);
      return true;
    });
    assert.deepEqual(planTrafficQuery(10, 500), { mode: 'list', limit: 500 });
    assert.deepEqual(planTrafficQuery(10, 100), { mode: 'list', limit: 100 });
  });

  test('[F03-UT-006] 100,001 件は summary mode を選択する', () => {
    assert.deepEqual(planTrafficQuery(100000, 100).mode, 'list');
    assert.deepEqual(planTrafficQuery(100001, 100).mode, 'summary');
  });
});

describe('TrafficOriginType', () => {
  test('[F03-UT-007] document hint は observed=false を保持し観測に昇格しない', () => {
    assert.deepEqual(originTypeOf({ url: 'http://a.test/x', originType: 'document-hint' }), {
      observed: false,
      originType: 'document-hint',
    });
    assert.deepEqual(originTypeOf({ url: 'http://a.test/x', originType: 'observed' }), {
      observed: true,
      originType: 'observed',
    });
  });
});
