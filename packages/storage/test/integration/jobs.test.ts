import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobRegistry } from '@scopepilot2/core';
import { migrate, openDatabase, SqliteJobStore } from '../../src/index.ts';
test('job/event and audit survive restore; unfinished jobs become Interrupted; sequence continues', async () => {
  const db = openDatabase(':memory:'); migrate(db); const store = new SqliteJobStore(db);
  const r = new JobRegistry(store); const input = { kind: 'active-scan' as const, label: 'test', guarantee: 'Mixed' as const, transport: 'fixture' as const };
  const a = r.create(input); const b = r.create(input); await r.execute(a, async () => ({ answer: 42 })); r.transition(b, 'Running');
  store.appendAudit({ type: 'RunStarted', at: new Date().toISOString(), runId: 'r1', jobId: b, planHash: 'hash' });
  const last = r.events().at(-1)!.seq; const restored = new JobRegistry(store);
  assert.equal(restored.get(a)?.summary.state, 'Completed'); assert.deepEqual(restored.get(a)?.result, { answer: 42 });
  assert.equal(restored.get(b)?.summary.state, 'Interrupted'); assert.equal(restored.events().at(-1)?.seq, last + 1);
  assert.equal(store.loadAudit()[0]?.jobId, b); assert.equal(store.loadEvents().length, restored.events().length);
  db.close();
});
