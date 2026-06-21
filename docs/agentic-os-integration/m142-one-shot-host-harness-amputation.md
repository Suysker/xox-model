# M142 One-Shot Host Harness Amputation

Status: In Progress (evidence/final-review/obligation root framework, final-review test harness surface, readiness/runtime-planning facades, root data/planning facades, memory helper subdirectory, sandbox file helper, provider-key helper, config-patch helper, and tool-coverage helper deleted)

Date: 2026-06-21

## Goal

This milestone removes the remaining xox-owned harness framework through coordinated, test-backed cuts.

This is not another helper migration. The target is the computer/peripheral boundary:

```text
Agentic OS
  owns the SaaS harness computer:
  loop, lifecycle, provider turns, action runtime, memory lifecycle,
  evidence/final review, recovery, projection primitives, and canonical events

xox-model
  owns peripherals:
  tenant/user/workspace storage, business tools, financial policy,
  domain execution, provider settings, localized product copy,
  API DTOs, and UI projection skins
```

An implementation cut is only acceptable if it materially lowers xox `apps/api/src/agent` harness complexity, deletes or collapses whole host framework files, and moves reusable semantics into Agentic OS packages with tests. A partial cut must be recorded as in-progress and must not be presented as M142 completion.

## Why This Exists

M141 removed active-memory lifecycle callbacks, but the same problem remains across goal, plan, memory, action, provider, evidence, and projection boundaries.

Original audit signals:

- `apps/api/src/agent/agentic-os/xox-agentic-os-host-kit.ts` is 2229 lines and still acts as a host runner.
- The host kit still constructs generic lifecycle events such as `goal_contract_created`, `goal_iteration_started`, `model_planning`, `goal_evaluated`, `final_answer_candidate`, `goal_iteration_exhausted`, and `runner_obligation_*`.
- `apps/api/src/agent/agentic-os/xox-action-approval-adapter.ts` still owns generic action lifecycle event drafts and performs post-confirmation goal evaluation.
- `apps/api/src/agent/agentic-os/xox-runtime-planning-adapter.ts` originally owned provider retry and planning lifecycle callbacks; it was deleted in M145, with residual provider boundary wiring collapsed into `xox-runtime-adapter.ts`.
- `apps/api/src/agent/agentic-os/xox-tool-observation-adapter.ts` still owns model continuation lifecycle events.
- `apps/api/src/agent/memory-kernel.ts` still owns generic memory lifecycle event drafts.
- `apps/api/src/agent/loop-obligation-ledger.ts`, `apps/api/src/agent/response-evaluator.ts`, and `apps/api/src/agent/evidence-ledger.ts` still mix domain policy with generic evidence/final-review harness mechanics.
- `apps/api/src/agent/agent-transcript-projector.ts` and `apps/api/src/agent/agent-timeline-projector.ts` still implement generic event tree/projection logic.

These are not independent bugs. They are the same boundary error: xox still understands too much about how the harness CPU runs.

## Implementation Progress

### M142a: Server-Owned Lifecycle Event Drafts

Status: completed as the first M142 implementation cut.

What moved to Agentic OS:

- `@agentic-os/server` now owns reusable SaaS harness lifecycle event drafts through `agentServerRunLifecycleEvents`.
- The moved event drafts cover goal/plan, provider retry/planning, model continuation, action lifecycle, final review/evaluation, runner obligation materialization, runtime evidence requests, and memory candidate/context lifecycle events.
- Agentic OS server tests now cover representative reusable lifecycle event drafts and assert their Agentic OS ownership marker.

What xox deleted or collapsed:

- `apps/api/src/agent/memory-kernel.ts` has been deleted.
- Remaining xox memory candidate/context-flush persistence initially lived in `apps/api/src/agent/memory-consolidator.ts`; after M147 the misleading memory root facades are deleted and durable memory storage/retrieval/consolidation wiring is collapsed into `apps/api/src/agent/memory.ts`.
- xox host adapters now call `agentServerRunLifecycleEvents` instead of hand-building generic lifecycle event objects.
- `apps/api/tests/agent-architecture.test.ts` now guards against reintroducing the deleted `memory-kernel.ts` file and direct M142 lifecycle event literal construction in host adapters.

Validation evidence for M142a:

