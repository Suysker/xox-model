# M123 Sandbox Runtime Package

Status: Implemented

Date: 2026-06-21

## Goal

Delete xox-owned sandbox runtime files and consume `@agentic-os/sandbox` as the shared SaaS sandbox harness package.

## What Moved

Moved to Agentic OS:

- `SandboxBroker` and backend registry.
- Local process and Docker sandbox backends.
- Sandbox policy gate.
- Child process timeout/stdout/stderr lifecycle.
- Staged input bundle and helper SDK generation.
- File-based Tool Runtime RPC bridge.
- Structured result parsing and artifact collection.

Deleted from xox:

- `apps/api/src/agent/sandbox/backend.ts`
- `apps/api/src/agent/sandbox/backend-registry.ts`
- `apps/api/src/agent/sandbox/sandbox-broker.ts`
- `apps/api/src/agent/sandbox/sandbox-policy.ts`
- `apps/api/src/agent/sandbox/result-parser.ts`
- `apps/api/src/agent/sandbox/backends/*`

## What Stayed In xox

- `apps/api/src/agent/sandbox-service.ts`: workspace data bundle, allowed business SDK entries, nested action aggregation, xox `ReadDraft`/action projection.
- `apps/api/src/agent/sandbox-file-adapters.ts`: uploaded-file identity and safety policy.

## Verification

- Agentic OS `@agentic-os/sandbox` build and tests.
- xox architecture test guards deleted sandbox runtime files.
- xox sandbox tests continue to run the real local backend through `@agentic-os/sandbox`.
