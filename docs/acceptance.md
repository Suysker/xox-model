# Acceptance

Status: Current after Agentic OS ADR 0074

## Harness Boundary

- [x] Complex runs enter the Agentic OS host kit and use one canonical Loop.
- [x] xox has no local continuation, evaluator-repair, or terminal-state loop.
- [x] Normal parent/child model calls use Runtime purpose `agent_turn`.
- [x] Runtime configuration is declarative and attempt-frozen.
- [x] Tool call, result, approval, clarification, wait, compaction, child, review,
  and finalization state survive exact resume without duplicate effects.

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

## Business Effects

- [x] Read tools return correlated observations.
- [x] Writes become server-owned editable action requests before execution.
- [x] Execution rechecks authz, scope, risk, revision, and domain validation.
- [x] Provider output or assistant text cannot write business state directly.
- [x] Failed or interrupted effects preserve Agentic OS replay discipline.

## Verification

- [x] `npm run build` passes.
- [x] API tests pass: 130/130.
- [x] Web tests pass: 78/78.
- [x] Agentic OS ADR0074 conformance passes through the real SaaS facade.
- [x] Architecture tests reject reintroduction of local harness control paths
  and legacy runtime-source API fields.

The previous milestone-by-milestone ledger is retained as historical evidence
in `docs/history/acceptance-pre-adr0074.md`.
