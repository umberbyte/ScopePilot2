/**
 * Nuclei JSONL 出力の固定 fixture。`docs/design/19-cli-automation.md` 5章。
 * F18 (known-vulnerabilities) の結果取込を基準フローで行使するため、
 * 重複行・破損行・scope 外 matched-at・critical severity の境界ケースを含む。
 * template 記述は合成であり、実在の脆弱性テンプレートを複製しない。
 */
import { hashStable } from '@scopepilot2/contracts';

export const FIXTURE_NUCLEI_VERSION = '3.4.0-fixture';

/** 意図的に不正な行 (quarantine 確認用) の 0 基点 index。 */
export const FIXTURE_NUCLEI_MALFORMED_LINE_INDEXES: readonly number[] = [5, 6];

export const FIXTURE_NUCLEI_JSONL: readonly string[] = [
  '{"template-id":"fixture-missing-header.yaml","matcher-name":"x-content-type-options","matched-at":"http://fixture.target.test/","info":{"severity":"info","name":"Fixture: missing security header"}}',
  '{"template-id":"fixture-verbose-path.yaml","matcher-name":"setup","matched-at":"http://fixture.target.test/setup.php","info":{"severity":"info","name":"Fixture: exposed setup path"}}',
  '{"template-id":"fixture-missing-header.yaml","matcher-name":"x-content-type-options","matched-at":"http://fixture.target.test/","info":{"severity":"info","name":"Fixture: missing security header"}}',
  '{"template-id":"fixture-sqli-error-based.yaml","matcher-name":"error-marker","matched-at":"http://fixture.target.test/vulnerabilities/sql_injection/?id=1","info":{"severity":"critical","name":"Fixture: SQL injection error marker"}}',
  '{"template-id":"fixture-out-of-scope.yaml","matcher-name":"anything","matched-at":"http://elsewhere.example/out-of-scope","info":{"severity":"info","name":"Fixture: matched out of scope"}}',
  '{"template-id":"fixture-broken-json.yaml"',
  '{"matched-at":"http://fixture.target.test/","info":{"severity":"info","name":"Fixture: line without template-id"}}',
];

export function nucleiJsonlFixtureHash(): string {
  return hashStable('scopepilot2.simulation.nuclei-jsonl', {
    version: FIXTURE_NUCLEI_VERSION,
    lines: FIXTURE_NUCLEI_JSONL,
  });
}
