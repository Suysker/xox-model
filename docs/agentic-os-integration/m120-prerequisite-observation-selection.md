# M120 Prerequisite Observation Selection

Status: implemented
Date: 2026-06-21

## 目标

继续按“整文件删除”推进。

`apps/api/src/agent/prerequisite-observations.ts` 只有一个生产入边：`agentic-os/xox-agentic-os-host-kit.ts` 的 loop 启动阶段。它把两类职责混在一起：

- 通用 harness 职责：根据 goal facts / obligation / existing observations 判断是否需要补一个 prerequisite observation；
- xox 领域职责：用 `data_query_workspace(scope=entity_summary)` 读取有序成员、股东、员工和成本对象，并作为 `runner_evidence` 落库。

正确边界是：Agentic OS core 拥有 prerequisite observation selection；xox host wiring 只声明 `entity_summary` 这个领域 prerequisite，并调用现有 xox read/persistence adapter。

## 模块分工

Agentic OS：

- `@agentic-os/core` 提供 `selectAgentPrerequisiteObservations()`；
- selector 只看 spec、goal facts、existing observations 和 optional obligation plan；
- 不知道 `entity_summary`、xox DB、中文文案或 action graph。

xox：

- `agentic-os/xox-agentic-os-host-kit.ts`
  - 声明 `ENTITY_SUMMARY_PREREQUISITE`；
  - 调用 `answerWorkspaceDataQuestion()`；
  - 通过 `storePlannedActionGraph()` 写入既有 `runner_evidence` observation。
- `prerequisite-observations.ts`
  - 整文件删除。

## 验证

```bash
cd C:\Github\agentic-os
npm.cmd run check

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts tests/api.test.ts -t "iterates through Agentic OS harness"
npm.cmd run test:api
```

## 完成标准

- `apps/api/src/agent/prerequisite-observations.ts` 已删除；
- architecture guard 防止文件和 import 回流；
- xox API suite 仍能通过，说明原有 `entity_summary` 预取行为未被削弱；
- Agentic OS core 测试覆盖 goal-triggered、observation-satisfied 和 obligation-scope-triggered selection。

## 结果

已于 2026-06-21 完成。

- xox host kit 消费 `@agentic-os/core` `selectAgentPrerequisiteObservations()`。
- `apps/api/src/agent/prerequisite-observations.ts` 已删除。
