import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NucleiRunner } from '../src/nuclei-runner.ts';

/**
 * Nuclei runner の契約検証。実 nuclei バイナリは使わず、node で動く stub script
 * (JSONL を stdout へ、版を stderr へ出す) を argsPrefix 経由で起動して、
 * 引数組立・対象 file 受渡・出力解析を検証する。
 */
const STUB_SCRIPT = `
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('-version')) {
  process.stderr.write('Current Version: v3.4.0\\n');
  process.exit(0);
}
const targetIndex = args.indexOf('-l');
const targetFile = targetIndex === -1 ? '' : args[targetIndex + 1];
const targets = targetFile === '' ? [] : readFileSync(targetFile, 'utf8').split('\\n').filter((line) => line !== '');
for (const target of targets) {
  process.stdout.write(JSON.stringify({ templateID: 'stub-template', matchedAt: target, severity: 'high' }) + '\\n');
}
`;

describe('Nuclei runner (stub binary 契約検証)', () => {
  test('対象を temp file 経由で渡し、JSONL 行と版を返す', async () => {
    const workdir = process.env['TEMP'] ?? '.';
    const stubPath = join(workdir, `scopepilot2-nuclei-stub-${Date.now()}.mjs`);
    await writeFile(stubPath, STUB_SCRIPT, 'utf8');
    try {
      const runner = new NucleiRunner({ command: process.execPath, argsPrefix: [stubPath], timeoutMs: 30_000 });
      assert.equal(await runner.version(), 'nuclei v3.4.0');

      const result = await runner.run({ targets: ['http://target.test/a', 'http://target.test/b'] });
      assert.equal(result.engineVersion, 'nuclei v3.4.0');
      assert.equal(result.lines.length, 2);
      const first = JSON.parse(result.lines[0] ?? '') as { templateID: string; matchedAt: string };
      assert.equal(first.templateID, 'stub-template');
      assert.equal(first.matchedAt, 'http://target.test/a');
    } finally {
      await writeFile(stubPath, '', 'utf8').catch(() => undefined);
    }
  });

  test('対象なしは実行前に拒否', async () => {
    const runner = new NucleiRunner({ command: process.execPath, argsPrefix: [], timeoutMs: 5_000 });
    await assert.rejects(runner.run({ targets: [] }), /at least one target/);
  });
});
