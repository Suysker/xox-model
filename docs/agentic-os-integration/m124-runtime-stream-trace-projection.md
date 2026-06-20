# M124 Runtime Stream Trace Projection

Status: Implemented

Date: 2026-06-21

## Goal

Delete xox-owned provider runtime stream trace projection and consume the Agentic OS server projector instead.

## What Moved

Moved to Agentic OS:

- provider stream event to run event type mapping;
- assistant/tool/lifecycle channel selection;
- running/info/completed/failed status selection;
- stream-start, delta, repair, damage and completed payload projection;
- bounded delta/preview projection;
- append adapter contract for host stores.

Deleted from xox:

- `apps/api/src/agent/runtime-trace-events.ts`

## What Stayed In xox

- `apps/api/src/agent/run-events.ts`: Kysely durable event append, row serialization, thread signal publication, xox Chinese copy adapter and redaction hook.
- Runtime callers still pass stream events from planning/final-answer lanes, but they no longer import a host trace wrapper.

## Verification

- Agentic OS `@agentic-os/server` build and tests.
- xox `npm.cmd run build:api`.
- xox architecture test guards the deleted file and requires `run-events.ts` to consume `@agentic-os/server`.
- xox full API suite.
