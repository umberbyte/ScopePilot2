import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKFLOW_PAYLOAD_CATALOG,
  WORKFLOW_PAYLOAD_CATALOG_REFERENCE,
  WORKFLOW_PAYLOAD_CATALOG_SHA256,
  parsePayloadCatalog,
  payloadById,
  renderPayload,
  selectPayloads,
} from '../src/index.ts';

function minimalCatalog(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    catalog: {
      id: 'test-catalog',
      version: '1.0.0',
      source: 'unit test fixture',
      publishedAt: '2026-10-26',
      generated: false,
      description: 'A minimal reviewed catalog.',
    },
    payloads: [
      {
        id: 'test.read-only',
        capability: 'sql-injection',
        contexts: ['query'],
        platforms: ['sql'],
        template: '{{marker}}',
        variables: ['marker'],
        oracle: 'marker-in-response',
        tags: ['test'],
        safety: {
          risk: 'read-only',
          maxAttempts: 1,
          requiresConfirmation: false,
          requiresTestAccount: false,
          requiresRollback: false,
          leavesResidue: false,
        },
      },
    ],
  };
}

function payloadsOf(document: Record<string, unknown>): Record<string, unknown>[] {
  return document.payloads as Record<string, unknown>[];
}

test('built-in catalog has a stable versioned reference and valid pairs', () => {
  assert.equal(WORKFLOW_PAYLOAD_CATALOG.catalog.id, 'scopepilot-workflow-payloads');
  assert.equal(WORKFLOW_PAYLOAD_CATALOG.catalog.version, '2.0.0');
  assert.match(WORKFLOW_PAYLOAD_CATALOG_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(
    WORKFLOW_PAYLOAD_CATALOG_REFERENCE,
    `scopepilot-workflow-payloads/v2.0.0 sha256:${WORKFLOW_PAYLOAD_CATALOG_SHA256}`,
  );
  assert.equal(Object.isFrozen(WORKFLOW_PAYLOAD_CATALOG), true);
  assert.equal(Object.isFrozen(WORKFLOW_PAYLOAD_CATALOG.payloads), true);

  const ids = new Set(WORKFLOW_PAYLOAD_CATALOG.payloads.map((payload) => payload.id));
  assert.equal(ids.size, WORKFLOW_PAYLOAD_CATALOG.payloads.length);
  for (const payload of WORKFLOW_PAYLOAD_CATALOG.payloads) {
    if (payload.pairId !== undefined) assert.ok(ids.has(payload.pairId));
  }
});

test('selection filters by capability, context, platform, risk and tags', () => {
  const selected = selectPayloads(WORKFLOW_PAYLOAD_CATALOG, {
    capability: 'command-injection',
    context: 'json',
    platform: 'posix',
    maximumRisk: 'read-only',
    tags: ['marker'],
  });
  assert.deepEqual(
    selected.map((payload) => payload.id),
    ['command.posix.semicolon.marker', 'command.posix.pipe.marker', 'command.posix.newline.marker'],
  );
  assert.equal(
    selectPayloads(WORKFLOW_PAYLOAD_CATALOG, { capability: 'file-upload', maximumRisk: 'state-changing' }).length,
    0,
  );
});

test('rendering requires exactly the reviewed variables', () => {
  const payload = payloadById(WORKFLOW_PAYLOAD_CATALOG, 'auth.invalid-password');
  assert.equal(renderPayload(payload, { marker: 'abc123', attempt: 4 }), 'ScopePilot-invalid-abc123-4');
  assert.throws(() => renderPayload(payload, { marker: 'abc123' }), /requires exactly/);
  assert.throws(() => renderPayload(payload, { marker: 'abc123', attempt: 4, extra: 'x' }), /requires exactly/);
  assert.throws(() => renderPayload(payload, { marker: 'line\nbreak', attempt: 4 }), /invalid/);
});

test('parser rejects generated and structurally unsafe catalogs', () => {
  const generated = minimalCatalog();
  (generated.catalog as Record<string, unknown>).generated = true;
  assert.throws(() => parsePayloadCatalog(generated), /generated must be false/);

  const stateChanging = minimalCatalog();
  const stateSafety = payloadsOf(stateChanging)[0]!.safety as Record<string, unknown>;
  stateSafety.risk = 'state-changing';
  assert.throws(() => parsePayloadCatalog(stateChanging), /requiresConfirmation must be true/);

  const boundedDelay = minimalCatalog();
  (payloadsOf(boundedDelay)[0]!.safety as Record<string, unknown>).risk = 'bounded-delay';
  assert.throws(() => parsePayloadCatalog(boundedDelay), /maxDelayMs is required/);

  const residue = minimalCatalog();
  (payloadsOf(residue)[0]!.safety as Record<string, unknown>).leavesResidue = true;
  assert.throws(() => parsePayloadCatalog(residue), /cleanupStrategy is required/);
});

test('parser rejects duplicate ids, missing pairs and placeholder drift', () => {
  const duplicate = minimalCatalog();
  payloadsOf(duplicate).push(structuredClone(payloadsOf(duplicate)[0]!));
  assert.throws(() => parsePayloadCatalog(duplicate), /duplicate payload id/);

  const missingPair = minimalCatalog();
  payloadsOf(missingPair)[0]!.pairId = 'missing.pair';
  assert.throws(() => parsePayloadCatalog(missingPair), /references missing pair/);

  const placeholderDrift = minimalCatalog();
  payloadsOf(placeholderDrift)[0]!.variables = [];
  assert.throws(() => parsePayloadCatalog(placeholderDrift), /must exactly match template placeholders/);
});

test('artifact-producing payloads explicitly describe confirmation and cleanup', () => {
  const upload = payloadById(WORKFLOW_PAYLOAD_CATALOG, 'upload.php-gif-canary');
  assert.equal(upload.safety.risk, 'artifact-producing');
  assert.equal(upload.safety.requiresConfirmation, true);
  assert.equal(upload.safety.leavesResidue, true);
  assert.ok(upload.safety.cleanupStrategy);
});
