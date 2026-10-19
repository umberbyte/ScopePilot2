/**
 * revision 競合の表示規則。`docs/detailed-design/02-ui-information-architecture.md` §4。
 * 同一案件を複数 window で編集した場合は競合を表示し、自動上書きしない (UI-UT-006)。
 */
export interface RevisionConflictDecision {
  readonly conflicted: boolean;
  readonly message?: string;
}

export function revisionConflictDecision(
  local: { readonly caseId: string; readonly revision: number },
  server: { readonly caseId: string; readonly revision: number },
): RevisionConflictDecision {
  if (local.caseId !== server.caseId) {
    return { conflicted: false };
  }
  if (local.revision !== server.revision) {
    return {
      conflicted: true,
      message: `案件は別の操作で更新されています (表示 ${local.revision} / 最新 ${server.revision})。再読込してください。自動上書きは行いません。`,
    };
  }
  return { conflicted: false };
}
