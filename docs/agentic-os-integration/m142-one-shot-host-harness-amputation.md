# M142 One-Shot Host Harness Amputation

Status: In Progress (lifecycle event draft cut started)

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
- `apps/api/src/agent/agentic-os/xox-runtime-planning-adapter.ts` still owns provider retry and planning lifecycle callbacks.
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
- Remaining xox memory candidate/context-flush persistence lives in `apps/api/src/agent/memory-consolidator.ts` as memory store/peripheral wiring, while event draft semantics come from Agentic OS.
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
npm.cmd run test:api -- --run tests/action-observation.test.ts tests/provider-runtime.test.ts tests/response-evaluator.test.ts tests/loop-obligation-ledger.test.ts tests/agent-transcript.test.ts
npm.cmd run test:api
git diff --check
```

Remaining M142 hard targets:

- Delete or collapse the xox-owned generic evidence/final-review/obligation runtime still visible in `response-evaluator.ts`, `loop-obligation-ledger.ts`, and `evidence-ledger.ts`.
- Move generic transcript/timeline tree projection out of `agent-transcript-projector.ts` and `agent-timeline-projector.ts`.
- Shrink `agentic-os/xox-agentic-os-host-kit.ts` further until it is HostProfile/HostAdapter wiring rather than the loop narrative.
- Continue deleting whole files when the remaining content is only a host harness facade.

## One-Shot Scope

M142 is not complete until all rows in this table are addressed. If a row cannot be completed in a given implementation cut, that cut must be presented as M142-in-progress rather than M142 completion.

| Domain | Current xox residue | M142 target |
| --- | --- | --- |
| Goal and plan lifecycle | Host kit creates goal contract, iteration, planning, evaluated, exhausted events and updates generic goal states around loop turns | Agentic OS owns goal lifecycle event drafts and loop-state transitions; xox provides durable goal/run row adapters |
| Evidence and final review | xox mixes final answer hygiene, evidence requirements, obligation projection, review obligations, and financial policy | Agentic OS owns generic final review gate, evidence ledger mechanics, obligation projection, and repair obligations; xox keeps financial/shareholder requirement policy only |
| Action lifecycle | xox writes canonical action executed/updated/cancelled/auto-execution lifecycle events and re-evaluates goal state after confirm | Agentic OS action runtime owns confirmation/edit/reject/execute lifecycle events and resume observation handoff; xox keeps business writes, audit rows, memory candidates, and product DTOs |
| Provider planning | xox owns provider retry event drafts, stable long-tool mode events, missing-observation recovery hooks, and provider planning lifecycle callbacks | Agentic OS runtime/server owns provider planning lifecycle, retry event drafts, boundary repair state, and stream event projection; xox keeps settings, tool catalog materialization policy, localized copy hook, and business budget policy |
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
  - Keep only business execution and row mapping. No canonical action lifecycle event construction.
- `apps/api/src/agent/agentic-os/xox-runtime-planning-adapter.ts`
  - Keep only provider settings, tool catalog materialization, business budgets, localized copy hook, and legacy DTO projection.
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
- `xox-runtime-planning-adapter.ts` must not branch on provider lifecycle event kinds to hand-build run events.
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
npm.cmd run test:api -- --run tests/agent-architecture.test.ts tests/response-evaluator.test.ts tests/loop-obligation-ledger.test.ts tests/action-observation.test.ts tests/provider-runtime.test.ts tests/agent-transcript.test.ts
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
