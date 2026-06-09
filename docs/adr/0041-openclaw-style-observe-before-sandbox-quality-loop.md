# ADR 0041: OpenClaw-Style Observe-Before-Sandbox Quality Loop

Status: Proposed

Date: 2026-06-10

Refines: ADR 0016 Manifest Scoped Sandbox Tool, ADR 0020 Progressive Tool Discovery Runtime, ADR 0032 Runner-Owned Evidence Contract v2, ADR 0036 Claim-Grounded Observation Loop, ADR 0039 Fast Accurate Main Loop, ADR 0040 Assistant Tool Lifecycle Evidence Lanes

Supersedes one decision from ADR 0039: a sandbox call must **not** replace model-visible domain observation for workspace-data calculations.

## Context

Recent regression comparisons between `6af70c27` and `9010a623` exposed a quality loss after the fast-path optimization:

- the better run first called `data_query_workspace`, then used sandbox code with observed business facts;
- the worse run skipped the model-visible domain read and asked `sandbox_run_code` to mount workspace data directly;
- the sandbox executed, but the generated code misunderstood the bundle shape (`totalRevenue` vs `grossSales`, `rows` as one summary row rather than twelve month rows);
- the final answer became shorter and less informative because the finalizer prompt also pushed a global short-answer policy.

The mistake was not that `xox_sandbox.load_structured()` exists. That helper is useful. The mistake was treating the sandbox data helper as a substitute for the model first observing the domain tool result.

For xox-model, OpenClaw remains the benchmark: one main loop, model observes environment feedback, tools return observations, and the assistant final answer is generated after those observations. Hermes contributes provider/tool-call hygiene and tool-result persistence discipline. OpenAI Agents JS contributes runner-side guardrail, tracing, HITL and sandbox boundaries.

## Reference Findings

### OpenClaw

Local reference: `C:\Github\openclaw`.

Relevant areas:

- `packages/llm-runtime/src/stream.ts`
- `packages/tool-call-repair/src/stream-normalizer.ts`
- `docs/tools/tool-search.md`
- `docs/tools/code-execution.md`
- `ui/src/ui/chat/tool-cards.ts`

Reusable ideas:

- Tool results are environment feedback, not assistant answers.
- Provider protocol repair belongs below the business loop.
- Assistant, tool and lifecycle events must stay separate.
- Code execution is a tool observation inside the same loop; failures are feedback for the model to repair.
- Tool search narrows inventory, but the selected tool still executes through the canonical tool-result path.

Do not copy:

- OpenClaw local control plane, local filesystem authority, plugin registry or host session assumptions.

### Hermes Agent

Local reference: `C:\Github\hermes-agent`.

Relevant areas:

- `agent/anthropic_adapter.py`
- `agent/agent_init.py`
- `tools/tool_search.py`
- `tools/tool_result_storage.py`
- `tools/code_execution_tool.py`

Reusable ideas:

- Tool calls and tool results are paired in the model message sequence.
- Dirty provider sequences are normalized without pretending to understand business intent.
- Large tool results have separate inline preview, stored raw result and model-readable content.
- Code execution can be powerful, but it must stay tool-mediated and bounded.

Do not copy:

- Hermes local machine authority, unrestricted local tool execution, or local user/session model.

### OpenAI Agents JS

Local reference: `C:\Github\openai-agents-js`.

Relevant areas:

- `packages/agents/README.md`
- `docs/src/content/docs/ko/guides/agents.mdx`
- `docs/src/content/docs/ko/guides/guardrails.mdx`
- `docs/src/content/docs/ko/guides/human-in-the-loop.mdx`
- `docs/src/content/docs/ko/guides/sandbox-agents.mdx`

Reusable ideas:

- Runner owns guardrails, tracing, HITL and sandbox boundaries.
- Tools receive typed context instead of reaching into arbitrary global state.
- Sandbox/session/manifest/capability boundaries are runner-side concepts, not business-tool shortcuts.

Do not copy:

- OpenAI-specific Responses-only assumptions into xox-model's OpenAI-compatible provider runtime.

## Decision

