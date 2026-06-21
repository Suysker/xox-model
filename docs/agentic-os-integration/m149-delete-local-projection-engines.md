# M149 Delete Local Projection Engines

Status: Completed

Date: 2026-06-21

## Cut

Deleted the xox-owned transcript and timeline projection engines:

- `apps/api/src/agent/agentic-os/xox-thread-transcript-adapter.ts`
- `apps/api/src/agent/agentic-os/xox-thread-timeline-adapter.ts`
- `apps/api/tests/agent-transcript.test.ts`

This is a direct deletion, not a move. The deleted files implemented generic transcript item construction, timeline visibility, provider stream grouping, provider tool-call/action merging, tool grouping, read-result attachment, navigation row attachment, and transcript tree grouping inside the downstream host.

That was beyond the xox boundary. Projection primitives are Agentic OS work. xox is allowed to keep only legacy DTO compatibility for its existing API and UI.

## New Boundary

`xox-thread-state-view.ts` now consumes Agentic OS projection facts:

- `AgentServerThreadStateProjector`
- `projectAgentServerRunSubmissionView`
- `projectAgentServerAgUiEvents`

The remaining `buildXoxProjectionViews()` function is intentionally a thin DTO compatibility mapper:

- Agentic OS transcript item -> legacy xox `AgentTranscriptItem`
- legacy xox transcript item -> flat legacy `AgentTimelineItem`
- legacy xox timeline item -> flat legacy `AgentTranscriptNode`

It must not regrow provider/action merge algorithms, timeline grouping, tree grouping, visibility heuristics, or provider stream aggregation.

## Guard

`apps/api/tests/agent-architecture.test.ts` now fails if the deleted projection files or their builder names return:

- `xox-thread-transcript-adapter`
- `xox-thread-timeline-adapter`
- `buildAgentTranscriptItems`
- `buildAgentTimelineItems`
- `buildAgentTranscriptNodes`

## Validation

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test --workspace @xox/api -- tests/api.test.ts -t "creates agent navigation events|answers basic conversation|answers ambient date questions|answers workspace data questions"
npm.cmd run test --workspace @xox/api -- tests/api.test.ts -t "keeps shareholder fact obligations open after a sandbox repair closes only the calculation"
npm.cmd run test:api
```

The first full `npm.cmd run test:api` run after this cut passed 242/243 tests and exposed one non-deterministic provider-call-count assertion in `keeps shareholder fact obligations open after a sandbox repair closes only the calculation`; the same test passed when rerun in isolation. The second full `npm.cmd run test:api` run passed 13 test files and 243 tests.
