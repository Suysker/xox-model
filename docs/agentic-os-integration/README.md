# xox-model Agentic OS Integration Plan

Status: Draft (M192 sandbox port cutover implemented; full API parity still open)

Date: 2026-06-21

## Latest Status: M192

M192 reconnects xox sandbox execution to the updated Agentic OS first-class sandbox port.

Current M192 cut:

- `@agentic-os/core` now owns sandbox tool execution as an `AgentSandboxPort` path. xox passes its existing manifest-scoped sandbox peripheral into `createOpenAISaaSHostComputerFromProfile()` instead of relying on the legacy read-draft tool path.
- `sandbox-service.ts` keeps only host peripheral responsibilities: workspace bundle creation, manifest policy, SDK manifest, file policy, backend selection, and conversion to `AgentSandboxExecutionResult`.
- xox sandbox manifests now use Agentic OS canonical bundle scopes (`summary_records`, `time_series_records`, `tabular_records`, `entity_records`, `uploaded_file`, `custom_bundle`) and `runtime.computeMs`.
- Sandbox tool activity is projected through Agentic OS run events/transcript (`tool_call_completed` / `tool_call_failed`) rather than xox legacy `planSteps`; this keeps sandbox in the Agentic OS CPU path while preserving user-visible tool evidence.
- Local test/dev runs without Docker explicitly select `XOX_SANDBOX_BACKEND=local-script`; production should continue using an isolated backend.

See [M192 Agentic OS Sandbox Port Cutover](m192-agentic-os-sandbox-port-cutover.md) for the design and validation contract.

## Previous Status: M191

M191 connects the Agentic OS ADR0058/ADR0059 frontend control plane to xox web as the standard harness UI surface.

Current M191 cut:

- xox API continues to project backend-owned `harnessUi` through `@agentic-os/server` `projectAgentServerHarnessUi()`.
- `apps/web/src/components/agent/AgentHarnessPanel.tsx` now reduces those frames through `@agentic-os/ui-react` and renders `@agentic-os/ui` audience surfaces.
- The default mounted surface is the ordinary user surface. It shows the Agentic OS run timeline, tool activity, inline approval, and completion state without exposing operator/developer internals.
- Operator/developer surfaces are explicit and gated by the host shell. The current web shell enables them only in Vite dev builds until a real product role/permission is passed through.
- Agentic OS inline approval callbacks route to the existing xox confirm/cancel lifecycle, so the generic harness UI does not invent another action execution path.
- xox keeps `AgentChatTimeline` only for xox-specific editable confirmation card rendering until Agentic OS exposes a generic host artifact renderer slot.

See [M191 Agentic OS Harness Frontend Audience Surface](m191-harness-frontend-audience-surface.md) for the downstream frontend boundary.

## Previous Status: M190

M190 fixes a realtime visibility regression found in conversation `e366b31c`.

Current M190 cut:

- xox keeps provider streaming enabled for observation-continuation and post-tool final-answer turns. A run must not stop streaming just because it already has tool observations; otherwise the user sees no model-authored post-tool text until completion.
- xox still shows only semantic user-visible transcript facts: assistant content, compact tool calls/arguments/results, confirmation interrupts, errors, and the lightweight running state. Provider lifecycle, memory recall, final-review and worker events remain in the technical log.

## Previous Status: M188

M188 removes the remaining visible lifecycle projection and StorePort assembly names from `apps/api/src/agent`.

Current M188 cut:

- `@agentic-os/server` now exposes `applyAgentServerSaaSActionCancellation()`, `applyAgentServerSaaSActionUpdate()`, and `applyAgentServerSaaSActionExecutionFailure()`. `routes.ts` no longer imports direct action projection helpers.
- `@agentic-os/server` now exposes `applyAgentServerSaaSRunInterruption()` and a durable profile `interruption` section. `xox-run-store-adapter.ts` no longer imports direct run interruption projection/apply helpers.
- `@agentic-os/server` now exposes `createAgentServerSaaSHostStorePort()`, and `@agentic-os/runtime-openai-agents` now accepts `storeProfile` in `createOpenAISaaSHostComputerFromProfile()`. `xox-host-profile.ts` no longer imports `AgentStorePort` or hand-builds `claimRunLane`, `refreshRunLease`, or `releaseRunLane`.
- xox still provides durable SQL facts/effects, provider setting values, prompt assets, tool registry, business execution, product events, route transport, and DTO projection.
- Architecture tests now guard against these low-level lifecycle/store symbols returning to `apps/api/src/agent`.

See [M188 Action, Run Interruption, and Store Profile Boundary](m188-action-run-store-profile-boundary.md) for the design and validation contract.

## Previous Status: M187

M187 continues M186 by removing the last visible lifecycle/runtime assembly names from the first downstream host.

Current M187 cut:

- `@agentic-os/server` now exposes `createAgentServerSaaSDurableRunHostFromProfile()` and `createAgentServerSaaSDurableRunHostProfileRegistry()`. `xox-run-store-adapter.ts` no longer constructs an `AgentServerDurableRunQueueStore` or exposes `claimPendingRuns`, `claimRecoverableRuns`, `markRunStarted`, `markRunCompleted`, `markRunFailed`, or `failClosedRecovery`.
- `@agentic-os/runtime-openai-agents` now exposes `createOpenAISaaSHostComputerFromProfile()`. `xox-host-profile.ts` no longer exposes low-level `compatible`, `agents`, or `selectAdapter` runtime groups.
- xox still provides durable SQL facts/effects, provider settings values, prompt assets, tool registry, business execution, product events, route transport, and DTO projection.
- Architecture tests now guard the higher-level boundary directly: downstream source must consume profile facades and must not reintroduce visible queue-store lifecycle keys or low-level runtime group names.

See [M187 Durable Host Profile Boundary](m187-durable-host-profile-boundary.md) for the design and validation contract.

## Previous Status: M186

M186 supersedes the older M142-M185 incremental notes below where they still mention deleted host harness files or xox-owned final-review/runtime/projection/tool-result/sandbox-aggregate helpers.

Current production entry is `apps/api/src/agent/host-profile/xox-host-profile.ts`. The old xox host harness pillars are deleted:

- `host-profile/xox-agent-run-profile.ts`
- `host-profile/xox-provider-runtime.ts`
- `host-profile/xox-final-review-policy.ts`
- `host-profile/xox-goal-facts.ts`
- `agentic-os/xox-goal-store-adapter.ts`
- `agentic-os/xox-run-worker-adapter.ts`
- `tests/provider-runtime.test.ts`

This cut also removed xox-local memory lifecycle orchestration, local progressive tool runtime projection, and local goal/obligation context fields. xox now keeps tool definitions, business execution, context/prompt assets, provider settings, memory store/Memory Center display, sandbox bundles, SQL/SSE adapters, and product DTO projection. Agent loop, provider execution/recovery, final review, goal/readiness, memory lifecycle, and tool-surface runtime are Agentic OS responsibilities.

Current correction: `xox-run-event-store-adapter.ts` must remain a pure event store/stream adapter. A temporary goal/evaluation/final-review projection expansion was removed; reusable final review completion behavior now belongs in `@agentic-os/server`. The follow-up three-file audit also removed `xox-action-graph-adapter.ts` hard-coded business-tool de-dupe, removed `xox-host-profile.ts` tool-name-driven provider stable mode, and shifted `xox-run-worker-adapter.ts` partial-output fail-closed classification back to Agentic OS durable queue recovery.

Current M186 cut:

- `@agentic-os/runtime-openai-agents` now exposes `createOpenAISaaSHostComputer()`, so `xox-host-profile.ts` no longer imports or directly composes `createOpenAISaaSHostRuntimeAdapter()` with `createAgentServerSaaSHostComputer()`.
- `@agentic-os/server` now exposes `createAgentServerSaaSDurableRunHostRegistry()` and SaaS completion/recovery projection facades, so `xox-run-store-adapter.ts` no longer imports `createAgentServerDurableRunCoordinatorRegistry()`, `projectAgentServerQueuedRunCompletion()`, `projectAgentServerRunRecoveryFailClosedInterruption()`, or `hasAgentServerRunPartialOutput()`.
- `@agentic-os/server` now exposes stable SaaS business-tool and tenant-memory runtime objects, so `tool-executor.ts` no longer calls one-off planner/memory helper functions.
- `@agentic-os/sandbox` now exposes `createAgenticSandboxSaaSPeripheral()` and an aggregate action executor object, so xox no longer calls direct sandbox peripheral/aggregate execution functions.
- Architecture tests now guard these low-level helper names from returning to `apps/api/src/agent`.

