# M129 Ambient Session Context

Status: Implemented

Date: 2026-06-21

## Goal

Delete xox-owned ambient session context helper code and consume Agentic OS core for current date/time/timezone model facts.

## What Moved

Moved to Agentic OS:

- current `nowIso` assembly;
- timezone resolution fallback;
- local date formatting for a timezone;
- model-visible ambient session fact projection with `source: "agent_ambient_context"`.

Deleted from xox:

- `apps/api/src/agent/ambient-context.ts`

## What Stayed In xox

- user display name mapping from xox auth rows;
- workspace display name mapping from xox workspace rows;
- `XOX_AGENT_TIMEZONE` environment override;
- direct-answer prompt and Chinese product run-event copy.

## Dependency Graph

```text
xox turn/direct-answer adapters
  -> @agentic-os/core buildAgentAmbientSessionContext()
  -> @agentic-os/core agentAmbientSessionContextFacts()
  -> xox provider runtime callback
```

No xox source should import or recreate `ambient-context.ts`.

## Verification

- Agentic OS core build and tests.
- xox `npm.cmd run build:api`.
- xox architecture test guarding the deleted file.
- xox ambient/direct-answer focused API tests and full API suite.
