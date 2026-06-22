# M150 Final-Review Test Surface Amputation

Status: Completed

## Intent

This cut removes the xox-local test surface that still treated final review,
evidence ledgers, and obligation ledgers as downstream-owned harness machinery.
Those mechanics belong to Agentic OS. xox remains a SaaS host peripheral:
financial/shareholder policy, SQL/product DTO mapping, localized copy, and
business tool wiring.

## Direct Deletions

- Deleted `apps/api/tests/response-evaluator.test.ts`.
- Deleted `apps/api/tests/loop-obligation-ledger.test.ts`.
- Deleted unused `apps/api/src/agent/prompts/memory.system.md`, because active
  memory prompt assembly is owned by Agentic OS core.
- Removed public `xox-final-review-adapter.ts` exports that existed only for the
  deleted local harness tests:
  - `evidenceContainsKey()`
  - `buildEvidenceRequirements()`
  - `loopObligationsFromResponseEvaluation()`
  - `planLoopObligations()`
  - `activeLedgerObligations()`
  - `canAttemptFinalAnswer()`
  - `serializeObligationLedger()`
  - `osEvidenceRecordsFromXoxEvidence()`
  - `osEvidenceRequirementFromXoxRequirement()`

## Remaining Host Boundary

`apps/api/src/agent/host-profile/xox-final-review-policy.ts` remains only because
xox still has host-specific policy and DTO responsibilities:

- classify xox observations into Agentic OS evidence records;
- declare financial/shareholder evidence requirements;
- map xox goal facts, data scopes, and metrics into Agentic OS metadata;
- provide localized repair/failure copy;
- map Agentic OS obligation projections into the legacy xox API DTO shape.

It must not become a local final-review runtime again.

## Guards

`apps/api/tests/agent-architecture.test.ts` now asserts:

- the deleted test files stay absent;
- old root `response-evaluator.ts`, `loop-obligation-ledger.ts`, and
  `evidence-ledger.ts` stay absent;
- the public final-review harness helper exports stay absent;
- xox does not import the deleted `loop-obligations` facade;
- xox consumes Agentic OS final-review and obligation projection primitives
  instead of hand-owning generic ledger projection APIs.

## Validation

Run:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test --workspace @xox/api -- tests/api.test.ts -t "requires model-visible ordered shareholder evidence|keeps shareholder fact obligations open|repairs shareholder fact obligations|replays repairable sandbox failures"
npm.cmd run test:api
git diff --check
```

Agentic OS docs/LTM update:

```powershell
cd C:\Github\agentic-os
git diff --check
```
