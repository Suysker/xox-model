# xox-model 项目规划

## 1. 项目定位

`xox-model` 不再只是一个前端测算器，而是一个带版本管理、实际记账和预实分析的平台，围绕四条核心业务闭环展开：

1. `测算`：编辑可变草稿、持续自动保存、发布不可变预算版本
2. `记账`：按期间把实际收入和成本分录挂到预测科目
3. `预实分析`：按期间把预算基线与实际结果做差异分析
4. `分享`：把某个不可变发布版通过只读链接对外分享

目标不是简单“加一个后端”，而是让测算、版本、账务、分析这四类数据在时间维度上保持一致。

## 2. 仓库结构

仓库必须保持分层和可部署，不能把前端、后端、脚本、文档继续平铺到根目录。

```text
xox-model/
├─ apps/
│  ├─ web/              # React + Vite 前端
│  └─ api/              # FastAPI + SQLAlchemy 后端
├─ docs/                # 架构、规划、验收、接口、运维文档
├─ infra/
│  └─ scripts/          # 部署与辅助脚本
├─ .agent/              # 工程计划与 lessons
├─ package.json         # 前端工作区编排
└─ README.md
```

建议的长期扩展方向：

- `apps/web/src/features/*`：按业务域拆分前端模块
- `apps/api/app/services/*` 或 `apps/api/app/modules/*`：按领域拆分后端
- `apps/api/alembic/`：正式数据库迁移体系
- `tests/e2e/`：如果后续把浏览器自动化固化到仓库中

## 3. 运行时架构

### 前端

- 技术栈：`React 19 + TypeScript + Vite`
- 负责：
  - 认证界面与会话初始化
  - 测算工作台
  - 版本库与分享交互
  - 记账与预实分析界面
  - 自动保存编排

### 后端

- 技术栈：`FastAPI + SQLAlchemy 2.0 + Pydantic`
- 当前本地环境：`SQLite`
- 生产目标：`PostgreSQL`
- 负责：
  - 认证与会话管理
  - 带乐观锁的草稿持久化
  - 版本发布与回滚
  - 预测事实表固化
  - 期间与分录管理
  - 预实聚合接口

### 部署边界

- `apps/web` 可独立作为静态资源部署
- `apps/api` 可独立作为应用服务部署
- 基础设施脚本统一放在 `infra/scripts`
- 生产环境中前后端应支持独立发布

## 4. 领域架构

### 4.1 认证域

- `users`
- `user_credentials`
- `user_sessions`
- `workspace_members`

规则：

- `register`：创建用户、密码、默认工作区、默认草稿、会话 Cookie
- `login`：创建新会话
- `logout`：只撤销当前会话
- `cancel account`：撤销全部会话并停用账号
- 任何工作区数据访问都必须经过成员关系校验

### 4.2 工作区域

- `workspaces`
- `workspace_drafts`
- `workspace_events`

规则：

- 一个工作区始终只有一份可变草稿
- 草稿带 `revision`，用于乐观锁
- 每次自动保存都记录工作区事件
- 前端自动保存可以防抖，但快照 / 发布前必须先刷掉脏草稿

### 4.3 版本域

- `workspace_versions`
- `forecast_month_facts`
- `forecast_line_item_facts`
- `workspace_version_shares`

规则：

- `snapshot`：工作快照，用于阶段性保存
- `release`：发布版，可作为记账和预实分析基线
- `share`：只能公开分享发布版
- `rollback`：从历史版本复制出新草稿
- 历史版本永远不允许原地修改
- 发布时必须同时固化月度事实表和行项目事实表
- 版本接口必须返回真实版本载荷，不能误返回当前草稿
- 公开分享页必须读取发布时冻结的结果载荷，不能按当前前端逻辑实时重算

### 4.4 账务域

- `ledger_periods`
- `actual_entries`
- `actual_entry_allocations`
- `audit_logs`

规则：

- 账务按期间管理，不是工作区级散账
- 每个期间绑定一个预算基线发布版
- 实际分录必须落到标准化预测科目
- 一笔分录可以分摊到多个科目
- 分摊合计必须等于分录金额
- 锁定期间拒绝新增记账和作废

### 4.5 预实分析域

- 由 `forecast_line_item_facts + actual_entry_allocations + ledger_periods` 派生

规则：

- 计划值来自该期间绑定的基线发布版
- 实际值只来自已过账且未作废的分摊
- 即使后续重做测算，历史预实口径也必须稳定

## 5. 核心数据模型

当前代码库已实现一版务实的数据结构。

### 事务表

