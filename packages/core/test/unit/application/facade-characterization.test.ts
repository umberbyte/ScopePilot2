import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaselineFlowService } from '../../../src/application/baseline-flow.ts';
import { bootstrapFlow } from '../support/test-flow.ts';
test('GO-30: facade public command/query surface remains compatible', () => {
    const expected = [
        "restoreWorkspace",
        "events",
        "listFindings",
        "listObservations",
        "listDeniedUrls",
        "registerDocumentHints",
        "listDocumentHints",
        "registerDocumentAuthHints",
        "listDocumentAuthHints",
        "registerDocumentPriorityHints",
        "listDocumentPriorityRules",
        "registerDocumentParameterHints",
        "listDocumentParameterHints",
        "listTraffic",
        "listSiteMapEndpoints",
        "listBreakItems",
        "breakQueueEvents",
        "enqueueBreakItem",
        "decideBreakItem",
        "runBusinessLogicCheck",
        "listBusinessLogicChecks",
        "runAuthBypassCheck",
        "listAuthBypassChecks",
        "runZapUnsupportedCheck",
        "listZapUnsupportedChecks",
        "runInteractiveDiagnostics",
        "registerLoginFlow",
        "runLogin",
        "listSessions",
        "refreshSession",
        "assignRoleCookies",
        "registerPayloadSet",
        "listPayloadSets",
        "runFuzzSession",
        "listFuzzRuns",
        "runSequencerSession",
        "listSequencerSessions",
        "importApiSpec",
        "startOastAttempt",
        "recordOastCallbacks",
        "listOastAttempts",
        "importWsFrames",
        "listWsFrames",
        "sendWsMessages",
        "negotiateTransportFor",
        "validateTransportHeaders",
        "analyzeDomFlows",
        "installExtension",
        "listExtensions",
        "listCaProfiles",
        "setCaProfileTrust",
        "listApiSpecImports",
        "listRepeaterDrafts",
        "createRepeaterDraft",
        "editRepeaterDraft",
        "sendRepeaterDraft",
        "repeaterAttemptLog",
        "dropBreakItem",
        "updateFindingStatus",
        "capabilities",
        "currentCase",
        "currentAuthorization",
        "createCase",
        "updateCaseScope",
        "grantAuthorization",
        "buildExplorationPlan",
        "verifyFindingExecution",
        "buildActiveScanPlan",
        "authorizePlan",
        "confirmPlan",
        "runExploration",
        "adoptCandidates",
        "runActiveScan",
        "importNucleiResults",
        "generateReport"
    ];
    for (const name of expected)
        assert.equal(typeof Reflect.get(BaselineFlowService.prototype, name), 'function', name);
});
test('GO-30: deterministic case / authorization / plan / confirmation contract', async () => {
    const { service, operator } = await bootstrapFlow();
    assert.equal(service.currentCase().caseId, 'case-0001');
    assert.equal(service.currentCase().revision, 1);
    assert.equal(service.currentAuthorization().authorizationId, 'authz-0001');
    service.registerDocumentHints(operator, { documentLabel: 'spec', urls: ['http://fixture.target.test/admin', 'http://outside.test/'] });
    const { plan, planHash } = service.buildExplorationPlan(operator, ['http://fixture.target.test/']);
    assert.deepEqual(plan.steps[0]!.targetSnapshot, ['http://fixture.target.test/', 'http://fixture.target.test/admin']);
    assert.deepEqual(service.authorizePlan(plan), { planHash });
    const confirmation = service.confirmPlan(plan, operator);
    assert.equal(confirmation.planHash, planHash);
    assert.equal(confirmation.confirmationId, 'confirm-0001');
    assert.deepEqual(service.events().map(event => event.type), ['CaseCreated', 'AuthorizationGranted', 'DocumentHintsRegistered', 'PlanValidated', 'PlanAuthorized', 'PlanConfirmed']);
    const outcome = service.updateCaseScope(operator, { expectedRevision: 1, allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [], limits: { maxRequests: 1, maxPages: 1, maxDurationMinutes: 1 } });
    assert.deepEqual(outcome.invalidatedConfirmationIds, ['confirm-0001']);
    await assert.rejects(service.runExploration(operator, plan, confirmation, { maxDepth: 1 }), { code: 'ConfirmationRequired' });
});
