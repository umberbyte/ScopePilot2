/**
 * AI 提案の reducer。`docs/detailed-design/02-ui-information-architecture.md` §5。
 * 提案は明示採用 (人間または許可された automation grant) まで draft を変更しない (UI-UT-007)。
 */
export interface AiProposal<S> {
  readonly proposalId: string;
  readonly provider: string;
  readonly model: string;
  readonly generatedAt: string;
  readonly patch: (draft: S) => S;
}

export type ProposalState<S> =
  | { readonly kind: 'idle'; readonly draft: S }
  | { readonly kind: 'proposed'; readonly draft: S; readonly proposal: AiProposal<S> }
  | { readonly kind: 'adopted'; readonly draft: S; readonly adoptedProposalId: string };

export function receiveProposal<S>(state: ProposalState<S>, proposal: AiProposal<S>): ProposalState<S> {
  // 受信だけでは draft を変更しない。
  return { kind: 'proposed', draft: state.draft, proposal };
}

export function adoptProposal<S>(state: ProposalState<S>): ProposalState<S> {
  if (state.kind !== 'proposed') {
    return state;
  }
  return { kind: 'adopted', draft: state.proposal.patch(state.draft), adoptedProposalId: state.proposal.proposalId };
}

export function dismissProposal<S>(state: ProposalState<S>): ProposalState<S> {
  if (state.kind !== 'proposed') {
    return state;
  }
  return { kind: 'idle', draft: state.draft };
}
