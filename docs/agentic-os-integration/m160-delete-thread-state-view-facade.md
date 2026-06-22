# M160 Delete Thread State View Facade

## Decision

Delete the standalone downstream projection facade:

- `apps/api/src/agent/agentic-os/xox-thread-state-view.ts`

The remaining xox contract compatibility mapping now lives inside:

- `apps/api/src/agent/agentic-os/xox-thread-store-adapter.ts`

This is a whole-file amputation. The deleted file made xox look like it still owned a local transcript/timeline projection engine. The actual owner of generic thread/run projection remains Agentic OS server:

- `AgentServerThreadStateProjector`
- `projectAgentServerRunSubmissionView`
- `projectAgentServerAgUiEvents`

## Boundary

xox may keep only product DTO compatibility:

- Kysely row loading and authorization;
- legacy `AgentThreadState`, timeline, transcript, and node DTO shapes required by the current frontend;
- Chinese labels and product navigation/action row joins.

xox must not keep a separate projection subsystem:

- no `xox-thread-state-view.ts`;
- no `xox-thread-transcript-adapter.ts`;
- no `xox-thread-timeline-adapter.ts`;
- no local provider/action merge tree engine.

## Dependency Graph

```text
xox-thread-store-adapter.ts
  -> AgentServerThreadStateProjector
  -> projectAgentServerAgUiEvents
  -> xox legacy AgentThreadState DTO

xox-run-submission-adapter.ts
  -> projectAgentServerRunSubmissionView
  -> projectAgentServerAgUiEvents
  -> xox-thread-store-adapter.ts DTO compatibility helpers
```

## Validation

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test:api
git diff --check
```

Expected result:

- TypeScript compiles without `xox-thread-state-view.ts`.
- architecture tests assert the deleted file remains absent.
- full API tests preserve frontend-facing thread/run response behavior.
