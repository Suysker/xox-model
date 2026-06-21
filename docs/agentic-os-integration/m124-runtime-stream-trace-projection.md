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

- `apps/api/src/agent/agentic-os/xox-run-event-store-adapter.ts`: Kysely durable event append, row serialization, thread signal publication, xox Chinese copy adapter and redaction hook. This adapter was still rooted at `apps/api/src/agent/run-events.ts` when M124 landed; M134 deleted the root file.
- Runtime callers still pass stream events from planning/final-answer lanes, but they no longer import a host trace wrapper.

## Verification

- Agentic OS `@agentic-os/server` build and tests.
- xox `npm.cmd run build:api`.
- xox architecture test guards the deleted trace file and requires `agentic-os/xox-run-event-store-adapter.ts` to consume `@agentic-os/server`.
- xox full API suite.
