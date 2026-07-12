# xox-model Agentic OS Integration

Status: Active downstream integration

Date: 2026-07-05

## Purpose

This folder is the long-lived integration entrypoint for using Agentic OS inside xox-model.

Agentic OS is the SaaS harness computer. xox-model is a downstream product host: it provides tenant data, tools, prompts, durable storage, business execution, provider settings, and UI projection. xox must not rebuild a local agent loop, provider runtime, worker lifecycle, final-review engine, memory kernel, sandbox runtime, or transcript reducer.

Historical one-shot milestone documents were consolidated into [history.md](history.md). Keep new details here only when they describe the current integration contract or a durable validation rule.

## Current Boundary

Agentic OS owns:

- agent loop and terminal-state decisions
- provider turn execution, stream normalization, replay, retry, and recovery
- inline model-turn decisions, Runtime Executor calls, tool/result causality, and exact resume
- V4 causal model history, provider acknowledgement, and provider-family projection
- generation-fenced causal journal, trace/span assembly, trajectory, and exporter boundaries
- sandbox execution protocol, backend broker, result parsing, repair semantics, and runtime metadata
- action lifecycle semantics, approval authority, resume, interruption, and finalization
- mandatory/additive Evaluator composition, evidence freshness, repair feedback, and Turn Finalizer
- memory lifecycle semantics, recall/capture/search/get tool behavior, and reusable memory ranking policy
- run-plane lifecycle, durable worker orchestration, queue drain, recovery, cancellation, and fail-closed policy
- transcript / harness UI projection and AG-UI-compatible user/operator surfaces

xox-model owns:

- xox business tools and tool catalog metadata
- domain services for workspace, ledger, members, shareholders, costs, versions, sharing, and import/export
- tenant/workspace/user authorization and provider setting storage
- SQL row stores, leases, messages, run events, action requests, and legacy DTO compatibility
- xox prompts and product policy text under `apps/api/src/agent/host-profile/prompts`
- sandbox input bundle composition, file adapters, manifest policy values, and allowed business SDK surface
- Memory Center management UI/DTOs and tenant memory persistence
- route transport, auth, SSE framing, Chinese product copy, and xox visual projection

## Current Implementation Points

- API host profile: `apps/api/src/agent/host-profile/xox-host-profile.ts`
- xox planned-item DTOs and prompt assets: `apps/api/src/agent/host-profile/`
- Agentic OS store/transport adapters: `apps/api/src/agent/agentic-os/`
- xox business tool catalog and execution: `apps/api/src/agent/tool-catalog.ts`, `apps/api/src/agent/tool-executor.ts`
- xox sandbox peripheral: `apps/api/src/agent/sandbox-service.ts`
- xox memory persistence / Memory Center: `apps/api/src/agent/memory.ts`
- web harness surface: `apps/web/src/components/agent/AgentHarnessPanel.tsx`

## Recent Integration State

ADR0074-0076 are the current integration baseline.

- `xox-host-profile.ts` supplies declarative catalog/credentials, business
  tools/actions/sandbox/context and additive product facts to
  `createSaaSAgentHost()`; it has no local continuation engine, Runtime selector, Evaluator,
  continuation or terminal callback.
- `xox-harness-control-store-adapter.ts` maps SQLite/Kysely to
  `AgentServerControlRecordBackend`, including tenant/workspace/user scoped
  records and atomic loop-state-plus-transition CAS. The same backend supplies
  durable Runtime Execution Store and Trace journal records.
- xox does not build assistant `tool_calls`, tool result replay, provider
  acknowledgement cursors, trace ids, span parents, or trajectory rows.
- the shared fake provider enforces the real causal pairing contract, including
  parallel source order and incomplete-group rejection.
- Recovery keeps `maxIterations` on the original `AgentRunInput`, submits
  explicit observations, and never reconstructs model history from loose
  messages.
