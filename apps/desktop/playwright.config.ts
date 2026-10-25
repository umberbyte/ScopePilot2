import { defineConfig } from '@playwright/test';

/**
 * Electron app test 構成。`docs/detailed-design/02-ui-information-architecture.md` §7。
 * browser binary は不要 (electron binary を直接起動する)。CI では unit/contract の後に
 * 明示 script でのみ実行する (03-unit-test-strategy §8 の段階分離)。
 */
export default defineConfig({
  testDir: './test/app',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'off',
  },
});