Still open after M186: xox still owns business tool handlers, business write execution, SQL run/action/message stores, route transport, provider settings, prompts, workspace bundles, Memory Center DTOs, and product display projection. These are host peripherals, not harness loop ownership. The remaining cleanup target is size and naming, not visible local loop ownership.

Current M185 cut:

- `@agentic-os/server` now exposes `createAgentServerSaaSDurableRunHost()`, so xox no longer exports `runXoxSubmittedRun()`, `startXoxReadyRuns()`, `requestXoxRunQueueDrain()`, or `startXoxRunQueue()`.
- `apps/api/src/agent/agentic-os/xox-run-worker-adapter.ts` has been deleted. The remaining host code is `xox-run-store-adapter.ts`, which supplies SQL row loading/effects and consumes the Agentic OS durable run host facade.
- `@agentic-os/server` now exposes `createAgentServerSaaSToolDefinition()`, so `xox-host-profile.ts` no longer imports `inferToolAuthorityClass()` or locally computes tool authority classes.
- Architecture tests now assert the worker file stays deleted and that old worker lifecycle function names do not return to `apps/api/src/agent`.

Still open after M185: `xox-run-store-adapter.ts` still contains SQL recovery/loading/effect callbacks; `tool-executor.ts` / `tool-policy.ts` still expose sandbox aggregate execution and memory tool wiring. These should be cut next only through stronger Agentic OS APIs, not by moving code into another xox file.

Current M184 cut:

- `@agentic-os/server` now exposes `createAgentServerSaaSHostComputer()`, so `xox-host-profile.ts` no longer directly calls `createAgentServerSaaSHostExecutionPorts()`, `createAgentServerSaaSRuntimeEventHandlers()`, or `createAgentServerSaaSHostProfile()`.
- `@agentic-os/runtime-openai-agents` now exposes `createOpenAISaaSHostRuntimeAdapter()`, so xox no longer imports the lower-level `createOpenAISaaSRuntimeAdapter()` symbol.
- `@agentic-os/server` now exposes `createAgentServerDurableRunCoordinatorRegistry()`, so `xox-run-worker-adapter.ts` no longer directly creates `createAgentServerDurableRunWorker()` or exports `completeAgentRun()` / `recoverRunningAgentRuns()` / `scheduleAgentRunQueueDrain()`.
- `@agentic-os/server` now exposes `createAgentServerSaaSTenantMemoryRepository()`, so `memory.ts` no longer imports capture runtime, ranking, search, get, promote, or archive projector primitives directly. The xox active-memory profile function was removed.
- `@agentic-os/sandbox` now exposes `runAgenticSandboxSaaSPeripheralRead()`, so `sandbox-service.ts` no longer imports direct peripheral read, SaaS host tool peripheral, or aggregate action draft primitives.
- `@agentic-os/server` now exposes `planAgentServerSaaSBusinessToolStep()` and `agentServerSaaSTenantMemoryToolHandlers()`, so `tool-executor.ts` no longer constructs local SaaS business tool planner or explicit `create*TenantMemoryToolHandlers()` objects.
- Architecture tests now guard these deleted CPU-level symbols from returning to `apps/api/src/agent`.

Still open after M184: xox still owns business tool handlers, business write execution, SQL run/action/message stores, route transport, provider settings, prompts, workspace bundles, Memory Center DTOs, and product display projection. These are host peripherals, not harness loop ownership.

Current M183 cut:

- `@agentic-os/server` now exposes `createAgentServerSaaSBusinessToolPlanner()`, so `tool-executor.ts` no longer constructs a local SaaS tool-result port or local empty-result fallback planner.
- `@agentic-os/server` now exposes `createAgentServerSaaSTenantMemoryToolHandlers()`, so `tool-executor.ts` no longer repeats memory search/get/remember product copy or calls the lower-level tenant memory tool handler directly.
- `@agentic-os/sandbox` now exposes `createAgenticSandboxAggregateActionDraft()`, so `sandbox-service.ts` no longer serializes nested sandbox actions or constructs aggregate confirmation details/payloads locally.
- Architecture tests now guard `createAgentServerSaaSHostToolResultPort`, `createAgentServerTenantMemoryToolHandlers`, `serializableNestedAction`, `nestedActions: actions.map`, and `details: actions.map` from returning to `apps/api/src/agent`.

M183 left `xox-host-profile.ts`, `xox-run-worker-adapter.ts`, and `memory.ts` with CPU-shaped assembly seams. M184 removes those visible low-level seams by raising the Agentic OS API boundary.

Current M182 cut:

- `@agentic-os/core` now owns locale-aware SaaS defaults for generic tool-result runtime observations: clarification, account-boundary notice, UI navigation read, read statuses, and empty-result failure projection.
- `@agentic-os/server` now exposes `createAgentServerSaaSHostToolResultPort()`, so `tool-executor.ts` no longer configures `clarificationTitle`, `accountForbiddenTitle`, `emptyResultTitle`, `readStatus`, or the low-level `createAgentServerHostToolResultPort()`.
- `@agentic-os/sandbox` now exposes `createAgenticSandboxSaaSHostToolPeripheral()`, so `sandbox-service.ts` no longer passes a low-level `resultRuntime` block or repeats generic tool-result copy/status semantics.
- xox now keeps only the route encoder `xoxNavigationFromTabs()`, business tool handlers, sandbox bundle/policy, and product DTO projection for this slice.
- Architecture tests now guard `clarificationTitle`, `accountForbiddenTitle`, `emptyResultTitle`, `emptyResultMessage`, `readStatus:`, `resultRuntime:`, `createAgentServerHostToolResultPort`, and `createAgenticSandboxHostToolPeripheral` from returning to `apps/api/src/agent`.

Current M181 cut:

- `@agentic-os/server` now exposes `createAgentServerSaaSHostExecutionPorts()`, so xox no longer hand-builds `AgentActionPort`, `AgentSandboxPort`, or tool read executor wiring inside `xox-host-profile.ts`.
- `@agentic-os/server` now exposes `createAgentServerSaaSRuntimeEventHandlers()`, so xox no longer converts OpenAI-compatible planning recovery events, runtime stream events, or model-planning run events inside HostProfile.
- `xox-host-profile.ts` no longer contains `xoxRuntimePort()`, local action audit/result envelope construction, direct sandbox observation parsing, or the expanded active-memory recall block.
- Confirmed xox business action execution moved to the real business tool/action peripheral in `tool-executor.ts`; active memory store wiring moved to the memory peripheral in `memory.ts`.
- Architecture tests now guard against `xoxRuntimePort`, `AgentActionPort`, `AgentSandboxPort`, direct runtime recovery projection helpers, direct sandbox observation parsing helpers, and `executeAgentActionRequest` returning to HostProfile.

Current M180 cut:

- `routes.ts` no longer directly constructs generic action execution failure lifecycle events; it consumes `@agentic-os/server` `projectAgentServerActionExecutionFailure()`.
- `xox-run-worker-adapter.ts` no longer sequences generic run interruption effects locally; it consumes `applyAgentServerRunInterruptionProjection()` and only supplies SQL/message/event/signal effects.
- `tool-executor.ts` and `tool-policy.ts` no longer own confirmed sandbox aggregate nested-action execution/validation loops; they consume `@agentic-os/sandbox` `executeAgenticSandboxAggregateAction()`.
- `memory.ts` no longer owns memory promote/archive lifecycle decisions; it consumes `projectAgentServerTenantMemoryPromotion()` and `projectAgentServerTenantMemoryArchive()`.
- `xox-host-profile.ts` no longer owns `hostToolResults`, local runtime user-content helper, local runtime stream source helper, or direct runtime recovery/model-planning event construction.

Current M179 cut:

