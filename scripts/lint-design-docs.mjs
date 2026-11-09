import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reject legacy implementation vocabulary; exceptions are exact reviewed lines,
// never whole files or a generic "not" substring that could hide new instructions.
const legacy = /C#|WPF|XAML|Avalonia|\w*ViewModel|\w+\.cs(?:proj)?\b|ScopePilot\.[A-Z]/;
const retiredClasses = JSON.parse(readFileSync(new URL('./legacy-design-classes.json', import.meta.url), 'utf8'));
const retiredClassPattern = new RegExp(`\\b(?:${retiredClasses.join('|')})\\b`);
export function lintDesignText(path, text, allowlist) {
  const remaining = [...allowlist.filter(entry => entry.path === path)];
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!legacy.test(line) && !retiredClassPattern.test(line)) return [];
    const allowed = remaining.findIndex(entry => entry.line === line && entry.reason?.trim());
    if (allowed >= 0) {
      remaining.splice(allowed, 1);
      return [];
    }
    return [`${path}:${index + 1}: legacy implementation reference; use TypeScript design or add an exact, reasoned migration/negative exception`];
  });
}
export function lintDesignDocs(root) {
  const allowlist = JSON.parse(readFileSync(join(root, 'scripts/design-docs-allowlist.json'), 'utf8'));
  function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : /\.md$/i.test(entry.name) ? [path] : [];
    });
  }
  return walk(join(root, 'docs/design')).flatMap(path =>
    lintDesignText(relative(root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8'), allowlist));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = lintDesignDocs(fileURLToPath(new URL('../', import.meta.url)));
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Design docs lint passed.');
}
