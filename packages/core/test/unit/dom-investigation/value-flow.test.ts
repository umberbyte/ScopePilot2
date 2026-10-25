import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildDomCandidate,
  classifyObserverEvent,
  domEvidenceProjection,
  frameBoundaryPolicy,
  shadowDomPolicy,
  traceValueFlows,
} from '@scopepilot2/core';

describe('DOM investigation', () => {
  test('[F16-UT-001] 同一 marker が source/sink に現れたら高 confidence 候補を作る', () => {
    const candidates = traceValueFlows([
      { api: 'location.search', marker: 'marker-abc' },
      { api: 'innerHTML', marker: 'marker-abc' },
    ]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.confidence, 0.9);
    assert.equal(candidates[0]?.sourceApi, 'location.search');
    assert.equal(candidates[0]?.sinkApi, 'innerHTML');
  });

  test('[F16-UT-002] 部分一致は低 confidence として区別する', () => {
    const candidates = traceValueFlows([
      { api: 'location.search', marker: 'marker-abcdef' },
      { api: 'eval', marker: 'abc' },
    ]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.confidence, 0.3);
  });

  test('[F16-UT-003] cross-origin child frame は観測対象外として記録する', () => {
    assert.deepEqual(frameBoundaryPolicy({ origin: 'http://a.test', parentOrigin: 'http://a.test' }), { observable: true });
    const cross = frameBoundaryPolicy({ origin: 'http://child.test', parentOrigin: 'http://a.test' });
    assert.equal(cross.observable, false);
    assert.match(cross.reason ?? '', /cross-origin/);
  });

  test('[F16-UT-004] shadow DOM は open のみ観測対象とする', () => {
    assert.deepEqual(shadowDomPolicy({ mode: 'open' }), { observable: true });
    const closed = shadowDomPolicy({ mode: 'closed' });
    assert.equal(closed.observable, false);
    assert.match(closed.reason ?? '', /closed shadow roots/);
  });

  test('[F16-UT-005] 観測なしでは finding (候補) を作らない', () => {
    assert.deepEqual(buildDomCandidate([]), []);
    assert.ok(buildDomCandidate([{ api: 'location.hash', marker: 'm' }, { api: 'document.write', marker: 'm' }]).length > 0);
  });

  test('[F16-UT-006] PII を含み得る node は projection で redact する', () => {
    const projection = domEvidenceProjection([
      { text: '山田 太郎 (利用者名)', looksLikePii: true },
      { text: '通常の DOM テキスト', looksLikePii: false },
    ]);
    assert.deepEqual(projection, ['[redacted: potential PII]', '通常の DOM テキスト']);
  });

  test('[F16-UT-007] navigation 後の旧 generation event は stale として隔離する', () => {
    assert.deepEqual(classifyObserverEvent({ generation: 2 }, 3), { stale: true });
    assert.deepEqual(classifyObserverEvent({ generation: 3 }, 3), { stale: false });
  });
});
