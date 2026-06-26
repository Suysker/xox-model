# M185 Host Worker Runtime Amputation

## Goal

Continue the M184 deletion cut. xox must not expose a local worker/runtime/memory/sandbox harness shape under `apps/api/src/agent`.

The immediate target is to remove visible host CPU surfaces:

- `agentic-os/xox-run-worker-adapter.ts`
- host-profile runtime adapter parameter assembly
- memory tool handler wiring in `tool-executor.ts`
- sandbox aggregate execution/validation loops in `tool-executor.ts` and `tool-policy.ts`
- sandbox peripheral bridge policy details in `sandbox-service.ts`

## Boundary

xox may keep:

- durable SQL row loading and writes
- provider settings/key source
- business tool handlers
- concrete business write execution
- workspace bundle/manifest/SDK descriptions
- Memory Center DTOs
- route/SSE transport and product DTO projection

Agentic OS should own:

- worker coordinator lifecycle
- queue drain and submitted-run execution helpers
- recovery/fail-closed orchestration
- runtime adapter replay/default policy
- memory tool semantics
- sandbox aggregate nested action protocol

## Acceptance

`apps/api/src/agent` must not contain:

- `xox-run-worker-adapter.ts`
- `completeAgentRun`
- `recoverRunningAgentRuns`
- `scheduleAgentRunQueueDrain`
- `getAgentRunWorker`
- `runXoxSubmittedRun`
- `startXoxReadyRuns`
- `requestXoxRunQueueDrain`
- direct low-level runtime/sandbox/memory helper imports once a SaaS-level API exists
