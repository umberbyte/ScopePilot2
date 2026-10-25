/**
 * secret 参照の表示規則。`docs/detailed-design/02-ui-information-architecture.md` §4。
 * secret 値は renderer の永続 store に置かず、表示は保存先・状態のみ (UI-UT-008)。
 */
export interface SecretReferenceView {
  readonly referenceId: string;
  readonly store: string;
  readonly status: 'available' | 'missing';
}

export function presentSecretReference(input: { readonly referenceId: string; readonly store: string; readonly resolved: boolean }): SecretReferenceView {
  return {
    referenceId: input.referenceId,
    store: input.store,
    status: input.resolved ? 'available' : 'missing',
  };
}

/** 表示 model に値が混入していないかの検証用 (誤って値を渡した実装を検出する)。 */
export function assertNoSecretValue(view: SecretReferenceView): void {
  const allowed: ReadonlySet<string> = new Set(['referenceId', 'store', 'status']);
  for (const key of Object.keys(view)) {
    if (!allowed.has(key)) {
      throw new Error(`unexpected field ${key} on secret reference view`);
    }
  }
}
