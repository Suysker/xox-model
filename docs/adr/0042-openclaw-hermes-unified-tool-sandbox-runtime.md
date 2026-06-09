# ADR 0042: OpenClaw/Hermes Unified Tool Sandbox Runtime

Status: Proposed

Date: 2026-06-10

Refines: ADR 0016 Manifest Scoped Sandbox Tool, ADR 0018 AgentRunEngine v2 Single-Loop Harness, ADR 0020 Progressive Tool Discovery Runtime, ADR 0021 Turn Lane Resolution And Direct Answer Runtime, ADR 0041 OpenClaw-Style Observe-Before-Sandbox Quality Loop

Supersedes these ADR 0041 decisions:

- `sandbox_run_code` must not be hard-wired behind a fixed `data_query_workspace -> sandbox_run_code` path.
- Write-capable sandbox SDK functions must not be policy-stop stubs by default.
- `xox_sandbox.load_structured()` must not be the model-facing domain data API.

## Context

Recent sandbox and finance-calculation regressions exposed a deeper harness issue, not a single bad prompt:

- Provider tool calls and sandbox code used different vocabularies. The model could call `data_query_workspace(...)`, but sandbox examples used low-level helpers such as `load_structured()`.
- Sandbox writes were described as impossible, even though the real SaaS boundary should be tenant isolation, policy, approval and audit, not a blanket ban on write intent inside code.
- Tool discovery became too volatile. Useful kernel tools such as sandbox, scoped search and tool search should not disappear because a reranker decided to expose a narrow business subset.
- Some documents made one workflow mandatory for one class of questions. That is not OpenClaw-style harness design. A mature harness gives the model observations, tools and repair feedback inside one loop; it does not encode a product-case script.

The target is not to copy OpenClaw, Hermes or OpenAI Agents JS as control planes. The target is to absorb their runtime ideas into xox-model's SaaS boundary:

- OpenClaw: a small stable runtime kernel, tools mediated by a gateway, permission modes, model-observed tool results and repair loops.
- Hermes: core tools are always loaded, deferred tools are searched/described/called through the same tool executor, and bridge calls are unwrapped so hooks/guardrails/approvals see the real tool.
- OpenAI Agents JS: runner-side approvals, tracing, guardrails and sandbox/session/capability boundaries.

## Decision

Adopt a **Unified Tool Sandbox Runtime**:

```text
If the model can call a provider tool named X with arguments A and receive result R,
then sandbox code can call xox_sandbox.X(**A) and receive the same result contract R.
```

This is one logical tool runtime with multiple entry surfaces:

1. Provider surface: model emits OpenAI-compatible `tool_calls`.
2. Sandbox SDK surface: code inside `sandbox_run_code` calls `xox_sandbox.<tool_name>(...)`.
3. Tool-search bridge surface: model asks for deferred tools, then invokes a materialized tool through the same runtime.

All surfaces converge on the same Tool Runtime Gateway. No surface may call domain services, the database, internal HTTP endpoints or production secrets directly.

## Canonical Loop

The loop remains a single OpenClaw-style harness loop:

```mermaid
flowchart TD
  User["User Turn"] --> Lane["Turn Lane Resolver"]
  Lane --> Context["Context Pack<br/>session + memory + page state"]
  Context --> Catalog["Effective Tool Catalog<br/>fixed core + searched deferred tools"]
  Catalog --> Model["Provider Model Turn"]

  Model -->|assistant text| AssistantObs["Assistant Draft"]
  Model -->|provider tool_calls| ToolRuntime["Tool Runtime Gateway"]
  Model -->|sandbox_run_code| Sandbox["Sandbox Session"]

  Sandbox -->|xox_sandbox.tool_name(args)| ToolRuntime
  ToolRuntime --> Policy["Policy / Tenant / Approval / Audit"]
  Policy -->|read or auto-allowed write| Domain["Domain Services"]
  Policy -->|approval needed| AggregateApproval["Aggregate Sandbox Approval<br/>one interrupt for the sandbox run"]

  Domain --> Observation["Tool Observation Ledger"]
  AggregateApproval --> Observation
  Observation --> Model

  AssistantObs --> Evaluator["Response / Goal Evaluator"]
  Evaluator -->|continue / repair| Catalog
  Evaluator -->|wait for human| Wait["Wait"]
  Evaluator -->|pass| Final["Final Assistant Answer"]
  Evaluator -->|terminal| Fail["Fail Closed"]
```

