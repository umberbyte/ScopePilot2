import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NucleiRunner } from '../src/nuclei-runner.ts';
import { startVulnerableTarget } from './vulnerable-target.ts';

/**
 * 実 nuclei binary との結合検証。既定では skip し、SCOPEPILOT_NUCLEI_COMMAND に
 * binary path が設定されているときだけ実行する。
 * 実行例:
 *   SCOPEPILOT_NUCLEI_COMMAND=C:/Users/GoSugawara/src/ScopePilot2/nuclei.exe \
 *   npm test -w @scopepilot2/adapters
 *
 * テンプレート一式は実行環境の管理物 (design/21) のため、ここでは最小の自作
 * template 1件 (marker 検出) だけを使い、runner の起動・JSONL 解析・版解析を
 * 検証する。対象は所有している vulnerable-target (127.0.0.1) のみ。
 */
const nucleiCommand = process.env['SCOPEPILOT_NUCLEI_COMMAND'] ?? '';
const gated = nucleiCommand === '' ? describe.skip : describe;

/** index の title marker に match する最小 template。plain page には match しない。 */
const MARKER_TEMPLATE = [
  'id: scopepilot-it-marker',
  'info:',
  '  name: ScopePilot IT marker',
  '  author: scopepilot-it',
  '  severity: info',
  'http:',
  '  - method: GET',
  '    path:',
  '      - "{{BaseURL}}"',
  '    matchers:',
  '      - type: word',
  '        words:',
  '          - "ScopePilot IT Target"',
].join('\n');

gated('Nuclei runner (実 binary 結合)', () => {
  test('版解析と JSONL 行取得 (最小自作 template・所有ターゲット)', { timeout: 180_000 }, async () => {
    const target = await startVulnerableTarget();
    const workdir = await mkdtemp(join(tmpdir(), 'scopepilot2-nuclei-it-'));
    try {
      const templateFile = join(workdir, 'marker.yaml');
      await writeFile(templateFile, MARKER_TEMPLATE, 'utf8');
      const runner = new NucleiRunner({
        command: nucleiCommand,
        argsPrefix: ['-t', templateFile],
        timeoutMs: 120_000,
      });

      // v3 は「Nuclei Engine Version: v3.x.y」(v2 は Current Version)。
      const version = await runner.version();
      assert.match(version, /^nuclei v\d+\.\d+/);

      // index は marker に match、plain は match しない。
      const result = await runner.run({ targets: [target.indexUrl, target.plainUrl] });
      assert.equal(result.engineVersion, version);
      assert.equal(result.lines.length, 1, `match 行は 1 件のはず: ${result.lines.join(' / ')}`);
      const match = JSON.parse(result.lines[0] ?? '{}') as {
        'template-id'?: string;
        'matched-at'?: string;
        host?: string;
      };
      assert.equal(match['template-id'], 'scopepilot-it-marker');
      assert.equal(match['matched-at'], target.indexUrl);
      assert.equal(match.host, '127.0.0.1');
    } finally {
      await rm(workdir, { recursive: true, force: true });
      target.server.close();
    }
  });
});
