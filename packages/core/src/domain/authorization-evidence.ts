/**
 * 認可証跡の metadata 許可欄の白リスト。`docs/detailed-design/f01-case-scope-authorization.md` §5 (AuthorizationEvidence)。
 * 許可 field 以外を保存しない (F01-UT-008)。秘密値は派生成果物へ複写しない。
 */
const ALLOWED_METADATA_FIELDS: readonly string[] = ['contractName', 'authorizedBy', 'authorizedAt', 'reference', 'note'];
const SECRET_FIELD_PATTERN = /(?:secret|token|password|passphrase|api[-_]?key|credential|cookie|session)/i;

export function filterAuthorizationEvidenceMetadata(
  metadata: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const filtered: Record<string, string> = {};
  for (const field of ALLOWED_METADATA_FIELDS) {
    const value = metadata[field];
    if (value !== undefined && !SECRET_FIELD_PATTERN.test(field)) {
      filtered[field] = value;
    }
  }
  return filtered;
}