```powershell
cd C:\Github\agentic-os
npm.cmd run build -w @agentic-os/server
npm.cmd run test -w @agentic-os/server
npm.cmd run check
git diff --check

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test:api -- --run tests/agent-architecture.test.ts
npm.cmd run test:api -- --run tests/action-observation.test.ts tests/provider-runtime.test.ts tests/response-evaluator.test.ts tests/loop-obligation-ledger.test.ts
npm.cmd run test:api
git diff --check
```

Remaining M142 hard targets:

- Delete or collapse the xox-owned generic evidence/final-review/obligation runtime still visible in `response-evaluator.ts`, `loop-obligation-ledger.ts`, and `evidence-ledger.ts`.
- Move generic transcript/timeline tree projection out of `agent-transcript-projector.ts` and `agent-timeline-projector.ts`.
- Shrink `agentic-os/xox-agentic-os-host-kit.ts` further until it is HostProfile/HostAdapter wiring rather than the loop narrative.
- Continue deleting whole files when the remaining content is only a host harness facade.

### M142b: Agentic OS-Owned Final Gate and Obligation Repair

Status: completed for the evidence/final-review/obligation root framework cut.

What moved to Agentic OS:

- `@agentic-os/core` now owns `evaluateAgentFinalResponseReview()`, a generic final-response gate that orders pending confirmation, pending clarification, missing final answer after observations, provider protocol artifact hygiene, evidence requirement evaluation, empty final answer, and pass.
- `@agentic-os/core` now generates canonical final-answer and evidence-repair obligations from final-response gate decisions.
- `@agentic-os/core` evidence requirement obligations support stable host-declared `metadata.obligationId` while preserving the OS-owned lifecycle and projection semantics.
- `@agentic-os/core` obligation ledger observation updates can accept a host domain evaluator for domain-specific fact satisfaction, without moving the ledger state machine back into xox.

What xox deleted or collapsed:

- Deleted `apps/api/src/agent/evidence-ledger.ts`.
- Deleted `apps/api/src/agent/response-evaluator.ts`.
- Deleted `apps/api/src/agent/loop-obligation-ledger.ts`.
- Moved remaining xox domain evidence/final-review policy into `apps/api/src/agent/agentic-os/xox-final-review-adapter.ts`.
- `xox-final-review-adapter.ts` no longer owns the generic final gate or constructs repair obligations from response statuses. It supplies xox financial/shareholder requirements, evidence source mapping, localized copy, and product DTO projection around Agentic OS-generated obligations.
- Architecture tests now guard the deleted root files from returning.

Hardening added during this cut:

- xox host materialization now reads Agentic OS canonical obligation metadata through both top-level metadata and `metadata.host`, because Agentic OS preserves downstream policy as host passthrough instead of understanding xox taxonomies.
- `needs_more_evidence` can enter the same obligation materialization path as `needs_calculation` and `needs_final_answer`, but only when doing so does not skip a necessary model-visible final-answer turn.
- Ordered-shareholder evidence is auto-materialized only when the current final candidate already names a concrete shareholder. If the final candidate does not actually answer the entity-specific claim, the loop continues and the model must see the entity read before producing a new final answer.
- Materialized `runner_obligation` reads are now persisted as visible xox plan steps for audit and UI state. Synthetic `runner_evidence` prerequisites remain observation-only to avoid polluting the user-visible plan.

Reference alignment:

- OpenAI Agents JS keeps the run loop, turn resolution, tool execution, tool output items, interruption handling, and final-output decision inside `Runner` and runner/core modules.
- Hermes confirms the same loop shape: model turn -> tool calls -> append tool results -> continue/final, with guardrail halt still represented through loop-visible messages.
- OpenClaw keeps reusable provider/tool-call repair and runtime primitives in packages rather than app-local adapters. This reinforces that xox must not be the Agentic OS blueprint.

Validation evidence for M142b:

```powershell
cd C:\Github\agentic-os
npm.cmd run build -w @agentic-os/core
npm.cmd test -w @agentic-os/core

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/api.test.ts -t "requires model-visible ordered shareholder evidence|keeps shareholder fact obligations open|repairs shareholder fact obligations|replays repairable sandbox failures"
npm.cmd run test --workspace @xox/api -- tests/response-evaluator.test.ts tests/loop-obligation-ledger.test.ts tests/agent-architecture.test.ts
npm.cmd run test:api
```

Remaining M142 hard targets after M142b:

