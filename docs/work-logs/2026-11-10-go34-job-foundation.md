# GO-34: P0 job foundation

Base: local main `c86e452`; branch `go-34-job-foundation`. Design reference: advanced-mode-redesign worktree, design 40 sections 5, 6 and 7.1 P0. No branch merges, push, PR or Linear mutations.

Implemented:
- Shared JobKind/JobState/JobCounters/JobSummary/JobEvent contracts and explicit active-scan StartJobRequest. Other job kinds are represented; their public start handlers remain later-stage work.
- Core JobRegistry owns transitions, cooperative AbortSignal stop, default concurrency 2 with queued cancellation, independent confirmed/delegated counters, run association and stored results. Verbose events above the 50,000 soft cap aggregate each second; important events remain, with an explicit truncation warning.
- SQLite migration 5 adds jobs, indexed job_events and audit_events. Summary/event writes are atomic; reopening marks unfinished jobs Interrupted and continues global event sequence IDs. Desktop workspace composition supplies the store; renderer/UI files are unchanged.
- GET/POST /api/jobs, detail, filtered/paged event history, stop, persistent SSE replay using Last-Event-ID, 15-second heartbeats and bounded slow-consumer buffering. /api/events now streams too; NDJSON snapshot compatibility remains.
- /api/run/scan/start|status|stop use the same registry, preserving executionId, lowercase state, logs, commands and result shape. OpenAPI and route parity cover these routes.
- Async execution context attributes audit and observed exchanges to jobId/runId, including nested workflow HTTP requests, rejection and finding events. External message counts remain estimates. Fixture transport is explicitly supplied by the simulation composition.

Validation:
- Typecheck and desktop build pass.
- Core unit suite: 365 passed, including registry transitions, cooperative stop, queue cancellation, counters, event cap and redaction.
- Contracts + job HTTP/SSE + all storage integration tests: 22 passed. Includes live delivery, global and per-job reconnect without gaps, scan compatibility and persistence/recovery.
- Simulation: 10 passed, including explore -> scan -> findings through jobs, with lifecycle/phase/finding events and traffic attribution.
- Existing API integration suite: 36 passed, 3 failed. Replacing the API/service implementations temporarily with main reproduced exactly the same failures: document-hint originType expectation, business-logic missing transport (503), and findings/status request (400). Originals were restored afterward.
- Existing wizard.spec.ts is unchanged. With a dedicated loopback ZAP 2.17 daemon, S01-S05 pass; S06 fails before scanning at authenticated-browser preflight: `browser success marker was not present`. The same S01-S06 command against main reproduces the failure. The full wizard run consequently also fails downstream S07/navigation tests. Thus the requested S06-pass acceptance condition is **not met**, even though the failure predates this branch. An initial default-engine run timed out waiting for automatic ZAP startup; using an isolated ZAP endpoint resolved startup.

Scope: no P1 navigation/activity UI, policy UI or P2 feature screens; no changes to the wizard test or authentication preflight semantics. Incidental apps/cli changes are excluded. Public POST /api/jobs accepts active-scan in P0; crawl and the other execution handlers remain the planned later stages.
