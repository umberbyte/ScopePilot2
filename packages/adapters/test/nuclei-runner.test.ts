import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NucleiRunner } from '../src/nuclei-runner.ts';

/**
 * Nuclei runner の契約検証。実 nuclei バイナリは使わず、node で動く stub script
 * (JSONL を stdout へ、版を stderr へ出す) を argsPrefix 経由で起動して、
 * 引数組立・対象 file 受渡・出力解析を検証する。
 */
const STUB_SCRIPT = `
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('-version')) {
  process.stderr.write('Current Version: v3.4.0\\n');
  process.exit(0);
}
if (args.includes('-silent')) throw new Error('silent must not be passed');
for (const required of ['-type', '-t', '-exclude-tags', '-severity', '-stats', '-stats-interval', '-jsonl-export', '-no-color', '-include-rr']) {
  if (!args.includes(required)) throw new Error('missing option: ' + required);
}
const typeIndex = args.indexOf('-type');
const profileType = typeIndex === -1 ? '' : args[typeIndex + 1];
if (profileType !== 'http') throw new Error('only the reviewed HTTP profile is allowed');
if (args.includes('-automatic-scan')) throw new Error('automatic scan must not be passed');
const targetIndex = args.indexOf('-l');
const targetFile = targetIndex === -1 ? '' : args[targetIndex + 1];
const exportIndex = args.indexOf('-jsonl-export');
const resultFile = exportIndex === -1 ? '' : args[exportIndex + 1];
const targets = targetFile === '' ? [] : readFileSync(targetFile, 'utf8').split('\\n').filter((line) => line !== '');
process.stderr.write('[INF] Templates loaded: 42\\n');
process.stderr.write('[0:00:02] | Templates: 42 | Hosts: ' + targets.length + ' | RPS: 5\\n');
const findings = targets.map((target) => JSON.stringify({ templateID: 'stub-template', matchedAt: target, severity: 'high' }));
if (resultFile !== '') writeFileSync(resultFile, findings.length === 0 ? '' : findings.join('\\n') + '\\n', 'utf8');
`;

async function reviewedManifest(template = 'id: reviewed-fixture\ninfo:\n  name: Reviewed fixture\n  severity: medium\nhttp:\n  - method: GET\n    path:\n      - "{{BaseURL}}/"\n'): Promise<{ readonly path: string; readonly templatePath: string; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'scopepilot2-reviewed-nuclei-'));
  const templatePath = join(directory, 'reviewed.yaml');
  await writeFile(templatePath, template, 'utf8');
  const sha256 = createHash('sha256').update(template, 'utf8').digest('hex');
  const path = join(directory, 'manifest.json');
  await writeFile(path, JSON.stringify({
    schemaVersion: 'scopepilot2.nuclei-template-bundle.v1',
    templates: [{ id: 'reviewed-fixture', path: 'reviewed.yaml', sha256, protocol: 'http' }],
  }), 'utf8');
  return { path, templatePath, cleanup: async () => { await rm(directory, { recursive: true, force: true }); } };
}

