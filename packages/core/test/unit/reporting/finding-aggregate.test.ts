import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildCoverageSection,
  confirmFinding,
  labelReportOrigins,
  matchDuplicates,
  redactForProfile,
  renderDeterministicMarkdown,
  setManualSeverity,
  verifyEvidenceChain,
} from '@scopepilot2/core';
import type { DomainError, Finding } from '@scopepilot2/contracts';

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  findingId: 'finding-0001',
  title: 'XSS (fixture)',
  source: { kind: 'zap-alert', engineVersion: '2.17.0-fixture', unverified: true },
  url: 'http://fixture.target.test/x',
  method: 'GET',
  param: 'q',
  severity: 'medium',
  status: 'candidate',
  evidenceRefs: ['evidence-0001'],
  firstSeenAt: '2026-10-18T09:00:00.000Z',
  lastSeenAt: '2026-10-18T09:00:00.000Z',
  occurrences: 1,
  enginePluginId: '40012',
  ...overrides,
});

describe('reporting (F19)', () => {
  test('[F19-UT-001] evidence なしでは Confirmed にできない', () => {
    assert.throws(() => confirmFinding(finding(), []), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as DomainError).code, 'ValidationFailed');
      assert.match((error as DomainError).message, /without at least one evidence/);
      return true;
    });
    assert.deepEqual(confirmFinding(finding(), [{ evidenceId: 'evidence-0001' }]), { status: 'confirmed' });
  });

  test('[F19-UT-002] 類似候補は merge せず suggestion だけ出す', () => {
    const suggestions = matchDuplicates(
      { findingId: 'f1', title: 'Session cookie without Secure', url: 'http://a.test/x' },
      [
        { findingId: 'f2', title: 'Session cookie without Secure flag', url: 'http://a.test/x' },
        { findingId: 'f3', title: 'SQL injection', url: 'http://a.test/y' },
      ],
    );
    assert.deepEqual(suggestions.suggestions, [{ findingId: 'f2', reason: 'same url' }]);
  });

  test('[F19-UT-003] source severity と手動値を両方保持し、変更理由を残す', () => {
    assert.throws(() => setManualSeverity({ sourceSeverity: 'medium' }, 'high', '  '), /requires a reason/);
    const result = setManualSeverity({ sourceSeverity: 'medium' }, 'high', '実影響を確認したため');
    assert.deepEqual(result, { sourceSeverity: 'medium', manualSeverity: 'high', changeReason: '実影響を確認したため' });
  });

  test('[F19-UT-004] hint/observation/AI 混在は origin label を分離する', () => {
    const labels = labelReportOrigins([
      { source: 'zap-alert' },
      { source: 'observation' },
      { source: 'document-hint' },
      { source: 'ai-proposal' },
    ]);
    assert.deepEqual(
      labels.map((label) => label.label),
      ['observation', 'observation', 'document-hint', 'ai-proposal'],
    );
  });

  test('[F19-UT-005] secret/PII は shared profile で除外される', () => {
    const entries = [
      { text: '通常記述', kind: 'normal' as const },
      { text: 'password=hunter2', kind: 'secret' as const },
      { text: '利用者: 山田太郎', kind: 'pii' as const },
    ];
    assert.deepEqual(redactForProfile(entries, 'internal-full'), ['通常記述', 'password=hunter2', '利用者: 山田太郎']);
    assert.deepEqual(redactForProfile(entries, 'shared-masked'), ['通常記述', '[redacted: secret]', '[redacted: PII]']);
  });

  test('[F19-UT-006] 固定 model から決定的な markdown を出す', () => {
    const model = { caseId: 'case-0001', titles: ['b-item', 'a-item'] };
    assert.equal(renderDeterministicMarkdown(model), renderDeterministicMarkdown(model));
    assert.equal(renderDeterministicMarkdown(model), '# case case-0001\n- a-item\n- b-item\n');
  });

  test('[F19-UT-007] 証跡 chain の hash 不一致は broken chain として失敗する', () => {
    const ok = verifyEvidenceChain([
      { from: { evidenceId: 'e1', sha256: 'aa' }, to: { evidenceId: 'e2', sha256: 'bb' }, expectedFromSha256: 'aa' },
    ]);
    assert.deepEqual(ok, { valid: true, brokenAt: null });
    const broken = verifyEvidenceChain([
      { from: { evidenceId: 'e1', sha256: 'aa' }, to: { evidenceId: 'e2', sha256: 'bb' }, expectedFromSha256: 'aa' },
      { from: { evidenceId: 'e2', sha256: 'tampered' }, to: { evidenceId: 'e3', sha256: 'cc' }, expectedFromSha256: 'bb' },
    ]);
    assert.deepEqual(broken, { valid: false, brokenAt: 1 });
  });

  test('[F19-UT-008] delegated step がある場合は limitation を必ず含める', () => {
    const withDelegated = buildCoverageSection([{ engineKind: 'zap' }]);
    assert.ok(withDelegated.limitations.length >= 2);
    assert.match(withDelegated.limitations[0] ?? '', /送信前に拒否できません/);
    const without = buildCoverageSection([]);
    assert.equal(without.limitations.length, 1);
    assert.match(without.limitations[0] ?? '', /証明するものではありません/);
  });
});
