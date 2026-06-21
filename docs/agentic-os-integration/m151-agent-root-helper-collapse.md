# M151 Agent Root Helper Collapse

Status: Completed

## Intent

This cut removes single-entry helper files and subdirectory wrappers from
`apps/api/src/agent`. The goal is not to move harness logic around. The goal is
to make xox look like a downstream SaaS host with a few concrete peripherals:
memory store, sandbox service, provider settings, tool catalog, routes, and
business tool execution.

## Direct Deletions

- Deleted `apps/api/src/agent/config-patch.ts`.
- Deleted `apps/api/src/agent/provider-key-codec.ts`.
- Deleted `apps/api/src/agent/tool-coverage.ts`.
- Deleted `apps/api/src/agent/sandbox-file-adapters.ts`.
- Deleted the remaining `apps/api/src/agent/memory/*` helper files:
  - `daily-notes.ts`
  - `dreaming-worker.ts`
  - `memory-backend.ts`
  - `memory-center.ts`
  - `memory-tools.ts`
  - `recall-signals.ts`

## New Boundaries

- `memory.ts` is the single xox durable memory peripheral. It owns SQL row
  mapping, Memory Center DTOs, recall signals, daily notes, dreaming reports,
  memory tools, and redaction call placement.
- `sandbox-service.ts` is the single xox sandbox peripheral. Agentic OS owns the
  sandbox runtime; xox keeps upload/file policy, workspace data bundles,
  business SDK exposure, and product `ReadDraft` projection in this boundary.
- `tool-catalog.ts` is the single xox tool manifest boundary. Writable config
  coverage now lives with the catalog instead of a standalone `tool-coverage.ts`.
- `provider-settings.ts` owns provider key encryption because that is tenant
  settings storage, not an agent harness module.
- `action-draft-utils.ts` owns config patch helpers because they are action draft
  implementation details.

## Guards

`apps/api/tests/agent-architecture.test.ts` now fails if any deleted helper file
returns or if production agent files import the deleted paths.

## Validation

Run:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test --workspace @xox/api -- tests/sandbox-tool.test.ts tests/agent-memory-core.test.ts
npm.cmd run test:api
git diff --check
```
