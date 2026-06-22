# M162 Delete Local Observation Continuation Runner

Status: completed.

Date: 2026-06-22

## Problem

`apps/api/src/agent/host-profile/xox-agent-run-profile.ts` still contains a local `continueModelAfterToolObservations()` runner. Even after the standalone tool-observation facade was deleted, this function still makes xox understand too much about the harness CPU:

- when an observation continuation starts;
- how continuation success/failure is classified;
- which `model_continuation*` lifecycle events are emitted;
- how an empty continuation result becomes a failed continuation;
- how provider exceptions are converted into safe continuation failure copy.

This violates the target boundary. xox should provide provider settings, context, messages, event sink, and failure persistence. Agentic OS should own the continuation lifecycle.

## Module Division

| Module | Responsibility after M162 |
| --- | --- |
| `@agentic-os/server` | Owns provider-neutral observation continuation lifecycle: skip empty observations, append started/completed/failed events, classify assistant-text success, convert empty/error result into failed continuation. |
| `@agentic-os/runtime-openai-compatible` | Continues to own OpenAI-compatible assistant/tool replay message assembly. |
| `xox-agent-run-profile.ts` | Supplies xox runtime context, provider settings, prompt identity, runtime callback, and persists the xox failed plan step if Agentic OS returns a failed continuation. |
| `xox-run-event-store-adapter.ts` | Persists Agentic OS lifecycle event drafts. |

## Dependency Graph

```text
xox-agent-run-profile.ts
  -> @agentic-os/server runAgentServerObservationContinuation()
  -> @agentic-os/runtime-openai-compatible buildProviderToolObservationContinuationMessages()
  -> xox provider/runtime callback and DB persistence

@agentic-os/server
  -> agentServerRunLifecycleEvents.modelContinuation*
  -> host appendRunEvent callback
```

Forbidden shape:

```text
xox-agent-run-profile.ts
  -> function continueModelAfterToolObservations(...)
  -> direct local model_continuation started/completed/failed classification
```

## Reuse Plan

- Reuse existing `agentServerRunLifecycleEvents.modelContinuation()`, `modelContinuationCompleted()`, and `modelContinuationFailed()`.
- Reuse existing `safeAgentServerErrorMessage()` for provider exception redaction.
- Reuse existing runtime-compatible message helper in xox as provider-specific input assembly.
- Add a focused Agentic OS server test for success, empty result failure, thrown failure, and no-observation skip.

## Naming

New Agentic OS API:

```ts
runAgentServerObservationContinuation()
```

The name is provider-neutral and SaaS-harness oriented. It deliberately avoids `xox`, `OpenAI`, or `finalizer`.

## Validation

Evidence from this cut:

```powershell
cd C:\Github\agentic-os
npm.cmd run build -w @agentic-os/server
npm.cmd run test -w @agentic-os/server
git diff --check

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test:api
git diff --check
```

Observed result:

- `@agentic-os/server` build passed.
- `@agentic-os/server` test passed: 36 tests.
- `xox-model` `build:api` passed.
- `tests/agent-architecture.test.ts` passed: 56 tests.
- `test:api` passed: 11 test files, 220 tests.

## Acceptance

- `continueModelAfterToolObservations` no longer exists in xox source.
- xox does not directly emit `model_continuation`, `model_continuation_completed`, or `model_continuation_failed` events for observation continuation.
- The remaining xox code only calls Agentic OS continuation runner and persists xox product artifacts.
