# M122 Content Safety Helper

Status: Implemented

Date: 2026-06-21

## Scope

This slice deletes `apps/api/src/agent/memory-safety.ts`.

That file was not xox business logic. It contained generic harness content-safety helpers for:

- redacting secret-like strings;
- detecting secret-like labels;
- normalizing whitespace and bounding text length.

These helpers now come from `@agentic-os/core`.

## New Boundary

xox keeps:

- memory persistence and Memory Center API;
- memory promotion policy, lane/status defaults and recall ranking;
- sandbox result parsing and business SDK exposure;
- provider settings, localized copy and DTO projection.

Agentic OS owns:

- `redactSecretLikeContent()`;
- `containsSecretLikeContent()`;
- `normalizeSecretSafeText()`.

`apps/api/src/agent/memory.ts` re-exports the redactor for existing xox call sites, but the implementation is no longer local.

## Architecture Guard

`apps/api/tests/agent-architecture.test.ts` now requires `apps/api/src/agent/memory-safety.ts` to be absent and checks that xox memory code consumes `@agentic-os/core`.

## Validation

```bash
cd C:/Github/agentic-os
npm.cmd run build -w @agentic-os/core
node --test packages/core/dist/test/content-safety.test.js
npm.cmd run test -w @agentic-os/core
npm.cmd run check

cd C:/Github/xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts tests/agent-memory-core.test.ts tests/sandbox-tool.test.ts
npm.cmd run test:api
```
