# 接口说明

## 认证

- `POST /api/v1/auth/register`
  - 创建 `user + workspace + draft + session`
- `POST /api/v1/auth/login`
  - 创建新的会话 Cookie
- `GET /api/v1/auth/me`
  - 返回当前用户并刷新会话有效期
  - 刷新只延长当前 token，不旋转 token；并发恢复请求必须保持幂等，避免页面刷新时一个请求成功、另一个请求把前端踢回登录页
- `POST /api/v1/auth/logout`
  - 只撤销当前会话
- `DELETE /api/v1/auth/me`
  - 注销账号并撤销全部会话

## 工作区

- `GET /api/v1/workspace/draft`
  - 返回当前可编辑草稿
- `PATCH /api/v1/workspace/draft`
  - 必须传 `revision`
  - 草稿版本过旧时返回 `409`
- `GET /api/v1/workspace/bundle`
  - 返回当前工作区 bundle：`schemaVersion / workspaceName / currentConfig / snapshots / lastSavedAt`
  - 只读导出，不修改草稿或版本
- `POST /api/v1/workspace/bundle/import`
  - 入参：`{ bundle }`
  - 用 `bundle.currentConfig` 和 `bundle.workspaceName` 覆盖当前草稿
  - 当前与前端导入语义保持一致：不把 `snapshots` 恢复进后端版本表
- `GET /api/v1/workspace/versions`
  - 返回不可变版本列表及当前分享信息
- `POST /api/v1/workspace/versions`
  - `kind` 取值：`snapshot | release`
  - 发布时会固化 `forecast_month_facts` 与 `forecast_line_item_facts`
- `POST /api/v1/workspace/versions/{id}/rollback`
  - 从历史不可变版本生成新草稿
  - 回滚后账期、科目与预实分析口径会同步切到该版本对应的草稿
- `DELETE /api/v1/workspace/versions/{id}`
  - 若版本已激活或已分享，则拒绝删除

## 分享

- `POST /api/v1/workspace/versions/{id}/share`
  - 仅允许分享发布版
- `DELETE /api/v1/workspace/versions/{id}/share`
  - 立即撤销公开访问 Token
- `GET /api/v1/public/shares/{token}`
  - 返回冻结的发布版配置与结果，只读展示

## 账务

- `GET /api/v1/ledger/periods`
  - 返回期间列表，以及计划 / 实际汇总
  - 若当前草稿已有月份但账期尚未生成，会按草稿自动补齐
  - 只返回当前草稿规划范围内仍然有效的月份；当规划月数从 24 缩到 12 时，超出的账期会从列表里收回
- `GET /api/v1/ledger/periods/{id}/subjects`
  - 返回该期间当前草稿计划对应的标准化预测科目
  - 会包含少量计划值为 `0` 的通用挂账科目，例如收入侧的 `退费退款`
- `POST /api/v1/ledger/periods/{id}/lock`
- `POST /api/v1/ledger/periods/{id}/unlock`
- `GET /api/v1/ledger/entries?periodId=...`
- `POST /api/v1/ledger/entries`
  - 支持一笔分录分摊到多个科目
  - 分摊总额必须等于分录金额
  - 分摊科目方向必须与 `direction` 一致
  - 若显式传入 `occurredAt`，后端会按该日期的月份归到账期；若未传，则继续使用请求里的 `ledgerPeriodId`
  - 锁定期间拒绝写入
- `PATCH /api/v1/ledger/entries/{id}`
  - 更新已过账的手工分录
  - 若本次更新显式改了 `occurredAt`，分录会同步移动到对应月份的账期
  - 自动生成的提成分录不能直接编辑，需要从源收入分录一起修改
- `POST /api/v1/ledger/entries/{id}/void`
  - 锁定期间拒绝作废
- `POST /api/v1/ledger/entries/{id}/restore`
  - 锁定期间拒绝取消作废
  - 自动生成的提成分录不能直接取消作废，需要从源收入分录一起恢复

## 预实分析

- `GET /api/v1/variance/periods/{id}`
  - 返回：
    - 当前期间计划 / 实际汇总
    - 当前期间差异额 / 差异率
    - 累计计划 / 实际汇总
    - 累计差异额 / 差异率
    - 科目级差异明细

## Agent OS

