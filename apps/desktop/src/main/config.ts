/**
 * main process の API 結線設定。純関数として分離し unit test で検証する。
 */
export interface ApiBinding {
  readonly host: '127.0.0.1';
  readonly port: number;
}

/** PORT 環境変数 (0..65535) を解決する。未指定は 0 (ephemeral)。`docs/design/01` の信頼境界: loopback 固定。 */
export function resolveApiBinding(env: Readonly<Record<string, string | undefined>>): ApiBinding {
  const raw = env.SCOPEPILOT_API_PORT;
  if (raw === undefined || raw.trim() === '') {
    return { host: '127.0.0.1', port: 0 };
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`SCOPEPILOT_API_PORT must be an integer between 0 and 65535 (got: ${raw})`);
  }
  return { host: '127.0.0.1', port };
}
