# ADR 0013: Clarification Resume and Cross-Domain Goal Loop

Status: Implemented

Date: 2026-05-24

Refines: ADR 0004 Evaluator-Centered Harness Agent, ADR 0012 Tool Result Observation Continuation Loop

## Context

Conversation `c7b3b3ec` exposed a harness-level failure on a realistic cross-domain request:

```text
我们几个月才能回本？帮我记一笔成员A的今天的线上10张，然后帮我第一个股东注资100w
```

The request spans:

- read-only data query: payback period
- ledger write preview: member online sales
- draft write preview: shareholder capital update

The first turn asked a clarification for the ambiguous member name, but the run stopped before preparing the independent shareholder draft confirmation. The next user answer was treated as a new standalone goal, so the original multi-action objective was lost.

This is not a UI problem. It is a goal-loop problem.

## Root Causes

1. **Ordinal shareholder phrases were extracted as cardinal facts**
   - `第一个股东` must mean an ordinal reference to an existing shareholder.
   - It must not become `expectedShareholderCount = 1`.

2. **Clarification stopped independent planning too early**
   - A clarification for `memberName` blocks the ledger action.
   - It does not block a shareholder investment draft action.
   - The evaluator must continue planning independent missing capabilities before waiting.

3. **Clarification answers were not resumed as the same goal**
   - A message like `是的。成员1` is not a new business objective.
   - It is a continuation of the previous `needs_clarification` goal in the same thread.

4. **Business validation returned null instead of a visible clarification**
   - `ledger_create_member_income` could silently return no planned item when a member name did not match exactly.
   - Domain validation should either produce a confirmation card or a visible clarification/failure observation.

## Decision

xox-model will add a **Clarification Resume Boundary** inside the existing Goal Run Engine.

The kernel remains:

```text
user message
  -> goal contract
  -> model planning
  -> action graph / observations
  -> evaluator
  -> repair planning or interruption
  -> final model answer
```

But when the latest prior goal in the same thread is `needs_clarification`, the next user message is converted into a scoped resume objective:

```text
继续上一轮等待澄清的 Agent 目标
用户本轮补充: ...
上一轮澄清问题: ...
本轮只补齐仍缺失的能力: ...
已有确认卡不要重复
```

The original thread messages remain available through `threadConversationLog`, but the new goal contract only tracks the missing work for this resume turn. This prevents duplicate cards while still letting the model resolve references from the same conversation.

## Module Division

| Module | Path | Responsibility |
| --- | --- | --- |
| Goal fact extraction | `apps/api/src/agent/goal-fact-extractor.ts` | Extract hard goal facts without confusing ordinal references with target counts. |
| Completion evaluator | `apps/api/src/agent/completion-evaluator.ts` | Continue independent missing capabilities even when another step needs clarification. |
| Clarification resume | `apps/api/src/agent/clarification-resume.ts` | Build a scoped resume objective from the previous `needs_clarification` goal, latest evaluation, and latest clarification step. |
| Goal run engine | `apps/api/src/agent/goal-run-engine.ts` | Use the resume objective for planning/evaluation while preserving the user message in thread history. |
| Ledger action drafts | `apps/api/src/agent/ledger-action-drafts.ts` | Resolve normalized member names and return visible clarification observations instead of silent nulls. |
| Tool catalog gateway | `apps/api/src/agent/tool-gateway.ts` | Keep capability routing model-owned, but document that shareholder capital updates belong to `draft`, not `ledger`. |

## Dependency Graph

```text
run-submission
  -> goal-run-engine
    -> clarification-resume
      -> agent_goals / agent_evaluations / agent_plan_steps / agent_action_requests
    -> planner
      -> context-pack
      -> tool-gateway
      -> runtime provider
      -> action-graph-store
        -> action draft builders
          -> domain services
    -> completion-evaluator
```

No frontend code owns the resume logic. The UI renders the server-owned action graph.

## Invariants

- A clarification for one business field must not hide other independent actions in the same user request.
- The answer to a clarification resumes the previous pending goal unless the user starts a new thread or the previous goal is no longer `needs_clarification`.
- Existing pending confirmation cards must not be duplicated in the resume turn.
- Tool builders must prefer domain validation and visible clarification rows over silent `null` when a model-selected tool has insufficient or unmatched arguments.
- Tool results remain observations; final answers still require the ADR 0012 continuation loop.

## Acceptance

- `第一个股东注资100w` does not create `expectedShareholderCount = 1`.
- A run with `data_query_workspace + ask_user_clarification` and a missing independent `draft` capability continues to prepare the draft confirmation before waiting for the clarification answer.
- A follow-up message such as `是的。成员1` in the same thread resumes the prior goal and prepares the missing ledger confirmation without duplicating the existing draft confirmation.
- `成员1` resolves to `成员 1`; an unknown member name creates a visible clarification observation, not an invisible dropped tool call.
- API tests cover the `c7b3b3ec` failure shape.
