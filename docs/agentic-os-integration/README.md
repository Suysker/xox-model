# xox-model Agentic OS Integration Plan

Status: Draft

Date: 2026-06-19

## Purpose

This folder tracks the `xox-model` plan for introducing `C:/Github/agentic-os` as the shared SaaS harness agent kernel.

This is not a `xox-model` ADR and not an `agentic-os` ADR. It is an integration plan for replacing duplicated harness infrastructure with an external, updatable Agentic OS dependency while keeping xox business logic unchanged.

## Goal

Introduce Agentic OS into `xox-model` by versioned package reference, not by copying code and not by long-term local file dependency.

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
- final answer claim DTO and generic claim-to-evidence-requirement projection;
- final answer hygiene for provider protocol artifacts;
- obligation plan aggregation and runner-obligation instruction;
- runtime adapter contract testing;
- host profile and host kit composition.

Agentic OS packages should be consumed as versioned `@agentic-os/*` packages:

```json
"@agentic-os/contracts": "^0.1.0",
"@agentic-os/core": "^0.1.0",
"@agentic-os/testing": "^0.1.0"
```

Exact versions should be pinned or ranged according to the release policy chosen for the first Agentic OS package release. The integration branch should not depend on copied source files or permanent `file:` references.

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
- Do not keep two production harnesses long-term.
- Do not merge the branch until the one-shot Agentic OS replacement reaches equal or better behavior than the current xox harness.
- Do not change business behavior unless a parity test proves the new Agentic OS path preserves or improves the old behavior.
- Do not put this plan under `docs/adr`; ADRs remain for architecture decisions, not this integration workstream.

## Current State

`xox-model` originally depended on Agentic OS packages through local file dependencies:

```json
"@agentic-os/contracts": "file:../../../agentic-os/packages/contracts",
"@agentic-os/core": "file:../../../agentic-os/packages/core"
```

On the integration branch, `apps/api/package.json` has been switched to versioned package references:

```json
"@agentic-os/contracts": "^0.1.0",
"@agentic-os/core": "^0.1.0",
"@agentic-os/testing": "^0.1.0"
```

The current local development install still resolves those packages through junctions into `C:/Github/agentic-os` until the selected registry contains the matching packages.

Current integration is no longer compatibility-only:

- `apps/api/src/agent/agentic-os/xox-runtime-turn-output.ts` maps xox `RuntimePlanResult` into Agentic OS `RuntimeTurnOutput`.
- The normal xox agent kernel now enters `apps/api/src/agent/agentic-os/xox-agentic-os-host-kit.ts`.
- The host kit calls Agentic OS `createAgentHostKit` and uses the Agentic OS loop as the production harness loop.
- xox still owns product/domain behavior, action graph projection, memory, sandbox, provider settings, and final response evidence policy through Agentic OS ports.
- xox `apps/api/src/agent/evidence-ledger.ts` now consumes `@agentic-os/core` `evidenceRequirementsFromFinalAnswerClaims()` for generic final claim kind projection.
- xox `apps/api/src/agent/response-evaluator.ts` now consumes `@agentic-os/core` `evaluateFinalAnswerHygiene()` for final answer protocol artifact rejection.
- xox `apps/api/src/agent/loop-obligations.ts` now consumes `@agentic-os/core` `ledgerToObligationPlan()` for generic required-tool/capability aggregation, runner-obligation instruction, and opaque metadata passthrough.
- xox `apps/api/src/agent/loop-obligation-ledger.ts` now consumes `@agentic-os/core` `projectObligationLedger()` for generic active/status counts and neutral obligation row projection.
- xox `apps/api/src/agent/obligation-materializer.ts` now consumes `@agentic-os/core` `planObligationMaterialization()` for active obligation task filtering, stable de-duplication, and generic event payloads.
- xox still owns provider final-answer claim extraction and financial/shareholder policy, including the xox adapter rule that unscoped entity/domain final-answer claims require shareholder domain evidence.
- xox still owns response-evaluator finding to financial/domain obligation mapping, plus `goalFacts`, `requiredDataScopes`, and `requiredMetrics`.
- xox still owns obligation materializer selection, `data_query_workspace` arguments, business read execution, and product run event persistence.
- xox still owns provider runtime plain-text tool-call recovery in `apps/api/src/agent/runtime/provider-plain-text-tool-calls.ts`; it is runtime recovery, not final review policy.
- Obsolete local harness helper files are intentionally removed: `agent-run-engine.ts`, `turn-resolver.ts`, `agent-action-runtime.ts`, `context-engine/index.ts`, and the former top-level `agentic-os-adapter.ts`.

