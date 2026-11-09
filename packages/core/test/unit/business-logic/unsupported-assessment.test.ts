import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveUnsupportedAssessments, isImplementedTheme, requireImplementedTheme, automaticGuidelineRequestCount } from '@scopepilot2/core';

test('GO-23 separates theme-level restriction and ASVS scope policy; neither has a verdict', () => {
  const entries = resolveUnsupportedAssessments(['OWASP ASVS 5.0', 'OWASP ASVS 5.0', 'OWASP WSTG 4.2']);
  assert.equal(entries.length, 2);
  const theme = entries.find((entry) => entry.themeNo === '17')!;
  const scope = entries.find((entry) => entry.itemId === '10.2.3')!;
  assert.equal(theme.reasonCode, 'RAW_TRANSPORT_AND_DUAL_PARSER_ORACLE_MISSING');
  assert.equal(scope.themeNo, undefined);
  assert.deepEqual(scope.guidelineIds, ['OWASP ASVS 5.0']);
  assert.equal(scope.reasonCode, 'OAUTH_SCOPE_POLICY_AND_COMPARISON_PRINCIPAL_MISSING');
  for (const entry of entries) {
    assert.equal(entry.assessment, 'not-assessed');
    assert.equal(entry.guarantee, 'Unsupported');
    assert.equal(entry.routeKind, 'unsupported');
    assert.ok(entry.policyVersion);
    assert.ok(entry.resumeConditions.length >= 3);
    assert.equal('checkStatus' in entry, false);
  }
  assert.equal(isImplementedTheme('17'), false);
  assert.throws(() => requireImplementedTheme('17'));
  assert.equal(automaticGuidelineRequestCount('17', 5), 0);
});

test('GO-23 does not assign OAuth scope to unrelated guidelines or treat missing guideline as applicable', () => {
  assert.deepEqual(resolveUnsupportedAssessments([]), []);
  assert.deepEqual(resolveUnsupportedAssessments(['unknown']), []);
  const entries = resolveUnsupportedAssessments(['OWASP WSTG 4.2']);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.themeNo, '17');
});
