import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaselineFlowService } from '../../../src/application/baseline-flow.ts';
import { CaseService } from '../../../src/application/services/case-service.ts';
import { AuthorizationService } from '../../../src/application/services/authorization-service.ts';
import { PlanService } from '../../../src/application/services/plan-service.ts';
import { CaseSessionContext } from '../../../src/application/services/case-session-context.ts';
import { EvidenceService } from '../../../src/application/services/evidence-service.ts';
import { EventPublisher } from '../../../src/application/services/event-publisher.ts';
import { RuntimeProfileService } from '../../../src/application/services/runtime-profile.ts';
import { RunLifecycleService } from '../../../src/application/services/run-lifecycle-service.ts';
import { FixedClock, SequentialIdGenerator, InMemoryEvidenceStore, type StoredEvidence } from '../../../src/ports/infra.ts';
import { bootstrapFlow, FakeExplorer, FakeScanEngine, TEST_NOW, TEST_OPERATOR } from '../support/test-flow.ts';
import { toolFixtures } from '../support/tool-fixtures.ts';
import type { BaselineFlowDeps } from '../../../src/application/baseline-contracts.ts';
import type { RunRecord } from '@scopepilot2/contracts';
function deps(overrides: Partial<BaselineFlowDeps> = {}): BaselineFlowDeps {
    return { clock: new FixedClock([TEST_NOW]), ids: new SequentialIdGenerator(), evidence: new InMemoryEvidenceStore(), explorer: new FakeExplorer(), scanEngine: new FakeScanEngine(), capabilities: [], runtimeBundleHash: 'test', ...overrides };
}
const caseInput = { name: 'service contract', allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [], limits: { maxRequests: 10, maxPages: 5, maxDurationMinutes: 1 } };
const authorizationInput = { allowedOperationClasses: ['Browse' as const], targetRoles: ['anonymous'], validFrom: '2026-10-18T08:00:00Z', validUntil: '2026-10-18T10:00:00Z', evidence: { label: 'authorization', content: 'approved' } };
test('GO-30: facade and independent Case/Auth/Plan services produce identical contracts and audit order', async () => {
    const facade = new BaselineFlowService(deps());
    const context = new CaseSessionContext();
    const events = new EventPublisher();
    const dependencies = deps();
    const cases = new CaseService(dependencies, context, events);
    const auth = new AuthorizationService(dependencies, context, { currentCase: () => cases.currentCase() }, new EvidenceService(dependencies.evidence), events);
    const plans = new PlanService(dependencies, context, {
        currentCase: () => cases.currentCase(), currentAuthorization: () => auth.currentAuthorization(),
        registerConfirmation: confirmation => cases.registerConfirmation(confirmation),
        isConfirmationInvalidated: id => cases.isConfirmationInvalidated(id), invalidationReason: id => cases.invalidationReason(id),
    }, events);
    assert.deepEqual(cases.createCase(TEST_OPERATOR, caseInput), facade.createCase(TEST_OPERATOR, caseInput));
    assert.deepEqual(await auth.grantAuthorization(TEST_OPERATOR, authorizationInput), await facade.grantAuthorization(TEST_OPERATOR, authorizationInput));
    const direct = plans.buildExplorationPlan(TEST_OPERATOR, ['http://fixture.target.test/']);
    const wrapped = facade.buildExplorationPlan(TEST_OPERATOR, ['http://fixture.target.test/']);
    assert.deepEqual(direct, wrapped);
    assert.deepEqual(plans.confirmPlan(direct.plan, TEST_OPERATOR), facade.confirmPlan(wrapped.plan, TEST_OPERATOR));
    assert.deepEqual(events.events(), facade.events());
});
test('GO-30: authorization does not publish or update its ledger until evidence storage succeeds', async () => {
    let resolve!: (value: StoredEvidence) => void;
    const pending = new Promise<StoredEvidence>(done => { resolve = done; });
    const service = new BaselineFlowService(deps({ evidence: { saveText: () => pending } }));
    service.createCase(TEST_OPERATOR, caseInput);
    const granting = service.grantAuthorization(TEST_OPERATOR, authorizationInput);
    assert.throws(() => service.currentAuthorization(), { code: 'ValidationFailed' });
    assert.deepEqual(service.events().map(event => event.type), ['CaseCreated']);
    resolve({ evidenceId: 'stored', sha256: 'hash', label: 'authorization', savedAt: TEST_NOW });
    await granting;
    assert.equal(service.currentAuthorization().evidenceRef.evidenceId, 'stored');
    assert.equal(service.events().at(-1)?.type, 'AuthorizationGranted');
    const failed = new BaselineFlowService(deps({ evidence: { async saveText() { throw new Error('disk full'); } } }));
    failed.createCase(TEST_OPERATOR, caseInput);
    await assert.rejects(failed.grantAuthorization(TEST_OPERATOR, authorizationInput), /disk full/);
    assert.throws(() => failed.currentAuthorization(), { code: 'ValidationFailed' });
    assert.deepEqual(failed.events().map(event => event.type), ['CaseCreated']);
});
test('GO-30: concurrent workspace exploration keeps state, events, and target snapshots separate', async () => {
    const first = await bootstrapFlow({ allowedOrigins: ['http://first.test'] });
    const second = await bootstrapFlow({ allowedOrigins: ['http://second.test'] });
    await Promise.all([first, second].map(async ({ service, operator }, index) => {
        const { plan } = service.buildExplorationPlan(operator, [index === 0 ? 'http://first.test/' : 'http://second.test/']);
        const confirmation = service.confirmPlan(plan, operator);
        await service.runExploration(operator, plan, confirmation, { maxDepth: 1 });
    }));
    assert.ok(first.service.listObservations().every(item => item.url.startsWith('http://first.test/')));
    assert.ok(second.service.listObservations().every(item => item.url.startsWith('http://second.test/')));
    first.service.registerDocumentHints(first.operator, { documentLabel: 'first', urls: ['http://first.test/admin'] });
    assert.deepEqual(second.service.listDocumentHints(), []);
    assert.equal(second.service.events().some(event => event.type === 'DocumentHintsRegistered'), false);
});
test('GO-30: reopened workspace restores durable case/auth without restoring memory-only sessions or audit events', async () => {
    const original = await bootstrapFlow();
    original.service.registerLoginFlow(original.operator, { role: 'admin', flowVersion: 'v1', steps: [] });
    const reopened = new BaselineFlowService(deps());
    reopened.restoreWorkspace(original.service.currentCase(), original.service.currentAuthorization());
    assert.deepEqual(reopened.currentCase(), original.service.currentCase());
    assert.deepEqual(reopened.currentAuthorization(), original.service.currentAuthorization());
    assert.deepEqual(reopened.listSessions(), []);
    assert.deepEqual(reopened.events(), []);
});
for (const profile of ['production', 'simulation', 'test'] as const) {
    test(`GO-30: ${profile} requires an explicitly injected adapter`, () => {
        const runtime = new RuntimeProfileService(profile);
        assert.throws(() => runtime.requireAdapter('tool', undefined), { code: 'CapabilityUnavailable' });
        assert.throws(() => runtime.requireAdapter('tool', {}, 'unavailable'), { code: 'CapabilityUnavailable' });
        if (profile === 'production')
            assert.throws(() => runtime.requireAdapter('tool', {}, 'fixture'), { code: 'CapabilityUnavailable' });
        else
            assert.deepEqual(runtime.requireAdapter('tool', {}, 'fixture'), {});
    });
}
for (const fixture of [false, true]) {
    test(`GO-30: production ${fixture ? 'fixture' : 'missing'} tools leave no successful ledger, finding, traffic, or event`, async () => {
        const service = new BaselineFlowService(deps(fixture ? { ...toolFixtures(), adapterKinds: { repeaterTransport: 'fixture', fuzzTransport: 'fixture', sequencerTransport: 'fixture', oastProvider: 'fixture', webSocketTransport: 'fixture' } } : {}));
        service.createCase(TEST_OPERATOR, caseInput);
        const draft = service.createRepeaterDraft(TEST_OPERATOR, { targetUrl: 'http://fixture.target.test/', protocol: 'http/1.1' });
        const before = service.events();
        const commands = [
            () => service.sendRepeaterDraft(TEST_OPERATOR, draft.draftId, draft.planHash),
            () => service.runFuzzSession(TEST_OPERATOR, { targetUrl: draft.targetUrl, positions: [{ name: 'q', values: ['a'] }] }),
            () => service.runSequencerSession(TEST_OPERATOR, { targetUrl: draft.targetUrl, samples: 30 }),
            () => service.startOastAttempt(TEST_OPERATOR, { targetUrl: draft.targetUrl, protocol: 'http' }),
            () => service.sendWsMessages(TEST_OPERATOR, { targetUrl: draft.targetUrl, messages: ['hello'] }),
        ];
        for (const command of commands)
            await assert.rejects(command(), { code: 'CapabilityUnavailable' });
        assert.deepEqual(service.events(), before);
        assert.deepEqual(service.repeaterAttemptLog(), []);
        assert.deepEqual(service.listFuzzRuns(), []);
        assert.deepEqual(service.listSequencerSessions(), []);
        assert.deepEqual(service.listOastAttempts(), []);
        assert.deepEqual(service.listWsFrames(), []);
        assert.deepEqual(service.listFindings(), []);
        assert.deepEqual(service.listTraffic(100).entries, []);
    });
}
test('GO-30: run lifecycle keeps independent stop machines and durable run snapshots', () => {
    const records: RunRecord[] = [];
    const runs = new RunLifecycleService({ save: record => records.push(record) });
    const first = runs.createMachine();
    const second = runs.createMachine();
    first.transition('Running');
    second.transition('Running');
    first.requestStop();
    assert.equal(first.state, 'Stopping');
    assert.equal(second.state, 'Running');
    const record: RunRecord = { runId: 'run-1', planId: 'plan-1', caseId: 'case-1', state: first.transition('Stopped'), attempt: 1, stopReason: 'user-request' };
    runs.save(record);
    assert.deepEqual(records, [record]);
    assert.throws(() => first.transition('Running'), { code: 'Conflict' });
});