describe('Nuclei runner (stub binary 契約検証)', () => {
  test('対象を temp file 経由で渡し、JSONL 行と版を返す', async () => {
    const workdir = process.env['TEMP'] ?? '.';
    const stubPath = join(workdir, `scopepilot2-nuclei-stub-${Date.now()}.mjs`);
    const manifest = await reviewedManifest();
    await writeFile(stubPath, STUB_SCRIPT, 'utf8');
    try {
      const runner = new NucleiRunner({ command: process.execPath, argsPrefix: [stubPath], timeoutMs: 30_000, templateManifestPath: manifest.path });
      assert.equal(await runner.version(), 'nuclei v3.4.0');

      const logs: string[] = [];
      const result = await runner.run({
        targets: ['http://target.test/a', 'http://target.test/b'],
        onLog: (line) => logs.push(line),
      });
      assert.equal(result.engineVersion, 'nuclei v3.4.0');
      assert.equal(result.lines.length, 2);
      const first = JSON.parse(result.lines[0] ?? '') as { templateID: string; matchedAt: string };
      assert.equal(first.templateID, 'stub-template');
      assert.equal(first.matchedAt, 'http://target.test/a');
      assert.ok(logs.some((line) => line.includes('Templates loaded: 42')));
      assert.ok(logs.some((line) => line.includes('Templates: 42')));
      assert.ok(logs.some((line) => line.includes('starting nuclei reviewed HTTP profile')));
    } finally {
      await writeFile(stubPath, '', 'utf8').catch(() => undefined);
      await manifest.cleanup();
    }
  });

  test('対象なしは実行前に拒否', async () => {
    const runner = new NucleiRunner({ command: process.execPath, argsPrefix: [], timeoutMs: 5_000 });
    await assert.rejects(runner.run({ targets: [] }), /at least one target/);
  });

  test('hash不一致とHTTP以外の実行keyを送信前に拒否する', async () => {
    const tampered = await reviewedManifest();
    try {
      await writeFile(tampered.templatePath, 'id: changed\nhttp:\n  - method: GET\n', 'utf8');
      const runner = new NucleiRunner({ command: process.execPath, templateManifestPath: tampered.path });
      await assert.rejects(runner.run({ targets: ['http://target.test/'] }), /hash mismatch/);
    } finally {
      await tampered.cleanup();
    }

    const network = await reviewedManifest('id: denied-network\ninfo:\n  name: denied\n  severity: medium\nnetwork:\n  - host: "{{Hostname}}"\n');
    try {
      const runner = new NucleiRunner({ command: process.execPath, templateManifestPath: network.path });
      await assert.rejects(runner.run({ targets: ['http://target.test/'] }), /not HTTP-only/);
    } finally {
      await network.cleanup();
    }
  });

  test('Nuclei reports and stops a projected request count above the confirmed cap', async () => {
    const workdir = process.env['TEMP'] ?? '.';
    const stubPath = join(workdir, `scopepilot2-nuclei-request-cap-${Date.now()}.mjs`);
    const manifest = await reviewedManifest();
    await writeFile(stubPath, `
      const args = process.argv.slice(2);
      if (args.includes('-version')) process.exit(0);
      process.stderr.write('[0:00:02] | Templates: 100 | Hosts: 1 | Requests: 3/673134 (0%)\\n');
      setInterval(() => {}, 1000);
    `, 'utf8');
    try {
      const runner = new NucleiRunner({ command: process.execPath, argsPrefix: [stubPath], timeoutMs: 5_000, templateManifestPath: manifest.path });
      const logs: string[] = [];
      await assert.rejects(
        runner.run({
          targets: ['http://target.test/'],
          limits: { maxRequests: 5_000, maxDurationMinutes: 30, maxConcurrency: 2, requestsPerSecond: 2 },
          onLog: (line) => logs.push(line),
        }),
        /673134.*confirmed limit 5000/,
      );
      assert.ok(logs.some((line) => line.includes('exceeding the confirmed limit 5000')));
    } finally {
      await writeFile(stubPath, '', 'utf8').catch(() => undefined);
      await manifest.cleanup();
    }
  });

  test('templateIds 指定のスポット実行は審査済み template だけを stage する', async () => {
    const workdir = process.env['TEMP'] ?? '.';
    // stage された template file 数を JSONL で返す counting stub。
    const stubPath = join(workdir, `scopepilot2-nuclei-spot-${Date.now()}.mjs`);
    await writeFile(stubPath, [
      "import { readdirSync, readFileSync, writeFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      "if (args.includes('-version')) { process.stderr.write('Current Version: v3.4.0\\n'); process.exit(0); }",
      "const dirIndex = args.indexOf('-t');",
      'const directory = args[dirIndex + 1];',
      "const staged = readdirSync(directory).filter((name) => name.endsWith('.yaml'));",
      "const targetIndex = args.indexOf('-l');",
      "const targets = readFileSync(args[targetIndex + 1], 'utf8').split('\\n').filter((line) => line !== '');",
      "const exportIndex = args.indexOf('-jsonl-export');",
      "writeFileSync(args[exportIndex + 1], staged.map((name) => JSON.stringify({ templateID: name, matchedAt: targets[0] })).join('\\n') + '\\n', 'utf8');",
    ].join('\n'), 'utf8');
    // 2 template の審査済み manifest。
    const directory = await mkdtemp(join(tmpdir(), 'scopepilot2-reviewed-spot-'));
    const templateA = [
      'id: old-tls-detected',
      'info:',
      '  name: old tls',
      '  severity: high',
      'http:',
      '  - method: GET',
      '    path:',
      '      - "{{BaseURL}}/"',
      '',
    ].join('\n');
    const templateB = [
      'id: backup-file-exposed',
      'info:',
      '  name: backup',
      '  severity: medium',
      'http:',
      '  - method: GET',
      '    path:',
      '      - "{{BaseURL}}/backup.zip"',
      '',
    ].join('\n');
    await writeFile(join(directory, 'tls.yaml'), templateA, 'utf8');
    await writeFile(join(directory, 'backup.yaml'), templateB, 'utf8');
    const sha = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 'scopepilot2.nuclei-template-bundle.v1',
      templates: [
        { id: 'old-tls-detected', path: 'tls.yaml', sha256: sha(templateA), protocol: 'http' },
        { id: 'backup-file-exposed', path: 'backup.yaml', sha256: sha(templateB), protocol: 'http' },
      ],
    }), 'utf8');
    try {
      const runner = new NucleiRunner({ command: process.execPath, argsPrefix: [stubPath], timeoutMs: 30_000, templateManifestPath: manifestPath });
      const logs: string[] = [];
      const spot = await runner.run({ targets: ['http://target.test/'], templateIds: ['old-tls-detected'], onLog: (line) => logs.push(line) });
      assert.equal(spot.lines.length, 1);
      assert.ok((JSON.parse(spot.lines[0] ?? '') as { templateID: string }).templateID.includes('old-tls-detected'));
      assert.ok(logs.some((line) => line.includes('spot execution limited to reviewed templates: old-tls-detected')));

      const full = await runner.run({ targets: ['http://target.test/'] });
      assert.equal(full.lines.length, 2);

      await assert.rejects(runner.run({ targets: ['http://target.test/'], templateIds: ['not-reviewed'] }), /not in the reviewed manifest/u);
    } finally {
      await writeFile(stubPath, '', 'utf8').catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('プロセス終了シグナルではなく実行時間上限として報告する', async () => {
    const workdir = process.env['TEMP'] ?? '.';
    const stubPath = join(workdir, `scopepilot2-nuclei-timeout-${Date.now()}.mjs`);
    const manifest = await reviewedManifest();
    await writeFile(stubPath, 'setInterval(() => {}, 1000);', 'utf8');
    try {
      const runner = new NucleiRunner({
        command: process.execPath,
        argsPrefix: [stubPath],
        timeoutMs: 50,
        templateManifestPath: manifest.path,
      });
      await assert.rejects(
        runner.run({ targets: ['http://target.test/'] }),
        /nuclei exceeded execution time limit/,
      );
    } finally {
      await writeFile(stubPath, '', 'utf8').catch(() => undefined);
      await manifest.cleanup();
    }
  });
});