- `apps/api/src/agent/agentic-os/xox-agentic-os-host-kit.ts` is still too large and must continue shrinking toward HostProfile/HostAdapter wiring.
- `apps/api/src/agent/agentic-os/xox-thread-transcript-adapter.ts` and `xox-thread-timeline-adapter.ts` were directly deleted in M149. xox keeps only a thin legacy DTO compatibility mapper in `xox-thread-state-view.ts`; generic projection grouping and merge algorithms must stay Agentic OS-owned.
- `apps/api/src/agent/agentic-os/xox-runtime-adapter.ts` must remain a concrete provider settings/DTO/runtime-boundary mapper and must not become a second runtime or regrow a standalone planning adapter.

### M143: Deleted the Action Approval Adapter

Status: completed as a follow-up M142 action-lifecycle cut.

- Deleted `apps/api/src/agent/agentic-os/xox-action-approval-adapter.ts`.
- `routes.ts` now keeps only confirm/cancel/edit HTTP transport glue.
- `tool-executor.ts` owns xox business action execution and audit writes.
- `xox-agentic-os-host-kit.ts` owns the post-confirmation handoff into Agentic OS `ActionRuntime.confirm()` and `AgentRunEngine.resume()`.
- Architecture guards now fail if the deleted approval adapter returns or if action graph code imports it.

### M144: Deleted Host Entry, Stream, and Projection Facades

Status: completed as a follow-up M142 whole-file deletion cut.

- Deleted `xox-turn-intake-adapter.ts`, `xox-direct-answer-adapter.ts`, `xox-clarification-resume-adapter.ts`, `xox-observation-adapter.ts`, `xox-thread-state-stream-adapter.ts`, `xox-thread-signal-adapter.ts`, `xox-run-submission-view.ts`, and `xox-agentic-os-facts.ts`.
- Turn intake and direct-answer state machines still come from `@agentic-os/core`; xox worker keeps only DB/provider/prompt/storage callback wiring at the real worker boundary.
- Clarification resume row loading moved to the goal store adapter, observation DTO projection moved to the tool observation adapter, SSE transport moved to routes, signal reason mapping moved to the run-event store, and submitted/thread projection fact mapping moved to the concrete submission/thread-state projection boundaries.
- Architecture guards now fail if any of the deleted facade files return.

### M145: Deleted Readiness and Runtime Planning Facades

Status: completed as a follow-up M142 whole-file deletion cut.

- Deleted `xox-loop-readiness-adapter.ts` and `xox-runtime-planning-adapter.ts`.
- Agentic OS still owns readiness priority through `decideAgentReadiness()`; xox goal-store code now keeps only goal rows, xox domain findings, and persistence mappings at the concrete goal boundary.
- Runtime planning recovery still comes from Agentic OS runtime packages; xox runtime adapter now keeps provider settings, context-pack input, tool-catalog callback wiring, business high-volume budgets, localized event sink, and legacy runtime DTO projection at the concrete provider boundary.
- Architecture guards now fail if either deleted facade returns.
- This cut is intentionally an amputation-first step. It reduces visible host harness files, but the remaining semantics in `xox-agentic-os-host-kit.ts`, `xox-final-review-adapter.ts`, projection adapters, and `xox-tool-observation-adapter.ts` still require deeper Agentic OS extraction.

### M146: Deleted Root Data and Planning Facades

Status: completed as a follow-up M142 root-file deletion cut.

- Deleted `data-agent.ts` and `planning-context.ts`.
- `data.query_workspace` business read execution now lives in `runtime-intent-handlers.ts`, the concrete xox tool handler registry, with `WorkspaceDataQueryStep` naming instead of `DataAgentQueryStep`.
- `PlannerContext` now lives in `action-draft-builder.ts`, beside xox action/read draft DTOs, instead of a standalone planning context facade.
- Architecture guards now fail if either deleted root file returns.
- This cut removes misleading root agent filenames only. It does not move business data reads or action draft generation into Agentic OS, because those remain xox peripheral responsibilities.

### M147: Deleted Memory Root Facades

Status: completed as a follow-up M142 root-file deletion cut.

