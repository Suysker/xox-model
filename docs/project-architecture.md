# xox-model 项目架构

## 目标

构建一个可持续迭代、易于部署和维护的测算平台，具备以下能力：

- 账号注册、登录、退出、注销
- 草稿自动保存、版本发布、版本回滚
- 面向发布版的只读公开分享
- 按预测收入项 / 成本项记账
- 按期间对比预算与实际的预实分析

详细规划、数据模型、路线图与验收条件见 `docs/project-plan.md`。

## 仓库结构

- `apps/web`：React 前端应用
- `apps/api`：TypeScript Fastify API 与 Agent 服务
- `packages/domain`：前后端共享的测算模型、默认值、事实表和导入归一化逻辑
- `packages/contracts`：REST DTO、Agent 协议、确认卡与共享错误语义
- `docs`：架构、接口、验收、运维与规划文档
- `infra/scripts`：部署与辅助脚本

当前本地开发默认使用 SQLite。生产环境应切换到 PostgreSQL，服务边界保持不变。

## 运行时依赖

```text
apps/web -> packages/contracts -> packages/domain
apps/api/routes -> apps/api/modules -> packages/domain -> apps/api/db
apps/api/agent -> packages/contracts -> apps/api/modules -> apps/api/db
```

Agent 只能通过领域服务执行动作，不能直接写数据库。所有会改变草稿、版本、分享、账务或锁账状态的 Agent 工具必须先生成确认卡，用户确认后才执行并写入审计日志。账号影响类动作不开放给 Agent。

## 数据架构

### 事务层

- `users`
- `user_credentials`
- `user_sessions`
- `workspaces`
- `workspace_members`
- `workspace_drafts`
- `workspace_events`
- `workspace_version_shares`
- `ledger_periods`
- `actual_entries`
- `actual_entry_allocations`
- `audit_logs`
- `agent_threads`
- `agent_messages`
- `agent_runs`
- `agent_action_requests`
- `agent_plan_steps`

### 计划层

- `workspace_versions`
- `forecast_month_facts`
- `forecast_line_item_facts`

### 分析层

- 按期间、月份、科目、版本聚合的预实分析视图

## 核心建模规则

- 草稿可变
- 发布版不可变
- 公开分享只能指向发布版
- 回滚是从历史版本复制出新草稿
- 记账与预实分析始终跟随当前草稿 / 当前版本，发布与回滚会同步改变账务口径
- 一笔实际分录可以分摊到一个或多个预测科目
- 锁定期间后禁止记账和作废
- 预实分析同时提供当期差异与累计差异
- Agent 调用业务能力时必须显式切到对应页面或面板，不允许静默后台写入
- 写入型 Agent 工具遵循 `preview -> confirm -> execute -> audit -> refresh`
- Agent 规划先尝试 DeepSeek OpenAI-compatible Chat Completions 输出 JSON 步骤，后端再转换为受控工具；模型失败时回退本地规则规划
- 多步骤计划持久化到 `agent_plan_steps`，待确认动作可在 `pending` 状态编辑确认卡和执行载荷

## 交付阶段

1. 仓库重构与 TypeScript 后端骨架
2. 认证与草稿持久化
3. 版本发布、版本回滚与事实表固化
4. 发布版公开分享与撤销
5. 期间记账、多分摊分录、锁定 / 解锁流程
6. 预实分析、累计对账与浏览器验收
7. TypeScript 后端等价迁移、共享领域层与 Agent OS 化

## 验收摘要

- 登录用户只能访问自己的工作区
- 草稿修改会自动保存，刷新后能恢复
- 旧草稿版本会被拒绝，并反馈到前端
- 发布版保持不可变
- 发布时会固化月度事实表和行项目事实表
- 分享链接只暴露发布版数据，不暴露草稿编辑
- 回滚不会篡改历史
- 记账分录与分摊金额严格对齐
- 锁定期间后禁止新增与作废
- 预实分析汇总值必须与当前草稿计划和已过账实际一致
- 累计差异必须按期间逐期对齐
