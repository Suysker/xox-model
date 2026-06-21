# xox-model Agentic OS Integration Plan

Status: Draft (M136 thread-store root adapter deleted)

Date: 2026-06-21

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
- xox local `apps/api/src/agent/loop-obligations.ts` facade has been deleted. The remaining financial/domain finding -> obligation DTO policy is folded into `apps/api/src/agent/loop-obligation-ledger.ts`, while `@agentic-os/core` owns generic obligation plan aggregation, projection, materialization planning, review-obligation projection, and additional repair state projection.
- xox `apps/api/src/agent/loop-obligation-ledger.ts` now consumes `@agentic-os/core` `projectObligationLedger()` for generic active/status counts and neutral obligation row projection.
- xox `apps/api/src/agent/obligation-materializer.ts` has been deleted. `@agentic-os/core` owns `planObligationMaterialization()` for active obligation task filtering, stable de-duplication, and generic event payloads; xox now keeps the `domain_fact -> data_query_workspace` read wiring private inside the real host adapter.
- xox final review response now consumes `@agentic-os/core` `ledgerToReviewObligations()` for active ledger obligation to completion repair obligation projection.
- xox final review response event now consumes `@agentic-os/core` `projectObligationLedgerWithAdditionalObligations()` for non-mutating additional obligation merge, runner identity de-duplication, and status counts. `xox-agentic-os-host-kit.ts` no longer owns this runner event projection.
- xox runtime-boundary missing-observation repair now consumes `@agentic-os/core` `projectObligationStateWithAdditionalObligations()` for non-mutating additional repair obligation ledger + plan projection. `xox-agentic-os-host-kit.ts` no longer owns the `runtime_boundary_sandbox_calculation` object graph.
- xox tool supervisor failure fallback now consumes `@agentic-os/core` `buildToolSupervisorEmptyResultFailureObservation()`; xox keeps only `ReadDraft` / `AgentToolObservation` DTO adapters, localized copy, and action graph persistence. `xox-agentic-os-host-kit.ts` no longer hand-writes `tool_supervisor_failure` JSON payloads.
- xox structured evidence key matching now consumes `@agentic-os/core` `evidenceFactsContainKey()`; local `apps/api/src/agent/structured-evidence-utils.ts` has been deleted, while xox keeps only financial/shareholder subject and requirement policy.
- xox readiness domain observation collection has been folded into `agentic-os/xox-loop-readiness-adapter.ts`; local `apps/api/src/agent/observation-collector.ts` has been deleted because it had a single host-adapter ingress and was not an Agentic OS core primitive.
- xox prerequisite observation selection now consumes `@agentic-os/core` `selectAgentPrerequisiteObservations()`; local `apps/api/src/agent/prerequisite-observations.ts` has been deleted, while xox keeps the `entity_summary` reader wiring, Chinese copy, and action graph persistence.
- xox tool discovery and manifest search observations now consume `@agentic-os/core` `buildToolSurfaceDiscoveryObservation()` / `buildToolSurfaceManifestSearchObservation()`; local `apps/api/src/agent/tool-discovery-tool.ts` has been deleted, while xox keeps only the tool manifest adapter and Chinese `ReadDraft` wrapper.
- xox content safety now consumes `@agentic-os/core` `redactSecretLikeContent()` / `containsSecretLikeContent()` / `normalizeSecretSafeText()`; local `apps/api/src/agent/memory-safety.ts` has been deleted. xox keeps memory storage, promotion policy, recall ranking, sandbox result adapters, provider settings, and product DTO projection.
- xox sandbox runtime now consumes `@agentic-os/sandbox` `SandboxBroker` and package-owned sandbox backend/runtime types. Local `apps/api/src/agent/sandbox/*` backend, broker, policy, process runner, staged IO helper, tool RPC file bridge and result parser files have been deleted. xox keeps `sandbox-service.ts` for workspace data bundles, exposed business SDK entries, nested action aggregation, Chinese `ReadDraft` projection, and `sandbox-file-adapters.ts` for uploaded-file policy.
- xox provider stream trace projection now consumes `@agentic-os/server` `addAgentServerRuntimeStreamRunEvent()` / `projectAgentServerRuntimeStreamRunEvent()` through `apps/api/src/agent/agentic-os/xox-run-event-store-adapter.ts`. Local `apps/api/src/agent/runtime-trace-events.ts` and root `apps/api/src/agent/run-events.ts` have been deleted; xox keeps durable event SQL, thread signal publication, localized Chinese copy, and redaction hook placement behind the host adapter boundary.
- xox OpenAI-compatible host sidecar has been deleted. Local `apps/api/src/agent/runtime/openai-compatible-chat-adapter.ts` no longer exists; M132 also removed the last `apps/api/src/agent/runtime/runtime-adapter.ts` file. The remaining xox provider-selection adapter is `apps/api/src/agent/agentic-os/xox-runtime-adapter.ts`, which calls `@agentic-os/runtime-openai-compatible` `runOpenAICompatibleRuntimeTurn()` directly and keeps only settings/prompt/event source mapping plus normalized provider call -> xox planner-step mapping.
- xox AG-UI event projection now consumes `@agentic-os/server` `projectAgentServerAgUiEvents()` from submitted-run and thread-state views. Local `apps/api/src/agent/ag-ui-projection.ts` has been deleted; xox keeps only `eventNamePrefix: 'xox'`, DTO compatibility, product transcript/timeline nodes, Chinese copy and navigation mapping.
- xox final-answer claim extraction now consumes `@agentic-os/server` `runAgentServerFinalAnswerClaimExtraction()`. Local `apps/api/src/agent/final-answer-claim-extractor.ts` has been deleted; xox keeps only subject taxonomy, evidence projection, `planWithRuntimeAdapter` provider callback, claim type narrowing, Chinese run-event copy, and financial/shareholder evidence policy.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `detectProviderPlainTextToolCallArtifact()` and `recoverProviderPlainTextToolCalls()` for provider plain-text tool-call recovery; the local `provider-plain-text-tool-calls.ts` duplicate has been removed.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `extractBalancedJson()`, `parseToolArgumentsWithRepair()`, `repairToolName()`, and `normalizeProviderToolCallsForExecution()` for provider-frame JSON extraction, bounded streamed argument repair, inventory-bound tool-name repair, effective-inventory/deferred boundary validation, and normalized provider tool-call output; local `balanced-json.ts`, `tool-call-argument-repair.ts`, `tool-call-name-normalizer.ts`, and `tool-call-repair.ts` duplicates/facades have been removed. The remaining normalized provider call -> xox planner-step mapping is private inside `agentic-os/xox-runtime-adapter.ts` because it depends on xox `toolCallToPlannerStep()`.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `classifyProviderHttpError()`, `safeProviderErrorMessage()`, `providerRejectsToolChoice()`, and `runOpenAICompatibleRuntimePlanningRecovery()` for provider HTTP taxonomy, safe error redaction, `tool_choice` rejection detection, deferred materialization retry, recoverable same-turn retry, retry request shaping, retry patch application, and missing-observation evidence recovery; local `provider-error-classifier.ts`, `provider-failover-policy.ts`, and `high-volume-tool-policy.ts` have been removed. xox keeps high-volume tool budgets, tool catalog materialization, evidence requirement persistence, and Chinese retry run-event copy only as private host callbacks in `agentic-os/xox-runtime-planning-adapter.ts`.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `resolveProviderModelRef()` and `resolveProviderModelProfile()` for canonical provider/model refs and protocol profile facts; local `provider-model-ref.ts` and `provider-model-profile.ts` have been removed.
- xox provider request shaping now consumes `@agentic-os/runtime-openai-compatible` `shapeOpenAICompatibleChatRequest()` for provider request bodies, plus `normalizeProviderToolSchemas()` and `sanitizeOpenAICompatibleRequestBody()` through that shaper for provider-facing tool schema compatibility and OpenAI-compatible request body sanitation; local `provider-tool-schema.ts`, `provider-payload-sanitizer.ts`, and `provider-request-shaper.ts` have been removed. `agentic-os/xox-runtime-adapter.ts` only maps xox settings, prompt/context/messages/tools and stream flags into the runtime package shaper.
- xox provider settings probe now consumes `@agentic-os/runtime-openai-compatible` `probeOpenAICompatibleProvider()` directly from `provider-settings.ts`; local `runtime/provider-probe.ts` has been removed. xox keeps provider settings/key source, the `xox_provider_probe` tool name, and Chinese product check copy in the settings module.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `resolveProviderRuntimeProfile()`, `resolveProviderRuntimeCapability()`, `resolveRuntimeThinkingLevel()`, `replayPolicyPreservedMessageKeys()`, `sanitizeProviderReplayMessages()`, `providerToolObservationReplayMessages()`, and `buildProviderToolObservationTurnMessages()` for provider family capability, thinking normalization, request patching, replay policy, assistant field backfill, low-level observation replay, and full observation-bearing provider turn message assembly; local `provider-capability.ts`, `provider-capability-registry.ts`, `provider-families/*`, and `provider-transcript-replay.ts` have been removed.
- xox provider runtime now consumes `@agentic-os/runtime-openai-compatible` `ProviderToolCallStreamAssembler` for streamed `delta.tool_calls` accumulation, ordered OpenAI-compatible tool call output, and provider-neutral frame damage facts; local `tool-call-stream-assembler.ts` has been removed.
- xox OpenAI Agents route now consumes `@agentic-os/runtime-openai-agents` directly from `agentic-os/xox-runtime-adapter.ts`; local `runtime/openai-agents-adapter.ts` and `runtime/runtime-adapter.ts` have been removed. Agentic OS owns OpenAI Agents SDK lifecycle, provider cleanup, SDK tool-call capture, runtime events, and SDK error redaction; xox keeps only provider settings, prompt compatibility, xox tool metadata fill, canonical tool call -> planner-step mapping, and localized event DTO mapping at the real provider selection boundary.
- xox OpenAI-compatible route now consumes `@agentic-os/runtime-openai-compatible` `runOpenAICompatibleRuntimeTurn()` from `agentic-os/xox-runtime-adapter.ts`; Agentic OS owns request shaping, transport, stream parsing, provider turn normalization, tool-call normalization, provider artifact, and replay assistant message. xox adapter keeps only settings/prompt input mapping, localized event source bridging, and normalized provider call -> xox planner-step mapping.
- xox root `runtime-planning-call.ts` has been removed. `agentic-os/xox-runtime-planning-adapter.ts` consumes `@agentic-os/runtime-openai-compatible` `runOpenAICompatibleRuntimePlanningRecovery()`; Agentic OS owns first/deferred/retry/missing-observation same-turn recovery orchestration. xox keeps only high-volume business budgets, tool catalog materialization callback, localized run events, evidence requirement callback, and `RuntimePlanResult` projection at the host adapter boundary.
- xox `planner.ts`, `planning-session.ts`, and `agent-kernel.ts` have been removed. The old host planner/session/kernel layer had no reason to survive after the Agentic OS host-kit cutover; keeping it would preserve a false second harness. xox production planning now enters through `run-worker.ts`, then directly wires `xox-turn-intake-adapter.ts`, `xox-direct-answer-adapter.ts`, and `xox-agentic-os-host-kit.ts`.
- xox `turn-intake-resolver.ts` has been removed. Turn intake lane contract, schema, pending guard ordering, provider-unavailable fallback, and uncertain fallback now come from `@agentic-os/core`; xox `run-worker.ts` only calls the thin adapter, and `agentic-os/xox-turn-intake-adapter.ts` supplies DB callbacks, runtime model callback, xox-specific prompt, and `goalFacts` sanitization.
- xox `direct-answer-runtime.ts` has been removed. Direct answer lane assistant-text-only validation, provider error handling, tool-call rejection, empty-output fail-closed behavior, and before-write cancellation now come from `@agentic-os/core`; xox `run-worker.ts` only calls the thin adapter, and `agentic-os/xox-direct-answer-adapter.ts` supplies prompt, ambient context, runtime callback, DB writes, and localized product events.
- xox ambient session context now consumes `@agentic-os/core` `buildAgentAmbientSessionContext()` / `agentAmbientSessionContextFacts()` from the turn-intake and direct-answer adapters. Local `apps/api/src/agent/ambient-context.ts` has been deleted; xox keeps only user/workspace display field mapping and `XOX_AGENT_TIMEZONE` override wiring.
- xox `clarification-resume.ts` has been removed. Clarification resume scaffold assembly now comes from `@agentic-os/core`; xox `agentic-os/xox-clarification-resume-adapter.ts` only loads prior goal/evaluation/action rows, maps xox action kinds to capabilities, and supplies localized copy plus redaction.
- xox `loop-readiness-check.ts` has been removed. Readiness status priority now comes from `@agentic-os/core` `decideAgentReadiness()`; xox `agentic-os/xox-loop-readiness-adapter.ts` only loads DB rows, produces xox domain findings, supplies localized copy, and persists xox goal status.
- xox `runtime-plan-reader.ts` has been deleted; `action-draft-builder.ts` consumes `@agentic-os/runtime-openai-compatible` `providerToolCallBoundaryObservations()` for provider boundary failure model payloads, while xox keeps only the `ReadDraft` wrapper, Chinese display copy, and product status mapping.
- xox tool observation outcome classification now consumes `@agentic-os/core` `classifyToolObservationOutcome()` and related helpers. `apps/api/src/agent/tool-observation-outcome.ts` has been removed; provider boundary, sandbox execution, action preview, and action result outcome branches are no longer maintained in xox.
- xox action observation payloads now consume `@agentic-os/core` `buildActionPreviewObservation()` and `buildActionResultObservation()`. Root `apps/api/src/agent/tool-observation-continuation.ts` has been removed; `apps/api/src/agent/agentic-os/xox-tool-observation-adapter.ts` remains the xox adapter for Chinese display copy, action row mapping, details parsing, and business result summaries. `apps/api/src/agent/action-graph-store.ts` no longer hand-writes `action_result` model payloads for blocked or failed actions.
- xox observation loop role checks now consume `@agentic-os/core` `parseToolObservationModelFacts()` and `is*ToolObservation()` helpers. `apps/api/src/agent/agentic-os/xox-agentic-os-host-kit.ts` still owns xox readable text and business finalization policy, but no longer directly parses `observation.modelContent` for action/sandbox/provider boundary/tool supervisor/tool discovery/clarification semantics; `tool-runtime/tool-loop-guardrails.ts` also uses core helpers for completed action-result detection.
- xox tool observation continuation/finalizer system prompt now consumes `@agentic-os/core` `toolObservationContinuationSystemPrompt()`. `apps/api/src/agent/prompt-registry.ts` has been deleted; concrete adapters load their xox prompt assets directly and only inject platform identity, agent name, and provider identity rules at the consuming boundary.
- xox provider observation turn message assembly now consumes `@agentic-os/runtime-openai-compatible` `buildProviderToolObservationTurnMessages()` for planning turns and `buildProviderToolObservationContinuationMessages()` for finalizer/continuation turns. `apps/api/src/agent/agentic-os/xox-runtime-planning-adapter.ts` still builds xox context/tool catalog/budget inputs, and `apps/api/src/agent/agentic-os/xox-tool-observation-adapter.ts` still loads xox runtime context and records run events, but neither file hand-assembles OpenAI-compatible assistant `tool_calls` and matching `tool` replay messages.
- xox progressive tool surface runtime now consumes `@agentic-os/core` `buildToolSurfacePack()` / `buildToolSurfaceManifests()` and search helpers. Local `apps/api/src/agent/tool-context-engine/*` algorithm files have been removed; xox keeps only `apps/api/src/agent/tool-surface-manifest.ts` for business manifest overrides, kernel tool names, canonical capability map, fact-dependent capability hints, and legacy xox DTO mapping.
- xox tool loop progress guardrails now consume `@agentic-os/core` `evaluateToolLoopGuardrails()`. Local guardrail algorithm branches for repeated failures, no-progress turns, and executed-write reapply have been removed; `apps/api/src/agent/tool-runtime/tool-loop-guardrails.ts` is now only a Row/DTO adapter. Local `approval-policy-composer.ts` has also been removed in favor of core `composeAgentWriteApprovalPolicy()`.
- xox tool-call supervision and runtime event payloads now consume `@agentic-os/core` `runToolCallSupervisor()`. Agentic OS owns the sequential runner, started/completed callback order, inventory-miss fail-closed path, empty-result failure path, observation summary, and event payload facts. `apps/api/src/agent/tool-runtime/tool-call-supervisor.ts` now only maps xox planner steps/results, adapts failure copy, and persists product run events; the obsolete local `tool-runtime/tool-execution-events.ts` adapter has been deleted.
- xox action graph materialization now consumes `@agentic-os/server` `materializeAgentServerActionGraph()`. Agentic OS owns sequence cursor traversal, action/read/status/assistant/observation-only item materialization, stored action observation collection, summary, and provider-neutral event drafts. `apps/api/src/agent/action-graph-store.ts` now maps xox `PlannedItem` values into server planned items and remains responsible only for Kysely row mapping, action automation settling, navigation/product run-event copy, and `@xox/contracts` compatibility.
- xox host observation bridge now consumes `@agentic-os/core` `createHostObservationBridge()`. Agentic OS owns canonical observation id/tool-call id mapping, host fallback hook invocation, and stable merge/dedupe; `apps/api/src/agent/agentic-os/xox-observation-adapter.ts` keeps only xox `AgentToolObservation` projection, legacy embedded `xoxObservation` recovery, product display copy fallback, and host key policy. `xox-agentic-os-host-kit.ts` and `action-graph-store.ts` no longer keep local observation maps or fallback bridge helpers.
- xox run worker lifecycle now consumes `@agentic-os/server` `createAgentServerRunScheduler()`. Agentic OS owns drain exclusivity, delayed drain, polling start/stop, active run controller claim/release, active run listing, and cancellation state. `apps/api/src/agent/run-worker.ts` keeps only Kysely lease SQL, recoverable-row validation, localized fail-closed copy, business completion writes, and xox run-event persistence; the local active controller map and queue state WeakMap have been removed.
- xox thread event signaling now consumes `@agentic-os/server` `AgentServerSignalBus`. Agentic OS owns topic listener mechanics, process-local sequence, unsubscribe cleanup, listener error isolation, and listener count. Root `apps/api/src/agent/thread-events.ts` has been deleted; xox thread reason names and `{ threadId, sequence, reason }` mapping now live in `apps/api/src/agent/agentic-os/xox-thread-signal-adapter.ts`.
- xox signal-driven thread state stream now consumes `@agentic-os/server` `openAgentServerSignalStateStream()`. Root `apps/api/src/agent/thread-state-stream.ts` has been deleted; Node HTTP/SSE headers, heartbeat, request close/abort, safe error copy, and product `AgentThreadState` loading now live in `apps/api/src/agent/agentic-os/xox-thread-state-stream-adapter.ts`.
- xox run lease heartbeat now consumes `@agentic-os/server` lease helpers. Agentic OS owns lease-lost error shape, lease expiry timestamp helper, heartbeat interval policy, active assertion helper, and heartbeat refresh loop. Root `apps/api/src/agent/run-lease.ts` has been deleted; Kysely claim/refresh/recovery SQL and worker-id durable facts now live in `apps/api/src/agent/agentic-os/xox-run-lease-store-adapter.ts`.
- xox run event append sequencing now consumes `@agentic-os/server` `createAgentServerSequencedRunEventAppender()`. Agentic OS owns per-run append serialization, max-sequence/next-sequence append flow, and sequence conflict retry. Root `apps/api/src/agent/run-events.ts` has been deleted; Kysely event SQL, row serialization, localized event DTO fields, legacy channel inference, and `run_trace` thread signal publication now live in `apps/api/src/agent/agentic-os/xox-run-event-store-adapter.ts`.
- xox submitted-run creation remains host product wiring, but root `apps/api/src/agent/run-submission.ts` has been deleted. DB row creation, queued event persistence, sync/background response selection, and xox `AgentSendResponse` projection now live in `apps/api/src/agent/agentic-os/xox-run-submission-adapter.ts`; routes keep auth/body parsing, and `xox-run-submission-view.ts` continues to consume Agentic OS server submitted-run projection facts.
- xox thread state loading remains host product wiring, but root `apps/api/src/agent/thread-store.ts` has been deleted. Kysely row loading, workspace/user authorization, legacy contract serialization, thread summaries, and product `AgentThreadState` projection now live in `apps/api/src/agent/agentic-os/xox-thread-store-adapter.ts`, which calls `xox-thread-state-view.ts` for Agentic OS server-owned thread projection facts.
- xox still owns financial/shareholder final-review policy, including the xox adapter rule that unscoped entity/domain final-answer claims require shareholder domain evidence.
- xox still owns response-evaluator finding to financial/domain obligation mapping, plus `goalFacts`, `requiredDataScopes`, and `requiredMetrics`.
- xox still owns obligation materializer selection, `data_query_workspace` arguments, business read execution, and product run event persistence.
- xox still owns timeout/abort wiring, business request assembly, localized retry/status run-event copy, planning-boundary high-volume business tool policy, user/workspace provider settings, and provider tool call to xox planner-step mapping at the real adapter boundary. Provider turn execution, tool-call normalization, boundary validation, retry patching, deferred materialization orchestration, missing-observation recovery, and provider stream trace projection now belong to Agentic OS.
- Obsolete local harness helper files are intentionally removed: `agent-run-engine.ts`, `turn-resolver.ts`, `agent-action-runtime.ts`, `context-engine/index.ts`, the former top-level `agentic-os-adapter.ts`, `planner.ts`, `planning-session.ts`, `turn-intake-resolver.ts`, `direct-answer-runtime.ts`, `ambient-context.ts`, `clarification-resume.ts`, `loop-readiness-check.ts`, `loop-obligations.ts`, `obligation-materializer.ts`, `runtime-planning-call.ts`, `tool-observation-continuation.ts`, `run-submission.ts`, `thread-store.ts`, `run-events.ts`, `run-lease.ts`, `thread-events.ts`, `thread-state-stream.ts`, `memory-safety.ts`, `runtime-trace-events.ts`, `ag-ui-projection.ts`, `final-answer-claim-extractor.ts`, `runtime/runtime-adapter.ts`, `runtime/provider-failover-policy.ts`, `runtime/provider-request-shaper.ts`, `runtime/provider-probe.ts`, `runtime/tool-call-repair.ts`, `runtime/high-volume-tool-policy.ts`, `runtime/openai-agents-adapter.ts`, `runtime/openai-compatible-chat-adapter.ts`, `runtime-plan-reader.ts`, `apps/api/src/agent/sandbox/*` runtime files, and provider runtime duplicates now owned by Agentic OS packages.

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

- keep `apps/api/src/agent/run-worker.ts` as queue/lease/store wiring and route complex goal runs directly into `createXoxAgenticOsHostKit()`;
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
- memory retrieval ranking and persistence;
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
- Provider observation turn messages remain sourced from `@agentic-os/runtime-openai-compatible`; `apps/api/src/agent/agentic-os/xox-runtime-planning-adapter.ts` and `apps/api/src/agent/agentic-os/xox-tool-observation-adapter.ts` must not reintroduce direct `providerToolObservationReplayMessages()` calls or local assistant/tool message pairing. The deleted root files `runtime-planning-call.ts` and `tool-observation-continuation.ts` must remain absent.
- Content safety helpers remain sourced from `@agentic-os/core`; `apps/api/src/agent/memory-safety.ts` must not return as a local host helper.
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
