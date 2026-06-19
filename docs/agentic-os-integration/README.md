# xox-model Agentic OS Integration Plan

Status: Draft

Date: 2026-06-19

## Purpose

This folder tracks the `xox-model` plan for introducing `C:/Github/agentic-os` as the shared SaaS harness agent kernel.

This is not a `xox-model` ADR and not an `agentic-os` ADR. It is an integration plan for replacing duplicated harness infrastructure with an external, updatable Agentic OS dependency while keeping xox business logic unchanged.

## Goal

Introduce Agentic OS into `xox-model` by reference, not by copying code.

The target shape is:

```text
xox-model business logic
  -> xox Agentic OS host adapter/profile
  -> @agentic-os/core host kit
  -> Agentic OS agent loop
```

Agentic OS should own reusable harness concerns:

- agent loop ownership;
- runtime turn output classification;
- tool runtime guardrails;
- action lifecycle integrity;
- context boundary and redaction;
- runtime adapter contract testing;
- host profile and host kit composition.

`xox-model` should continue to own product and domain concerns:

- financial model business rules;
- xox DB schema and migrations;
- API DTOs and routes;
- workspace/user authorization;
- action graph business semantics;
- memory backend and recall ranking;
- provider settings and real-provider smoke configuration;
- existing UI projection semantics.

## Non-Goals

- Do not copy Agentic OS source files into `xox-model`.
- Do not move xox business logic into Agentic OS core.
- Do not replace the mature xox production harness in one step.
- Do not change API behavior unless a parity test proves the new path is equivalent or better.
- Do not put this plan under `docs/adr`; ADRs remain for architecture decisions, not this integration workstream.

## Current State

`xox-model` already depends on Agentic OS packages through local file dependencies:

```json
"@agentic-os/contracts": "file:../../../agentic-os/packages/contracts",
"@agentic-os/core": "file:../../../agentic-os/packages/core"
```

Current integration is compatibility-only:

- `apps/api/src/agent/agentic-os-adapter.ts` maps xox `RuntimePlanResult` into Agentic OS `RuntimeTurnOutput`.
- The adapter reuses Agentic OS `TurnResolver`.
- It does not yet run the xox agent through Agentic OS `AgentRunEngine`, `createAgentHostKit`, `ToolRuntime`, or `ActionRuntime`.

This is a useful first boundary, but not yet a real kernel introduction.

## Integration Principles

1. **Introduce, do not copy**

   Agentic OS must remain an external package dependency. xox integration code should be adapter code, not copied Agentic OS implementation.

2. **Preserve xox business behavior**

   Existing xox tests and smoke expectations are the baseline. If a behavior is domain-specific, keep it in xox. If it is generic harness behavior, move or fix it in Agentic OS.

3. **Migrate by strangler path**

   Add an Agentic OS pilot path next to the mature xox harness. Expand it only after parity tests pass.

4. **Use xox as the maturity pressure source**

   xox has mature provider, sandbox, tool, memory, action graph, and obligation behaviors. Generic discoveries should feed Agentic OS after being reduced to reusable contracts/tests.

5. **Keep host adapter thin**

   The xox adapter should map existing services into Agentic OS ports. It should not become a second harness implementation.

## Proposed Folder Shape

Implementation files should live outside this documentation folder. Candidate source layout:

```text
apps/api/src/agent/agentic-os/
  xox-agentic-os-profile.ts
  xox-agentic-os-host-kit.ts
  xox-agentic-os-runtime.ts
  xox-agentic-os-tools.ts
  xox-agentic-os-actions.ts
  xox-agentic-os-context.ts
  xox-agentic-os-completion.ts
```

Tests should live beside existing agent tests:

```text
apps/api/tests/agentic-os-adapter.test.ts
apps/api/tests/agentic-os-runtime-contract.test.ts
apps/api/tests/agentic-os-host-kit.test.ts
apps/api/tests/agentic-os-parity.test.ts
```

The exact file names can change if the existing xox module structure suggests a cleaner split.

## Phase 1: Contract-Harden Existing Adapter

Purpose: make the existing compatibility adapter a stable provider/runtime contract boundary.

Work:

- Add `@agentic-os/testing` as a test dependency if needed.
- Validate `runtimePlanResultToAgenticOsTurnOutput()` with Agentic OS runtime contract helpers.
- Expand tests for:
  - assistant text output;
  - tool call output;
  - tool call dominance over assistant text;
  - provider error output;
  - malformed or missing runtime result;
  - provider tool call argument normalization.

Expected result:

- xox provider/runtime output can be checked against Agentic OS `RuntimeTurnOutput` without invoking the full Agentic OS run loop.

Validation:

```bash
npm run build:api
npm run test --workspace @xox/api -- agentic-os-adapter.test.ts
```

## Phase 2: Build a Test-Only Agentic OS Host Kit Pilot

Purpose: prove xox can materialize Agentic OS host ports without changing the production run path.

Work:

