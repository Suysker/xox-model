# M128 Delete Loop Obligations Facade

Status: Implemented

Date: 2026-06-21

## Goal

Delete the xox-owned `loop-obligations.ts` facade. Agentic OS already owns the generic obligation runtime pieces; xox should not keep a separate host framework file that looks like a local obligation planner.

## What Changed

Deleted from xox:

- `apps/api/src/agent/loop-obligations.ts`

Folded into the real xox obligation adapter:

- response-evaluator finding to xox obligation DTO mapping;
- xox `goalFacts`, `requiredDataScopes`, and `requiredMetrics`;
- xox Chinese user-safe failure copy;
- xox plan DTO projection from the Agentic OS canonical plan.

Still owned by Agentic OS:

- generic obligation plan aggregation through `ledgerToObligationPlan()`;
- generic ledger projection through `projectObligationLedger()`;
- final-review additional obligation merge through `projectObligationLedgerWithAdditionalObligations()`;
- runtime-boundary repair state through `projectObligationStateWithAdditionalObligations()`;
- obligation materialization planning through `planObligationMaterialization()`.

## Boundary

`loop-obligation-ledger.ts` is now the only xox obligation adapter. It is allowed to understand xox financial/domain evidence policy and legacy DTO shape, but it must call Agentic OS for generic harness obligation planning and projection.

No xox source should import or recreate `loop-obligations.ts`.

## Verification

- `npm.cmd run build:api`
- `npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts tests/response-evaluator.test.ts tests/loop-obligation-ledger.test.ts`
- `npm.cmd run test:api`
