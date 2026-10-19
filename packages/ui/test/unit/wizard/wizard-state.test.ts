import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { advance, canAdvance, goBack, initialWizardData, routeForStep, stepComplete, WIZARD_STEPS } from '../../../src/wizard/wizard-state.ts';
import { resolveRoute } from '../../../src/app/mode-policy.ts';

const fullPermissions = ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'] as const;

describe('wizard state machine', () => {
  test('[UI-UT-009] 未完了 step は先へ進めず、要件を満たすと次 step へ進む', () => {
    let data = initialWizardData();
    assert.deepEqual(advance('S01', data), { ok: false, reason: 'step S01 is not complete yet' });
    assert.equal(canAdvance('S02', data), false);

    data = { ...data, caseOpened: true };
    assert.deepEqual(advance('S01', data), { ok: true, next: 'S02' });
    assert.deepEqual(advance('S02', data), { ok: false, reason: 'step S02 is not complete yet' });

    data = { ...data, selectedGuidelines: ['OWASP WSTG 4.2'] };
    assert.deepEqual(advance('S02', data), { ok: true, next: 'S03' });
    data = { ...data, explorationDone: true, selectedTargets: ['http://a.test/'], planConfirmed: true, runFinished: true };
    assert.deepEqual(advance('S03', data), { ok: true, next: 'S04' });
    assert.deepEqual(advance('S04', data), { ok: true, next: 'S05' });
    assert.deepEqual(advance('S05', data), { ok: true, next: 'S06' });
    assert.deepEqual(advance('S06', data), { ok: true, next: 'S07' });
    assert.deepEqual(advance('S07', data), { ok: false, reason: 'step S07 has no next step' });
    // 全 step を通過する一貫性。
    assert.equal(WIZARD_STEPS.length, 7);
  });

  test('[UI-UT-010] 各 step は Simple で許可される wizard route に写る', () => {
    for (const step of WIZARD_STEPS) {
      const route = routeForStep(step);
      const decision = resolveRoute('simple', route, fullPermissions);
      assert.deepEqual(decision, { allowed: true }, `${step} -> ${route} は Simple で許可`);
    }
    // route は重複しない。
    const routes = WIZARD_STEPS.map((step) => routeForStep(step));
    assert.equal(new Set(routes).size, 7);
  });

  test('[UI-UT-011] 戻りは常に許可し、S01 では戻れない。stepComplete は S07 常true', () => {
    assert.deepEqual(goBack('S01'), { ok: false, reason: 'S01 has no previous step' });
    for (const step of WIZARD_STEPS.slice(1)) {
      const result = goBack(step);
      assert.equal(result.ok, true);
    }
    assert.deepEqual(goBack('S05'), { ok: true, previous: 'S04' });
    assert.equal(stepComplete('S07', initialWizardData()), true);
  });
});
