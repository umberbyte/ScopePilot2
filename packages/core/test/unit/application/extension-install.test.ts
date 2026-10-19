import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hashStable } from '@scopepilot2/contracts';
import { bootstrapFlow } from '../support/test-flow.ts';

/**
 * extension 読み込みの service 経路 (design/f20)。署名不一致・非信頼 publisher・
 * API 範囲外・secret read 権限要求は拒否する。fixture の信頼 root は決定的署名
 * trusted-{id}-{version}-{manifestHash 先頭 8 桁} (service と同一規約)。
 */
describe('extension install (service)', () => {
  interface InstallInput {
    readonly extensionId: string;
    readonly version: string;
    readonly signature: string;
    readonly publisherTrusted: boolean;
    readonly permissions: readonly string[];
    readonly apiRange: readonly string[];
  }

  function build(extensionId: string, version: string, overrides: Partial<Omit<InstallInput, 'extensionId' | 'version'>> = {}): InstallInput {
    const publisherTrusted = overrides.publisherTrusted ?? true;
    const permissions = overrides.permissions ?? ['observations.read'];
    const apiRange = overrides.apiRange ?? ['scopepilot2.api.v1'];
    const manifestHash = hashStable('scopepilot2.extension.manifest', { extensionId, version, publisherTrusted, permissions, apiRange });
    return {
      extensionId,
      version,
      signature: overrides.signature ?? `trusted-${extensionId}-${version}-${manifestHash.slice(0, 8)}`,
      publisherTrusted,
      permissions,
      apiRange,
    };
  }

  test('正しい署名の manifest は読み込まれ、一覧に載る', async () => {
    const { service, operator } = await bootstrapFlow();
    const result = service.installExtension(operator, build('fixture-helper', '1.0.0'));
    assert.equal(result.loaded, true);
    assert.deepEqual(result.extension, { extensionId: 'fixture-helper', version: '1.0.0', permissions: ['observations.read'], apiRange: ['scopepilot2.api.v1'] });
    assert.equal(service.listExtensions().length, 1);
    assert.ok(JSON.stringify(service.events()).includes('ExtensionInstalled'));
  });

  test('署名不一致・非信頼 publisher・API 範囲外・secret read 権限は拒否', async () => {
    const { service, operator } = await bootstrapFlow();
    assert.throws(
      () => service.installExtension(operator, build('broken', '1.0.0', { signature: 'wrong' })),
      /signature mismatch/,
    );
    assert.throws(
      () => service.installExtension(operator, build('untrusted', '1.0.0', { publisherTrusted: false })),
      /trust list/,
    );
    assert.throws(
      () => service.installExtension(operator, build('legacy', '0.9.0', { apiRange: ['scopepilot2.api.v0'] })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'Unsupported');
        return true;
      },
    );
    assert.throws(
      () => service.installExtension(operator, build('greedy', '1.0.0', { permissions: ['secrets.read'] })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'PermissionDenied');
        return true;
      },
    );
    assert.deepEqual(service.listExtensions(), [], '拒否されたものは読み込まれない');
  });
});
