# M116 Runtime Boundary Missing Observation Repair

Status: implemented
Date: 2026-06-20

## 目标

继续压缩 `apps/api/src/agent/host-profile/xox-agent-run-profile.ts`。

当前 host kit 在 provider 表达 `sandbox_run_code` 工具调用意图、重试后仍没有形成 tool observation 时，手写了一整段 runner repair state：

- `runtime_evidence_required` event；
- `response_evaluated` event；
- obligation ledger projection；
- obligation plan；
- next planner repair brief。

xox 应该只拥有 `sandbox_run_code -> sandbox_calculation` 的领域映射和中文产品文案。additional repair obligation 的 projection、去重、status count 和 obligation plan 生成应由 Agentic OS core 统一承担。

## 模块分工

Agentic OS：

- `@agentic-os/core`
  - 新增 `projectObligationStateWithAdditionalObligations()`；
  - 输入 canonical ledger、objective、additional obligations；
  - 输出 canonical obligation ledger projection 和 obligation plan；
  - 保证不突变 durable ledger，并按 runner identity 去重。

xox：

- `apps/api/src/agent/loop-obligations.ts`
  - 暴露 canonical Agentic OS plan -> xox plan DTO 的复用 adapter。
- `apps/api/src/agent/loop-obligation-ledger.ts`
  - 新增 `runtimeBoundaryMissingObservationRepair()`；
  - 把 `sandbox_run_code` missing observation 映射成 xox domain obligation；
  - 调用 Agentic OS helper；
  - 返回 xox event DTO 所需的 evaluation、obligation ledger、obligation plan、goal facts 和 next brief。
- `apps/api/src/agent/host-profile/xox-agent-run-profile.ts`
  - 删除手写的 `runtime_boundary_sandbox_calculation` ledger/plan 对象图；
  - 只保留 event persistence 和中文 copy。

## 验证

```bash
cd C:\Github\agentic-os
npm.cmd run build -w @agentic-os/core
npm.cmd run test -w @agentic-os/core
npm.cmd run check

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts tests/loop-obligation-ledger.test.ts
npm.cmd run test:api
```

## 完成标准

- host kit 不再手写 missing observation obligation ledger/plan；
- Agentic OS core 拥有 additional repair obligations 的 ledger + plan projection；
- xox sandbox missing-observation fail-closed 行为不回退；
- architecture guard 防止这段对象图回流。

## 结果

已于 2026-06-20 完成。

- `apps/api/src/agent/host-profile/xox-agent-run-profile.ts` 不再包含 `runtime_boundary_sandbox_calculation` 的手写 ledger/plan 对象图。
- `apps/api/src/agent/loop-obligation-ledger.ts` 新增 `runtimeBoundaryMissingObservationRepair()`，只保留 `sandbox_run_code -> sandbox_calculation` 领域映射，并调用 Agentic OS core helper 生成 ledger + plan。
- `apps/api/src/agent/loop-obligations.ts` 暴露 canonical Agentic OS plan -> xox plan DTO 的复用 adapter，避免重复转换逻辑。
- `apps/api/tests/agent-architecture.test.ts` 已防止 host kit 重新引入这段 missing-observation repair graph。

已通过 focused 验证：

```bash
cd C:\Github\agentic-os
npm.cmd run build -w @agentic-os/core
npm.cmd run test -w @agentic-os/core

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts tests/loop-obligation-ledger.test.ts
```
