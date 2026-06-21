# M126 Server AG-UI Event Projection

Status: Implemented

Date: 2026-06-21

## Goal

Delete xox-owned AG-UI event projection and consume `@agentic-os/server` projection infrastructure instead.

## What Moved

Moved to Agentic OS:

- run event ordering;
- provider stream delta to AG-UI content/tool-call events;
- lifecycle event to AG-UI run/step events;
- plan step and action request event projection;
- configurable host event-name prefix.

Deleted from xox:

- `apps/api/src/agent/ag-ui-projection.ts`

## What Stayed In xox

- submitted-run/thread-state response DTO wiring;
- `eventNamePrefix: 'xox'`;
- transcript item, timeline item and transcript node product projections;
- Chinese copy and navigation mapping.

## Verification

- Agentic OS server build and tests.
- xox `npm.cmd run build:api`.
- xox architecture/transcript tests.
- xox full API suite.
