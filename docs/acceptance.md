# Acceptance

Status: Current after Agentic OS ADR 0075, ADR 0076, and ADR 0077

## Harness Boundary

- [x] Complex runs enter the Agentic OS host kit and use one canonical Loop.
- [x] xox has no local continuation, evaluator-repair, or terminal-state loop.
- [x] Normal parent/child model calls use Runtime purpose `agent_turn`.
- [x] Runtime configuration is declarative and attempt-frozen.
- [x] Tool call, result, approval, clarification, wait, compaction, child, review,
  and finalization state survive exact resume without duplicate effects.
- [x] V4 causal history commits the assistant call group before effects and
  exact source-ordered results before provider continuation.
- [x] xox contains no provider replay builder or trace-span authority.
- [x] Production host construction requires durable Runtime Execution Store
  and Trace Plane records on the scoped SQL backend.

## Runtime Source Migration

- [x] Current DB writes use `agent_runs.runtime_source` only.
- [x] Existing DBs rename the former column in place and ambiguous dual-column
  schemas fail closed.
- [x] Contracts/API/UI use `AgentRuntimeSource` and `runtimeSource` only.
- [x] Product labels describe model runtime, not a semantic planning component.

## SaaS Isolation

- [x] Every control record, event, memory, file bundle, artifact, and provider
  credential is tenant/workspace/user scoped.
- [x] Sandbox inputs contain only host-selected files and normalized data.
- [x] Sandbox cannot access the API process, DB, secrets, internal HTTP,
  container-external paths, or another tenant.
- [x] User/operator/developer projections apply audience redaction and bounds.
- [x] Event and trace reads remain scoped even when two tenants reuse a run id.

## Business Effects

- [x] Read tools return correlated observations.
- [x] Writes become server-owned editable action requests before execution.
- [x] Execution rechecks authz, scope, risk, revision, and domain validation.
- [x] Provider output or assistant text cannot write business state directly.
- [x] Failed or interrupted effects preserve Agentic OS replay discipline.
- [x] xox does not configure or derive Evaluator deadlines; Agentic OS admits
  Review/Lane timing and preserves it exactly across resume.
- [x] The delayed three-turn workspace/sandbox fixture passes, while an
  expired persisted Lane cannot reinvoke the xox provenance evaluator.

## Verification

- [x] `npm run build` passes.
- [x] Agentic OS ADR0074, ADR0075, and ADR0076 conformance passes through the
  real SaaS facade.
- [x] Strict fake-provider tests reject orphan, duplicate, mismatched,
  out-of-order, and incomplete tool results.
- [x] M189 shareholder and parallel-read causal pairing regressions pass.
- [x] `npm run smoke:agent:m189` exercises the same continuation topology on an
  explicitly configured real OpenAI-compatible provider without printing keys.
- [x] Real smoke evidence on 2026-07-12: configured DeepSeek
  `deepseek-v4-pro`, three model turns, `data_query_workspace`, final answer,
  zero provider-history failures, and zero write actions.
- [x] Sequential approval resumes and mixed pending/deferred tool-result groups
  preserve the Agentic OS source-order prefix invariant.
- [x] The complete API suite passes: 9 files and 133 tests, including strict
  Chat Completions and OpenAI Responses/Agents provider-history fixtures.
- [x] Architecture tests reject reintroduction of local harness control paths
  and legacy runtime-source API fields.

The previous milestone-by-milestone ledger is retained as historical evidence
in `docs/history/acceptance-pre-adr0074.md`.