The model decides the next action from observations. The runtime decides whether a tool call is allowed, needs approval, must be audited, should be repaired, or must fail closed.

## Fixed Core Tools Plus Deferred Business Tools

xox-model should not provide every business tool on every turn, and it should not make every tool fully dynamic either.

Adopt two layers:

### Core Tool Set

The Core Tool Set is always visible for Agent-goal turns:

- `sandbox_run_code`
- tool discovery/search controls, currently `tool_discover` and future Hermes-style `tool_search / tool_describe / tool_call`
- manifest-scoped `rg`
- `ask_user_clarification`
- direct account-action refusal tool where needed
- minimal navigation/open-panel controls when the product action requires visible page movement

Core tools are small, stable and runner-owned. They are not deferred and must not be removed by capability hints, rerankers or context-budget optimizers.

### Effective Deferred Catalog

Business tools remain in an effective catalog:

- Built from `AGENT_TOOL_REGISTRY` and policy/session/workspace context.
- Cached by registry generation, workspace id, user id, automation level, provider family and policy version.
- Revalidated with a short TTL and fail-closed stale handling.
- Searchable and describable by model-selected tool search.
- Executed only through the Tool Runtime Gateway.

This fuses the two mature patterns:

- OpenClaw's progressive disclosure and gateway-mediated tool call.
- Hermes' retrieval-style tool search with always-loaded core tools and bridge unwrapping.

## Sandbox SDK Contract

Sandbox SDK functions are generated from the same tool registry as provider tools.

```ts
type ToolRuntimeSurface = 'provider' | 'sandbox' | 'tool_search_bridge'

type ToolRuntimeInvocation = {
  surface: ToolRuntimeSurface
  toolName: AgentToolName
  args: Record<string, unknown>
  userId: string
  workspaceId: string
  threadId: string
  runId: string
  automationLevel: 'manual' | 'low' | 'medium' | 'high'
  parentSandboxRunId?: string
  correlationId: string
}

type ToolRuntimeResult = {
  ok: boolean
  toolName: AgentToolName
  output?: unknown
  displayPreview?: string
  observationRef?: string
  requiresApproval?: boolean
  aggregateApproval?: SandboxAggregateApproval
  actionRequests?: Array<{ id: string; riskLevel: 'low' | 'medium' | 'high' }>
  error?: {
    code: string
    message: string
    repairable: boolean
  }
}
```

Python shape:

```python
import xox_sandbox

summary = xox_sandbox.data_query_workspace(
    scope="workspace_summary",
    metrics=["roi", "cash", "payback"],
)

patch = xox_sandbox.workspace_patch_config(
    patches=[{"path": "shareholders[1].investmentAmount", "value": 1000000}],
)

xox_sandbox.emit({"summary": summary, "patch": patch})
```

JavaScript shape:

```js
import { dataQueryWorkspace, workspacePatchConfig, emit } from './xox_sandbox.mjs'

const summary = await dataQueryWorkspace({
  scope: 'workspace_summary',
  metrics: ['roi', 'cash', 'payback'],
})

const patch = await workspacePatchConfig({
  patches: [{ path: 'shareholders[1].investmentAmount', value: 1000000 }],
})

emit({ summary, patch })
```

`load_structured()` and `load_rows()` may remain as low-level helpers for file/bundle manipulation, but they are not the primary model-facing contract for business data. The primary contract is the same tool name, same argument schema and same output schema as provider tool calls.

