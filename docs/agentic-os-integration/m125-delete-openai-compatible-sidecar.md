# M125 Delete OpenAI-Compatible Host Sidecar

Status: Implemented

Date: 2026-06-21

## Goal

Delete the remaining xox OpenAI-compatible runtime sidecar and keep one provider selection boundary.

## What Changed

Deleted from xox:

- `apps/api/src/agent/runtime/openai-compatible-chat-adapter.ts`

Folded into xox:

- settings/prompt/user-content mapping;
- provider stream source bridging;
- runtime error DTO narrowing;
- normalized provider call to xox planner-step mapping.

Already owned by Agentic OS:

- `runOpenAICompatibleRuntimeTurn()`;
- request shaping and transport;
- stream parsing and tool-call frame assembly;
- provider turn normalization;
- provider tool-call normalization and boundary validation;
- provider artifact/replay facts.

## Verification

- `npm.cmd run build:api`
- provider runtime tests through `planWithRuntimeAdapter`
- architecture guard requiring the sidecar to stay deleted
- full `npm.cmd run test:api`
