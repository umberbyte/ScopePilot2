import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GUIDELINE_THEME_AUTOMATION_POLICIES,
  GUIDELINE_AUTOMATION_POLICY_VERSION,
  resolveGuidelineThemeRoutes,
  automaticGuidelineRequestCount,
} from '@scopepilot2/core';

test('all 30 themes have exactly the design 41 target classes and explicit connection plans', () => {
  const classes = {
    automatic: ['8', '12', '13', '18', '19', '23', '24', '25', '28', '30'],
    'conditional-automatic': ['1', '2', '7', '9', '10', '21', '22', '26', '27', '29'],
    'operator-workflow': ['3', '5', '11', '15', '20'],
    'external-fixture': ['4', '6', '14', '16'],
    unsupported: ['17'],
  };
  const policies = Object.values(GUIDELINE_THEME_AUTOMATION_POLICIES);
  assert.deepEqual(policies.map((policy) => policy.themeNo), Array.from({ length: 30 }, (_, index) => String(index + 1)));
  for (const [classification, themeNos] of Object.entries(classes)) {
    assert.deepEqual(policies.filter((policy) => policy.automationClass === classification).map((policy) => policy.themeNo), themeNos);
  }
  assert.equal(new Set(policies.map((policy) => policy.routeId)).size, 30);
  for (const policy of policies) {
    assert.ok(policy.inputResolutionPlan);
    assert.ok(policy.assertionPlan);
    assert.ok(policy.limitationCodes.length);
    if (policy.connection !== 'active-scan') assert.ok(policy.deferredReason);
    if (policy.automationClass === 'conditional-automatic') assert.ok(policy.requiredInputCodes.length);
    assert.ok(Object.isFrozen(policy));
  }
});

test('only connected routes reserve request budget; passive plans and smuggling reserve zero', () => {
  for (const policy of Object.values(GUIDELINE_THEME_AUTOMATION_POLICIES)) {
    assert.equal(automaticGuidelineRequestCount(policy.themeNo, 0), 0);
    if (policy.connection !== 'active-scan') assert.equal(automaticGuidelineRequestCount(policy.themeNo, 5), 0);
  }
  assert.equal(automaticGuidelineRequestCount('13', 5), 6);
  assert.equal(automaticGuidelineRequestCount('24', 5), 10);
  assert.equal(automaticGuidelineRequestCount('25', 5), 3);
  assert.equal(automaticGuidelineRequestCount('30', 5), 5);
});

test('target automatic classification cannot enable an unconnected route or guess conditional inputs', () => {
  const routes = resolveGuidelineThemeRoutes(['OWASP ASVS 5.0', 'IPA/NISC/WebAppPentestGuidelines']);
  assert.deepEqual(routes.filter((route) => route.mode === 'automatic').map((route) => route.themeNo), ['13', '24', '25', '30']);
  for (const route of routes) {
    assert.equal(route.automationPolicyVersion, GUIDELINE_AUTOMATION_POLICY_VERSION);
    const policy = GUIDELINE_THEME_AUTOMATION_POLICIES[route.themeNo];
    assert.equal(route.automationClass, policy.automationClass);
    if (route.mode === 'needs-input') {
      assert.deepEqual(route.missingInputCodes, policy.requiredInputCodes);
      assert.ok(route.limitationCodes?.includes('automatic-route-not-connected'));
    }
  }
  assert.equal(routes.find((route) => route.themeNo === '18')?.mode, 'needs-input');
  const unsupported = GUIDELINE_THEME_AUTOMATION_POLICIES['17'];
  assert.equal(unsupported.connection, 'unsupported');
  assert.ok(unsupported.limitationCodes.includes('smuggling-send-prohibited'));
  assert.ok(!routes.some((route) => String(route.themeNo) === '17'));
});
