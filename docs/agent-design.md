# Agent OS 设计

## 目标

把现有测算、记账、预实分析和版本管理能力开放给 Agent 调用，让用户通过对话完成单步或复合命令。Agent 不是独立后门，它只能通过同一套领域服务和权限校验执行动作。

## 模块划分

- `packages/domain`：共享业务模型、默认配置、预测计算、预测科目生成和导入归一化。
- `packages/contracts`：REST DTO、Agent 协议、确认卡、导航事件、错误码与共享字面量类型。
- `apps/api`：TypeScript Fastify 服务，负责认证、工作区、版本、分享、账务、预实分析、Agent 会话和确认式动作执行。
- `apps/web`：React 工作台，保留手动页面，并新增底部 Agent 台作为主入口。

## 依赖图

```text
apps/web
  -> packages/contracts
  -> packages/domain

apps/api/routes
  -> apps/api/modules
  -> packages/domain
  -> apps/api/db

apps/api/agent
  -> packages/contracts
  -> apps/api/modules
  -> apps/api/db
```

Agent 工具不得直接写数据库；所有写入必须走领域服务，继承现有权限、锁账、分摊、派生提成和审计规则。

## Agent 协议

Agent 响应由三类事件组成：

- `message`：自然语言回复。
- `navigation`：显式打开页面、面板或定位记录，例如进入 `bookkeeping` 并选中目标账期。
- `action_request`：写入确认卡，包含动作类型、摘要、影响对象、明细、风险说明和执行载荷。

写入生命周期固定为：

```text
preview -> action_request -> confirm/cancel -> execute -> audit -> refresh
```

读取、解释和预测可以自动执行；任何会改变草稿、版本、分享、账务、锁账状态或导入/重置工作区的动作必须确认。

## 工具权限

| 工具类型 | 示例 | 确认 | 说明 |
| --- | --- | --- | --- |
| Client | `ui.navigate`, `ui.openPanel`, `ui.focusRecord` | 否 | 只改变 React UI 状态。 |
| Read | 查询草稿、版本、账期、分录、预实分析、预测试算 | 否 | 不写库，可自动执行。 |
| Draft Write | 修改模型字段、导入、重置草稿 | 是 | 必须展示旧值/新值或摘要。 |
| Ledger Write | 记账、修改分录、作废/恢复、锁账/解锁 | 是 | 必须展示金额、科目、期间和派生影响。 |
| Version Write | 保存快照、发布、恢复版本、删除版本 | 是 | 恢复和删除必须提示覆盖或不可恢复影响。 |
| Share Write | 创建、复制、撤销分享 | 是 | 公开链接相关动作必须确认。 |
| Account | 登录、退出、注销、删除账号、改密码 | 不支持 | Agent 必须拒绝自动执行。 |

## Provider 配置

默认开发 provider 为 DeepSeek OpenAI-compatible Chat Completions：

```text
LLM_PROVIDER=deepseek
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

密钥只允许放在本地 `.env` 或部署环境变量中，不写入仓库。实现只依赖 OpenAI-compatible chat/tool-calls 能力，避免绑定 Responses-only 特性，便于后续通过环境变量切换 OpenAI 或其他兼容 provider。

## 多步骤与可编辑确认

用户的一条消息可以被拆成多个 `agent_plan_steps`，每个步骤会显示序号、标题和状态。读取/预测步骤可自动完成；写入步骤会生成对应 `agent_action_requests`，状态为 `ready`，用户确认后才执行。

确认卡允许在执行前编辑摘要、明细 JSON 和执行载荷 JSON。编辑保存后会同步更新计划步骤描述；执行时仍然走同一套领域服务和校验，因此即使用户改了载荷，也会被账期锁定、金额分摊、版本权限和草稿修订号规则约束。

## 模型规划器

Agent 先尝试使用 DeepSeek OpenAI-compatible Chat Completions 做 JSON 规划，要求模型输出 `steps` 数组；后端只把模型输出当作计划草稿，再转换成受控工具调用。若没有配置密钥或模型调用失败，系统回退到本地规则规划器，以保证开发和测试环境稳定。

通用扩展点为 `workspace.patch_config`：对于页面上可手动修改但尚未做专用工具的模型字段，模型可以输出配置路径和新值，后端生成完整草稿修改确认卡。专用工具优先覆盖高频场景，例如成员收入入账、线上系数试算/保存、发布/恢复版本、分享、锁账和重置草稿。

## 命名与审计

- Agent 动作类型使用动宾式命名，例如 `ledger.create_entry`、`workspace.publish_release`、`ui.navigate`。
- `agent_action_requests` 保存确认卡和执行状态。
- `agent_runs` 保存一次用户消息触发的编排过程。
- 执行成功或失败都写入 `audit_logs`，并关联 `agentActionRequestId`。
