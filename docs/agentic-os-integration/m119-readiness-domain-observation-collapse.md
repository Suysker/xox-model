# M119 Readiness Domain Observation Collapse

Status: implemented
Date: 2026-06-21

## 目标

继续按“整文件删除”推进。

`apps/api/src/agent/observation-collector.ts` 只有一个生产入边：`agentic-os/xox-loop-readiness-adapter.ts`。它收集 xox 工作区草稿、账期、版本、分享和审计数量，用于 readiness 的领域事实判断。

这不是 Agentic OS core 的通用能力，但也不应该作为顶层 xox agent helper 文件单独存在。正确边界是：xox readiness adapter 内部拥有这段 domain snapshot 查询，Agentic OS core 继续拥有通用 readiness decision priority。

## 模块分工

Agentic OS：

- 无 core 代码变更；
- `@agentic-os/core` 继续通过 `decideAgentReadiness()` 拥有通用 readiness 裁决顺序。

xox：

- `agentic-os/xox-loop-readiness-adapter.ts`
  - 内部收集 xox domain snapshot；
  - 继续只把 domain findings 交给 core readiness decision。
- `observation-collector.ts`
  - 整文件删除。

## 验证

```bash
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts tests/api.test.ts -t "iterates through Agentic OS harness"
npm.cmd run test:api
```

## 完成标准

- `apps/api/src/agent/observation-collector.ts` 已删除；
- architecture guard 防止文件和 import 回流；
- xox build 和 API suite 通过。

## 结果

已于 2026-06-21 完成。

- `collectAgentObservation()` 折叠进 `xox-loop-readiness-adapter.ts`。
- `apps/api/src/agent/observation-collector.ts` 已删除。
