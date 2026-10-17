/**
 * ZAP alert API 出力の固定 fixture。`docs/design/19-cli-automation.md` 5章。
 * poll 1 で 2 件、poll 2 で再観測 1 件 (重複) と新規 1 件を返し、取込側の
 * 重複除外 (F11-UT-006) と alert cursor の回帰基準に使う。
 * pluginId は ZAP の実際の ID 空間に合わせた固定値だが、内容は合成である。
 */
import { hashStable, type EngineAlert } from '@scopepilot2/contracts';

export const FIXTURE_ZAP_VERSION = '2.17.0-fixture';

const alertXssFirst: EngineAlert = {
  engineAlertId: 'zap-alert-0001',
  pluginId: '40012',
  name: 'Cross Site Scripting (Reflected) (fixture)',
  risk: 'Medium',
  url: 'http://fixture.target.test/vulnerabilities/xss_reflected/?name=guest',
  method: 'GET',
  param: 'name',
  evidenceSummary: 'reflected marker observed in response body (fixture)',
};

const alertSqlInjection: EngineAlert = {
  engineAlertId: 'zap-alert-0002',
  pluginId: '40018',
  name: 'SQL Injection (fixture)',
  risk: 'High',
  url: 'http://fixture.target.test/vulnerabilities/sql_injection/?id=1',
  method: 'GET',
  param: 'id',
  evidenceSummary: 'database error marker observed (fixture)',
};

const alertXssReobserved: EngineAlert = {
  ...alertXssFirst,
  engineAlertId: 'zap-alert-0003',
};

const alertCookieFlag: EngineAlert = {
  engineAlertId: 'zap-alert-0004',
  pluginId: '10010',
  name: 'Cookie without HttpOnly flag (fixture)',
  risk: 'Low',
  url: 'http://fixture.target.test/login.php',
  method: 'GET',
  evidenceSummary: 'Set-Cookie header without HttpOnly (fixture)',
};

/** poll 番号 (1 起点) ごとの alert 批次。cursor = 直前までに取り出した件数。 */
export const FIXTURE_ZAP_ALERT_BATCHES: readonly (readonly EngineAlert[])[] = [
  [alertXssFirst, alertSqlInjection],
  [alertXssReobserved, alertCookieFlag],
];

export function zapAlertsFixtureHash(): string {
  return hashStable('scopepilot2.simulation.zap-alerts', {
    version: FIXTURE_ZAP_VERSION,
    batches: FIXTURE_ZAP_ALERT_BATCHES,
  });
}