- Create xox Agentic OS profile builder.
- Map existing xox subsystems into Agentic OS ports:
  - run/store/event persistence -> `AgentStorePort`;
  - provider planning -> `RuntimeAdapter`;
  - tool catalog/tool executor -> `AgentToolDefinition[]`;
  - action graph/action runtime -> `AgentActionPort`;
  - memory/context -> `ContextSource[]`;
  - readiness/final answer review -> `AgentCompletionPort`;
  - sandbox runtime -> optional `AgentSandboxPort`.
- Create `createXoxAgenticOsHostKit()` around `createAgentHostKit()`.
- Keep this path test-only or feature-flagged.

Expected result:

- A xox host kit can run a minimal read-only loop through Agentic OS.
- No public API route changes yet.

Validation:

```bash
npm run build:api
npm run test --workspace @xox/api -- agentic-os-host-kit.test.ts
```

## Phase 3: Read-Only Parity

Purpose: compare Agentic OS pilot behavior against xox mature harness for non-writing agent runs.

Work:

- Select existing read-only agent tests from `apps/api/tests/api.test.ts`.
- Run equivalent scenarios through the Agentic OS host kit.
- Verify:
  - same or better final answer quality signals;
  - same server-owned transcript visibility;
  - same tool observation semantics;
  - same provider error behavior;
  - no business writes.

Expected result:

- Agentic OS path can safely handle read-only xox agent work.

Validation:

```bash
npm run build:api
npm run test:api
```

## Phase 4: Action Lifecycle Parity

Purpose: prove Agentic OS `ActionRuntime` can wrap xox action graph semantics without changing business writes.

Work:

- Map xox action graph preview/edit/execute/reject into `AgentActionPort`.
- Ensure action request ids, audit ids, tool call ids, and observations stay bound to the same run/action/tool.
- Preserve xox action graph persistence and audit logs.
- Add tests for:
  - pending action creation;
  - edit before confirm;
  - confirm execution;
  - reject;
  - invalid preview mutation fail-closed;
  - cross-run/action result mismatch fail-closed.

Expected result:

- xox business writes still occur only through xox services.
- Agentic OS provides generic lifecycle guardrails.

Validation:

```bash
npm run build:api
npm run test:api
```

## Phase 5: Controlled Runtime Switch

Purpose: route a limited production-like path through Agentic OS while preserving fallback.

Work:

- Add feature flag or internal setting:

```text
XOX_AGENTIC_OS_KERNEL=0|1
```

- Default remains existing xox harness until parity is proven.
- When enabled, selected agent paths run through `createXoxAgenticOsHostKit()`.
- Keep fallback to existing harness during rollout.

Expected result:

- Agentic OS can be consumed as the actual harness kernel for scoped xox flows.

Validation:

```bash
npm run build:api
npm run test:api
npm run smoke:agent
```

`smoke:agent` depends on provider credentials and should be run when the environment is configured.

## Problem Ownership

Fix in Agentic OS when the issue is generic harness behavior:

- loop terminal-state ownership;
- runtime output contract;
- tool inventory/effective surface;
- tool observation outcome;
- action lifecycle integrity;
- context scope/redaction;
- cancellation;
- resume;
- obligation/final-review mechanics;
- runtime adapter contract testing.

Fix in xox-model when the issue is product/domain behavior:

- financial model semantics;
- workspace/team/member/ledger rules;
- xox DB schema and migrations;
- xox API DTOs;
- action graph business projection;
- memory retrieval ranking and persistence;
- provider settings UI/API;
- real-provider smoke configuration.

If a xox mature behavior looks generic, first reproduce it as an Agentic OS test, then move the generic invariant into Agentic OS.

## Acceptance Gate

The integration is not considered successful until:

- Agentic OS is consumed as dependency, not copied.
- `xox-model` default business behavior is unchanged unless explicitly approved.
- `npm run build:api` passes.
- `npm run test:api` passes.
- `agentic-os-adapter.test.ts` passes.
- New Agentic OS pilot/parity tests pass.
- Relevant Agentic OS tests pass when Agentic OS itself changes.
- Navigation server tests are not regressed when Agentic OS changes.

## Standard Cross-Repo Validation

When changing Agentic OS during this integration:

```bash
cd C:/Github/agentic-os
npm run check

cd C:/Github/navigation
npm run typecheck -w apps/server
npm run test -w apps/server

cd C:/Github/xox-model
npm run build:api
npm run test --workspace @xox/api -- agentic-os-adapter.test.ts
```

When changing xox-model only:

```bash
cd C:/Github/xox-model
npm run build:api
npm run test --workspace @xox/api -- agentic-os-adapter.test.ts
```

Escalate to full `npm run test:api` when the change touches agent routes, DB projection, action graph, memory, provider runtime, or public API behavior.

## First Implementation Slice

The first implementation slice should be intentionally small:

1. Add `@agentic-os/testing` to xox API test dependencies if necessary.
2. Extend `agentic-os-adapter.test.ts` with runtime contract validation.
3. Add a small `agentic-os-runtime-contract.test.ts` if the existing test becomes too broad.
4. Keep production harness untouched.
5. Run `build:api` and the Agentic OS adapter tests.

After this slice passes, start the host kit pilot.
