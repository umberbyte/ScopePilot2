import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PlaywrightExplorerAdapter } from '../src/playwright-explorer.ts';
import { startVulnerableTarget } from './vulnerable-target.ts';

/**
 * 実 playwright (chromium) との結合検証。既定では skip し、
 * SCOPEPILOT_PLAYWRIGHT_IT=1 が設定されているときだけ実行する。
 * 対象は所有している vulnerable-target (127.0.0.1) のみ。
 */
const gated = process.env['SCOPEPILOT_PLAYWRIGHT_IT'] === '1' ? describe : describe.skip;

gated('Playwright explorer adapter (実 browser 結合)', () => {
  test(
    'observe: 実 chromium で title・絶対 link 取得。void(0) は除外',
    { timeout: 120_000 },
    async () => {
      const target = await startVulnerableTarget();
      const adapter = new PlaywrightExplorerAdapter({
        scope: { allowedOrigins: [target.base], deniedOrigins: [] },
      });
      try {
        const observation = await adapter.observe(target.indexUrl);
        assert.ok(observation !== null);
        assert.equal(observation.status, 200);
        assert.equal(observation.title, 'ScopePilot IT Target');
        assert.ok(observation.links.includes(target.echoUrl), `links に echo がない: ${observation.links.join(' ')}`);
        assert.ok(observation.links.includes(target.plainUrl), `links に plain がない: ${observation.links.join(' ')}`);
        assert.ok(observation.links.every((link) => link.startsWith('http://') || link.startsWith('https://')));
        assert.equal(adapter.engineVersionLabel, 'playwright-chromium');
      } finally {
        await adapter.close();
        target.server.close();
      }
    },
  );

  test('scope 外 URL は browser を起動すらしない (Enforced: 送信前拒否)', { timeout: 30_000 }, async () => {
    const target = await startVulnerableTarget();
    const adapter = new PlaywrightExplorerAdapter({
      // 全 origin 不許可: observe が browser context を作ったら検知できる。
      scope: { allowedOrigins: [], deniedOrigins: [target.base] },
    });
    try {
      const observation = await adapter.observe(target.indexUrl);
      assert.equal(observation, null);
      assert.equal(adapter.engineVersionLabel, 'playwright (未起動)');
    } finally {
      await adapter.close();
      target.server.close();
    }
  });

  test('404 は status 観測のみ (link 抽出なし)', { timeout: 60_000 }, async () => {
    const target = await startVulnerableTarget();
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: [target.base], deniedOrigins: [] },
    });
    try {
      const observation = await adapter.observe(`${target.base}/missing`);
      assert.ok(observation !== null);
      assert.equal(observation.status, 404);
      assert.deepEqual(observation.links, []);
    } finally {
      await adapter.close();
      target.server.close();
    }
  });

  test('attachment 応答は実 chromium でも探索を中断しない', { timeout: 60_000 }, async () => {
    const target = await startVulnerableTarget();
    const adapter = new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: [target.base], deniedOrigins: [] },
    });
    try {
      const observation = await adapter.observe(target.downloadUrl);
      assert.ok(observation !== null);
      assert.equal(observation.url, target.downloadUrl);
      assert.equal(observation.status, 200);
      assert.equal(observation.contentType, 'application/octet-stream');
      assert.deepEqual(observation.links, []);
      assert.deepEqual(observation.forms, []);
    } finally {
      await adapter.close();
      target.server.close();
    }
  });
});