- Deleted `memory-events.ts`, `memory-retriever.ts`, `memory-candidate-detector.ts`, `memory-promotion-policy.ts`, and `memory-consolidator.ts`.
- Durable memory row/event write, governed candidate policy, retrieval/recall marking, candidate generation, consolidation, and long-context flush wiring now live in `memory.ts`.
- Agentic OS still owns active recall runtime and memory lifecycle event drafts. xox keeps SQL row mapping, Memory Center DTOs, business candidate text/evidence, recall signals, daily notes, and localized run-event copy.
- Architecture guards now fail if any deleted memory root facade returns.

### M150: Deleted Final-Review Harness Test Surface

Status: completed as a follow-up M142 test-surface deletion cut.

- Deleted `apps/api/tests/response-evaluator.test.ts`.
- Deleted `apps/api/tests/loop-obligation-ledger.test.ts`.
- Removed the old public final-review/obligation harness exports from `xox-final-review-adapter.ts`: `evidenceContainsKey()`, `buildEvidenceRequirements()`, `loopObligationsFromResponseEvaluation()`, `planLoopObligations()`, `activeLedgerObligations()`, `canAttemptFinalAnswer()`, `serializeObligationLedger()`, `osEvidenceRecordsFromXoxEvidence()`, and `osEvidenceRequirementFromXoxRequirement()`.
- The remaining adapter surface is production host policy and DTO mapping only. Agentic OS still owns the generic final-review gate, obligation ledger state machine, and projection primitives.
- Architecture guards now fail if the deleted tests or public harness helper exports return.
- The unused local memory prompt `apps/api/src/agent/prompts/memory.system.md` was also deleted in this cut because active-memory prompt assembly is Agentic OS-owned.

### M151: Deleted Single-Entry Agent Helper Files

Status: completed as a follow-up `apps/api/src/agent` deletion cut.

- Deleted `config-patch.ts`, `provider-key-codec.ts`, `tool-coverage.ts`, and `sandbox-file-adapters.ts`.
- Deleted the remaining `memory/*` helper files: `daily-notes.ts`, `dreaming-worker.ts`, `memory-backend.ts`, `memory-center.ts`, `memory-tools.ts`, and `recall-signals.ts`.
- Collapsed the remaining code into real host boundaries: `action-draft-utils.ts`, `provider-settings.ts`, `tool-catalog.ts`, `sandbox-service.ts`, and `memory.ts`.
- `apps/api/src/agent` dropped from 44 files after M150 to 34 files after this cut.
- Architecture guards now fail if these deleted helpers or imports return.

## One-Shot Scope

M142 is not complete until all rows in this table are addressed. If a row cannot be completed in a given implementation cut, that cut must be presented as M142-in-progress rather than M142 completion.

| Domain | Current xox residue | M142 target |
| --- | --- | --- |
| Goal and plan lifecycle | Host kit creates goal contract, iteration, planning, evaluated, exhausted events and updates generic goal states around loop turns | Agentic OS owns goal lifecycle event drafts and loop-state transitions; xox provides durable goal/run row adapters |
| Evidence and final review | xox mixes final answer hygiene, evidence requirements, obligation projection, review obligations, and financial policy | Agentic OS owns generic final review gate, evidence ledger mechanics, obligation projection, and repair obligations; xox keeps financial/shareholder requirement policy only |
| Action lifecycle | xox writes canonical action executed/updated/cancelled/auto-execution lifecycle events and re-evaluates goal state after confirm | Agentic OS action runtime owns confirmation/edit/reject/execute lifecycle events and resume observation handoff; xox keeps business writes, audit rows, memory candidates, and product DTOs |
| Provider planning | The standalone `xox-runtime-planning-adapter.ts` is deleted, but `xox-runtime-adapter.ts` still carries provider-boundary wiring, localized event sink, tool catalog callbacks, business budget policy, and legacy DTO projection | Agentic OS runtime/server owns provider planning lifecycle, retry event drafts, boundary repair state, and stream event projection; xox keeps only provider settings, tool catalog materialization policy, localized copy hook, and business budget policy at the concrete runtime boundary |
| Model continuation | xox owns `model_continuation*` events for observation-to-final-answer continuation | Agentic OS owns continuation lifecycle and canonical events; xox keeps prompt identity additions, provider settings, and persisted final message projection |
| Memory lifecycle | xox owns memory candidate/context-flush/dreaming lifecycle event drafts | Agentic OS owns generic memory lifecycle and event drafts; xox keeps memory store, tenant scope, ranking inputs, Memory Center DTOs, and localized product copy |
| Projection/transcript | xox builds generic transcript/timeline trees from provider/goal/action/run events | Agentic OS projection/server package owns generic run tree, grouping, visibility, provider stream grouping, and action/observation joins; xox keeps Chinese labels, navigation links, and contract DTO shape |
| Host kit size | `xox-agentic-os-host-kit.ts` remains a large runner-like orchestration file | Collapse host kit into thin HostProfile/HostAdapter wiring. The file should stop being the loop narrative |

