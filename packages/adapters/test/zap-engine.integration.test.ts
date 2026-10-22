import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ZapEngineAdapter } from '../src/zap-engine.ts';
import { startVulnerableTarget, type VulnerableTarget } from './vulnerable-target.ts';

/**
 * 実 ZAP との結合検証。既定では skip し、SCOPEPILOT_ZAP_BASE_URL が設定されている
 * ときだけ実行する (CI・通常の unit 実行は実 engine 不要)。
 * 実行例:
 *   SCOPEPILOT_ZAP_BASE_URL=http://127.0.0.1:8090 \
 *   SCOPEPILOT_ZAP_API_KEY=scopepilot2-test \
 *   npm test -w @scopepilot2/adapters
 * ※実 ZAP を共有する gated test は並列実行すると newSession が他 test の
 * scan/alert/login jar を消し合うため必ず直列で: npm run test:gated -w @scopepilot2/adapters
 *
 * 検証するのは adapter の入出力写像のみ (design/22: engine の内部挙動は制御しない)。
 * 対象は所有している vulnerable-target (127.0.0.1) だけ。
 */
const zapBaseUrl = process.env['SCOPEPILOT_ZAP_BASE_URL'] ?? '';
const gated = zapBaseUrl === '' ? describe.skip : describe;

gated('ZAP adapter (実 ZAP 結合)', () => {
  test(
    'start → progress → (完了待ち) → alerts: accessUrl 経由で scan が始まり alert が取れる',
    { timeout: 360_000 },
    async () => {
      const target: VulnerableTarget = await startVulnerableTarget();
      const adapter = new ZapEngineAdapter({ baseUrl: zapBaseUrl, timeoutMs: 60_000 });
      try {
        // 版の確認 (能力表 source=measured の前提)。
        const version = await adapter.resolvedVersion();
        assert.match(version, /^zap \d+\.\d+/);

        // 他の gated test と同じく、過去 run の site・alert を混入させないため
        // session を作り直してから診断する (work log 2026-10-19 の流儀)。
        const apiKey = process.env['SCOPEPILOT_ZAP_API_KEY'] ?? '';
        await fetch(`${zapBaseUrl}/JSON/core/action/newSession/?apikey=${apiKey}`);

        // start: accessUrl → ascan。URL Does not Exist が出ないこと自体が検証対象。
        const scanId = await adapter.start({
          runId: 'run-it-zap-0001',
          targets: [target.indexUrl, target.echoUrl],
          attackStrength: 'Medium',
          leasedLimits: { maxRequests: 200, maxPages: 10, maxDurationMinutes: 5, maxConcurrency: 1, requestsPerSecond: 2 },
          authorizationRef: 'authz-it-0001',
        });
        assert.match(scanId, /^scopepilot:run-it-zap-0001$/);

        // progress の写像。既定 policy は時間がかかるので、完了するか期限まで待つ。
        let lastProgress = await adapter.progress(scanId);
        const deadline = Date.now() + 240_000;
        while (lastProgress.status === 'running' && Date.now() < deadline) {
          await new Promise((resolve) => {
            setTimeout(resolve, 5_000);
          });
          lastProgress = await adapter.progress(scanId);
        }
        if (lastProgress.status !== 'complete') {
          // 期限内に終わなければ冪等停止して、alert 取得に進む (passive 分は出ている)。
          await adapter.stop(scanId);
        }
        assert.ok(lastProgress.progress >= 0 && lastProgress.progress <= 100);

        // alerts: paging して打切り。passive scan (header なし) で必ず何かしら出る。
        // pscan の alert 生成は非同期で遅れることがあるため、空なら最大 10 秒待つ。
        const seen: string[] = [];
        let cursor = 0;
        for (let settle = 0; settle < 10; settle += 1) {
          const probe = await adapter.alerts(scanId, cursor);
          if (probe.alerts.length > 0 || settle === 9) {
            break;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 1_000);
          });
        }
        for (let page = 0; page < 10; page += 1) {
          const result = await adapter.alerts(scanId, cursor);
          for (const alert of result.alerts) {
            seen.push(alert.engineAlertId);
            assert.match(alert.engineAlertId, /^zap-\d+$/);
            assert.ok(alert.risk === 'Informational' || alert.risk === 'Low' || alert.risk === 'Medium' || alert.risk === 'High');
          }
          if (result.nextCursor === cursor) {
            break;
          }
          cursor = result.nextCursor;
        }
        assert.ok(seen.length > 0, 'alert が 1 件も取れない');

        // 完了済み run への stop も error にしない (冪等: F11-UT-005)。
        await adapter.stop(scanId);
      } finally {
        target.server.close();
      }
    },
  );
});
