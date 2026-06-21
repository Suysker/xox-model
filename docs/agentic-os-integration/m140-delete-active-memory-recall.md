# M140 Delete Active Memory Recall Harness

Status: Implemented

Date: 2026-06-21

## Goal

Delete the xox-owned active memory recall harness files:

- `apps/api/src/agent/active-memory-recall.ts`
- `apps/api/src/agent/memory/active-memory-subagent.ts`

Implemented in M140. `@agentic-os/core` now owns `createAgentActiveMemoryRecallRuntime()` and `buildAgentActiveMemoryPromptPack()`. `apps/api/src/agent/context-pack.ts` wires xox memory retrieval, recall-signal persistence, run-event copy and context DTO projection into that runtime.

These files are not xox business logic. They own generic harness behavior: run-scoped recall cache, query cache, timeout, circuit breaker, prompt pack budgeting, citation formatting, lifecycle event sequencing, and skip reasons. A new SaaS host such as `navigation` should not have to copy these files.

After M140, xox keeps only the memory peripherals:

- historical M140: xox DB query/ranking adapter in `apps/api/src/agent/memory-retriever.ts`; after M147 this is collapsed into `apps/api/src/agent/memory.ts`;
- historical M140: xox memory event persistence in `apps/api/src/agent/memory-events.ts`; after M147 this is collapsed into `apps/api/src/agent/memory.ts`;
- Memory Center APIs and product projection;
- Chinese run-event copy and xox-specific row mapping.

## Module Division

| Responsibility | xox after M140 | Agentic OS owner |
| --- | --- | --- |
| active recall cache, timeout and circuit breaker | none | `@agentic-os/core` active-memory recall runtime |
| prompt pack budget and untrusted `<memory_context>` rendering | none | `@agentic-os/core` active-memory prompt pack |
| memory citations and selected memory ids | none | `@agentic-os/core` active-memory prompt pack |
| xox memory table ranking and lane/status policy | historical M140: `memory-retriever.ts`; after M147: `memory.ts` durable memory store | host business adapter |
| xox run/memory event persistence and Chinese copy | historical M140: `context-pack.ts` callback + memory event modules; after M147: `memory.ts` + concrete callbacks | host adapter callbacks |
| context DTO fields expected by existing prompts | `context-pack.ts` | host product DTO |

## Dependency Graph

```text
context-pack.ts
  -> @agentic-os/core createAgentActiveMemoryRecallRuntime()
      -> xox retrieveAgentMemories() callback
      -> xox markAgentMemoriesRecalled() callback
      -> xox addRunEvent()/addMemoryEvent() callbacks
  -> returns the same xox context pack shape

deleted:
  active-memory-recall.ts
  memory/active-memory-subagent.ts
```

## Reuse and Abstraction Plan

- Add `@agentic-os/core` active-memory recall runtime instead of introducing another xox adapter file.
- Keep host callbacks explicit and narrow: retrieve memories, mark selected memories, emit lifecycle events.
- Do not move xox memory SQL, promotion policy, Memory Center, or Chinese product DTOs into Agentic OS.
- Do not keep compatibility re-exports or root shims for the deleted files.
- Add architecture guards so deleted files and old imports cannot return.

## Naming and Style

- Agentic OS exports use `AgentActiveMemory*` names.
- xox code consumes the runtime directly from `@agentic-os/core`.
- xox memory row mapping stays close to `context-pack.ts`, because this is the real context assembly boundary.

## Validation

Commands:

```powershell
cd C:\Github\agentic-os
npm.cmd run build -w @agentic-os/core
npm.cmd run test -w @agentic-os/core
git diff --check

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test:api -- --run tests/agent-architecture.test.ts tests/api.test.ts
npm.cmd run test:api
git diff --check
```

Expected result:

- `apps/api/src/agent/active-memory-recall.ts` is absent.
- `apps/api/src/agent/memory/active-memory-subagent.ts` is absent.
- Production source no longer imports `./active-memory-recall.js` or `./memory/active-memory-subagent.js`.
- Existing memory recall API behavior remains: scoped recall, secret redaction, `memory_recall_*` run events, `memory_injected` run event, recall signals, and Memory Center state.
