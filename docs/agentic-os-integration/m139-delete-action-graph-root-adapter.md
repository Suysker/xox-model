# M139 Delete Action Graph Root Adapter

Status: Implemented

## Implementation Notes

- Moved `apps/api/src/agent/action-graph-store.ts` to `apps/api/src/agent/agentic-os/xox-action-graph-adapter.ts`.
- Updated host kit and direct-answer adapter imports to consume the host-prefixed action graph adapter.
- Added architecture guards so the deleted root file and old `./action-graph-store.js` / `../action-graph-store.js` imports cannot return.

Date: 2026-06-21

## Goal

Delete root `apps/api/src/agent/action-graph-store.ts`.

Action graph materialization is already owned by `@agentic-os/server` through `materializeAgentServerActionGraph()`. xox still needs a durable store adapter for Kysely rows, business action draft settling, navigation events and localized product copy, but that is host wiring. It should live under an explicit Agentic OS host adapter path:

```text
apps/api/src/agent/agentic-os/xox-action-graph-adapter.ts
```

No root compatibility re-export should remain.

## Module Division

| Responsibility | New xox path | Agentic OS owner |
| --- | --- | --- |
| xox durable action graph row adapter | `agentic-os/xox-action-graph-adapter.ts` | `@agentic-os/server` `AgentServerActionGraphStore` port |
| action/read/status/assistant item ordering and summary | none in xox | `@agentic-os/server materializeAgentServerActionGraph()` |
| xox business action request creation and automation settling | `agentic-os/xox-action-graph-adapter.ts` calling `xox-action-approval-adapter.ts` | host business/action policy |
| xox plan step row mapping and product run-event copy | `agentic-os/xox-action-graph-adapter.ts` | Agentic OS emits provider-neutral event drafts |
| xox observation bridge projection | `agentic-os/xox-action-graph-adapter.ts` consuming `xox-observation-adapter.ts` | `@agentic-os/core createHostObservationBridge()` |

## Dependency Graph

```text
agentic-os/xox-agentic-os-host-kit.ts
  -> agentic-os/xox-action-graph-adapter.ts
  -> @agentic-os/server materializeAgentServerActionGraph()
  -> agentic-os/xox-action-approval-adapter.ts
  -> xox business draft/execution modules

agentic-os/xox-direct-answer-adapter.ts
  -> agentic-os/xox-action-graph-adapter.ts

routes/thread-state adapters
  -> persisted xox rows, not the root action graph file
```

## Reuse and Abstraction Plan

- Preserve public function/type names for host-kit compatibility:
  - `storePlannedActionGraph`
  - `StoredActionGraph`
- Keep the existing Agentic OS server materializer as the only traversal/summary/event-draft owner.
- Do not introduce a root shim, barrel, or compatibility export.
- Do not move xox business action draft builders, Kysely schema, localized copy or DTO serializers into Agentic OS in this slice.
- Add architecture guards so root `agent/action-graph-store.ts` and old `../action-graph-store.js` imports cannot return.

## Naming and Style

- Use the existing host-prefixed naming style: `xox-action-graph-adapter.ts`.
- Keep xox-specific DTO names unchanged to avoid unrelated API churn.
- Keep import paths local within `agentic-os/` when adapters call each other.

## Validation

Commands:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test:api -- --run tests/agent-architecture.test.ts tests/api.test.ts tests/action-observation.test.ts
npm.cmd run test:api
git diff --check

cd C:\Github\agentic-os
npm.cmd run check
git diff --check
```

Expected result:

- Root `apps/api/src/agent/action-graph-store.ts` is absent.
- Production source no longer imports `../action-graph-store.js` or `./action-graph-store.js`.
- Agentic OS server remains the only owner of generic action graph materialization.
- xox API behavior for confirmations, auto execution, read observations, sandbox observations and thread projection remains unchanged.
