# Operations

Status: Current after Agentic OS ADR 0074

## Local Verification

```powershell
npm run build
npm test
```

Run provider smoke tests only with an explicitly configured scoped provider
credential. A missing credential fails closed; production requests never fall
back to natural-language rules that fabricate business tool calls.

## Agent Runtime

- xox enters Agentic OS through `xox-agentic-os-host-kit.ts`.
- Runtime source is `openai_agents`, `openai_compatible_tool_calls`, or the
  explicit local/CI `rules` path.
- Current DB/API/UI names are `runtime_source`, `AgentRuntimeSource`, and
  `runtimeSource`.
- Normal model execution uses Agentic OS Runtime purpose `agent_turn`.
- Provider adapters normalize streams and tool calls; they do not execute xox
  tools or own continuation.
- Run recovery resumes Agentic OS `AgentLoopStateV3` from tenant-scoped durable
  control records.

## Provider Settings

Provider settings are scoped to the current user and workspace. API responses
return only provider/model/base URL metadata and `hasApiKey`; the secret value
is never returned. Probe operations use the submitted or existing scoped key
without persisting transient form values.

## Sandbox

The host materializes only explicitly selected user files and normalized
business data. Production sandbox backends must be isolated; local script mode
is development-only. Network, internal HTTP, API process memory, DB paths,
provider secrets, user session tokens, and container-external paths are denied.

## Run Recovery

- workers claim a scoped run lease before entering the host kit;
- canonical events are persisted before UI projection;
- tool/action results use idempotency and provider call correlation;
- interrupted side effects are reconciled according to Agentic OS effect
  disposition and are not blindly replayed;
- late workers that lose their lease cannot publish terminal state.

## Diagnostics

Use `runEvents`, Agentic OS operator/developer projections, and durable control
records. Do not log provider keys, raw authorization headers, full prompts,
unbounded tool arguments, worker-local paths, or hidden reasoning.

The pre-ADR0074 operational ledger is retained at
`docs/history/operations-pre-adr0074.md`.
