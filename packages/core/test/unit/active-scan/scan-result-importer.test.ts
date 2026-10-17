import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FindingImporter } from '@scopepilot2/core';
import type { EngineAlert } from '@scopepilot2/contracts';

const baseAlert: EngineAlert = {
  engineAlertId: 'zap-alert-0001',
  pluginId: '40012',
  name: 'Cross Site Scripting (Reflected) (fixture)',
  risk: 'Medium',
  url: 'http://fixture.target.test/vulnerabilities/xss_reflected/?name=guest',
  method: 'GET',
  param: 'name',
  evidenceSummary: 'first observation',
};

function importContext() {
  return {
    now: '2026-10-18T09:05:00.000Z',
    engineVersion: '2.17.0-fixture',
    makeFindingId: (() => {
      let sequence = 0;
      return () => {
        sequence += 1;
        return `finding-${String(sequence).padStart(4, '0')}`;
      };
    })(),
    evidenceRef: 'evidence-0001',
  };
}

describe('FindingImporter', () => {
  test('[F11-UT-006] 同一 (pluginId, url, param) の alert 再取込は dedupe して観測回数を増やす', () => {
    const importer = new FindingImporter();
    const first = importer.importAlerts([baseAlert, { ...baseAlert, pluginId: '40018', engineAlertId: 'zap-alert-0002' }], importContext());
    assert.equal(first.created.length, 2);
    assert.equal(first.duplicateCount, 0);

    const second = importer.importAlerts(
      [{ ...baseAlert, engineAlertId: 'zap-alert-0003', evidenceSummary: 're-observed' }],
      importContext(),
    );
    assert.equal(second.created.length, 0);
    assert.equal(second.duplicateCount, 1);

    const findings = importer.list();
    assert.equal(findings.length, 2);
    const reobserved = findings.find((finding) => finding.enginePluginId === '40012');
    assert.notEqual(reobserved, undefined);
    assert.equal(reobserved?.occurrences, 2);
    assert.equal(reobserved?.source.unverified, true);
  });

  test('[F11-UT-006] param の有無は別の観測として区別される', () => {
    const importer = new FindingImporter();
    importer.importAlerts([baseAlert], importContext());
    const { param: _param, ...withoutParam } = baseAlert;
    const second = importer.importAlerts([{ ...withoutParam, engineAlertId: 'zap-alert-0004' }], importContext());
    assert.equal(second.created.length, 1);
    assert.equal(importer.list().length, 2);
  });
});