## Sandbox Writes And Aggregate Approval

Sandbox write calls are allowed only through the unified Tool Runtime Gateway.

Rules:

- A sandbox cannot write directly to DB, files, memory stores, internal HTTP endpoints or domain services.
- A sandbox may call write-capable `xox_sandbox.<tool_name>(...)`.
- The gateway evaluates each nested tool call with the same tenant, policy, navigation, confirmation and audit logic as provider tool calls.
- If all nested writes are allowed by the current automation level, they may execute normally.
- If at least one nested write exceeds the current automation level, the whole sandbox run pauses on one aggregate approval interrupt.
- Aggregate approval presents the nested calls, max risk, page navigation, business diffs and editable action payloads as one coherent unit.
- After approval, replay must resume from the same sandbox run state or a deterministic replay state. It must not ask the model to invent the write calls again.
- If sandbox code later asks for additional writes or a higher risk than approved, the runtime opens a new aggregate approval.
- Every executed nested write still creates normal action/audit/observation records. Aggregate approval does not weaken auditability.

```ts
type SandboxAggregateApproval = {
  sandboxRunId: string
  title: string
  maxRisk: 'low' | 'medium' | 'high'
  requestedAutomationLevel: 'manual' | 'low' | 'medium' | 'high'
  nestedCalls: Array<{
    toolName: AgentToolName
    args: Record<string, unknown>
    riskLevel: 'low' | 'medium' | 'high'
    navigationTarget?: string
    diffPreview?: unknown
    editablePayloadRef?: string
  }>
  decision: 'pending' | 'approved' | 'cancelled'
}
```

This preserves the user's automation semantics: manual/low/medium/high controls write authorization, not planner effort.

## Scoped `rg`

`rg` is a fixed core tool because code-writing models need to inspect contracts and available functions.

It is still not host filesystem access.

Allowed roots:

- `tools/agent-tool-manifest.md`
- `tools/effective-tool-manifest.md`
- `observations/*.json`
- `observations/*.md`
- `inputs/**` files explicitly mounted in the sandbox manifest
- generated SDK documentation for the current sandbox session

Forbidden roots:

- repository source files
- database files
- environment files
- provider keys
- server logs
- other tenants' data
- memory stores not explicitly materialized as same-run observations
- absolute paths, symlinks and `..` traversal

`rg` helps the model use authorized tools correctly. It must not become a side channel to discover unapproved tools or tenant data.

## Relationship To Existing ADRs

### ADR 0016

Keep manifest-scoped sandbox isolation, execution backend selection, file policy and artifact boundaries.

Correct the interpretation: sandbox is not read-only by definition. It is direct-access forbidden. Writes are allowed only as nested calls through the unified Tool Runtime Gateway and may require aggregate approval.

### ADR 0018

Keep one `AgentRunEngine` main loop. Tool discovery, sandbox execution, memory, approvals, evaluator and final answer generation are stages inside that loop, not independent planners.

### ADR 0020

Keep progressive tool discovery. Refine it with Hermes' always-loaded core tools and OpenClaw's effective tool inventory:

- Core tools are always injected.
- Non-core business tools are searchable, describable and materialized.
- Bridge calls execute as real tools through the same runtime.

### ADR 0021

Keep direct-answer lane resolution for ordinary conversation and simple ambient facts. Direct-answer turns should not enter sandbox or business tool discovery.

### ADR 0041

Keep the lesson that model-facing tool contracts and sandbox code contracts must be unified.

Supersede the fixed path that made `data_query_workspace -> sandbox_run_code` mandatory for a class of questions. A data read is often the right observation, but it is not a hardcoded route. The main loop, model and evaluator decide from evidence, not from a case-specific workflow.

## Implementation Plan

### 1. Document And Contract Alignment

Edit:

- `docs/agent-design.md`
- `docs/agent-tool-manifest.md`
- `docs/adr/0041-openclaw-style-observe-before-sandbox-quality-loop.md`
- `.agent/lessons.md`

