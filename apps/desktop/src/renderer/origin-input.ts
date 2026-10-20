/** UIの複数行入力をcanonical originへ変換する。パス、末尾slash、既定portはURL実装で除去する。 */
export function parseHttpOriginInput(raw: string): { readonly origins: readonly string[]; readonly invalidEntries: readonly string[] } {
  const origins: string[] = [];
  const invalidEntries: string[] = [];
  for (const entry of raw.split(/[\r\n,]+/u).map((value) => value.trim()).filter(Boolean)) {
    try {
      const parsed = new URL(entry);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        invalidEntries.push(entry);
        continue;
      }
      origins.push(parsed.origin);
    } catch {
      invalidEntries.push(entry);
    }
  }
  return { origins: [...new Set(origins)], invalidEntries };
}