- `routes.ts` no longer directly constructs generic action cancel/update lifecycle events; it consumes `@agentic-os/server` `projectAgentServerActionCancellation()` / `projectAgentServerActionUpdate()` and only persists xox SQL rows plus DTO responses.
- `xox-run-worker-adapter.ts` no longer composes `createAgentServerRunWorker()` with `createDurableRunQueuePort()` or formats recovery fail-closed messages locally; it consumes `createAgentServerDurableRunWorker()` and `projectAgentServerRunRecoveryFailClosedInterruption()`.
- `tool-executor.ts` no longer owns `memory.remember` parsing/copy; `memory.search`, `memory.get`, and `memory.remember` all go through `createAgentServerTenantMemoryToolHandlers()`.
- `sandbox-service.ts` consumes `@agentic-os/sandbox` `createAgenticSandboxHostToolPeripheral()` for nested tool runtime and aggregate action wiring, while xox keeps only bundle/manifest/SDK allowlist/product DTOs.
- `xox-host-profile.ts` no longer reinterprets OpenAI Agents runtime events through `appendOpenAIAgentsRuntimeEvent()`; it persists the Agentic OS/runtime draft directly.

Current M178 cut:

- `xox-host-profile.ts` no longer manually builds `createAgentServerSaaSHostAdapter()` + `createAgentServerSaaSRunPlane()` or calls `resumeAgentServerRun()` / `confirmAgentServerActionAndResume()`; it now creates a HostProfile and gives execution to `@agentic-os/server` `runAgentServerSaaSProfileRun()` / `confirmAgentServerSaaSProfileActionAndResume()`.
- `sandbox-service.ts` no longer directly calls low-level sandbox loop/projection helpers; it consumes `@agentic-os/sandbox` `runAgenticSandboxPeripheralRead()`, while keeping workspace bundle, manifest, business SDK policy and localized read DTOs.
- `memory.ts` no longer directly constructs the core memory capture runtime; it consumes `@agentic-os/server` `createAgentServerTenantMemoryCaptureRuntime()` plus tenant memory ranking/search/get projection APIs while keeping SQL row access and Memory Center DTOs.
- `xox-action-graph-adapter.ts` no longer owns generic planned-item materialization from host read/action DTOs; it consumes `@agentic-os/server` `projectAgentServerHostPlannedItems()` and keeps only durable row writes and localized event persistence.
- `xox-run-worker-adapter.ts` no longer calls direct failure/cancellation projection helpers or keeps `failInterruptedAgentRun`; it applies `@agentic-os/server` `projectAgentServerInterruptedRunCompletion()` / `projectAgentServerQueuedRunCompletion()` to SQL rows.
- `tool-executor.ts` no longer owns `answerWorkspaceDataQuestion()`; it routes `data.query_workspace` to the ordinary workspace business read tool `planWorkspaceDataQueryRead()` in `workspace-action-drafts.ts`.
- Architecture tests now guard these deleted host-side responsibilities from returning.

Current M174-M176 background:

- `xox-host-profile.ts` no longer imports low-level provider runner functions. It wires `createOpenAICompatiblePlanningRuntimeAdapter()` and `createOpenAIAgentsRuntimeAdapter()` as Agentic OS runtime adapters, leaving provider turn execution to Agentic OS packages.
- `xox-host-profile.ts` no longer imports `createAgentHostAdapterFromProfile`; it returns a server SaaS HostProfile and lets `createAgentServerSaaSHostAdapter()` build the actual harness adapter.
- `xox-planned-items.ts`, `xox-action-graph-adapter.ts`, and `sandbox-service.ts` no longer call xox-local or low-level core outcome classifiers. Host observations now pass through `canonicalObservationFromHostToolObservation()`, and empty-result tool-supervisor projections use `buildToolSupervisorEmptyResultHostProjection()`.
- `xox-run-worker-adapter.ts` no longer owns partial-output recovery predicates or fail-closed recovery messages. It consumes `hasAgentServerRunPartialOutput()` and `agentServerRunRecoveryFailClosedMessage()` from `@agentic-os/server`.
- `xox-thread-store-adapter.ts` no longer queries or serializes `agent_goals` / `agent_evaluations`; legacy DTO fields remain as empty compatibility arrays until Agentic OS provides any future canonical projection.
- `xox-thread-store-adapter.ts` no longer owns generic transcript/timeline/node projection; it calls `projectAgentServerLegacyTranscriptViews()` and only supplies product copy/action/navigation mapping.
- `xox-run-worker-adapter.ts` no longer writes `agent_goals` or pushes `goal_status` lifecycle values; `xox-run-submission-adapter.ts` initializes legacy `goal_status` as `null`.
- `memory.ts` no longer exposes `runMemorySearchTool()` / `runMemoryGetTool()`; `tool-executor.ts` uses `createAgentMemoryToolRuntime()` from `@agentic-os/core`, while xox keeps tenant memory repository and Memory Center DTOs.
- `sandbox-service.ts` no longer owns generic sandbox proof/hash/model-readable/status helpers, structured nested tool-call projection, nested tool runtime bridge, or aggregate action loop. Those are now `@agentic-os/sandbox` helpers; xox keeps workspace bundle construction, business SDK policy predicates, and localized aggregate action copy.
- `tool-catalog.ts` no longer exposes `final_answer_extract_claims` as a xox provider tool. Final-answer claim extraction is a server harness concern.

Current validation: `npm run build -w @agentic-os/server`, `npm run build -w @agentic-os/sandbox`, `npm run test -w @agentic-os/server`, and `npm run test -w @agentic-os/sandbox` pass in `agentic-os`. `npm run build:api` and `npx vitest run tests/agent-architecture.test.ts tests/action-observation.test.ts tests/sandbox-tool.test.ts` pass in `xox-model/apps/api`. Full `npx vitest run tests/api.test.ts` was last rerun in M174 and still reported 62 passed / 27 failed; the failures remain broad legacy parity expectations around navigation projection, old goal/evaluation/status events, provider failure plan-step shapes, memory recall signals, redundant action de-duplication, and complex-goal pacing. They must be fixed by product projection adapters or Agentic OS-owned reusable projection/runtime behavior, not by restoring local xox harness code.

See [M184 Host CPU Amputation](m184-host-cpu-amputation.md) for the current boundary. See [M183 Five File CPU Amputation](m183-five-file-cpu-amputation.md) and [M182 Tool Result Runtime Amputation](m182-tool-result-runtime-amputation.md) for previous boundary notes and validation evidence.

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
- final answer claim DTO, generic claim-to-evidence-requirement projection, and server-owned claim extraction runtime;
- final answer hygiene for provider protocol artifacts;
- obligation plan aggregation and runner-obligation instruction;
- runtime adapter contract testing;
- provider plain-text tool-call recovery, bounded provider tool-call repair primitives, and provider tool-call normalization/boundary validation;
- provider tool schema normalization and OpenAI-compatible request payload sanitation;
- provider runtime capability, thinking profile, request patch, replay policy, and transcript replay primitives;
- provider tool-call stream assembly and frame damage primitives;
- provider boundary failure observation payloads;
- provider observation turn message assembly for protocol-native assistant/tool replay in planning, repair, and continuation turns;
- host observation bridge for canonical `AgentObservation` to host observation DTO mapping, fallback recovery, and stable merge/dedupe;
- tool observation outcome classification for provider boundary, sandbox execution, action preview, and action result observations;
- tool observation facts parsing and role helpers for action, sandbox, provider boundary, tool supervisor failure, discovery, and clarification observations;
- action observation envelope builders for action preview, executed result, failed result, and policy-blocked result observations;
- tool observation continuation/finalizer prompt template for turning observation replay into safe user-facing answers;
- secret-like content safety helpers for redaction, detection, and bounded text normalization;
- manifest-scoped sandbox runtime for backend selection, policy validation, process execution, staged helper SDKs, tool RPC files, result parsing, and artifact collection;
- provider runtime stream trace projection from runtime stream facts to durable run event drafts;
- AG-UI event projection from run/plan/action facts to streamable UI events;
- host profile and host kit composition.

Agentic OS packages should be consumed as versioned `@agentic-os/*` packages:

```json
"@agentic-os/contracts": "^0.1.0",
"@agentic-os/core": "^0.1.0",
"@agentic-os/runtime-openai-compatible": "^0.1.0",
"@agentic-os/sandbox": "^0.1.0",
"@agentic-os/testing": "^0.1.0"
```

Exact versions should be pinned or ranged according to the release policy chosen for the first Agentic OS package release. The integration branch should not depend on copied source files or permanent `file:` references.

`xox-model` should continue to own product and domain concerns:

