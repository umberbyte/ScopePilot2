import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthenticationUser } from '@scopepilot2/contracts';
import { SessionCoordinator, type LoginExecutorPort, type InteractiveBrowserPort } from '@scopepilot2/core';
import { bootstrapFlow } from '../support/test-flow.ts';

const user: AuthenticationUser = { role: 'alice-admin', displayName: 'Alice', authorizationRole: 'admin', method: 'Form', enabled: true };
const credentials = { role: user.role, baseUrl: 'http://fixture.target.test', expectedUrlPrefix: 'http://fixture.target.test/', secretValues: { 'secret:password': 'private-password' } };
const steps = [{ kind: 'fill' as const, target: '#password', secretReference: 'secret:password' }, { kind: 'assert' as const, target: 'Welcome' }];

function adapters() {
  const login: LoginExecutorPort & { success: boolean; calls: number } = {
    engineVersion: 'fake-login', success: true, calls: 0,
    async execute(input) {
      this.calls += 1;
      assert.deepEqual(input.scope?.allowedOrigins, ['http://fixture.target.test']);
      return { authenticated: this.success, finalUrl: 'http://fixture.target.test/home', cookies: [{ name: 'sid', value: 'private-session', domain: 'fixture.target.test', path: '/' }] };
    },
  };
  const browser: InteractiveBrowserPort & { passed: boolean; calls: number; fail: boolean; beforeResult?: () => Promise<void> } = {
    engineVersion: 'fake-browser', passed: true, calls: 0, fail: false,
    async execute(input) {
      this.calls += 1;
      assert.equal(input.browserSession?.cookies[0]?.value, 'private-session');
      if (this.beforeResult !== undefined) await this.beforeResult();
      if (this.fail) throw new Error('private-session must not reach response');
      return { finalUrl: input.targetUrl, status: 200, bodyHash: 'hash', bodyText: 'private-response', headers: [], elapsedMs: 1, assertions: [{ kind: 'assert', target: 'Welcome', passed: this.passed }] };
    },
  };
  return { login, browser };
}

async function configured() {
  const { login, browser } = adapters();
  const { service, operator } = await bootstrapFlow({ loginExecutor: login, interactiveBrowser: browser });
  service.saveAuthenticationUser(operator, user);
  service.registerLoginFlow(operator, { role: user.role, flowVersion: 'v1', steps });
  await service.runLogin(operator, credentials);
  return { service, operator, login, browser };
}

test('user metadata uses existing role flows, is projected defensively and enforces permission/method/disabled state', async () => {
  const { service, operator, login } = await configured();
  assert.equal(service.listSessions()[0]?.role, user.role);
  assert.equal(service.listSessions()[0]?.sessionRevision, 1);
  const copy = service.listAuthenticationUsers()[0] as { displayName: string };
  copy.displayName = 'changed';
  assert.equal(service.listAuthenticationUsers()[0]?.displayName, 'Alice');
  assert.throws(() => service.saveAuthenticationUser({ ...operator, permissions: ['run.manage'] }, user), /permission/);
  assert.throws(() => service.saveAuthenticationUser(operator, { ...user, method: 'Unknown' as never }), /user needs/);
  service.saveAuthenticationUser(operator, { ...user, enabled: false });
  assert.equal(service.listSessions()[0]?.verificationUrl, null);
  await assert.rejects(service.runLogin(operator, credentials), /disabled/);
  service.saveAuthenticationUser(operator, { ...user, method: 'Bearer' });
  await assert.rejects(service.runLogin(operator, credentials), /configuration-only/);
  assert.equal(login.calls, 1);
});

test('verification single-flights per identity, reports live adapter observations and never returns secrets', async () => {
  const { service, operator, browser } = await configured();
  const [first, second] = await Promise.all([service.verifySession(operator, user.role), service.verifySession(operator, user.role)]);
  assert.deepEqual(first, second);
  assert.equal(first.state, 'valid');
  assert.equal(first.source, 'adapter');
  assert.equal(browser.calls, 1);
  const exposed = JSON.stringify({ configuration: service.authenticationConfiguration(), sessions: service.listSessions(), events: service.events() });
  for (const secret of ['private-password', 'private-session', 'private-response']) assert.ok(!exposed.includes(secret));
  await assert.rejects(service.refreshSession(operator, user.role), /fixture-only/);
});

test('expired or failed verification discards stale browser state; re-login is required', async () => {
  const { service, operator, browser } = await configured();
  browser.passed = false;
  assert.equal((await service.verifySession(operator, user.role)).state, 'expired');
  assert.equal(service.listSessions()[0]?.verificationUrl, null);
  await assert.rejects(service.verifySession(operator, user.role), /run login/);
  await service.runLogin(operator, credentials);
  browser.fail = true;
  const failed = await service.verifySession(operator, user.role);
  assert.equal(failed.state, 'unverified');
  assert.ok(!JSON.stringify(failed).includes('private-session'));
  assert.equal(service.listSessions()[0]?.verificationUrl, null);
});

