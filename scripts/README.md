# Design documentation lint

Run `npm run lint:docs` and `npm run test:docs-lint` (Node 24; no install needed).
CI checks every Markdown file under `docs/design/**`, including nested files.

The lint rejects legacy technology, C# filenames/namespaces, ViewModel references,
and retired service identifiers. `legacy-design-classes.json` records service
filenames from the separate ScopePilot C# repository, not its implementation.
`CandidateSelector` is excluded because the current TypeScript design deliberately
retains that domain role. Maintain this list when retiring or adopting names.

Negative decisions and migration records require an exact path, complete line,
and review reason in `design-docs-allowlist.json`. Each exception permits one
occurrence only. Changed or newly added text fails until reviewed; do not allow
whole files or generic negative-language patterns. Old terminology in historical
work logs and reference documents outside `docs/design/**` is not checked.