- Action requests persist the canonical Agentic OS tool-call id. Confirmation
  reacquires a database continuation lease before `resumeRun()`, refreshes it
  across provider/action-graph writes, and releases it in `finally`; product
  action ids never replace loop causality.
- `apps/api/tests/agent-evaluation-dataset.test.ts` owns the xox financial
  workspace rubric and runs it through `@agentic-os/testing`; no product rubric
  is embedded in Agentic OS core.
- `.github/workflows/agentic-os-integration.yml` runs API build/full tests on
  pull requests and a weekly schedule with Agentic OS checked out as a sibling.

ADR0069 typed hooks remain a peripheral under this path. xox does not dispatch
hooks or create a parallel approval/finalizer lifecycle; Agentic OS freezes the
snapshot and owns invocation, timeout, replay, outbox and terminal semantics.

M192 sandbox port cutover is the current baseline.

- xox passes its manifest-scoped sandbox peripheral into Agentic OS through `AgentSandboxPort`.
- Sandbox calls are projected through Agentic OS run events and transcript facts rather than xox legacy `planSteps`.
- Sandbox manifests use Agentic OS canonical bundle scopes and `runtime.computeMs`.
- Local development uses `XOX_SANDBOX_BACKEND=local-script`; production should use Docker or another isolated backend.

M191 harness frontend cutover is also part of the baseline.

- xox web consumes Agentic OS harness UI frames through `@agentic-os/ui-react` / `@agentic-os/ui`.
- Default user surface hides raw harness internals and shows assistant text, tool activity, approvals, and final output.
- Operator/developer details remain gated by the host shell.

ADR0077 evaluator timing is part of the current baseline.

- xox declares no `reviewTimeoutMs`, absolute Review deadline, or Lane
  deadline; Agentic OS owns admission, parent clamping, and exact resume.
- The SQL control adapter exposes no V1 reader, converter, migration API, or
  compatibility alias. Old runs drain or terminate before V2 deployment.
- Downstream tests cover a delayed three-turn Candidate, workspace provenance,
  and an expired exact-resume Lane without a local evaluator loop.

## Do Not Reintroduce

The following categories must stay out of xox-model:

- local Agent Loop, model-turn controller, or direct-answer runner
- per-turn runtime selector or provider retry/replay controller
- provider runtime sidecars and provider replay message assembly
- local tool-call supervisor, outcome classifier, repair loop, or observation continuation runner
- local final-review/evidence/obligation framework
- arbitrary resume-message reconstruction or queue-time budget override
- local memory kernel, ranking, capture runtime, or active-recall lifecycle
- local sandbox broker/backend/process runner/result parser
- local durable run worker, queue lifecycle, recovery classifier, or fail-closed policy
- local transcript/timeline tree reducer or generic AG-UI projector
- keyword/regex business intent routing over user prose

Architecture tests should guard these boundaries in `apps/api/tests/agent-architecture.test.ts`.

## Validation

For xox-only integration changes:

```bash
npm.cmd run build:api
npm.cmd run build --workspace @xox/web
npm.cmd run test:api
```

Run broader API coverage when routes, DB projection, action graph, memory, provider runtime, or public API behavior changes:

```bash
npm.cmd run test --workspace @xox/api -- tests/api.test.ts
```

Run real provider smoke only when credentials are configured:

```bash
npm.cmd run smoke:agent --workspace @xox/api
```

When changing Agentic OS packages during this integration, validate both repos:

```bash
cd C:/Github/agentic-os
npm.cmd run check

cd C:/Github/xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/sandbox-tool.test.ts tests/agent-architecture.test.ts
```

## Package Model

xox should consume Agentic OS as versioned `@agentic-os/*` packages. Local `file:` references are acceptable only for the current pre-release workspace integration. Before a production dependency lock is considered final, the selected registry must resolve `@agentic-os/*` packages to the intended Agentic OS artifacts, not unrelated public packages.

## Documentation Rule

Do not add another per-slice `mNNN-*.md` file. Update this README for durable current-state facts, and update [history.md](history.md) only when a milestone changes the integration lineage.
