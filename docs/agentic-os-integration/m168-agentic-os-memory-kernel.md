# M168 Agentic OS Memory Kernel

Status: Completed

Date: 2026-06-23

## Goal

Move generic SaaS memory harness behavior out of `xox-model` and into `@agentic-os/core`.

The target boundary is:

```text
Agentic OS
  owns memory kernel:
  candidate policy, lane/status/default injection rules, recall scoring,
  prompt-budget filtering, MMR reranking, recall signal scoring,
  daily-note flush planning, citation format, and secret-safe normalization

xox-model
  owns memory peripherals:
  SQLite/Kysely rows, tenant/workspace/user authorization, memory center DTOs,
  route handlers, Chinese product copy, xox business memory candidates,
  memory_search/memory_get tool wiring, and UI management projection
```

xox must not behave like it owns a local memory harness. It may store, retrieve, display, and manage tenant memories; it must not decide the generic lifecycle or ranking model by local hard-coded enums when Agentic OS can own that kernel.

## Why This Cut Exists

M140 and M141 already moved active-memory recall runtime and lifecycle events into Agentic OS, but xox still contains a local memory kernel:

- `packages/agent-memory-core` is a generic OpenClaw-derived package under the xox namespace.
- `apps/api/src/agent/memory.ts` still implements generic candidate decision, lane/status derivation, prompt injection rules, recall scoring, MMR use, prompt lane budgets, query hashing, short-term promotion scoring, and flush planning.
- `apps/api/tests/agent-memory-core.test.ts` tests generic memory algorithms from xox rather than Agentic OS.

That violates the computer/peripheral boundary. A future SaaS host should not copy xox memory kernel code to get OpenClaw/Hermes-style memory behavior.

## Module Division

| Responsibility | Agentic OS owner | xox owner |
| --- | --- | --- |
| Secret-safe memory text normalization | `@agentic-os/core` memory kernel | none |
| Candidate lane/status/injection policy | `@agentic-os/core` memory kernel | passes host candidate fields |
| Candidate hash and policy decision | `@agentic-os/core` memory kernel | persists returned fields |
| Recall lexical relevance and MMR reranking | `@agentic-os/core` memory kernel | loads tenant-scoped candidate rows |
| Prompt memory filtering and lane budgets | `@agentic-os/core` memory kernel | supplies `threadId` and `forPrompt` flag |
| Recall signal query hash and promotion scoring | `@agentic-os/core` memory kernel | persists signal rows |
| Daily/session flush plan | `@agentic-os/core` memory kernel | stores daily note row |
| Citation format | `@agentic-os/core` memory kernel | maps row evidence refs |
| Memory Center state | none | `xox-model` product DTO |
| Business memory candidates from xox actions | none | `xox-model` domain plugin |
| Archive/promote routes | Agentic OS can define policy helpers | `xox-model` auth, DB update, DTO |

## Dependency Graph

```text
xox routes / tool-executor / host-profile
  -> apps/api/src/agent/memory.ts
    -> @agentic-os/core memory kernel
    -> xox DB schema, auth, routes, product DTO

@agentic-os/core memory kernel
  -> @agentic-os/core content safety
  -> node:crypto
  -> no xox imports, no DB, no Kysely, no route concepts
```

Forbidden:

```text
xox memory.ts
  -> local candidate policy / recall scoring / prompt lane budgets
  -> @xox/agent-memory-core
  -> generic OpenClaw-derived memory package under xox namespace
```

## Interface Plan

`@agentic-os/core` will expose a host-neutral memory kernel surface:

