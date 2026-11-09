# GO-17 Decoder / Comparer — partial implementation, Sequencer prerequisite missing

Date: 2026-11-10
Branch: `umberbyte/go-17-analysis-tools`
Status: **GO-17 is not complete. A52 is blocked on the common job infrastructure.**

## Design inputs and dependency gap

- Read this worktree's `AGENTS.md` before implementation.
- This worktree does not contain `docs/design/40-advanced-mode-redesign.md`. Read it from local branch `umberbyte/advanced-mode-redesign`, commit `894cece916f791c5a17382a36512862d9bbf654b`, with `git show`.
- Read design 41 from `C:/Users/GoSugawara/orca/workspaces/ScopePilot2/spec-gap-resolution/docs/design/41-spec-gap-resolution.md` and design 06 from this worktree.
- Design 40 §§5–7 requires Sequencer to run through the common JobRegistry and `/api/jobs`, with progress and cooperative stop. This branch has neither JobRegistry nor jobs contracts/routes/store. The similarly named `job-state-machine.test.ts` tests the existing RunStateMachine, not that infrastructure.
- Asked for the job infrastructure source branch/path while completing independent work. No source was supplied during this turn. Implementing the whole P0 job foundation, or replacing it with another synchronous Sequencer call, would not satisfy the requested scope/design.
- Common FeaturePage/FeatureSpec and the new traffic-detail/handoff API are also absent from this base. This commit does not invent substitutes for those independent issues.

## Implemented in this commit

- Added independent A50 `adv.tools.decoder` and A51 `adv.tools.comparer` renderer screens and navigation with `case.read` permissions; Simple mode cannot open them.
- A50 keeps the standard ordered decode chain and adds SHA-256/MD5 input fingerprints, explicitly described as fingerprints rather than a cryptographic assessment.
- A51 supports text line comparison and strict hexadecimal byte comparison. Each byte input is limited to 1 MiB; differences are readable in 64 KiB ranges, with the global first difference, lengths, total differing-row count and exact-byte SHA-256 provenance.
- Added local-only `/api/tools/hash` and `/api/tools/compare-binary` handlers, shared response types, OpenAPI schemas and route registration. They use no target transport, require no case/authorization and enforce `case.read`.
- Fixed comparisons that incorrectly treated an extra empty trailing line as equal, and binary prefix comparisons that omitted the first differing offset. Binary provenance no longer conflates invalid UTF-8 byte sequences through replacement-character decoding.
- Localized the new descriptions and byte controls in Japanese/English. Result state is cleared when relevant inputs change.
- Kept the legacy composite screen untouched so its GO-18-owned OAST/WebSocket functionality remains available pending its separate migration. No scan policy changes.

## Validation

- `npm run typecheck`: PASS.
- Explicit TypeScript check of `decoder-screen.tsx` and `comparer-screen.tsx` with JSX/NodeNext options: PASS. This supplements the repository tsconfig, whose include patterns name `.ts` files.
- `node --test "packages/core/test/unit/decoder-comparer/*.test.ts" "packages/core/test/integration/analysis-tools-api.test.ts" "packages/ui/test/unit/app/*.test.ts" "apps/desktop/test/unit/resources.test.ts"`: PASS, 23/23. Includes seven new tests for fingerprints, exact bytes, empty/prefix cases, bounds, paging, local-only execution without a case, and permissions.
- `npm run test --workspace @scopepilot2/contracts`: PASS, 8/8, including route parity and reference/schema completeness.
- `npm run build:renderer --workspace @scopepilot2/desktop`: PASS.
- Broader `packages/core/test/integration/core-api.test.ts`: 36/39 pass, three pre-existing failures: document-hint provenance (`undefined` versus `document-hint`), business-logic response (503 versus 200), and finding status (400 versus 200). Repeated the same 39 tests against temporary copies of the original HEAD API handler and decoder/comparer domain module: the identical three failures reproduced. Temporary source/test copies were removed. Unrelated failures were not changed.
- Electron visual/E2E execution was not performed.

## Remaining work before GO-17 acceptance

1. Supply/integrate the P0 job infrastructure, then implement independent A52 using its creation/status/events/stop contracts and sample progress. Add async execution, stop and reconnect tests. Preserve authorization, scope, budget and secret boundaries of sample collection.
2. Integrate these screens with the common FeaturePage/FeatureSpec and history selection handoffs when their prerequisite changes are available.
3. Complete legacy route migration with the navigation/GO-18 work, without dropping OAST/WebSocket/DOM/transport features.

This is a local partial commit only. No push, PR or Linear changes were made.