Adopt an **Observe-Before-Sandbox Quality Loop** for any task that combines current workspace data with external assumptions, scenario math, financing assumptions, inflation/discounting, or other derived calculations.

The required shape is:

```mermaid
flowchart TD
  User["User request"] --> Turn["Turn Lane Resolver"]
  Turn --> Catalog["Effective Tool Catalog<br/>progressive discovery + tool search"]
  Catalog --> Provider["Provider Planning Turn"]

  Provider -->|model-selected| DomainRead["data_query_workspace<br/>Domain Observation"]
  DomainRead --> Ledger["Observation Ledger<br/>model content + display + raw refs"]
  Ledger --> Replay1["Replay Observation To Model"]

  Replay1 --> Provider2["Provider Planning Turn"]
  Provider2 -->|model-selected| Sandbox["sandbox_run_code<br/>references domain observation"]
  Sandbox --> Ledger
  Ledger --> Replay2["Replay Observation To Model"]

  Replay2 --> Final["Assistant Final Candidate"]
  Final --> Eval["Response Evaluator<br/>claim + evidence + quality"]
  Eval -->|pass| Complete["Complete"]
  Eval -->|missing/invalid| Catalog
  Eval -->|human needed| Wait["Wait For Confirmation/Clarification"]
  Eval -->|terminal| Fail["Fail Closed"]
```

Short invariant:

```text
For workspace-data calculations, the model must observe the domain tool result before it writes sandbox code, unless an equivalent model-visible domain observation already exists in the same run.
```

This keeps the run fast by avoiding repeated reads, but not by hiding ground truth from the model.

## Contract

### Canonical Domain Observation

`data_query_workspace` is the canonical model-visible domain read for current workspace facts.

Target shape:

```ts
type DomainObservation = {
  id: string
  toolName: 'data_query_workspace'
  scope:
    | 'workspace_summary'
    | 'period_summary'
    | 'member_summary'
    | 'team_summary'
    | 'entity_summary'
    | 'top_months'
    | 'variance_detail'
    | 'ledger_history'
  schemaVersion: 'domain-observation.v1'
  structured: Record<string, unknown>
  rows?: Array<Record<string, unknown>>
  rowKind?: 'forecast_month' | 'ledger_entry' | 'variance_item' | 'none'
  entities?: Record<string, unknown>
  display: {
    title: string
    preview: string
  }
}
```

Important rules:

- `workspace_summary` is a summary object; it must not pretend that `rows` are month rows.
- Month-level data must use `rowKind: "forecast_month"` and explicit month rows.
- Ordered shareholders, members and cost objects must be represented in `entities` or in named structured fields.
- Field aliases used by tools (`grossSales`, `totalProfit`, `roi`, `shareholders`, `plannedRevenue`) must be shared with sandbox bundles.

### Sandbox Data Request

`sandbox_run_code` remains a real manifest-scoped execution tool, but its data request must be aligned with domain observations.

Target shape:

```ts
type SandboxDataRequest = {
  sourceObservationIds: string[]
  scopes: Array<DomainObservation['scope']>
  rowKind?: DomainObservation['rowKind']
  fields?: string[]
  assumptions?: Record<string, unknown>
}
```

The sandbox helper remains valid:

```python
import xox_sandbox
data = xox_sandbox.load_structured()
rows = xox_sandbox.load_rows()
xox_sandbox.emit({...})
```

But the helper must expose the same semantic contract the model already saw through `data_query_workspace`. It must not expose a second, hidden, incompatible shape.

### Observation Replay

Tool results must be replayed to the model as observations. The model, not the tool result projector, writes the final user answer.

The replay order for derived finance questions is:

```text
data_query_workspace observation
-> model sees domain structure
-> sandbox_run_code observation
-> model sees executed calculation output
-> assistant final answer
-> response evaluation
```

## Final Answer Quality Policy

Remove this global prompt rule:

```text
默认短答：优先用 1 个结论句 + 最多 4 个关键数字/要点。
除非用户要求详细报告，不要生成长表格、长解释、长“关键解读”。
```

Replacement policy:

