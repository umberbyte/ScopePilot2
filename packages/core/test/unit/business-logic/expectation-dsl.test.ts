import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hashStable } from '@scopepilot2/contracts';
import {
  businessTargetInScope,
  checkBusinessAction,
  compareObservations,
  evaluateRestore,
  importCatalogRows,
  parseExpectation,
  planRoleMatrix,
  resolveOutcome,
  verifyTemplateHash,
} from '@scopepilot2/core';
import type { DomainError } from '@scopepilot2/contracts';

describe('business logic (F17)', () => {
  test('[F17-UT-001] allowlist 外 expression は validation error', () => {
    assert.deepEqual(parseExpectation({ expression: 'status.equals', args: [200] }), { expression: 'status.equals' });
    assert.throws(() => parseExpectation({ expression: 'eval.arbitrary', args: [] }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /not allowed: eval.arbitrary/);
      return true;
    });
  });

  test('[F17-UT-002] 2 role 検証は session と evidence を分離する', () => {
    const plan = planRoleMatrix(['admin', 'general']);
    assert.equal(plan.evidenceSeparated, true);
    assert.notEqual(plan.sessions.get('admin'), plan.sessions.get('general'));
    assert.notEqual(plan.sessions.get('admin')?.cookieJarId, plan.sessions.get('general')?.cookieJarId);
  });

  test('[F17-UT-003] 観測欠落は Inconclusive とする', () => {
    assert.deepEqual(compareObservations('same', 'same'), { outcome: 'pass' });
    assert.deepEqual(compareObservations('a', 'b'), { outcome: 'fail' });
    assert.deepEqual(compareObservations(null, 'x'), { outcome: 'inconclusive' });
    assert.deepEqual(compareObservations('x', null), { outcome: 'inconclusive' });
  });

  test('[F17-UT-004] restore assert 不一致は成功扱いにしない', () => {
    assert.equal(evaluateRestore([{ name: 'reset-cart', passed: true }]).outcome, 'restored');
    assert.equal(evaluateRestore([{ name: 'reset-cart', passed: true }, { name: 'assert-empty', passed: false }]).outcome, 'restore-failed');
  });

  test('[F17-UT-005] template hash 不一致は実行拒否する', () => {
    const content = 'GET /x HTTP/1.1\nHost: fixture.target.test\n';
    const correct = hashStable('scopepilot2.template', { name: 't1', content });
    assert.equal(verifyTemplateHash({ name: 't1', content }, correct).allowed, true);
    assert.equal(verifyTemplateHash({ name: 't1', content: content + 'X' }, correct).allowed, false);
  });

  test('[F17-UT-006] setup blocked では Pass/Fail を作らない', () => {
    const blocked = resolveOutcome({ setupBlocked: true, assertionPassed: true });
    assert.equal(blocked.status, 'not-run');
    assert.match(blocked.reason ?? '', /neither pass nor fail/);
    assert.equal(resolveOutcome({ setupBlocked: false, assertionPassed: true }).status, 'pass');
    assert.equal(resolveOutcome({ setupBlocked: false, assertionPassed: false }).status, 'fail');
  });

  test('[F17-UT-007] 曖昧な Excel 行は warning と review required にする', () => {
    const result = importCatalogRows([
      { sheet: 'OWASP WSTG 4.2', row: 4, itemId: 'WSTG-INFO-06', templateContent: 't' },
      { sheet: 'OWASP WSTG 4.2', row: 5, itemId: '', templateContent: 't' },
      { sheet: 'OWASP WSTG 4.2', row: 6, itemId: 'WSTG-INFO-06', templateContent: 't2' },
    ]);
    assert.equal(result.imported.length, 1);
    assert.equal(result.warnings.length, 2);
    assert.equal(result.reviewRequired, true);
    assert.match(result.warnings[0]?.reason ?? '', /blank/);
    assert.match(result.warnings[1]?.reason ?? '', /duplicate/);
  });

  test('[F17-UT-008] 禁止操作は action 実行前に拒否する', () => {
    const forbidden = new Set(['ActiveScan', 'Fuzz']);
    assert.equal(checkBusinessAction({ operationClass: 'Browse' }, forbidden).allowed, true);
    const rejected = checkBusinessAction({ operationClass: 'ActiveScan' }, forbidden);
    assert.equal(rejected.allowed, false);
    assert.match(rejected.reason ?? '', /forbidden/);

    const scope = { allowedOrigins: ['http://fixture.target.test'], deniedOrigins: [] };
    assert.equal(businessTargetInScope('http://fixture.target.test/cart', scope), true);
    assert.equal(businessTargetInScope('http://elsewhere.example/cart', scope), false);
  });
});