- memory taxonomy types: lane, status, kind, candidate decision;
- normalization helpers for memory kind/scope/type/lane/status/sensitivity/key/confidence/value;
- `decideAgentMemoryCandidate()` for default SaaS memory governance;
- `isAgentMemoryPromptInjectable()` for prompt injection eligibility;
- `rankAgentMemoryRecords()` for recall filtering, lexical scoring, prompt budget filtering, and MMR reranking;
- `agentMemoryQueryHash()` for recall signal dedupe;
- `rankShortTermPromotionCandidates()` for OpenClaw-style short-term promotion scoring;
- `buildMemoryFlushPlan()` for daily/session note flush planning;
- `buildMemoryCitation()` / `formatMemoryCitation()` for memory citations;
- budget helpers such as `compactMemoryForBudget()` and `takeBudgetedMemoryItems()`.

xox `memory.ts` will become a store/peripheral adapter:

- maps `agent_memories` rows into `AgentMemoryRecordLike`;
- persists policy results returned by Agentic OS;
- persists recall signals and memory events;
- builds Memory Center DTOs;
- keeps xox action-derived memory candidate plugins because those are domain facts;
- calls Agentic OS memory kernel for all generic lifecycle decisions.

## Deletions

This cut must delete:

- `packages/agent-memory-core/package.json`
- `packages/agent-memory-core/src/citations.ts`
- `packages/agent-memory-core/src/flush-plan.ts`
- `packages/agent-memory-core/src/index.ts`
- `packages/agent-memory-core/src/memory-budget.ts`
- `packages/agent-memory-core/src/retrieval.ts`
- `packages/agent-memory-core/src/short-term-promotion.ts`
- `apps/api/tests/agent-memory-core.test.ts`

It must also remove:

- `@xox/agent-memory-core` from `apps/api/package.json`;
- package-lock entries for `@xox/agent-memory-core`;
- local `memory.ts` implementations of generic candidate policy, prompt lane budgets, recall scoring, MMR helper imports from xox, query hash, and promotion scoring.

## Architecture Guards

`apps/api/tests/agent-architecture.test.ts` must fail if:

- `packages/agent-memory-core` returns;
- `@xox/agent-memory-core` appears in source or package manifests;
- xox `memory.ts` reintroduces `decideMemoryCandidate`, `deriveMemoryLane`, `deriveMemoryStatus`, `scoreMemory`, `applyPromptLaneBudgets`, or local `queryHash`;
- xox `memory.ts` imports `createHash` for memory hash decisions.

The guard allows xox row adapter functions because DB rows are host peripherals.

## Validation

Agentic OS:

```powershell
cd C:\Github\agentic-os
npm.cmd run build --workspace @agentic-os/core
npm.cmd test --workspace @agentic-os/core
git diff --check
```

xox:

```powershell
cd C:\Github\xox-model
npm.cmd run build --workspace @xox/api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test --workspace @xox/api -- tests/api.test.ts -t "memory"
npm.cmd run test --workspace @xox/api -- tests/api.test.ts
git diff --check
```

## Acceptance Criteria

- xox has no local `@xox/agent-memory-core` package.
- Agentic OS core tests cover the migrated memory kernel.
- xox memory behavior remains equal or better for candidate storage, recall, prompt injection, daily notes, recall signals, memory tools, archive/promote, and Memory Center display.
- xox only stores and projects memory; Agentic OS owns the generic memory lifecycle and ranking decisions.
- Documentation and `lessons.md` record the corrected boundary.

## Completion Evidence

Completed on 2026-06-23.

Changes:

- `@agentic-os/core` now exposes the generic memory kernel.
- xox `memory.ts` now calls Agentic OS memory kernel helpers and keeps only store/DTO/tool/domain-candidate adapter responsibilities.
- xox-local `packages/agent-memory-core` and `apps/api/tests/agent-memory-core.test.ts` were deleted.
- Architecture guards prevent the local package and old local memory kernel function names from returning.

Validation:

```powershell
cd C:\Github\agentic-os
npm.cmd run check

cd C:\Github\xox-model
npm.cmd run build --workspace @xox/api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test --workspace @xox/api -- tests/api.test.ts -t "Memory Kernel v2"
npm.cmd run test --workspace @xox/api -- tests/api.test.ts -t "memory"
npm.cmd run test --workspace @xox/api
```