- Answer depth follows the task and evidence, not a global brevity cap.
- Simple direct-answer turns such as greetings or current date stay concise through the Turn Lane Resolver.
- Derived finance answers should preserve useful evidence from sandbox output: assumptions, formula口径, key values, alternative口径 when relevant, and caveats.
- The assistant may be concise only when the user asks a simple question or the evidence itself is simple.
- The evaluator should reject final answers that drop requested variables or materially under-explain a complex calculation.

## Relationship To Existing ADRs

### Keep

- ADR 0016: real manifest-scoped sandbox, no business writes from sandbox.
- ADR 0020: progressive tool discovery plus Hermes-style search/retrieval.
- ADR 0032: runner-owned evidence and response evaluation.
- ADR 0036: claim-grounded loop requiring domain facts before shareholder ROI claims.
- ADR 0040: assistant/tool/lifecycle lane separation and model/display/raw result split.

### Correct

ADR 0039's sandbox fast path must be narrowed:

- Keep `xox_sandbox.load_structured()` and `load_rows()`.
- Keep self-describing sandbox bundles.
- Remove the claim that sandbox should avoid a separate domain read for facts the model needs to reason about.
- The optimization target is not "one sandbox call instead of a domain observation"; it is "one domain observation, one sandbox call, no duplicate capability-router churn, no repeated memory injection, no fake tool rows".

ADR 0040's runner evidence separation remains valid, but it does not mean current workspace facts should always be hidden as runner-only evidence. For workspace-data calculations, the domain read is part of model cognition and should be a model-visible observation. Hidden runner evidence may support safety or evaluator checks, but it cannot replace the model's observed domain tool result.

## Implementation Plan

### 1. Prompt Cleanup

Edit:

- `apps/api/src/agent/prompts/planner.system.md`
- `apps/api/src/agent/prompts/tool-observation-finalizer.system.md`

Changes:

- Delete the instruction that says not to call `data_query_workspace` before sandbox for the same summary.
- Replace it with observe-before-sandbox language.
- Delete the global short-answer rule.
- Keep simple direct-answer behavior in the turn resolver, not in the finalizer prompt.

### 2. Shared Domain Observation Contract

Edit:

- `packages/contracts/src/index.ts`
- `apps/api/src/agent/data-agent.ts`
- `apps/api/src/agent/tool-catalog.ts`
- `apps/api/src/agent/sandbox-service.ts`
- `apps/api/src/agent/sandbox/backends/staged-sandbox-io.ts`

Changes:

- Introduce `DomainObservation` and `SandboxDataRequest` types.
- Make `data_query_workspace` response and sandbox bundles share field names and row semantics.
- Ensure `workspace_summary` does not expose ambiguous `rows`.
- Ensure `forecast_months` exposes month rows with a clear `rowKind`.
- Ensure `entity_summary` exposes ordered shareholders and investments.

### 3. Loop Obligation

Edit:

- `apps/api/src/agent/agent-run-engine.ts`
- `apps/api/src/agent/loop-obligations.ts`
- `apps/api/src/agent/loop-obligation-ledger.ts`
- `apps/api/src/agent/tool-context-engine/tool-reranker.ts`
- `apps/api/src/agent/runtime-planning-call.ts`

Changes:

- If a turn requires current workspace facts plus sandbox computation, open a `domain_observation_before_sandbox` obligation.
- Satisfy it only with same-run model-visible `data_query_workspace` observation or an explicitly replayed equivalent.
- Do not satisfy it with hidden runner-only prerequisites.
- After a matching domain observation exists, keep `sandbox_run_code` projected and make the sandbox request reference the observation id.

### 4. Sandbox And Result Quality Evaluation

Edit:

- `apps/api/src/agent/evidence-ledger.ts`
- `apps/api/src/agent/response-evaluator.ts`
- `apps/api/src/agent/loop-readiness-check.ts`

Changes:

- Treat sandbox results as valid computation evidence only when real execution completed and manifest consumption is proven.
- Add quality checks for structural anomalies:
  - `totalRevenue` or similar derived fields become zero while observed `grossSales` is non-zero;
  - `monthCount` is one when the user asked for a horizon/monthly calculation and domain evidence has many months;
  - final answer omits requested assumptions such as inflation rate, loan rate, shareholder index, investment amount, dividend ratio or selected ROI口径;
  - final answer ignores useful structured sandbox output.
- These checks must inspect typed observations and claims, not scan user prose with keyword lists.

### 5. Transcript Projection

Edit:

- `apps/api/src/agent/agent-transcript-projector.ts`
- `apps/api/src/agent/agent-timeline-projector.ts`
- `apps/web/src/components/agent/AgentChatTimeline.tsx`

Changes:

- Show model-selected `data_query_workspace` and `sandbox_run_code` as visible tools.
- Keep runner-only lifecycle and hidden prerequisites in technical logs.
- Show sandbox parsed output compactly in the tool row expansion.
- Ensure final assistant answer appears after tool observations.

### 6. Tests And Real-Provider Smoke

Edit:

- `apps/api/tests/api.test.ts`
- `apps/api/tests/response-evaluator.test.ts`
- `apps/api/tests/sandbox-tool.test.ts`
- `apps/api/tests/tool-runtime.test.ts`
- `apps/web/src/components/agent/AgentChatTimeline.test.ts`

Validation commands:

```powershell
npm.cmd run test:api -- response-evaluator
npm.cmd run test:api -- sandbox-tool
npm.cmd run test:api -- tool-runtime
npm.cmd run test:api
npm.cmd run test:web
npm.cmd run build:web
npm.cmd run test
```

Real-provider smoke cases:

```text
给我预测一下，如果目前的通胀率是15%，我的投资回报率是多少？
我是第2个股东，我投入的钱都是银行贷款出来的，银行利率是年利率3%
```

Expected trajectory:

```text
data_query_workspace
-> sandbox_run_code
-> assistant final answer
-> response_evaluated pass
```

```text
今天天气怎么样
```

Expected trajectory:

```text
direct answer or explicit unsupported-live-weather clarification
no workspace data tool
no sandbox
no goal/evaluator loop
```

## Acceptance Criteria

For the shareholder inflation/loan ROI class:

- The run cannot call `sandbox_run_code` as the first workspace-data observation.
- `data_query_workspace` must appear before sandbox unless an equivalent model-visible same-run domain observation already exists.
- Sandbox code reads the same structured contract the model observed.
- The final answer includes:
  - selected shareholder identity or ordinal;
  - investment amount;
  - dividend ratio or profit share;
  - base profit/shareholder profit;
  - loan interest;
  - nominal ROI;
  - loan-adjusted ROI;
  - inflation-adjusted ROI口径;
  - caveats when the model data lacks monthly cash-flow granularity.
- The final answer is allowed to be rich when the calculation is rich; no global short-answer rule may truncate it.
- ResponseEvaluator fails if sandbox output contains structural anomalies such as zero revenue from a non-zero workspace summary or one-month count from a twelve-month forecast.

For simple direct-answer turns:

- `今天是几月几号` uses the direct-answer lane and does not enter domain/sandbox harness.
- `你好` remains one concise assistant reply.

For UI/transcript:

- Tool rows show tool observations, not fake assistant answers.
- Technical lifecycle events remain behind technical log disclosure.
- Sandbox row expansion shows parsed output or raw artifact references, not only "completed".

## Non-Goals

- Do not add a second runtime adapter.
- Do not reintroduce keyword, regex or language-specific semantic routing.
- Do not remove `xox_sandbox.load_structured()`; align it with domain observation instead.
- Do not import OpenClaw/Hermes control planes.
- Do not make OpenAI Responses-only behavior a requirement.

## Migration Order

1. Prompt cleanup and documentation alignment.
2. Contract unification with tests for domain observation and sandbox bundle shape.
3. Loop obligation for observe-before-sandbox.
4. Evaluator quality checks.
5. Transcript projection checks.
6. Real-provider smoke with DeepSeek key supplied through local environment only.

This order is intentional: contract and observation shape must be fixed before evaluator strictness, otherwise the evaluator will only add another layer of noise.