test('failed re-login, flow edits and context edits invalidate the existing session', async () => {
  const { service, operator, login } = await configured();
  login.success = false;
  assert.equal((await service.runLogin(operator, credentials)).authenticated, false);
  assert.equal(service.listSessions()[0]?.verificationUrl, null);
  login.success = true;
  await service.runLogin(operator, credentials);
  service.registerLoginFlow(operator, { role: user.role, flowVersion: 'v2', steps });
  assert.equal(service.listSessions()[0]?.verificationUrl, null);
  await service.runLogin(operator, credentials);
  const record = service.currentCase();
  service.updateCaseScope(operator, { expectedRevision: record.revision, allowedOrigins: record.scope.allowedOrigins, deniedOrigins: [], limits: record.scope.limits });
  assert.equal(service.listSessions()[0]?.verificationUrl, null);
});

test('out-of-context login and navigate steps are rejected before executor receives credentials', async () => {
  const { service, operator, login } = await configured();
  await assert.rejects(service.runLogin(operator, { ...credentials, baseUrl: 'https://outside.test/' }), /outside the case context/);
  await assert.rejects(service.runLogin(operator, { ...credentials, expectedUrlPrefix: 'https://outside.test/' }), /outside the case context/);
  service.registerLoginFlow(operator, { role: user.role, flowVersion: 'v2', steps: [{ kind: 'navigate', target: 'https://outside.test/' }] });
  await assert.rejects(service.runLogin(operator, credentials), /outside the case context/);
  assert.equal(login.calls, 1);
});

test('verification cannot restore a session disabled while its browser call was in flight', async () => {
  const { service, operator, browser } = await configured();
  browser.beforeResult = async () => { service.saveAuthenticationUser(operator, { ...user, enabled: false }); };
  await assert.rejects(service.verifySession(operator, user.role), /session changed/);
  assert.equal(service.authenticationConfiguration().verifications.length, 0);
});

test('changing cases clears auth metadata and browser state', async () => {
  const { service, operator } = await configured();
  const record = service.currentCase();
  service.createCase(operator, { name: 'Another case', ...record.scope });
  assert.deepEqual(service.listAuthenticationUsers(), []);
  assert.deepEqual(service.listSessions(), []);
});

test('refresh failure and single-flight state are isolated between roles', async () => {
  const calls: string[] = [];
  const coordinator = new SessionCoordinator({ refresh: async (role) => { calls.push(role); if (role === 'alice') throw new Error('locked'); return 'session'; } });
  await assert.rejects(coordinator.refresh('alice'), /locked/);
  assert.equal((await coordinator.refresh('alice')).outcome, 'stopped-lockout-guard');
  const [bob, carol] = await Promise.all([coordinator.refresh('bob'), coordinator.refresh('carol')]);
  assert.equal(bob.sessionRevision, 1);
  assert.equal(carol.sessionRevision, 1);
  assert.deepEqual(calls, ['alice', 'bob', 'carol']);
});

test('missing verification capability is unverified, never a synthetic success', async () => {
  const { login } = adapters();
  const { service, operator } = await bootstrapFlow({ loginExecutor: login });
  service.registerLoginFlow(operator, { role: user.role, flowVersion: 'v1', steps });
  await service.runLogin(operator, credentials);
  const result = await service.verifySession(operator, user.role);
  assert.equal(result.state, 'unverified');
  assert.equal(result.source, 'unavailable');
  assert.equal(service.listSessions()[0]?.verificationUrl, null);
});

test('flow version edits require a new version; executor failures return no credential material', async () => {
  const { service, operator, login } = await configured();
  assert.throws(() => service.registerLoginFlow(operator, { role: user.role, flowVersion: 'v1', steps: [{ kind: 'assert', target: 'Different marker' }] }), /new flow version/);
  login.execute = async () => { throw new Error('private-password'); };
  await assert.rejects(service.runLogin(operator, credentials), (error: unknown) => {
    assert.match(String(error), /login browser execution failed/);
    assert.ok(!String(error).includes('private-password'));
    return true;
  });
  assert.equal(service.listSessions()[0]?.verificationUrl, null);
});

test('a late concurrent login cannot overwrite the newer session', async () => {
  const pending: ((value: Awaited<ReturnType<LoginExecutorPort['execute']>>) => void)[] = [];
  const { service, operator } = await bootstrapFlow({ loginExecutor: { engineVersion: 'concurrent-fixture', execute: () => new Promise((resolve) => pending.push(resolve)) } });
  service.registerLoginFlow(operator, { role: user.role, flowVersion: 'v1', steps });
  const first = service.runLogin(operator, credentials);
  const rejected = assert.rejects(first, /session changed during login/);
  const second = service.runLogin(operator, credentials);
  pending[1]!({ authenticated: true, finalUrl: 'http://fixture.target.test/home', cookies: [{ name: 'new-sid', value: 'new-secret', domain: 'fixture.target.test', path: '/' }] });
  await second;
  pending[0]!({ authenticated: true, finalUrl: 'http://fixture.target.test/home', cookies: [] });
  await rejected;
  assert.deepEqual(service.listSessions()[0]?.cookieNames, ['new-sid']);
});
