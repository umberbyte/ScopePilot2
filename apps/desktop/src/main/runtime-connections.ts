import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { NucleiRunner } from '@scopepilot2/adapters';
import type { RuntimeConnectionStatus, RuntimeSettingsSnapshot } from '../shared/runtime-settings.ts';
import { runtimeEnvironment } from './runtime-settings.ts';

const execute = promisify(execFile);

/** Explicit, bounded checks only: no scan, daemon startup or OAST payload registration. */
export async function testRuntimeConnections(
  snapshot: RuntimeSettingsSnapshot,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly RuntimeConnectionStatus[]> {
  const env = runtimeEnvironment(snapshot, inherited);
  const check = async (id: RuntimeConnectionStatus['id'], configured: boolean, probe: () => Promise<string>): Promise<RuntimeConnectionStatus> => {
    if (!configured) return { id, state: 'unconfigured', detail: id === 'zap' ? 'API接続先未指定（自動構成）。起動中エンジンの状態は能力表を参照してください。' : '未設定・利用不可', checkedAt: new Date().toISOString() };
    try {
      return { id, state: 'available', detail: await probe(), checkedAt: new Date().toISOString() };
    } catch {
      // Child output and config contents can contain secrets. Do not return them over IPC.
      return { id, state: 'unavailable', detail: '確認失敗。パス・接続先・起動状態を確認してください。', checkedAt: new Date().toISOString() };
    }
  };
  return await Promise.all([
    check('zap', Boolean(env.SCOPEPILOT_ZAP_BASE_URL), async () => {
      const response = await fetch(new URL('/JSON/core/view/version/', env.SCOPEPILOT_ZAP_BASE_URL!), {
        signal: AbortSignal.timeout(5_000), redirect: 'error',
      });
      if (!response.ok) throw new Error('ZAP unavailable');
      const body = await response.json() as { version?: unknown };
      if (typeof body.version !== 'string' || !/^[\w.+ -]{1,80}$/u.test(body.version)) throw new Error('Invalid ZAP version');
      return `ZAP ${body.version} / 実API接続`;
    }),
    check('nuclei', Boolean(env.SCOPEPILOT_NUCLEI_EXECUTABLE), async () => {
      await execute(env.SCOPEPILOT_NUCLEI_EXECUTABLE!, ['-version'], { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, shell: false });
      return '実CLIの版確認に成功（診断は未実行）';
    }),
    check('templates', Boolean(env.SCOPEPILOT_NUCLEI_TEMPLATE_MANIFEST), async () => {
      const bundle = await new NucleiRunner({ templateManifestPath: env.SCOPEPILOT_NUCLEI_TEMPLATE_MANIFEST! }).verifyTemplateBundle();
      return `${bundle.templateCount}件 / SHA-256 ${bundle.bundleHash}`;
    }),
    check('oast', Boolean(env.SCOPEPILOT_OAST_SERVER_URL), async () => {
      await access(env.SCOPEPILOT_INTERACTSH_CONFIG!, constants.R_OK);
      const response = await fetch(env.SCOPEPILOT_OAST_SERVER_URL!, { method: 'HEAD', signal: AbortSignal.timeout(5_000), redirect: 'error' });
      if (!response.ok) throw new Error('OAST unavailable');
      return 'HTTPS到達・設定ファイル読取を確認。CLI認証・callback相関は未確認';
    }),
  ]);
}
