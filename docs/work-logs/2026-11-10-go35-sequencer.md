# GO-35: Sequencer (A52) on JobRegistry

Base: GO-34 `85a12b4`; local branch `go-35-sequencer`.

Local commits:
- `4c23dcc`: cherry-pick of GO-17 `3c00538` (independent Decoder/Comparer screens and analysis contracts). Resolved the contract index and OpenAPI conflicts by retaining both GO-34 jobs and GO-17 analysis additions.
- `1a3ac44`: Sequencer implementation, API/contracts, UI and regression tests.
- This work-log commit records the final validation. No push, PR or Linear mutation.

Design reference: `../advanced-mode-redesign/docs/design/40-advanced-mode-redesign.md`, sections 3, 5 and 7. The reference draft is not present on the foundation branch.

Implemented:
- Extend the existing `StartJobRequest` discriminated union and OpenAPI with `{ kind: 'sequencer', params }`. Shared Sequencer parameter/result types replace duplicate core/UI definitions. The jobs endpoint accepts the existing bounded replay envelope.
- Validate permissions, current scope, sample bounds, case request limit, replay fields, extractor configuration and role availability before accepting a job; validate again after queuing. Reuse existing extraction, statistics, session cookies and HTTP transport.
- Use JobRegistry for queueing, lifecycle, stop, stored results and SSE. Emit absolute sample progress. Count dispatched live requests before waiting for responses, including requests aborted in flight; synthetic samples do not increment real HTTP counters. Recheck scope, request budget and elapsed duration immediately before each live send.
- Preserve statistics collected before a user stop in the Stopped job result. Insufficient samples retain the existing non-conclusive verdict. Stopped collection does not create a completion audit event. Normal completion audit and traffic entries retain job attribution.
- Persist statistics only, without token values or replay header/body values. Sanitize job transport errors and sensitive target URL fields in stored job results. The synchronous legacy API remains compatible.
- Add permission-controlled `adv.tools.sequencer` / A52. Reuse the existing Fluent UI collection form and charts, showing only Sequencer on A52. Display live/fixture transport, guarantee, lifecycle and sample progress. Use per-job SSE with automatic reconnect and ordered snapshot reconciliation. Navigation closes the subscription while the job continues; reopening restores the latest active job or latest result. The legacy A10 collection form also uses jobs.
- Preserve GO-17 A50/A51. Update the legacy navigation count and remove its obsolete synchronous collection cancellation mock.

Validation (all passed):
- `npm run typecheck`.
- `npm run build --workspace @scopepilot2/desktop`.
- Core unit suite: **370 tests**.
- Contracts suite: **9 tests** (OpenAPI routes, references, enums and schemas).
- UI unit suite: **14 tests**, including A52 permission and navigation behavior.
- Focused command: `node --test packages/core/test/integration/sequencer-jobs-api.test.ts packages/core/test/integration/jobs-api.test.ts packages/core/test/integration/analysis-tools-api.test.ts packages/core/test/unit/application/sequencer-session.test.ts packages/core/test/unit/jobs/job-registry.test.ts`: **24 tests**. Includes async completion, SSE replay/live progress, queued and running stop, partial results, in-flight dispatch accounting, mid-run scope rejection, validation/permission rejection, credential exclusion, scan compatibility and Decoder/Comparer APIs. Some unit tests overlap the full core suite.
- `node --test packages/adapters/test/sequencer-transport.test.ts packages/storage/test/integration/jobs.test.ts`: **4 tests**, including actual loopback HTTP, rate limiting, abort propagation and persisted registry recovery.
- From `apps/desktop`, `npx playwright test sequencer.spec.ts`: **1 Electron integration test**, passed repeatedly (last run 26.9 seconds). Uses the real Advanced renderer, real jobs API/SSE and Node HTTP transport against a loopback target, without ZAP/Nuclei startup. Covers live progress, navigation while running, restoration, stop/no later sends, partial statistics, subsequent completion and A50/A51 interaction.
- `git diff --check`.

The full external-engine-dependent Advanced/wizard suites were not run. No detection benchmark was performed. All task changes are committed; unrelated `apps/cli/src/main.ts` line-ending/stat noise is excluded (no content diff) and its working file is untouched.
