import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScanCandidate } from '@scopepilot2/contracts';
import { rankCandidates } from '../../../src/domain/exploration-discovery.ts';

/** Evaluation shapes from the existing Juice Shop coverage inventory, not a new live measurement. */
test('Juice Shop candidate ranking is invariant under generic route renaming', () => {
  const rows = [
    { id: 'search', path: '/rest/products/search', method: 'GET', basis: 'observed-http:fetch', inputs: 1 },
    { id: 'whoami', path: '/rest/user/whoami', method: 'GET', basis: 'observed-http:fetch', inputs: 0 },
    { id: 'feedback', path: '/api/Feedbacks', method: 'POST', basis: 'script-api-call', inputs: 0 },
    { id: 'asset', path: '/main.js', method: 'GET', basis: 'provisional:page', inputs: 0 },
    { id: 'transport', path: '/socket.io/', method: 'GET', basis: 'observed-http:fetch', inputs: 0 },
  ];
  const make = (generic: boolean): ScanCandidate[] => rows.map((row, index) => ({ candidateId: row.id, url: `http://owned.test${generic && row.id !== 'asset' && row.id !== 'transport' ? `/resource-${index}` : row.path}`, method: row.method, category: 'api-endpoint', guidelineBasis: [row.basis], confidence: 0.8, observationUrl: 'http://owned.test/', inputPoints: Array.from({ length: row.inputs }, () => ({ name: 'q', location: 'query', type: 'string' })) }));
  const ranked = rankCandidates(make(false));
  assert.deepEqual(ranked.map((candidate) => candidate.candidateId), ['search', 'whoami', 'feedback', 'asset', 'transport']);
  assert.deepEqual(ranked.map((candidate) => [candidate.candidateId, candidate.score]), rankCandidates(make(true)).map((candidate) => [candidate.candidateId, candidate.score]));
  assert.ok(ranked.every((candidate) => candidate.scoreSignals?.length));
});
