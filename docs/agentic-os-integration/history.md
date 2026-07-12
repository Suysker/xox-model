# Agentic OS Integration History

Status: Consolidated historical ledger

Date: 2026-07-05

## Purpose

This document replaces the old `m107-*.md` through `m192-*.md` one-shot milestone files. It keeps the integration lineage readable without preserving dozens of stale implementation notes in the active documentation folder.

For exact deleted prose, use git history. For current integration rules, use [README.md](README.md).

## Phase Summary

| Milestones | Theme | Result |
|---|---|---|
| M107-M113 | Provider/runtime entry extraction | Removed old host OpenAI adapter shape; moved OpenAI-compatible runtime turns, planning recovery, turn intake, direct-answer, and clarification-resume mechanics toward Agentic OS-owned boundaries. |
| M114-M127 | Loop, observation, safety, projection primitives | Moved readiness decisions, final-review projection, missing-observation repair, tool supervision, evidence matching, prerequisite observations, tool discovery observations, content safety, sandbox runtime package, runtime stream trace, AG-UI projection, and claim extraction toward generic Agentic OS packages. |
| M128-M141 | Root harness facade deletion | Deleted misleading xox root facades for loop obligations, ambient context, host entrypoints, runtime directory, planning continuation, run-plane files, run submission, thread store, run worker, approval executor, action graph, active memory, and memory lifecycle events. |
| M142-M160 | One-shot host harness amputation | Consolidated the “xox must not own harness” rule and deleted local readiness/runtime/data/memory/projection/prompt/tool-gateway/context/planned-item facades. xox kept concrete business tools, prompts, SQL stores, routes, and DTO projection. |
| M161-M170 | Orchestration residue deletion | Removed standalone tool observation adapter, local observation continuation runner, hard-coded host-profile heuristics, local auto-execution decisions, local generic memory package, host harness pillars, and remaining root orchestration residue. |
| M171-M185 | Aggressive CPU amputation | Repeatedly cut host-profile, run-store, tool-result, sandbox, memory, action, and worker seams until xox consumed higher-level Agentic OS server/runtime facades instead of looking like it assembled the CPU itself. |
| M186-M188 | SaaS host computer boundary | Finalized high-level Agentic OS host computer, durable run host, action lifecycle, run interruption, and store profile APIs. xox became durable facts/effects plus business peripherals rather than local lifecycle owner. |
| M189 | Sandbox compute boundary | Reaffirmed that sandbox is a calculation/transformation peripheral, not the primary business-tool gateway. Top-level business tools remain the primary user-visible action/read path. |
| M190 | Realtime visibility correction | Restored user-visible assistant streaming after tool observations while keeping provider lifecycle, memory, final-review, and worker internals in technical logs. |
| M191 | Harness frontend audience surface | Integrated Agentic OS harness UI packages into xox web, separating ordinary user timeline from operator/developer trace surfaces. |
| M192 | Sandbox port cutover | Wired xox manifest-scoped sandbox execution into Agentic OS `AgentSandboxPort`, canonicalized sandbox manifest fields, and made local dev explicitly choose `local-script`. |
| M193 | Trace and causal history cutover | Wired durable Runtime/Trace stores and strict V4 provider pairing through the production SaaS facade. |
| M194 | Evaluator temporal authority | Adopted Agentic OS ADR0077 Review admission/Lane CAS, enforced a V2-only hard cutover with no V1 conversion path, rejected host deadline overrides, and locked delayed-candidate/exact-resume regressions. |

## Boundary Lessons Preserved

- xox-model must not keep a second agent harness. The local app provides tools, prompts, stores, context, product DTOs, and transport; Agentic OS owns the loop and generic lifecycle semantics.
- Filename shape matters. A downstream file named like a runner, resolver, final reviewer, memory kernel, worker, transcript projector, or provider runtime tends to become a second CPU and should be deleted or moved behind a concrete host adapter.
- Prompt assets are allowed when they are product policy text. They should live under `host-profile/prompts`, not in a generic-looking `agent/prompts` framework.
- Sandbox execution must be a manifest-scoped Agentic OS port. xox may build the input bundle and SDK manifest, but Agentic OS owns execution outcome, repair, transcript projection, and final-review evidence semantics.
- User-visible transcript rows must be semantic. Assistant content, tool calls, tool results, approvals, and final answers are visible; raw provider lifecycle, memory recall, final-review internals, and worker state belong to operator/developer trace.
- Tests should protect the desired boundary, not an intermediate milestone. When Agentic OS grows a higher-level facade, xox tests should stop depending on old low-level symbols.

## Current Deleted-File Guardrails

These categories were repeatedly deleted across the old milestone files and should not return:

- `agent-run-engine.ts`, `turn-resolver.ts`, `agent-action-runtime.ts`, local planner/session/kernel files
- local provider runtime directory and provider replay/request-shaping helpers
- local final-review, evidence, obligation, readiness, or response-evaluator modules
- local memory package / memory kernel helpers / active-memory orchestration files
- local sandbox backend, broker, staged IO, process runner, result parser, or tool RPC framework
- root run worker, run event, run lease, thread event, thread state stream, run submission, and thread store facades
- local transcript/timeline/AG-UI projection engines
- local tool gateway, tool observation continuation runner, tool observation adapter, and approval executor facades

Keep future cleanup notes in this file only when they change the durable integration lineage.
## M193: ADR0075/0076 Trace And Causal History Cutover

Date: 2026-07-12

- xox production construction moved to `createSaaSAgentHost()` with one scoped
  SQL CAS backend for Loop records, Runtime Execution Store, and Trace journal.
- Agentic OS V4 causal model history now owns assistant-before-effect commit,
  exact source-ordered result commit, provider acknowledgement, compaction,
  and provider projection.
- xox event reservation writes and commits the exact canonical event identity;
  product events remain a downstream projection.
- the fake provider rejects orphan, duplicate, mismatched, out-of-order, and
  incomplete results. Sanitized M189 shareholder and parallel-read fixtures
  exercise the production facade without a local replay builder.
