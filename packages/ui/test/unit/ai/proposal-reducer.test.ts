import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { adoptProposal, dismissProposal, receiveProposal, type AiProposal } from '../../../src/ai/proposal-reducer.ts';

interface Draft {
  readonly note: string;
}

const proposal: AiProposal<Draft> = {
  proposalId: 'prop-1',
  provider: 'z.ai',
  model: 'glm-5.3',
  generatedAt: '2026-10-19T00:00:00.000Z',
  patch: (draft) => ({ ...draft, note: `${draft.note} (AI提案採用)` }),
};

describe('ai proposal reducer', () => {
  test('[UI-UT-007] AI 提案の受信だけでは draft を変更せず、明示採用で適用する', () => {
    const initial = { kind: 'idle' as const, draft: { note: '元の記録' } };
    const proposed = receiveProposal(initial, proposal);
    assert.deepEqual(proposed.draft, { note: '元の記録' }, '受信だけでは draft 不変');
    assert.equal(proposed.kind, 'proposed');

    const adopted = adoptProposal(proposed);
    assert.equal(adopted.kind, 'adopted');
    assert.deepEqual(adopted.draft, { note: '元の記録 (AI提案採用)' });

    const dismissed = dismissProposal(receiveProposal(initial, proposal));
    assert.equal(dismissed.kind, 'idle');
    assert.deepEqual(dismissed.draft, { note: '元の記録' });

    // idle では採用できず draft も不変。
    assert.deepEqual(adoptProposal(initial), initial);
  });
});