This is a real kernel introduction. Remaining package work is registry/release hardening, not code copying.

This is not yet the final install model. The replacement work prepared Agentic OS packages for versioned consumption and switched xox dependency declarations to package versions, but the packages must still be published to a controlled registry before `package-lock.json` can be a pure registry lock.

Current Agentic OS package state observed on 2026-06-19:

- `@agentic-os/contracts`, `@agentic-os/core`, `@agentic-os/testing`, `@agentic-os/runtime-openai-compatible`, and `@agentic-os/runtime-ai-sdk` exist in `C:/Github/agentic-os`.
- package versions are `0.1.0`.
- publishable packages are no longer marked `private: true`; the repository root remains private.
- `main`, `types`, and `files` point at built `dist` artifacts.
- `npm run check` passes in `C:/Github/agentic-os`.

Registry state observed on 2026-06-19:

- public npm contains an unrelated `@agentic-os/core@0.1.0` from `https://github.com/wewei/agentic-os.git`;
- public npm does not contain `@agentic-os/contracts` or `@agentic-os/testing`;
- the local repository remote is `https://github.com/Suysker/agentic-os.git`.

Therefore final package locking must use a controlled publishing route: either publish the Suysker Agentic OS packages to an owned/private registry under the chosen scope, or change the package scope before merge. Do not generate a fake registry lock against the public npm package.

## Integration Principles

1. **Introduce, do not copy**

   Agentic OS must remain an external package dependency. xox integration code should be adapter code, not copied Agentic OS implementation.

2. **Preserve xox business behavior**

   Existing xox tests and smoke expectations are the baseline. If a behavior is domain-specific, keep it in xox. If it is generic harness behavior, move or fix it in Agentic OS.

3. **Replace in one integration branch**

   Do the replacement in `codex/xox-agentic-os-integration` as a single cutover branch. Internal work can be sequenced, but the branch should not merge until the production xox harness entrypoint has moved to Agentic OS and full tests pass.

4. **Use xox as the maturity pressure source**

   xox has mature provider, sandbox, tool, memory, action graph, and obligation behaviors. Generic discoveries should feed Agentic OS after being reduced to reusable contracts/tests.

5. **Keep host adapter thin**

   The xox adapter should map existing services into Agentic OS ports. It should not become a second harness implementation.

6. **Use versioned packages**

   xox should consume `@agentic-os/*` through versioned package references. Local `file:` dependencies are acceptable only as the current pre-release state and should be removed before the final integration branch is considered complete.

## Replacement Strategy

This plan now uses a single-branch, one-shot replacement strategy:

```text
prepare versioned Agentic OS packages
  -> switch xox dependencies from file refs to @agentic-os versions
  -> build xox Agentic OS host adapter/profile/kit
  -> replace xox production agent kernel entrypoint
  -> delete or isolate obsolete duplicate harness code
  -> run full xox tests until equal or better
```

This is "short pain" at merge level, not reckless untested replacement. The branch may still contain ordered implementation slices, but main should only receive the final cutover once the old behavior is matched or improved.

Rollback strategy after merge should be package-version based:

- repin `@agentic-os/*` to the last known good version;
- revert xox adapter changes if package repin is insufficient;
- reproduce generic failures in Agentic OS tests before releasing the next version.

## Versioned Package Plan

Agentic OS must be consumable as real packages before xox cutover.

Required Agentic OS package work:

- choose first integration version, currently `0.1.0`;
- remove `private: true` from publishable packages or configure the chosen private registry workflow;
- verify package `main`, `types`, and `files` point to built artifacts;
- run `npm run check` in Agentic OS;
- produce package artifacts through `npm pack` or publish to the selected registry;
- document the package version consumed by xox;
- verify the selected registry resolves all required packages to the Suysker Agentic OS artifacts, not the unrelated public npm `@agentic-os/core`.

Required xox dependency work:

- replace `file:../../../agentic-os/packages/contracts` with a versioned `@agentic-os/contracts`;
- replace `file:../../../agentic-os/packages/core` with a versioned `@agentic-os/core`;
- add `@agentic-os/testing` as a dev/test dependency when contract helpers are used;
- commit `package-lock.json` updates;
- avoid importing from Agentic OS source paths.

Current integration-branch status:

