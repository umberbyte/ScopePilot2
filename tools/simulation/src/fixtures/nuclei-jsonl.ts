/**
 * Nuclei JSONL 出力の固定 fixture。`docs/design/19-cli-automation.md` 5章。
 * A0 時点では harness への供給データのみを固定し、取込 (F18) は未実装。
 * template 記述は合成であり、実在の脆弱性テンプレートを複製しない。
 */
import { hashStable } from '@scopepilot2/contracts';

export const FIXTURE_NUCLEI_VERSION = '3.4.0-fixture';

export const FIXTURE_NUCLEI_JSONL: readonly string[] = [
  '{"template-id":"fixture-missing-header.yaml","matcher-name":"x-content-type-options","matched-at":"http://fixture.target.test/","info":{"severity":"info","name":"Fixture: missing security header"}}',
  '{"template-id":"fixture-verbose-path.yaml","matcher-name":"setup","matched-at":"http://fixture.target.test/setup.php","info":{"severity":"info","name":"Fixture: exposed setup path"}}',
];

export function nucleiJsonlFixtureHash(): string {
  return hashStable('scopepilot2.simulation.nuclei-jsonl', {
    version: FIXTURE_NUCLEI_VERSION,
    lines: FIXTURE_NUCLEI_JSONL,
  });
}