## Non-Negotiable Deletions or Collapses

M142 implementation cuts should delete whole files where possible. If a file cannot be deleted because it still owns real xox peripheral behavior, it must be collapsed and renamed/positioned so it is clearly a host adapter, not a harness subsystem.

Primary targets:

- `apps/api/src/agent/agentic-os/xox-agentic-os-host-kit.ts`
  - Must shrink from runner narrative to HostProfile/HostAdapter wiring.
  - Must not construct generic lifecycle event types directly.
- `apps/api/src/agent/loop-obligation-ledger.ts`
  - Delete or reduce to financial/domain policy declarations consumed by Agentic OS evidence/obligation runtime.
- `apps/api/src/agent/response-evaluator.ts`
  - Delete generic final answer hygiene and completion gate logic from xox.
  - Keep only xox financial policy if needed.
- `apps/api/src/agent/evidence-ledger.ts`
  - Delete generic ledger mechanics from xox.
  - Keep only domain evidence requirement source policy if needed.
- `apps/api/src/agent/goal-contract.ts`
  - Convert to durable SQL adapter for Agentic OS goal facts, or delete if Agentic OS server can own the abstraction.
- `apps/api/src/agent/agent-transcript-projector.ts`
  - Remove generic transcript tree construction.
- `apps/api/src/agent/agent-timeline-projector.ts`
  - Remove generic timeline tree construction.
- `apps/api/src/agent/memory-kernel.ts`
  - Remove generic lifecycle events and kernel orchestration from xox.
- `apps/api/src/agent/agentic-os/xox-action-approval-adapter.ts`
  - Deleted in M143. Do not reintroduce a host approval adapter; keep HTTP glue in routes, business execution in `tool-executor.ts`, and resume semantics in Agentic OS host kit/core.
- `apps/api/src/agent/agentic-os/xox-runtime-planning-adapter.ts`
  - Deleted in M145. Do not reintroduce a standalone provider planning facade.
  - Any unavoidable xox provider settings, tool catalog materialization, business budgets, localized copy hook, and legacy DTO projection must live at `xox-runtime-adapter.ts`, the concrete runtime boundary.
- `apps/api/src/agent/agentic-os/xox-tool-observation-adapter.ts`
  - Keep only xox prompt additions, provider settings, final message persistence, and product DTO mapping.

## Module Division

| Responsibility | Agentic OS owner after M142 | xox owner after M142 |
| --- | --- | --- |
| Agent loop and next-step state machine | `@agentic-os/core` / `@agentic-os/server` | none |
| Goal lifecycle event drafts | `@agentic-os/server` | durable SQL adapter only |
| Goal status transition semantics | `@agentic-os/server` | row persistence adapter only |
| Provider planning and retry lifecycle | `@agentic-os/runtime-openai-compatible` + `@agentic-os/server` | provider settings, key source, model policy, business budget callback |
| Tool/action confirmation lifecycle | `@agentic-os/core` / `@agentic-os/server` ActionRuntime | xox business write executor, audit, product DTO |
| Observation-to-continuation lifecycle | `@agentic-os/core` / runtime package | xox prompt additions and final message persistence |
| Evidence ledger mechanics | `@agentic-os/core` | financial/shareholder evidence policy |
| Final review repair loop | `@agentic-os/core` / `@agentic-os/server` | domain finding policy and localized copy |
| Memory lifecycle | `@agentic-os/core` memory runtime | memory DB/store/ranking inputs and Memory Center DTO |
| Generic transcript/timeline projection | `@agentic-os/server` projection | Chinese copy, navigation links, `@xox/contracts` DTO |
| Event append ordering | `@agentic-os/server` | Kysely event row adapter |

## Dependency Graph

Target dependency direction:

