import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createSecurityFixtureAdapters,
  HttpSecurityFixtureOtpInbox,
  HttpSecurityFixtureSaml,
} from '../src/security-fixture.ts';

describe('security fixture adapters', () => {
  test('configuration is opt-in and restricted to loopback', () => {
    assert.equal(createSecurityFixtureAdapters({}), undefined);
    assert.throws(
      () => createSecurityFixtureAdapters({ SCOPEPILOT_SECURITY_FIXTURE_BASE_URL: 'https://fixture.example' }),
      /loopback/u,
    );
    const configured = createSecurityFixtureAdapters({ SCOPEPILOT_SECURITY_FIXTURE_BASE_URL: 'http://127.0.0.1:4317' });
    assert.ok(configured?.otpInbox instanceof HttpSecurityFixtureOtpInbox);
    assert.ok(configured?.samlFixture instanceof HttpSecurityFixtureSaml);
  });

  test('OTP polling sends only the fixture reference and returns a fresh transient value', async () => {
    const requests: URL[] = [];
    let count = 0;
    const issuedAfter = '2026-10-31T00:00:00.000Z';
    const adapter = new HttpSecurityFixtureOtpInbox({
      baseUrl: 'http://localhost:4317/controller',
      bearerToken: 'fixture-token',
      otpPollIntervalMs: 50,
      fetchImpl: (async (input, init) => {
        requests.push(new URL(String(input)));
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
        count += 1;
        return count === 1
          ? new Response(null, { status: 204 })
          : Response.json({ otp: '391204', receivedAt: '2026-10-31T00:00:01.000Z' });
      }) as typeof fetch,
    });
    const result = await adapter.waitForOtp({ mailboxRef: 'case-42/alice', issuedAfter, timeoutMs: 1_000 });
    assert.deepEqual(result, { otp: '391204', receivedAt: '2026-10-31T00:00:01.000Z' });
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.pathname, '/controller/v1/otp');
    assert.equal(requests[0]?.searchParams.get('mailboxRef'), 'case-42/alice');
    assert.equal(requests[0]?.searchParams.get('issuedAfter'), issuedAfter);
  });

  test('SAML controller must attest isolation and return only a SHA-256 assertion hash', async () => {
    let requestBody: unknown;
    const adapter = new HttpSecurityFixtureSaml({
      baseUrl: 'http://[::1]:4317',
      fetchImpl: (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          fixtureIsolated: true,
          controlAccepted: true,
          replayAccepted: false,
          controlStatus: 302,
          replayStatus: 403,
          assertionHash: 'a'.repeat(64),
        });
      }) as typeof fetch,
    });
    const result = await adapter.issueAndReplay({
      idpStartUrl: 'https://idp.fixture.test/start',
      acsUrl: 'https://sp.fixture.test/acs',
      role: 'diagnostic-user',
    });
    assert.deepEqual(requestBody, {
      idpStartUrl: 'https://idp.fixture.test/start',
      acsUrl: 'https://sp.fixture.test/acs',
      role: 'diagnostic-user',
    });
    assert.deepEqual(result, {
      controlAccepted: true,
      replayAccepted: false,
      controlStatus: 302,
      replayStatus: 403,
      assertionHash: 'a'.repeat(64),
    });
  });

  test('SAML controller cannot return unverified or raw assertion-shaped output', async () => {
    const adapter = new HttpSecurityFixtureSaml({
      baseUrl: 'http://127.0.0.1:4317',
      fetchImpl: (async () => Response.json({
        fixtureIsolated: false,
        controlAccepted: true,
        replayAccepted: true,
        controlStatus: 200,
        replayStatus: 200,
        assertionHash: '<saml:Assertion>secret</saml:Assertion>',
      })) as typeof fetch,
    });
    await assert.rejects(
      adapter.issueAndReplay({ idpStartUrl: 'https://idp.fixture.test/start', acsUrl: 'https://sp.fixture.test/acs', role: 'diagnostic-user' }),
      /attest isolated execution/u,
    );
  });
});
