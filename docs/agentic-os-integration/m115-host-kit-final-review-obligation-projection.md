# M115 Host Kit Final Review Obligation Projection

Status: implemented
Date: 2026-06-20

## 目标

继续压缩 `apps/api/src/agent/agentic-os/xox-agentic-os-host-kit.ts`。本轮删除 host kit 里手写的 final-review obligation event projection：

- 从当前 obligation ledger 投影产品事件；
- 从 response evaluator 派生本轮新增 repair obligations；
- 去重；
- 重新计算 open/invalid/satisfied/blocked counts。

这些是 harness runner event projection 规则，不是 xox 业务规则。xox 只应该把 financial/domain response evaluation 映射成 obligations，真正的 projection merge 和计数由 Agentic OS core 负责。

## 模块分工

Agentic OS：

- `@agentic-os/core`
  - 新增 `projectObligationLedgerWithAdditionalObligations()`；
  - 合并当前 ledger projection 与本轮 final review 新增 obligations；
  - 负责去重和 status count。

xox：

- `apps/api/src/agent/loop-obligation-ledger.ts`
  - 新增 `serializeObligationLedgerForResponseEvent()`；
  - 把 xox `ResponseEvaluation` 映射成 canonical additional obligations；
  - 调用 Agentic OS helper；
  - 映射回现有 xox event DTO。
- `apps/api/src/agent/agentic-os/xox-agentic-os-host-kit.ts`
  - 删除 `responseEvaluationObligationLedger()`；
  - 删除 `responseEventObligationLedger()`；
  - 只调用 xox adapter。

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

- host kit 不再手写 response evaluation obligation ledger projection；
- Agentic OS core 拥有 projection merge/dedupe/count；
- xox event DTO 兼容；
- final review、sandbox repair、evidence repair 和 complex operating-model tests 不回归。

## 结果

已于 2026-06-20 完成。

- `apps/api/src/agent/agentic-os/xox-agentic-os-host-kit.ts` 已删除 `responseEvaluationObligationLedger()` 和 `responseEventObligationLedger()`。
- `apps/api/src/agent/loop-obligation-ledger.ts` 新增 `serializeObligationLedgerForResponseEvent()`，只负责把 xox `ResponseEvaluation` 映射成 canonical additional obligations，再把 Agentic OS projection 映射回现有 xox event DTO。
- `apps/api/tests/agent-architecture.test.ts` 已防止 host kit 重新引入本地 response-event obligation projection。

已通过：

```bash
cd C:\Github\agentic-os
npm.cmd run build -w @agentic-os/core
npm.cmd run test -w @agentic-os/core

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts tests/loop-obligation-ledger.test.ts
```
