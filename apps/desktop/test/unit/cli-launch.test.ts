import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { resolveCliLaunch } from '../../src/main/cli-launch.ts';

describe('CLI launcher', () => {
  test('Windowsのnpm PowerShell shimはNodeのエントリーポイントを直接起動する', { skip: process.platform !== 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'scopepilot-cli-launch-'));
    try {
      const entryPoint = join(root, 'node_modules', '@example', 'tool', 'bin', 'tool.js');
      const shimPath = join(root, 'tool.ps1');
      const nodePath = join(root, 'node.exe');
      await mkdir(join(root, 'node_modules', '@example', 'tool', 'bin'), { recursive: true });
      await writeFile(entryPoint, 'console.log("stub");', 'utf8');
      await writeFile(nodePath, 'stub', 'utf8');
      await writeFile(shimPath, '& "$basedir/node.exe" "$basedir/node_modules/@example/tool/bin/tool.js" $args', 'utf8');

      const launch = resolveCliLaunch(shimPath, 'node');

      assert.equal(launch.executable, nodePath);
      assert.deepEqual(launch.prefix, [entryPoint]);

      const directLaunch = resolveCliLaunch(shimPath, 'file');
      assert.equal(directLaunch.executable, 'powershell.exe');
      assert.ok(directLaunch.prefix.includes(shimPath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