```text
xox routes / worker
  -> xox host adapters
  -> @agentic-os/server run engine and lifecycle services
  -> @agentic-os/core loop, evidence, action, memory, projection primitives
  -> @agentic-os/runtime-openai-compatible / @agentic-os/runtime-openai-agents

xox host adapters
  -> xox DB, domain services, provider settings, business tools, localized copy
```

Forbidden dependency direction:

```text
xox host adapter
  -> hand-built goal/provider/action/memory/final-review lifecycle
  -> custom event sequencing
  -> custom loop repair state
  -> custom generic transcript tree
```

## Agentic OS Work Required

M142 is expected to change Agentic OS, not only xox. At minimum, Agentic OS needs reusable APIs for:

- server-owned goal lifecycle event drafts and durable goal transition ports;
- final review orchestration that accepts host domain policy but owns generic evidence/obligation repair;
- action lifecycle event drafts and confirmation resume observation handoff;
- provider planning lifecycle event projection, retry events, and missing-observation repair events;
- model continuation lifecycle events;
- memory lifecycle event drafts beyond active recall;
- generic transcript/timeline projection from server run facts.

Each moved primitive must have Agentic OS tests before xox consumes it.

## xox Work Required

xox changes must be peripheral-only:

- adapt Kysely rows to Agentic OS goal/run/action/evidence facts;
- supply financial/domain evidence policy as data/functions, not as a local final-review runtime;
- execute business writes and audit side effects;
- supply provider settings, keys, model policy, and business-specific high-volume tool budgets;
- supply memory store/retrieval/ranking inputs;
- localize product copy through hooks or DTO projection;
- keep existing API response shapes unless an explicit product change is approved.

## Architecture Guards

M142 implementation cuts must extend `apps/api/tests/agent-architecture.test.ts` with guards that fail if xox reintroduces host-owned harness semantics.

Required guards:

- `xox-agentic-os-host-kit.ts` must not contain direct literal construction of these generic event types:
  - `goal_contract_created`
  - `goal_iteration_started`
  - `model_planning`
  - `goal_evaluated`
  - `final_answer_candidate`
  - `goal_iteration_exhausted`
  - `runner_obligation_materializing`
  - `runner_obligation_materialized`
- `xox-action-approval-adapter.ts` must not construct canonical `action_*` lifecycle event drafts directly.
- `xox-loop-readiness-adapter.ts` and `xox-runtime-planning-adapter.ts` must stay deleted; readiness priority and runtime planning recovery must be consumed through Agentic OS APIs at concrete xox peripheral boundaries.
- `xox-tool-observation-adapter.ts` must not construct `model_continuation*` lifecycle events directly.
- xox root files must not contain generic final review/evidence/obligation ledger runtime code.
- xox projection files must not own generic provider stream grouping or goal/action tree lifecycle logic.

These guards should check semantics, not just filenames, because move-only refactors are explicitly rejected.

## Acceptance Criteria

M142 is complete only when all are true:

- xox `apps/api/src/agent` file count and total lines drop materially.
- `xox-agentic-os-host-kit.ts` is no longer the narrative runner file.
- Generic lifecycle event drafts for goal, provider, action, memory, model continuation, evidence, and final review are emitted by Agentic OS packages or server-owned helpers.
- xox still passes all existing API tests with unchanged public behavior.
- New Agentic OS tests cover every moved generic primitive.
- Architecture guards prevent the deleted local harness semantics from returning.
- Documentation reflects the new boundary: Agentic OS is the SaaS harness computer; xox is storage, memory, display, tools, policy, and transport peripherals.

## Validation

Run the full cross-repo gate because this commit is intentionally broad:

```powershell
cd C:\Github\agentic-os
npm.cmd run check
git diff --check

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test:api -- --run tests/agent-architecture.test.ts tests/action-observation.test.ts tests/provider-runtime.test.ts
npm.cmd run test:api
git diff --check
```

If navigation consumes changed Agentic OS packages in the same branch, also run:

```powershell
cd C:\Github\navigation
npm.cmd run typecheck -w apps/server
npm.cmd run test -w apps/server
```

## Commit Rule

A M142 completion commit must be a real amputation commit:

- no compatibility shim that keeps the old host-owned harness semantics alive;
- no move-only rename that preserves the same runner code under a new filename;
- no partial claim that only fixes one domain while leaving the same callback/lifecycle problem in the others;
- no green final answer without the validation evidence above.

If the full cut is too large to validate, split the code internally while working, but present M142 only after the full scope passes.