- `GET /api/v1/agent/threads`
  - 返回当前登录用户 / 当前工作区内最近 30 个 Agent 对话摘要
  - 摘要包含标题、最近消息、最新 run 状态、planner source 和待确认动作数量
- `GET /api/v1/agent/threads/{threadId}`
  - 返回可恢复的线程状态：messages、runs、最新 run 的 `planSteps`、`actionRequests`、`navigationEvents` 和 planner source
  - 只能读取当前用户 / 当前工作区下的 thread；跨用户或跨工作区返回 `403`
- `POST /api/v1/agent/runs/{runId}/cancel`
  - 取消当前用户 / 当前工作区下仍在 `running` 的 run，并返回最新 thread state
  - 服务端会中止当前进程内 provider 请求，标记 run 为 `cancelled`，取消该 run 下未执行确认卡和未执行计划步骤
  - 已经 `completed / failed / cancelled` 的 run 以幂等方式返回 thread state，不会重复写入取消消息
- `POST /api/v1/agent/messages`
  - 入参：`threadId?`、`message`、`background?`
  - 同步模式返回新增对话消息、`status=completed`、`planner`、显式页面导航事件、`planSteps`、待确认动作卡
  - 产品前端默认传 `background=true`：接口先创建 `agent_runs` 和用户消息并立即返回 `status=running / planner=null`，模型规划、确认卡生成和 assistant 回复在服务端后台继续落库
  - 前端应保存返回的 `threadId`，并轮询 `GET /api/v1/agent/threads/{threadId}` 恢复 running/completed/failed run、消息、计划步骤、导航事件和待确认动作
  - `agent_runs` 保存输入消息；API 启动时会恢复尚未产生运行产物的 `running` run。若 run 已经有部分计划步骤或确认卡，则标记 failed 并取消未执行确认卡，避免重复创建或执行半成品动作
  - `planner` 为 `openai_agents`、`openai_compatible_tool_calls`、`rules` 或运行中时的 `null`
  - 一条消息可拆成多个 `planSteps`，写入步骤会关联一个待确认动作卡
  - 当 `LLM_PROVIDER` 不是 `rules` 时，只有模型返回 provider-native tool call 才会生成业务确认卡；模型未返回 tool call 时只返回失败型只读步骤，不用本地规则猜测业务动作
  - 缺少必要业务信息时，模型应调用 `ask_user_clarification`，返回只读澄清消息和 `info` 计划步骤，不生成确认卡
  - 读取和试算类请求不会生成写入动作
  - 账号登录、退出、注销、删除账号和密码类请求会被拒绝自动执行
- `GET /api/v1/agent/memories`
  - 返回当前登录用户在当前工作区内可用的 Agent 记忆
  - 不返回其他用户、其他工作区或已删除记忆
- `DELETE /api/v1/agent/memories/{id}`
  - 软删除当前登录用户 / 当前工作区下的一条记忆
  - 删除其他用户或其他工作区的记忆返回 `403`
- `PATCH /api/v1/agent/action-requests/{id}`
  - 仅允许编辑当前用户 / 工作区下的 `pending` 动作
  - 可编辑确认卡摘要、明细、导航事件和执行载荷；保存后同步更新计划步骤描述
- `POST /api/v1/agent/action-requests/{id}/confirm`
  - 仅允许确认当前用户 / 工作区下的 `pending` 动作
  - 执行成功后会写入业务审计和 `agent.action_executed`
- `POST /api/v1/agent/action-requests/{id}/cancel`
  - 取消待确认动作，不写业务数据

Agent 写入动作统一遵循 `preview -> confirm -> execute -> audit -> refresh`。当前支持记账、草稿修改、发布版本、恢复版本、删除版本、重置草稿、工作区 bundle 导入、创建 / 撤销分享、锁账 / 解锁；所有写入都先生成确认卡。工作区 bundle 导出为只读工具，Agent 会打开版本管理面板并提示通过 `/api/v1/workspace/bundle` 获取完整 JSON。

Agent 只读数据问答通过模型选择 `data_query_workspace` 工具完成，支持整体工作区、单月汇总、成员汇总和月份排行。该工具只返回 `planSteps / messages / navigationEvents`，不生成 `actionRequests`，不修改业务数据。

## 错误语义

- `401`：未登录或会话已失效
- `403`：资源存在但属于其他工作区
- `404`：资源不存在
- `409`：草稿版本冲突或受保护资源删除失败
- `422`：业务参数非法