- financial model business rules;
- xox DB schema and migrations;
- API DTOs and routes;
- workspace/user authorization;
- action graph business semantics;
- memory store, Memory Center DTOs, and domain-specific memory candidate plugins;
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
- The normal xox agent kernel now enters `apps/api/src/agent/host-profile/xox-agent-run-profile.ts`.
- The host kit calls Agentic OS `createAgentHostKit` and uses the Agentic OS loop as the production harness loop.
- xox still owns product/domain behavior, action graph durable/product projection adapters, memory store and Memory Center DTOs, sandbox workspace bundles, provider settings, final-response evidence classification, localized copy, and DTO projection through Agentic OS ports.
- xox root `apps/api/src/agent/evidence-ledger.ts`, `apps/api/src/agent/response-evaluator.ts`, `apps/api/src/agent/loop-obligations.ts`, and `apps/api/src/agent/loop-obligation-ledger.ts` have been deleted. The remaining final-review code at the HostProfile boundary is limited to xox evidence classification, subject narrowing, metadata mapping, localized copy, and legacy DTO projection.
- xox final review now consumes `@agentic-os/server` `reviewAgentServerFinalResponse()` for the final-response evidence gate. `@agentic-os/core` still owns final-answer hygiene, evidence requirement projection, obligation plan aggregation, materialization planning, review-obligation projection, and additional repair state projection; xox keeps only evidence classification, metadata mapping, localized copy, business materializers, and legacy DTO projection.
- M165 moves final-response review cycle orchestration into `@agentic-os/server` `runAgentServerFinalResponseReviewCycle()`. `host-profile/xox-agent-run-profile.ts` no longer imports `decideAgentServerFinalAnswerClaimReview()` or `shouldMaterializeAgentServerFinalResponseObligations()`, and no longer hand-emits `final_answer_candidate` / `agentic_os.final_reviewed` events. xox only supplies evidence snapshots, review/copy callbacks, obligation materializer callback, and DB event sink.
- M166 removes text-enum harness heuristics from `host-profile/xox-agent-run-profile.ts`: objective keyword guessing for forecast/write/sandbox behavior, pause metadata inferred from punctuation, fixed runner-local entity summary arguments, duplicated observation-scope final text rendering, plan-row copy `includes(...)` checks for account/provider branches, host-side prerequisite/observation-continuation/missing-observation runners, and worker-owned direct-answer/turn-lane execution. Direct-answer remains an Agentic OS-owned harness capability; xox keeps `xox-turn-lane-policy.md` and `xox-direct-answer-policy.md` only as HostPolicy prompt assets. xox worker now consumes `@agentic-os/server` run completion projection from `AgentRunResult.status` instead of deriving run failure/completion from goal status or action-count message branches.
- xox `apps/api/src/agent/obligation-materializer.ts` has been deleted. `@agentic-os/core` owns `planObligationMaterialization()` for active obligation task filtering, stable de-duplication, and generic event payloads; xox now keeps the `domain_fact -> data_query_workspace` read wiring private inside the real host adapter.
- xox final review response now consumes `@agentic-os/core` `ledgerToReviewObligations()` for active ledger obligation to completion repair obligation projection.
- xox final review response event now consumes `@agentic-os/core` `projectObligationLedgerWithAdditionalObligations()` for non-mutating additional obligation merge, runner identity de-duplication, and status counts. The deleted `agentic-os/xox-agentic-os-host-kit.ts` facade must not return.
- xox runtime-boundary missing-observation repair now consumes `@agentic-os/core` `projectObligationStateWithAdditionalObligations()` for non-mutating additional repair obligation ledger + plan projection. The HostProfile run wiring no longer owns the `runtime_boundary_sandbox_calculation` object graph.
- xox tool supervisor failure fallback now consumes `@agentic-os/core` `buildToolSupervisorEmptyResultFailureObservation()`; xox keeps only `ReadDraft` / `AgentToolObservation` DTO adapters, localized copy, and action graph persistence. The HostProfile run wiring no longer hand-writes `tool_supervisor_failure` JSON payloads.
- xox structured evidence key matching now consumes `@agentic-os/core` `evidenceFactsContainKey()`; local `apps/api/src/agent/structured-evidence-utils.ts` has been deleted, while xox keeps only financial/shareholder subject and evidence-classification adapters.
- xox readiness domain observation collection no longer has a standalone adapter. `agentic-os/xox-loop-readiness-adapter.ts` and local `apps/api/src/agent/observation-collector.ts` have both been deleted; xox domain finding generation and goal/evaluation row persistence now sit in the concrete `agentic-os/xox-goal-store-adapter.ts` peripheral, while readiness priority still comes from Agentic OS core.
- xox prerequisite observation selection now consumes `@agentic-os/core` `selectAgentPrerequisiteObservations()`; local `apps/api/src/agent/prerequisite-observations.ts` has been deleted, while xox keeps the `entity_summary` reader wiring, Chinese copy, and action graph persistence.
- xox tool discovery and manifest search observations now consume `@agentic-os/core` `buildToolSurfaceDiscoveryObservation()` / `buildToolSurfaceManifestSearchObservation()`; local `apps/api/src/agent/tool-discovery-tool.ts` has been deleted, while xox keeps only the tool manifest adapter and Chinese `ReadDraft` wrapper.
- xox content safety now consumes `@agentic-os/core` `redactSecretLikeContent()` / `containsSecretLikeContent()` / `normalizeSecretSafeText()`; local `apps/api/src/agent/memory-safety.ts` has been deleted. M168 then moves candidate policy, recall ranking, prompt lane budgets, query hashing, flush planning, citations, MMR retrieval, and promotion scoring into `@agentic-os/core`; xox keeps memory SQL storage, Memory Center DTO projection, business candidate text, sandbox result adapters, provider settings, and product DTO projection.
- xox sandbox runtime now consumes `@agentic-os/sandbox` `SandboxBroker` and package-owned sandbox backend/runtime types. Local `apps/api/src/agent/sandbox/*` backend, broker, policy, process runner, staged IO helper, tool RPC file bridge and result parser files have been deleted. xox keeps `sandbox-service.ts` for workspace data bundles, exposed business SDK entries, nested action aggregation, Chinese `ReadDraft` projection, and uploaded-file policy; the old `sandbox-file-adapters.ts` helper has also been deleted.
- xox provider stream trace projection now consumes `@agentic-os/server` `addAgentServerRuntimeStreamRunEvent()` / `projectAgentServerRuntimeStreamRunEvent()` through `apps/api/src/agent/agentic-os/xox-run-event-store-adapter.ts`. Local `apps/api/src/agent/runtime-trace-events.ts` and root `apps/api/src/agent/run-events.ts` have been deleted; xox keeps durable event SQL, thread signal publication, localized Chinese copy, and redaction hook placement behind the host adapter boundary.
- xox OpenAI-compatible host sidecar has been deleted. Local `apps/api/src/agent/runtime/openai-compatible-chat-adapter.ts` no longer exists; M132 also removed the last `apps/api/src/agent/runtime/runtime-adapter.ts` file. The remaining xox provider-selection adapter is `apps/api/src/agent/host-profile/xox-provider-runtime.ts`, which calls `@agentic-os/runtime-openai-compatible` `runOpenAICompatibleRuntimeTurn()` directly and keeps only settings/prompt/event source mapping plus normalized provider call -> xox planner-step mapping.
- xox AG-UI event projection now consumes `@agentic-os/server` `projectAgentServerAgUiEvents()` from submitted-run and thread-state views. Local `apps/api/src/agent/ag-ui-projection.ts` has been deleted; xox keeps only `eventNamePrefix: 'xox'`, DTO compatibility, product transcript/timeline nodes, Chinese copy and navigation mapping.
- xox final-answer claim extraction now consumes `@agentic-os/server` `runAgentServerFinalAnswerClaimExtraction()`. Local `apps/api/src/agent/final-answer-claim-extractor.ts` has been deleted; xox keeps only subject taxonomy, evidence projection, `planWithRuntimeAdapter` provider callback, claim type narrowing, Chinese run-event copy, and financial/shareholder subject defaults.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `detectProviderPlainTextToolCallArtifact()` and `recoverProviderPlainTextToolCalls()` for provider plain-text tool-call recovery; the local `provider-plain-text-tool-calls.ts` duplicate has been removed.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `extractBalancedJson()`, `parseToolArgumentsWithRepair()`, `repairToolName()`, and `normalizeProviderToolCallsForExecution()` for provider-frame JSON extraction, bounded streamed argument repair, inventory-bound tool-name repair, effective-inventory/deferred boundary validation, and normalized provider tool-call output; local `balanced-json.ts`, `tool-call-argument-repair.ts`, `tool-call-name-normalizer.ts`, and `tool-call-repair.ts` duplicates/facades have been removed. The remaining normalized provider call -> xox planner-step mapping is private inside `host-profile/xox-provider-runtime.ts` because it depends on xox `toolCallToPlannerStep()`.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `classifyProviderHttpError()`, `safeProviderErrorMessage()`, `providerRejectsToolChoice()`, and `runOpenAICompatibleRuntimePlanningRecovery()` for provider HTTP taxonomy, safe error redaction, `tool_choice` rejection detection, deferred materialization retry, recoverable same-turn retry, retry request shaping, retry patch application, and missing-observation evidence recovery; local `provider-error-classifier.ts`, `provider-failover-policy.ts`, and `high-volume-tool-policy.ts` have been removed. xox keeps high-volume tool budgets, tool catalog materialization, evidence requirement persistence, and Chinese retry run-event copy only as private host callbacks in the HostProfile provider boundary `host-profile/xox-provider-runtime.ts`.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `resolveProviderModelRef()` and `resolveProviderModelProfile()` for canonical provider/model refs and protocol profile facts; local `provider-model-ref.ts` and `provider-model-profile.ts` have been removed.
- xox provider request shaping now consumes `@agentic-os/runtime-openai-compatible` `shapeOpenAICompatibleChatRequest()` for provider request bodies, plus `normalizeProviderToolSchemas()` and `sanitizeOpenAICompatibleRequestBody()` through that shaper for provider-facing tool schema compatibility and OpenAI-compatible request body sanitation; local `provider-tool-schema.ts`, `provider-payload-sanitizer.ts`, and `provider-request-shaper.ts` have been removed. `host-profile/xox-provider-runtime.ts` only maps xox settings, prompt/context/messages/tools and stream flags into the runtime package shaper.
- xox provider settings probe now consumes `@agentic-os/runtime-openai-compatible` `probeOpenAICompatibleProvider()` directly from `provider-settings.ts`; local `runtime/provider-probe.ts` has been removed. xox keeps provider settings/key source, the `xox_provider_probe` tool name, and Chinese product check copy in the settings module.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `resolveProviderRuntimeProfile()`, `resolveProviderRuntimeCapability()`, `resolveRuntimeThinkingLevel()`, `replayPolicyPreservedMessageKeys()`, `sanitizeProviderReplayMessages()`, `providerToolObservationReplayMessages()`, and `buildProviderToolObservationTurnMessages()` for provider family capability, thinking normalization, request patching, replay policy, assistant field backfill, low-level observation replay, and full observation-bearing provider turn message assembly; local `provider-capability.ts`, `provider-capability-registry.ts`, `provider-families/*`, and `provider-transcript-replay.ts` have been removed.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `ProviderToolCallStreamAssembler` for streamed `delta.tool_calls` accumulation, ordered OpenAI-compatible tool call output, and provider-neutral frame damage facts; local `tool-call-stream-assembler.ts` has been removed.
- xox OpenAI Agents route now consumes `@agentic-os/runtime-openai-agents` directly from `host-profile/xox-provider-runtime.ts`; local `runtime/openai-agents-adapter.ts` and `runtime/runtime-adapter.ts` have been removed. Agentic OS owns OpenAI Agents SDK lifecycle, provider cleanup, SDK tool-call capture, runtime events, and SDK error redaction; xox keeps only provider settings, prompt compatibility, xox tool metadata fill, canonical tool call -> planner-step mapping, and localized event DTO mapping at the real provider selection boundary.
- xox OpenAI-compatible route now consumes `@agentic-os/runtime-openai-compatible` `runOpenAICompatibleRuntimeTurn()` from `host-profile/xox-provider-runtime.ts`; Agentic OS owns request shaping, transport, stream parsing, provider turn normalization, tool-call normalization, provider artifact, and replay assistant message. xox adapter keeps only settings/prompt input mapping, localized event source bridging, and normalized provider call -> xox planner-step mapping.
- xox root `runtime-planning-call.ts` and `agentic-os/xox-runtime-planning-adapter.ts` have both been removed. `host-profile/xox-provider-runtime.ts` consumes `@agentic-os/runtime-openai-compatible` `runOpenAICompatibleRuntimePlanningRecovery()`; Agentic OS owns first/deferred/retry/missing-observation same-turn recovery orchestration. xox keeps only high-volume business budgets, tool catalog materialization callback, localized run events, evidence requirement callback, and `RuntimePlanResult` projection at the concrete provider/runtime boundary.
- xox `planner.ts`, `planning-session.ts`, and `agent-kernel.ts` have been removed. The old host planner/session/kernel layer had no reason to survive after the Agentic OS host-kit cutover; keeping it would preserve a false second harness. xox production planning now enters through `agentic-os/xox-run-worker-adapter.ts`, which only performs queue/lease/storage wiring and submits the user message to the Agentic OS run profile.
- xox root `data-agent.ts`, `planning-context.ts`, `runtime-intent-handlers.ts`, and `action-draft-builder.ts` have been removed. `data.query_workspace` business read execution now lives in `tool-executor.ts`, the concrete xox business tool boundary, and `PlannerContext` / xox planned-item DTOs now live under `host-profile/xox-planned-items.ts`. These are still xox peripherals; the deletion removes misleading root agent facade filenames.
- M148 hardened that cut, and M156 moved the handler after deleting the runtime facade: `data_query_workspace` scope and metric enums now have a single source in `tool-catalog.ts`; `tool-executor.ts` consumes exported manifest constants and type guards instead of carrying duplicated hard-coded enum lists.
- M149 directly deletes xox's local transcript/timeline projection engines: `agentic-os/xox-thread-transcript-adapter.ts`, `agentic-os/xox-thread-timeline-adapter.ts`, and `tests/agent-transcript.test.ts`. M160 then deletes the standalone `agentic-os/xox-thread-state-view.ts` facade; xox consumes Agentic OS projection facts from the concrete thread store/submission adapters and keeps only legacy DTO compatibility mapping there. Provider/action merge, grouping, visibility, and transcript tree algorithms must not return downstream.
- M150 directly deletes xox's local final-review/obligation harness test surface: `tests/response-evaluator.test.ts` and `tests/loop-obligation-ledger.test.ts`. `host-profile/xox-final-review-policy.ts` no longer exposes old public harness helpers such as `planLoopObligations()`, `activeLedgerObligations()`, `canAttemptFinalAnswer()`, or `serializeObligationLedger()`.
- M151 directly deletes single-entry helper files under `apps/api/src/agent`: `config-patch.ts`, `provider-key-codec.ts`, `tool-coverage.ts`, `sandbox-file-adapters.ts`, and the remaining `memory/*` helper files. Their surviving host peripheral logic now lives in `action-draft-utils.ts`, `provider-settings.ts`, `tool-catalog.ts`, `sandbox-service.ts`, and `memory.ts`.
- xox `turn-intake-resolver.ts` and `agentic-os/xox-turn-intake-adapter.ts` have both been removed. The xox worker no longer calls `resolveAgentTurnIntake()` or owns `turn_lane_resolve`; `xox-turn-lane-policy.md` remains only as host policy text for Agentic OS-owned intake.
- xox `direct-answer-runtime.ts` and `agentic-os/xox-direct-answer-adapter.ts` have both been removed. The xox worker no longer calls `runDirectAnswerLane()` or owns `executeXoxDirectAnswerLane()`; `xox-direct-answer-policy.md` remains only as host policy text for Agentic OS-owned direct answer.
- xox worker terminal completion/failure/cancellation projection now consumes `@agentic-os/server` `projectAgentServerRunCompletion()`. Agentic OS owns durable status projection, run terminal event/signal, and optional assistant terminal message; xox only persists those facts through its SQL/thread adapters.
- xox ambient session context now stays out of the worker control flow. Local `apps/api/src/agent/ambient-context.ts` has been deleted; ambient facts belong to Agentic OS-owned intake/direct-answer/runtime context assembly rather than a downstream worker lane.
- xox `clarification-resume.ts` and `agentic-os/xox-clarification-resume-adapter.ts` have both been removed. Clarification resume scaffold assembly comes from `@agentic-os/core`; xox `agentic-os/xox-goal-store-adapter.ts` only loads prior goal/evaluation/action rows, maps xox action kinds to capabilities, and supplies localized copy plus redaction.
- xox `loop-readiness-check.ts` and `agentic-os/xox-loop-readiness-adapter.ts` have both been removed. Readiness status priority now comes from `@agentic-os/core` `decideAgentReadiness()`; xox `agentic-os/xox-goal-store-adapter.ts` only loads DB rows, produces xox domain findings, supplies localized copy, and persists xox goal status.
- xox `runtime-plan-reader.ts` has been deleted, and M170 removes the remaining `RuntimePlanResult` / provider-error-to-read-draft DTO bridge from `host-profile/xox-planned-items.ts`. Provider boundary repair and failure observation semantics belong to Agentic OS runtime/server packages; xox keeps only business action/read DTOs.
- xox tool observation outcome classification now consumes `@agentic-os/core` `classifyToolObservationOutcome()` and related helpers. `apps/api/src/agent/tool-observation-outcome.ts` has been removed; provider boundary, sandbox execution, action preview, and action result outcome branches are no longer maintained in xox.
- xox action observation payloads now consume `@agentic-os/core` `buildActionPreviewObservation()` and `buildActionResultObservation()`. Root `apps/api/src/agent/tool-observation-continuation.ts` and the standalone `apps/api/src/agent/agentic-os/xox-tool-observation-adapter.ts` facade have both been removed. `apps/api/src/agent/agentic-os/xox-action-graph-adapter.ts` keeps only action row mapping, details parsing, localized copy, business result summaries, and durable persistence at the concrete action graph boundary; it no longer hand-writes `action_preview` or `action_result` model payloads.
- xox observation loop role checks now consume `@agentic-os/core` `parseToolObservationModelFacts()` and `is*ToolObservation()` helpers. `apps/api/src/agent/host-profile/xox-agent-run-profile.ts` still owns xox readable text and business finalization policy, but no longer directly parses `observation.modelContent` for action/sandbox/provider boundary/tool supervisor/tool discovery/clarification semantics; `tool-runtime/tool-loop-guardrails.ts` also uses core helpers for completed action-result detection.
- xox tool observation continuation/finalizer system prompt now consumes `@agentic-os/core` `toolObservationContinuationSystemPrompt()`. `apps/api/src/agent/prompt-registry.ts` has been deleted; concrete adapters load their xox prompt assets directly and only inject platform identity, agent name, and provider identity rules at the consuming boundary.
- xox provider observation turn message assembly now consumes `@agentic-os/runtime-openai-compatible` `buildProviderToolObservationTurnMessages()` for planning turns and `buildProviderToolObservationContinuationMessages()` for finalizer/continuation turns. `apps/api/src/agent/host-profile/xox-provider-runtime.ts` builds xox context/tool catalog/budget inputs, while `apps/api/src/agent/host-profile/xox-agent-run-profile.ts` now calls `@agentic-os/server` `runAgentServerObservationContinuation()` for finalizer/continuation lifecycle. No xox file hand-assembles OpenAI-compatible assistant `tool_calls` and matching `tool` replay messages.
- M170 deletes the remaining xox progressive tool surface file `apps/api/src/agent/tool-surface-manifest.ts` and removes xox-visible `tool_discover` / `rg` provider tools. Agentic OS owns tool surface runtime and materialization; xox only declares business tools in `tool-catalog.ts` and generates sandbox SDK docs directly from that registry.
- M154 deletes the misleading root `apps/api/src/agent/tool-gateway.ts` facade. Runtime tool catalog projection, effective inventory snapshot creation, and `tool_catalog_ready` product event wiring now live in `apps/api/src/agent/tool-catalog.ts`, the real xox tool registry/catalog boundary. Agentic OS still owns provider execution, tool-call normalization, inventory snapshot shape, and progressive tool surface algorithms.
- xox tool loop progress guardrails now consume `@agentic-os/core` `evaluateToolLoopGuardrails()`. Local guardrail algorithm branches for repeated failures, no-progress turns, and executed-write reapply have been removed; `apps/api/src/agent/tool-runtime/tool-loop-guardrails.ts` is now only a Row/DTO adapter. Local `approval-policy-composer.ts` has also been removed; production xox code no longer calls a local `resolveActionAuthority()` or `composeAgentWriteApprovalPolicy()` wrapper.
- xox tool-call supervision and runtime event payloads now consume `@agentic-os/core` `runToolCallSupervisor()`. Agentic OS owns the sequential runner, started/completed callback order, inventory-miss fail-closed path, empty-result failure path, observation summary, and event payload facts. `apps/api/src/agent/tool-runtime/tool-call-supervisor.ts` now only maps xox planner steps/results, adapts failure copy, and persists product run events; the obsolete local `tool-runtime/tool-execution-events.ts` adapter has been deleted.
- xox action graph materialization now consumes `@agentic-os/server` `materializeAgentServerActionGraph()`. Agentic OS owns sequence cursor traversal, action/read/status/assistant/observation-only item materialization, stored action observation collection, summary, and provider-neutral event drafts. Root `apps/api/src/agent/action-graph-store.ts` has been deleted; the remaining xox durable adapter now lives at `apps/api/src/agent/agentic-os/xox-action-graph-adapter.ts` and maps `PlannedItem` values into server planned items, Kysely rows, pending action previews, navigation/product run-event copy, and `@xox/contracts` compatibility.
- M167 removes the last xox-owned auto-execution decision path. `apps/api/src/agent/tool-policy.ts` no longer exports `normalizeAgentAutomationLevel()` or `resolveActionAuthority()`, `apps/api/src/agent/tool-executor.ts` no longer exports `autoExecuteAgentActionRequest()`, and `apps/api/src/agent/agentic-os/xox-action-graph-adapter.ts` no longer decides `auto_execute` / `forbidden`. Agentic OS core owns automation normalization, write approval policy, and standard `action.*` lifecycle events; xox implements the business `actions.executeAction` port and localizes those standard events in its run-event store adapter.
- M170 deletes `host-profile/xox-context-pack.ts` and removes xox-local active memory recall from context assembly. Agentic OS owns active recall/cache/prompt lifecycle; xox retains Memory Center routes and explicit `memory_search` / `memory_get` / `memory_remember` business tool adapters in `memory.ts`.
- xox's unused local memory prompt `apps/api/src/agent/prompts/memory.system.md` has been deleted. Active-memory prompt assembly belongs to Agentic OS core; xox keeps only retrieval and persistence peripherals.
- M168 deletes the xox-local generic memory package `packages/agent-memory-core` and `apps/api/tests/agent-memory-core.test.ts`. `@agentic-os/core` now owns OpenClaw-derived memory budget, flush plan, citations, lexical/MMR retrieval, short-term promotion scoring, SaaS memory candidate policy, prompt injection eligibility, recall ranking, prompt lane budgets, and query hashing. xox `apps/api/src/agent/memory.ts` remains only a durable store / Memory Center / tool peripheral adapter plus xox business candidate plugins.
- M152 deletes the generic production `apps/api/src/agent/prompts` directory: `planner.system.md`, `turn-lane.system.md`, and `direct-answer.system.md` are gone. M153 corrects the overreach by restoring xox prompt text as host-profile assets under `apps/api/src/agent/host-profile/prompts` with product-policy names. Lane protocol and direct-answer state remain Agentic OS-owned; xox keeps business/product prompt policy as host profile content, not a reusable-looking local harness prompt framework.
- M155 deleted the misleading root `apps/api/src/agent/runtime-goal-facts.ts` file. M169 then deleted the remaining `host-profile/xox-goal-facts.ts`; xox no longer maintains a local goal-facts harness subsystem.
- M156 deletes the misleading root `apps/api/src/agent/runtime-intent-handlers.ts` facade. Provider-normalized tool step handling now lives in `apps/api/src/agent/tool-executor.ts`, because it is xox business tool execution/read wiring, not a downstream runtime intent layer.
- M141/M157 removed the root context-pack facade and lifecycle event construction. M170 finishes the cut by deleting `host-profile/xox-context-pack.ts`; host context is now plain xox facts assembled inside the HostAdapter, with no memory recall lifecycle or standalone context harness file.
- M158 deletes the misleading root `apps/api/src/agent/action-draft-builder.ts` facade. Planned-item DTOs and helper wrappers now live in `apps/api/src/agent/host-profile/xox-planned-items.ts`, and the business tool registry is named `xoxBusinessToolHandlers` instead of `runtimeIntentHandlers`.
- M159 deletes the obsolete local harness-named Agentic OS facades from `apps/api/src/agent/agentic-os`: `xox-agentic-os-host-kit.ts`, `xox-final-review-adapter.ts`, and `xox-runtime-adapter.ts`. M169/M170 then delete `xox-agent-run-profile.ts`, `xox-provider-runtime.ts`, `xox-final-review-policy.ts`, `xox-goal-facts.ts`, and `xox-context-pack.ts`; the remaining host-profile surface is `xox-host-profile.ts`, prompts, and xox business DTO helpers.
- M147 deletes the misleading xox memory root facades: `memory-events.ts`, `memory-retriever.ts`, `memory-candidate-detector.ts`, `memory-promotion-policy.ts`, and `memory-consolidator.ts`. M151 finishes that shape by deleting the remaining `memory/*` helper subdirectory. M168 removes the xox-local generic memory package as well: memory candidate policy, recall scoring, prompt injection eligibility, prompt lane budgets, query hashing, flush planning, citations, MMR retrieval, and short-term promotion scoring now live in `@agentic-os/core`. xox memory SQL row/event persistence, tenant retrieval, recall marking, xox domain candidate generation, Memory Center DTOs, memory tools, daily notes, and context flush storage remain in `memory.ts`.
- M142 is the current hard gate: [M142 One-Shot Host Harness Amputation](m142-one-shot-host-harness-amputation.md) defines the required coordinated cuts for the remaining goal/plan/memory/action/provider/evidence/projection harness residues. The root evidence/final-review/projection facades and old local tests are deleted; the milestone remains incomplete until the host-kit and remaining adapter boundaries stop reading like a local runner.
- M161 deletes the standalone `apps/api/src/agent/agentic-os/xox-tool-observation-adapter.ts` facade. The surviving `AgentToolObservation` DTO and `createHostObservationBridge()` mapping live in `host-profile/xox-planned-items.ts`, action preview/result/failure observation helpers live in `agentic-os/xox-action-graph-adapter.ts`, and provider finalizer/continuation wiring lives only at `host-profile/xox-agent-run-profile.ts` until the remaining lifecycle can move further into Agentic OS. Architecture guards now assert the old facade remains absent.
- M162 deletes the local `continueModelAfterToolObservations()` runner from `host-profile/xox-agent-run-profile.ts`. Agentic OS server now owns observation continuation lifecycle through `runAgentServerObservationContinuation()`: empty-observation skip, started/completed/failed event emission, assistant-text success classification, empty-output failure, and runtime-error redaction. xox only supplies runtime context/messages, provider callback, event sink, and failed plan-step persistence.
- xox host observation bridge now consumes `@agentic-os/core` `createHostObservationBridge()`. Agentic OS owns canonical observation id/tool-call id mapping, host fallback hook invocation, and stable merge/dedupe; `apps/api/src/agent/agentic-os/xox-observation-adapter.ts` and `apps/api/src/agent/agentic-os/xox-tool-observation-adapter.ts` have both been deleted. `host-profile/xox-agent-run-profile.ts` and `xox-action-graph-adapter.ts` no longer keep local observation maps or fallback bridge helpers.
- xox action approval execution is no longer a standalone host harness adapter. Root `apps/api/src/agent/approval-executor.ts` and `apps/api/src/agent/agentic-os/xox-action-approval-adapter.ts` have both been deleted. Confirm/cancel/edit HTTP handlers stay in `routes.ts` as transport glue; business execution and audit writes live in `tool-executor.ts`; post-confirmation resume runs through `host-profile/xox-agent-run-profile.ts` and Agentic OS `ActionRuntime` / `AgentRunEngine`.
- xox run worker lifecycle now consumes `@agentic-os/server` `createAgentServerRunScheduler()`. Agentic OS owns drain exclusivity, delayed drain, polling start/stop, active run controller claim/release, active run listing, and cancellation state. Root `apps/api/src/agent/run-worker.ts` has been deleted; remaining Kysely lease SQL, recoverable-row validation, localized fail-closed copy, business completion writes, and xox run-event persistence now live in `apps/api/src/agent/agentic-os/xox-run-worker-adapter.ts`.
- xox thread event signaling now consumes `@agentic-os/server` `AgentServerSignalBus`. Agentic OS owns topic listener mechanics, process-local sequence, unsubscribe cleanup, listener error isolation, and listener count. Root `apps/api/src/agent/thread-events.ts` and `agentic-os/xox-thread-signal-adapter.ts` have both been deleted; xox thread reason names and `{ threadId, sequence, reason }` mapping now live beside durable run-event persistence in `apps/api/src/agent/agentic-os/xox-run-event-store-adapter.ts`.
- xox signal-driven thread state stream now consumes `@agentic-os/server` `openAgentServerSignalStateStream()`. Root `apps/api/src/agent/thread-state-stream.ts` and `agentic-os/xox-thread-state-stream-adapter.ts` have both been deleted; Node HTTP/SSE headers, heartbeat, request close/abort, safe error copy, and product `AgentThreadState` loading now live in `apps/api/src/agent/routes.ts`.
- xox run lease heartbeat now consumes `@agentic-os/server` lease helpers. Agentic OS owns lease-lost error shape, lease expiry timestamp helper, heartbeat interval policy, active assertion helper, and heartbeat refresh loop. Root `apps/api/src/agent/run-lease.ts` has been deleted; Kysely claim/refresh/recovery SQL and worker-id durable facts now live in `apps/api/src/agent/agentic-os/xox-run-lease-store-adapter.ts`.
- xox run event append sequencing now consumes `@agentic-os/server` `createAgentServerSequencedRunEventAppender()`. Agentic OS owns per-run append serialization, max-sequence/next-sequence append flow, and sequence conflict retry. Root `apps/api/src/agent/run-events.ts` has been deleted; Kysely event SQL, row serialization, localized event DTO fields, legacy channel inference, and `run_trace` thread signal publication now live in `apps/api/src/agent/agentic-os/xox-run-event-store-adapter.ts`.
- xox submitted-run creation remains host product wiring, but root `apps/api/src/agent/run-submission.ts` and `agentic-os/xox-run-submission-view.ts` have both been deleted. DB row creation, queued event persistence, sync/background response selection, and xox `AgentSendResponse` projection now live in `apps/api/src/agent/agentic-os/xox-run-submission-adapter.ts`; routes keep auth/body parsing and Agentic OS server submitted-run projection is consumed at that single boundary.
- xox thread state loading remains host product wiring, but root `apps/api/src/agent/thread-store.ts`, `agentic-os/xox-agentic-os-facts.ts`, and `agentic-os/xox-thread-state-view.ts` have all been deleted. Kysely row loading, workspace/user authorization, legacy contract serialization, thread summaries, and product `AgentThreadState` projection now live in `apps/api/src/agent/agentic-os/xox-thread-store-adapter.ts`, which directly consumes Agentic OS server-owned thread projection facts.
- xox still owns financial/shareholder subject narrowing for claim extraction, including the adapter rule that unscoped entity/domain final-answer claims default to shareholder subject metadata.
- xox still owns financial/domain metadata mapping, plus `goalFacts`, `requiredDataScopes`, and `requiredMetrics`, as host context consumed by Agentic OS final-review primitives.
- xox still owns obligation materializer selection, `data_query_workspace` arguments, business read execution, and product run event persistence.
- xox still owns timeout/abort wiring, business request assembly, localized retry/status run-event copy, planning-boundary high-volume business tool policy, user/workspace provider settings, and provider tool call to xox planner-step mapping at the real adapter boundary. Provider turn execution, tool-call normalization, boundary validation, retry patching, deferred materialization orchestration, missing-observation recovery, and provider stream trace projection now belong to Agentic OS.
- Obsolete local harness helper files are intentionally removed: `agent-run-engine.ts`, `turn-resolver.ts`, `agent-action-runtime.ts`, `context-engine/index.ts`, the former top-level `agentic-os-adapter.ts`, `planner.ts`, `planning-session.ts`, `planning-context.ts`, `context-pack.ts`, `action-draft-builder.ts`, `data-agent.ts`, `runtime-intent-handlers.ts`, `turn-intake-resolver.ts`, `direct-answer-runtime.ts`, `ambient-context.ts`, `clarification-resume.ts`, `loop-readiness-check.ts`, `agentic-os/xox-loop-readiness-adapter.ts`, `agentic-os/xox-agentic-os-host-kit.ts`, `agentic-os/xox-final-review-adapter.ts`, `agentic-os/xox-runtime-adapter.ts`, `loop-obligations.ts`, `loop-obligation-ledger.ts`, `response-evaluator.ts`, `evidence-ledger.ts`, `obligation-materializer.ts`, `runtime-planning-call.ts`, `agentic-os/xox-runtime-planning-adapter.ts`, `agentic-os/xox-thread-state-view.ts`, `tool-observation-continuation.ts`, `action-graph-store.ts`, `active-memory-recall.ts`, `memory-events.ts`, `memory-retriever.ts`, `memory-candidate-detector.ts`, `memory-promotion-policy.ts`, `memory-consolidator.ts`, `memory/daily-notes.ts`, `memory/dreaming-worker.ts`, `memory/memory-backend.ts`, `memory/memory-center.ts`, `memory/memory-tools.ts`, `memory/recall-signals.ts`, `memory/active-memory-subagent.ts`, `prompts/memory.system.md`, `prompts/planner.system.md`, `prompts/turn-lane.system.md`, `prompts/direct-answer.system.md`, `tool-gateway.ts`, `runtime-goal-facts.ts`, `config-patch.ts`, `provider-key-codec.ts`, `tool-coverage.ts`, `sandbox-file-adapters.ts`, `run-submission.ts`, `thread-store.ts`, `run-worker.ts`, `approval-executor.ts`, `run-events.ts`, `run-lease.ts`, `thread-events.ts`, `thread-state-stream.ts`, `memory-safety.ts`, `runtime-trace-events.ts`, `ag-ui-projection.ts`, `final-answer-claim-extractor.ts`, `runtime/runtime-adapter.ts`, `runtime/provider-failover-policy.ts`, `runtime/provider-request-shaper.ts`, `runtime/provider-probe.ts`, `runtime/tool-call-repair.ts`, `runtime/high-volume-tool-policy.ts`, `runtime/openai-agents-adapter.ts`, `runtime/openai-compatible-chat-adapter.ts`, `runtime-plan-reader.ts`, `apps/api/src/agent/sandbox/*` runtime files, and provider runtime duplicates now owned by Agentic OS packages. Obsolete local final-review harness tests `response-evaluator.test.ts` and `loop-obligation-ledger.test.ts` are also deleted.

