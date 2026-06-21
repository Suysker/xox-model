# M157: Delete Root Context Pack Facade

Status: verified
Date: 2026-06-22

## Goal

Delete the root `apps/api/src/agent/context-pack.ts` facade.

The remaining code did not own a generic context engine. Agentic OS already owns active-memory recall runtime, conversation replay helpers, and runtime context sanitation primitives. xox still needs to assemble host profile facts: workspace draft, periods, versions, scoped memories, product DTO fields, and Chinese run-event sinks.

That makes the code a HostProfile input adapter, not a root agent harness file.

## Boundary

Agentic OS owns:

- active-memory recall lifecycle and event drafts;
- same-thread replay policy helpers;
- context sanitation primitives used by runtime packages.

xox owns:

- workspace/user/thread DB reads;
- xox memory retrieval and recalled-memory persistence;
- product context DTO shape expected by xox prompt policy;
- host event sinks such as `appendRunEvent` and `recordRecalledMemories`.

## Module Division

- `host-profile/xox-context-pack.ts`
  - owns `buildAgentContextPack()` and `buildThreadConversationLog()`;
  - wires xox DB/memory/product context into Agentic OS runtime inputs.
- `context-pack.ts`
  - deleted and guarded from returning.

## Validation

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test:api
git diff --check
```

Expected:

- root `apps/api/src/agent/context-pack.ts` is absent;
- provider runtime and observation continuation adapters import `host-profile/xox-context-pack.ts`;
- no source imports `./context-pack.js` or `../context-pack.js`;
- xox behavior remains unchanged.
