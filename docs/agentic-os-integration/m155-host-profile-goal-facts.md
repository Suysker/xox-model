# M155: Host Profile Goal Facts

Status: verified
Date: 2026-06-22

## Goal

Delete the root `apps/api/src/agent/runtime-goal-facts.ts` file and move its remaining policy to `apps/api/src/agent/host-profile/xox-goal-facts.ts`.

The code sanitizes, merges and reads xox-specific goal facts such as required action capabilities, forbidden publish/share actions, expected model size, and sandbox/entity evidence hints. Those are host product facts. They are not a generic runtime subsystem, and the root filename made xox look like it owned an Agentic OS runtime facts layer.

## Boundary

Agentic OS owns:

- goal contract lifecycle;
- loop readiness and evidence semantics;
- provider/runtime event lifecycle.

xox owns:

- product-specific goal fact vocabulary;
- safe parsing of model-emitted xox goal facts;
- mapping persisted xox run events and goal rows back into host facts for business policy.

## Module Division

- `host-profile/xox-goal-facts.ts`
  - owns `sanitizeAgentGoalFacts()`, `mergeAgentGoalFacts()`, `goalFactsFromRunEvent()`, and `readRuntimeGoalFacts()`;
  - is consumed by xox adapters and business action drafts.
- `runtime-goal-facts.ts`
  - deleted and guarded from returning.

## Validation

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test:api
git diff --check
```

Expected:

- root `runtime-goal-facts.ts` is absent;
- imports point to `host-profile/xox-goal-facts.ts`;
- behavior is unchanged.