Goal:

- Remove stale policy-stop and read-only sandbox wording.
- Mark ADR 0041's hardcoded path as superseded.
- Define same-name/same-args/same-output as the contract.

### 2. Tool Runtime Invocation Boundary

Edit:

- `packages/contracts/src/index.ts`
- `apps/api/src/agent/tool-runtime.ts`
- `apps/api/src/agent/tool-gateway.ts`
- `apps/api/src/agent/tool-executor.ts`

Goal:

- Introduce `ToolRuntimeInvocation` and `ToolRuntimeResult`.
- Make provider calls, tool-search bridge calls and sandbox nested calls enter the same gateway.
- Preserve tenant, policy, confirmation and audit checks at that gateway.

### 3. Generated Sandbox SDK

Edit:

- `apps/api/src/agent/sandbox-service.ts`
- `apps/api/src/agent/sandbox/backends/*`
- `apps/api/src/agent/tool-context-engine/tool-manifest.ts`
- `docs/agent-tool-manifest.md`

Goal:

- Generate `xox_sandbox.<tool_name>(...)` and JS camelCase functions from `AGENT_TOOL_REGISTRY`.
- Route calls back to the Tool Runtime Gateway.
- Keep `load_structured()` only as a low-level helper.

### 4. Aggregate Sandbox Approval

Edit:

- `apps/api/src/agent/automation-policy.ts`
- `apps/api/src/agent/action-graph-store.ts`
- `apps/api/src/agent/action-executor.ts`
- `apps/api/src/agent/sandbox-service.ts`
- `apps/web/src/components/agent/*`

Goal:

- Pause the whole sandbox run on one aggregate approval when nested writes exceed automation level.
- Preserve editable confirmation-card payloads.
- Resume deterministically after approval.

### 5. Core Tool Set And Effective Catalog

Edit:

- `apps/api/src/agent/tool-context-engine/*`
- `apps/api/src/agent/runtime-planning-call.ts`
- `apps/api/src/agent/provider-runtime-planner.ts`

Goal:

- Always inject core tools.
- Keep non-core tools deferred/searchable when the catalog is large.
- Cache effective catalog by registry/policy/session/workspace/provider context.

### 6. Validation

Commands:

```powershell
npm.cmd run test:api -- sandbox-tool
npm.cmd run test:api -- tool-runtime
npm.cmd run test:api
npm.cmd run test:web
npm.cmd run build:web
```

Real-provider smoke:

- A calculation turn can use provider tool calls, sandbox SDK tool calls and final answer generation without switching contracts.
- A sandbox write request above the current automation level produces one aggregate approval, not many separate prompts and not a blanket denial.
- A simple direct-answer turn such as `今天是几月几号` does not enter sandbox or tool discovery.

## Acceptance Criteria

- Provider `data_query_workspace(args)` and sandbox `xox_sandbox.data_query_workspace(**args)` return the same structured contract for the same tenant-authorized request.
- Provider and sandbox write calls use the same action preview, navigation, confirmation, execution and audit path.
- Sandbox can request writes through the same tool names. It cannot write directly.
- If sandbox nested writes exceed automation level, the UI shows one aggregate approval for the sandbox run.
- Core tools remain visible in every Agent-goal planning turn.
- Non-core business tools are discoverable without injecting the entire registry every turn.
- `rg` is manifest-scoped and cannot search host files, DB, env, logs, memory stores or other tenant data.
- No prompt or doc requires a hardcoded `data_query_workspace -> sandbox_run_code` route.
- `load_structured()` is not presented as the primary domain-data API.

## Non-Goals

- Do not import OpenClaw or Hermes control planes.
- Do not add a second runtime adapter.
- Do not implement semantic routing with regex, keyword tables or localized aliases.
- Do not expose arbitrary filesystem, network, DB, secret or tenant access inside sandbox.
- Do not reduce final answer quality with a global short-answer cap.