- `users(id, email, display_name, status, cancelled_at, created_at, updated_at)`
- `user_credentials(user_id, password_hash, created_at, updated_at)`
- `user_sessions(id, user_id, token_hash, expires_at, revoked_at, user_agent, ip_address)`
- `workspaces(id, owner_id, name, schema_version, active_version_id, created_at, updated_at)`
- `workspace_members(id, workspace_id, user_id, role, created_at, updated_at)`
- `workspace_drafts(workspace_id, revision, config_json, result_json, last_autosaved_at, updated_by)`
- `workspace_events(id, workspace_id, actor_id, event_type, meta_json, created_at)`

### 计划表

- `workspace_versions(id, workspace_id, version_no, name, kind, note, baseline_scenario, source_draft_revision, source_version_id, payload_json, result_json, created_by, created_at)`
- `workspace_version_shares(id, workspace_id, version_id, share_token, created_by, revoked_at, created_at, updated_at)`
- `forecast_month_facts(id, workspace_id, version_id, scenario_key, month_index, month_label, planned_revenue, planned_cost, planned_profit)`
- `forecast_line_item_facts(id, workspace_id, version_id, scenario_key, month_index, month_label, subject_key, subject_name, subject_type, subject_group, entity_type, entity_id, planned_amount)`

### 账务表

- `ledger_periods(id, workspace_id, baseline_version_id, month_index, month_label, status, created_at, updated_at)`
- `actual_entries(id, workspace_id, ledger_period_id, direction, amount, occurred_at, counterparty, description, status, created_by, posted_at, created_at, updated_at)`
- `actual_entry_allocations(id, actual_entry_id, subject_key, subject_name, subject_type, amount)`
- `audit_logs(id, workspace_id, actor_id, action, status, entity_type, entity_id, meta_json, created_at)`

## 6. 预测科目策略

预实分析能否稳定，关键不在图表，而在预测项是否被规范化成稳定的 `subject_key`。

示例：

- `revenue.offline_sales`
- `revenue.online_sales`
- `cost.member.commission`
- `cost.member.base_pay`
- `cost.employee.per_event`
- `cost.training.rehearsal`
- `cost.stage.perEvent.stage-cost-makeup`

这一层是“测算”和“记账”之间的桥。如果没有它，后续一旦改名或重构，预实分析就会退化成脆弱的字符串匹配。

## 7. API 边界

### 认证

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/logout`
- `DELETE /api/v1/auth/me`

### 工作区

- `GET /api/v1/workspace/draft`
- `PATCH /api/v1/workspace/draft`
- `GET /api/v1/workspace/versions`
- `POST /api/v1/workspace/versions`
- `POST /api/v1/workspace/versions/{id}/share`
- `DELETE /api/v1/workspace/versions/{id}/share`
- `POST /api/v1/workspace/versions/{id}/rollback`
- `DELETE /api/v1/workspace/versions/{id}`

### 公开分享

- `GET /api/v1/public/shares/{token}`

### 账务

- `GET /api/v1/ledger/periods`
- `GET /api/v1/ledger/periods/{id}/subjects`
- `POST /api/v1/ledger/periods/{id}/lock`
- `POST /api/v1/ledger/periods/{id}/unlock`
- `GET /api/v1/ledger/entries?periodId=...`
- `POST /api/v1/ledger/entries`
- `POST /api/v1/ledger/entries/{id}/void`

### 预实分析

- `GET /api/v1/variance/periods/{id}`

## 8. 交付路线图

### 第一阶段：基础能力

- 仓库拆分为 `apps / docs / infra`
- Python 后端初始化完成
- 认证与会话打通
- 注册时自动创建默认工作区和草稿

### 第二阶段：测算持久化

- 草稿从浏览器本地存储迁移到后端
- 自动保存支持版本冲突保护
- 导入 / 导出仍保留工作区 Bundle 能力

### 第三阶段：版本管理

- 快照与发布
- 不可变版本持久化
- 从历史版本回滚
- 发布时生成预测事实表

### 第四阶段：账务

- 根据发布版生成期间
- 按期间生成预测科目
- 支持记账、列表、作废

### 第五阶段：分享

- 只允许对发布版生成分享链接
- 公开只读分享页
- 撤销分享流程

### 第六阶段：预实分析

- 期间级预实汇总
- 科目级差异明细
- 累计预实对账
- 浏览器验收覆盖完整主链路

## 9. 验收原则

### 草稿与自动保存

- 任意测算字段修改后都能自动保存
- 刷新后能恢复最近一次成功保存的草稿
- 旧 `revision` 会被拒绝，前端能感知冲突

### 发布、回滚、分享

- 发布版不可变
- 回滚生成新草稿，不篡改历史
- 分享页只展示冻结的发布版配置和结果

### 账务与预实

- 记账直接挂预测科目
- 多分摊金额合计必须等于原始金额
- 锁定期间后禁止新增和作废
- 预实分析必须与发布基线和已过账实际逐项对齐

### 非功能

- 核心接口必须写审计日志
- 迁移入口必须可重复执行
- 前端单测 / 构建通过
- 后端 API 集成测试通过
- 浏览器验收通过
