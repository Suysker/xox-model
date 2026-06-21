# M156: Delete Runtime Intent Handler Facade

Status: verified
Date: 2026-06-22

## Goal

Delete `apps/api/src/agent/runtime-intent-handlers.ts`.

The file name made xox look like it still owned a runtime intent layer. Its remaining work was not an Agentic OS loop concern: it mapped provider-normalized tool steps to xox business drafts, xox reads, memory tool peripherals, sandbox tool requests, and tool discovery observations.

That is a host business tool boundary. It now lives in `apps/api/src/agent/tool-executor.ts` beside confirmed action execution, so xox exposes business peripherals without preserving a local runtime facade.

## Boundary

Agentic OS owns:

- agent loop state;
- provider tool-call normalization;
- effective tool inventory and progressive tool surface algorithms;
- tool observation loop semantics.

xox owns:

- business tool handler registration;
- domain read/write draft construction;
- xox memory store/tool peripherals;
- product navigation, labels and DTO-compatible read drafts.

## Module Division

- `tool-executor.ts`
  - owns confirmed business writes through `executeAgentTool()`;
  - owns provider-normalized tool step to xox business draft/read handler registration through `runtimeIntentHandlers`;
  - owns `answerWorkspaceDataQuestion()` as a xox business read tool.
- `runtime-intent-handlers.ts`
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

- `apps/api/src/agent/runtime-intent-handlers.ts` is absent;
- no production source imports `runtime-intent-handlers`;
- tool discovery/search observations still use Agentic OS core helpers;
- workspace data query enums still come from `tool-catalog.ts`, not handler-local hard-coded string branches.
