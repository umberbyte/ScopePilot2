/**
 * 計画 hash の正規化規約。
 * 同じ入力から同じ hash を作るため、object key は昇順、配列は与えた順を保持し、
 * 浮動小数点の表記ゆれを避けるため数値はそのまま JSON 表記を用いる。
 * 計画 hash は `docs/design/19-cli-automation.md` A0 受け入れ条件の基準。
 */
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => serialize(element)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value: ${String(value)}`);
}

/** namespace は schema/table 区別 (例: `scopepilot2.plan.v1`)。同じ入力・同じ namespace から同じ hash を返す。 */
export function hashStable(namespace: string, value: unknown): string {
  return createHash('sha256').update(`${namespace}\n${canonicalJson(value)}`, 'utf8').digest('hex');
}
