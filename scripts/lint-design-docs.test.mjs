import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintDesignText, lintDesignDocs } from './lint-design-docs.mjs';

test('current design preserves reviewed negative statements and migration records', () => {
  assert.deepEqual(lintDesignDocs(fileURLToPath(new URL('../', import.meta.url))), []);
});
test('rejects new legacy project, class, namespace and UI sharing instructions', () => {
  for (const line of ['Reuse ScopePilot.csproj', 'Share MainViewModel with CLI', 'Implement WPF/XAML UI', 'Reuse ScopePilot.Services.ZapClient', 'Port ZapClient.cs', 'Reuse ZapCliRunner and ManagedZapProxy', 'Use C# or Avalonia']) {
    assert.equal(lintDesignText('docs/design/new.md', line, []).length, 1, line);
  }
});
test('exceptions require exact file, text and reason and cannot be duplicated', () => {
  const line = 'Do not reuse WPF.';
  const entry = { path: 'docs/design/a.md', line, reason: 'Negative migration decision' };
  assert.deepEqual(lintDesignText(entry.path, line, [entry]), []);
  for (const [path, text, entries] of [
    ['docs/design/b.md', line, [entry]],
    [entry.path, `${line} Share MainViewModel.`, [entry]],
    [entry.path, line, [{ ...entry, reason: '' }]],
    [entry.path, `${line}\n${line}`, [entry]],
  ]) assert.equal(lintDesignText(path, text, entries).length, 1);
});
