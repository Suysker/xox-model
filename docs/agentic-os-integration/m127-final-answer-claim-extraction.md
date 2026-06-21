# M127 Final-Answer Claim Extraction Runtime

Status: Implemented

Date: 2026-06-21

## Goal

Delete the xox-owned final-answer claim extraction framework and consume `@agentic-os/server` claim extraction runtime instead.

## What Moved

Moved to Agentic OS:

- `final_answer_extract_claims` tool schema;
- generic claim extraction system prompt;
- claim kind validation and normalization;
- provider runtime request shape;
- started / unavailable / completed run-event draft lifecycle;
- unavailable handling when the provider omits the claim extraction tool.

Deleted from xox:

- `apps/api/src/agent/final-answer-claim-extractor.ts`

## What Stayed In xox

- xox subject taxonomy: workspace, shareholder, member, ledger entry, forecast, calculation and action;
- xox evidence projection through `evidenceForModel()`;
- `planWithRuntimeAdapter()` provider callback and settings/timeout/abort wiring;
- Agentic OS claim subject narrowing back to xox financial taxonomy;
- Chinese run-event copy;
- financial/shareholder final-review policy, including unscoped entity/domain claim defaulting in `evidence-ledger.ts`.

## Dependency Graph

```text
xox host-kit final review
  -> @agentic-os/server runAgentServerFinalAnswerClaimExtraction()
      -> xox planWithRuntimeAdapter callback
      -> xox addRunEvent callback
  -> xox response evaluator / evidence policy
```

No xox source should import or recreate `final-answer-claim-extractor.ts`.

## Verification

- Agentic OS server build and tests.
- xox `npm.cmd run build:api`.
- xox architecture test guarding the deleted file.
- xox final-answer claim review API tests and full API suite.
