import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bootstrapFlow } from '../support/test-flow.ts';

describe('report severity filter', () => {
  test('Low / Info は指定時だけ報告書から除外し、内部所見には保持する', async () => {
    const { service, operator } = await bootstrapFlow();
    await service.importNucleiResults(operator, {
      engineVersion: 'nuclei-filter-test',
      lines: [
        '{"template-id":"info-check","matched-at":"http://fixture.target.test/info","info":{"severity":"info","name":"Informational header"}}',
        '{"template-id":"low-check","matched-at":"http://fixture.target.test/low","info":{"severity":"low","name":"Low risk header"}}',
        '{"template-id":"high-check","matched-at":"http://fixture.target.test/high","info":{"severity":"high","name":"High risk issue"}}',
      ],
    });

    const complete = service.generateReport(operator, { guidelines: ['test'] });
    assert.match(complete.content, /Informational header/u);
    assert.match(complete.content, /Low risk header/u);
    assert.match(complete.content, /High risk issue/u);

    const filtered = service.generateReport(operator, { guidelines: ['test'], excludeLowAndInfo: true });
    assert.doesNotMatch(filtered.content, /Informational header/u);
    assert.doesNotMatch(filtered.content, /Low risk header/u);
    assert.match(filtered.content, /High risk issue/u);
    assert.match(filtered.content, /Low \/ Info/u);
    assert.equal(service.listFindings().length, 3, 'filtering must not delete audit findings');
  });
});