This is a real kernel introduction. Remaining package work is registry/release hardening, not code copying.

This is not yet the final install model. The replacement work prepared Agentic OS packages for versioned consumption and switched xox dependency declarations to package versions, but the packages must still be published to a controlled registry before `package-lock.json` can be a pure registry lock.

Current Agentic OS package state observed on 2026-06-19:

- `@agentic-os/contracts`, `@agentic-os/core`, `@agentic-os/testing`, `@agentic-os/server`, `@agentic-os/runtime-openai-compatible`, `@agentic-os/runtime-openai-agents`, `@agentic-os/runtime-ai-sdk`, and `@agentic-os/sandbox` exist in `C:/Github/agentic-os`.
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
apps/api/src/agent/host-profile/
  xox-host-profile.ts
  xox-planned-items.ts
  prompts/

apps/api/src/agent/agentic-os/
  xox-run-worker-adapter.ts
  xox-run-event-store-adapter.ts
  xox-run-lease-store-adapter.ts
  xox-run-submission-adapter.ts
  xox-thread-store-adapter.ts
  xox-action-graph-adapter.ts
```

Tests should live beside existing agent tests:

```text
apps/api/tests/agent-architecture.test.ts
```

Deleted host harness files must not be restored to satisfy stale local-runner tests.

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

- keep queue/lease/store wiring behind `apps/api/src/agent/agentic-os/xox-run-worker-adapter.ts` and route complex goal runs directly into `createXoxAgenticOsHostKit()`;
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
- tool observation outcome, except the generic classifier now owned by `@agentic-os/core`;
- action lifecycle integrity;
- context scope/redaction;
- cancellation;
- resume;
- obligation/final-review mechanics;
- provider failure classification, provider schema/payload compatibility, and same-turn retry decision primitives;
- runtime adapter contract testing.

Fix in xox-model when the issue is product/domain behavior:

- financial model semantics;
- workspace/team/member/ledger rules;
- xox DB schema and migrations;
- xox API DTOs;
- action graph business projection;
- memory persistence, tenant authorization, Memory Center DTOs, and business candidate plugins;
- provider settings UI/API;
- localized provider retry event copy and business-tool budget policy;
- real-provider smoke configuration.

If a xox mature behavior looks generic, first reproduce it as an Agentic OS test, then move the generic invariant into Agentic OS.

## Acceptance Gate

The integration is not considered successful until:

- Agentic OS is consumed as dependency, not copied.
- Agentic OS is consumed through versioned `@agentic-os/*` package declarations, not permanent local `file:` refs.
- Before merge, the selected registry must resolve all `@agentic-os/*` packages to the intended Agentic OS artifacts, and `package-lock.json` must no longer depend on development junctions.
- The normal xox production agent kernel uses Agentic OS as the harness loop.
- The old xox harness loop is removed or isolated so there is no long-term dual-harness maintenance.
- Obsolete local provider harness helpers, including `apps/api/src/agent/runtime/provider-error-classifier.ts`, `apps/api/src/agent/runtime/provider-tool-schema.ts`, `apps/api/src/agent/runtime/provider-payload-sanitizer.ts`, `apps/api/src/agent/runtime/provider-capability.ts`, `apps/api/src/agent/runtime/provider-capability-registry.ts`, `apps/api/src/agent/runtime/provider-transcript-replay.ts`, and `apps/api/src/agent/runtime/provider-families/*`, remain deleted after Agentic OS replacement.
- `apps/api/src/agent/tool-observation-outcome.ts` remains deleted; provider boundary, sandbox execution, and action observation outcome classification must stay sourced from `@agentic-os/core`.
- Tool observation continuation/finalizer instructions remain sourced from `@agentic-os/core`; `apps/api/src/agent/prompts/tool-observation-finalizer.system.md` must not return as a local prompt fork.
- Provider observation turn messages remain sourced from `@agentic-os/runtime-openai-compatible`; `apps/api/src/agent/host-profile/xox-provider-runtime.ts` and `apps/api/src/agent/host-profile/xox-agent-run-profile.ts` must not reintroduce direct `providerToolObservationReplayMessages()` calls or local assistant/tool message pairing. The deleted files `runtime-planning-call.ts`, `agentic-os/xox-runtime-planning-adapter.ts`, `agentic-os/xox-tool-observation-adapter.ts`, and `tool-observation-continuation.ts` must remain absent.
- Observation continuation lifecycle remains sourced from `@agentic-os/server`; `apps/api/src/agent/host-profile/xox-agent-run-profile.ts` must not reintroduce `continueModelAfterToolObservations()` or direct `agentServerRunLifecycleEvents.modelContinuation*()` calls.
- Dynamic tool authority, repeated pending action suppression, repeated auto-executed write suppression, and stale-final-after-materialization handling remain Agentic OS CPU responsibilities. xox may declare structured business mode such as `mode=forecast`, but it must not add local objective-text heuristics, duplicate-action row scanners, or finalizer runners to compensate for model loop behavior.
- Content safety helpers remain sourced from `@agentic-os/core`; `apps/api/src/agent/memory-safety.ts` must not return as a local host helper.
- Generic memory kernel helpers remain sourced from `@agentic-os/core`; `packages/agent-memory-core` and `@xox/agent-memory-core` must not return, and `apps/api/src/agent/memory.ts` must not reintroduce local candidate policy, recall scoring, prompt lane budgets, or query hashing.
- Sandbox runtime remains sourced from `@agentic-os/sandbox`; `apps/api/src/agent/sandbox` must not contain host-owned `.ts` backend, broker, policy, process, staged IO, tool RPC, or result-parser files.
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