- `apps/api/package.json` uses versioned `@agentic-os/*` references.
- `package-lock.json` records the current development junctions at package version `0.1.0`.
- A pure registry `package-lock.json` is intentionally blocked until the controlled registry contains `@agentic-os/contracts`, `@agentic-os/core`, and `@agentic-os/testing` from `Suysker/agentic-os`.
- Do not run `npm install` against public npm for this branch until the scope ownership/registry route is resolved.

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

## Phase 1: Release-Ready Agentic OS Dependency

Purpose: make Agentic OS consumable by xox as versioned packages.

Work:

- prepare `@agentic-os/contracts`, `@agentic-os/core`, and `@agentic-os/testing` for versioned consumption;
- publish or pack the packages according to the selected release workflow;
- update xox dependencies from local `file:` refs to versioned package refs;
- update `package-lock.json`;
- verify xox never imports Agentic OS source files directly.

Expected result:

- xox consumes Agentic OS by package version, so future Agentic OS updates can be synchronized through dependency upgrades.

Validation:

```bash
npm install
npm run build:api
```

## Phase 2: Contract-Harden Existing Adapter

Purpose: make the existing compatibility adapter a stable provider/runtime contract boundary before replacing the run loop.

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

## Phase 3: Build the xox Agentic OS Host Kit

Purpose: materialize xox's existing harness subsystems as Agentic OS ports.

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
- Keep the adapter thin: it maps xox services into Agentic OS; it does not reimplement the loop.

Expected result:

- xox can run through Agentic OS host kit in tests with xox business services still owning writes, memory, provider settings, and DB projection.

Validation:

```bash
npm run build:api
npm run test --workspace @xox/api -- agentic-os-host-kit.test.ts
```

## Phase 4: Replace Production Agent Kernel Entry

Purpose: replace the xox production harness entrypoint with Agentic OS in the integration branch.

Work:

- change `apps/api/src/agent/agent-kernel.ts` and related runner wiring to call `createXoxAgenticOsHostKit()`;
- route read tools, write actions, sandbox, memory context, and final review through Agentic OS ports;
- preserve xox API routes, DB projection, transcript output, and business semantics;
- remove or isolate obsolete duplicated loop control that Agentic OS now owns;
- keep xox-specific domain evaluators and action graph services behind host ports.

Expected result:

- the normal xox agent path uses Agentic OS as its harness loop.

Validation:

```bash
npm run build:api
npm run test:api
```

## Phase 5: Full Parity and Hardening

Purpose: reach equal or better behavior than the old xox harness before merge.

Work:

- run and fix the full xox API suite;
- run focused parity tests for:
  - read-only agent turns;
  - provider error behavior;
  - progressive tool discovery and effective inventory;
  - memory/context recall;
  - sandbox observation loop;
  - pending action creation;
  - edit before confirm;
  - confirm execution;
  - reject;
  - invalid preview mutation fail-closed;
  - cross-run/action result mismatch fail-closed;
  - final answer review/repair/clarification;
  - obligation ledger behavior.
- if Agentic OS lacks a generic invariant, fix Agentic OS and release a new package version;
- if xox mapping is wrong, fix the xox adapter.

Expected result:

- xox tests pass with the Agentic OS kernel, and behavior is equal or better than the previous harness.

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
- Agentic OS is consumed through versioned `@agentic-os/*` package declarations, not permanent local `file:` refs.
- Before merge, the selected registry must resolve all `@agentic-os/*` packages to the intended Agentic OS artifacts, and `package-lock.json` must no longer depend on development junctions.
- The normal xox production agent kernel uses Agentic OS as the harness loop.
- The old xox harness loop is removed or isolated so there is no long-term dual-harness maintenance.
- `xox-model` business behavior is unchanged unless explicitly approved.
- `npm run build:api` passes.
- `npm run test:api` passes.
- `agentic-os-adapter.test.ts` passes.
- New Agentic OS parity tests pass.
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

The first implementation slice should start the one-shot replacement branch by fixing dependency shape and contract safety:

1. Prepare Agentic OS packages for versioned consumption.
2. Replace xox local `file:` Agentic OS dependencies with versioned `@agentic-os/*` references.
3. Add `@agentic-os/testing` to xox API test dependencies if necessary.
4. Extend `agentic-os-adapter.test.ts` with runtime contract validation.
5. Add a small `agentic-os-runtime-contract.test.ts` if the existing test becomes too broad.
6. Run `build:api` and the Agentic OS adapter tests.

After this slice passes, build the host kit and then replace the production agent kernel entrypoint in the same branch.
