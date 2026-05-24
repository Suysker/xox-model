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

- `GET /api/v1/agent/provider-settings`
  - 返回当前登录用户 / 当前工作区的 OpenAI-compatible provider 设置
  - 只返回 `provider / baseUrl / model / hasApiKey / updatedAt`，不返回 API key
- `PUT /api/v1/agent/provider-settings`
  - 入参：`provider`、`baseUrl`、`model`、`apiKey?`
  - 首次保存必须提供 `apiKey`；后续只改 provider/baseUrl/model 时可省略 `apiKey` 并保留旧 key
  - 该设置优先于服务端环境变量，只影响当前用户 / 当前工作区的 Agent runtime
  - 支持 DeepSeek、Qwen、Doubao 等兼容 OpenAI Chat Completions `tools / tool_calls` 的服务；`tool_choice` 只作为 `auto` 或被省略，不发送 forced named choice；业务工具代码不按厂商特调
- `POST /api/v1/agent/provider-settings/probe`
  - 入参：`provider?`、`baseUrl?`、`model?`、`apiKey?`
  - 用当前表单值或已保存设置发起一次低成本 OpenAI-compatible Chat Completions probe，验证认证、模型、对话和 provider-native `tool_calls`
  - 返回 `status / provider / model / checks / message`，其中 `checks` 覆盖 `auth / model / chat / tools / stream`
  - 不保存表单值，不返回 API key；如果本次未传 `apiKey`，会复用当前用户 / 工作区已保存 key
- `DELETE /api/v1/agent/provider-settings`
  - 删除当前登录用户 / 当前工作区的 provider 设置
  - 删除后 Agent runtime 回到服务端环境变量配置；如果 provider 被选择但没有 key，仍然 fail-closed，不回退到本地规则伪造 tool call
- `GET /api/v1/agent/threads`
  - 返回当前登录用户 / 当前工作区内最近 30 个 Agent 对话摘要
  - 摘要包含标题、最近消息、最新 run 状态、planner source 和待确认动作数量
- `GET /api/v1/agent/threads/{threadId}`
  - 返回可恢复的线程状态：messages、runs、最新 run 的 `runEvents`、`planSteps`、`actionRequests`、`navigationEvents` 和 planner source
  - `runEvents` 是服务端持久化的运行轨迹，覆盖 run 入队、worker 认领、模型规划、provider chunk 预览、工具计划、确认卡生成、确认卡编辑、执行、取消和失败；不包含 provider 原始响应、提示词全文或密钥
  - OpenAI-compatible provider 流式输出会以 `provider_stream_started / provider_stream_delta / provider_stream_completed` 进入 `runEvents`；`provider_stream_delta.data` 只包含脱敏截断后的 `kind`、短 `delta`、累计 `preview`、`toolCallIndex`、`toolName`、`argumentsPreview` 等 UI 预览字段，不返回原始 SSE 行、HTTP header、完整 tool arguments 或 API key
  - 只能读取当前用户 / 当前工作区下的 thread；跨用户或跨工作区返回 `403`
- `GET /api/v1/agent/threads/{threadId}/events`
  - 建立 `text/event-stream` 事件流，事件名为 `thread_state`
  - 初始连接会立即返回一次完整 `AgentThreadState`；后续 run/message/action 状态变化会推送新的完整 thread state
  - SSE 只投影服务端状态，不包含 provider 原始响应、API key、worker lease 或内部提示词；provider chunk streaming 也是先落库为安全 run event，再通过同一条 `thread_state` 投影
  - 只能订阅当前用户 / 当前工作区下的 thread；跨用户或跨工作区不能建立事件流
- `POST /api/v1/agent/runs/{runId}/cancel`
  - 取消当前用户 / 当前工作区下仍在 `running` 的 run，并返回最新 thread state
  - 服务端会中止当前进程内 provider 请求，标记 run 为 `cancelled`，取消该 run 下未执行确认卡和未执行计划步骤
  - 已经 `completed / failed / cancelled` 的 run 以幂等方式返回 thread state，不会重复写入取消消息
- `POST /api/v1/agent/messages`
  - 入参：`threadId?`、`message`、`background?`
  - 同步模式返回新增对话消息、`status=completed`、`planner`、显式页面导航事件、`runEvents`、`planSteps`、待确认动作卡
  - 产品前端默认传 `background=true`：接口先创建 `agent_runs` 和用户消息并立即返回 `status=running / planner=null`，模型规划、确认卡生成和 assistant 回复由 Agent run worker 认领 lease 后继续落库
  - 前端应保存返回的 `threadId`，优先订阅 `GET /api/v1/agent/threads/{threadId}/events`，连接失败时轮询 `GET /api/v1/agent/threads/{threadId}`，以恢复 running/completed/failed run、消息、计划步骤、导航事件和待确认动作
  - `agent_runs` 保存输入消息、worker lease 和 heartbeat；每个 API worker 会按 `AGENT_RUN_WORKER_POLL_MS` 扫描未租约、同 worker 或租约已过期且尚未产生运行产物的 `running` run。若 run 已经有部分计划步骤或确认卡，则标记 failed 并取消未执行确认卡，避免重复创建或执行半成品动作
  - 后台执行在回写 assistant message、计划步骤和确认卡前会刷新 worker lease；如果租约已经被其他 worker 认领，迟到的模型结果会被丢弃，不能写入 pending 动作
  - `planner` 为 `openai_agents`、`openai_compatible_tool_calls`、`rules` 或运行中时的 `null`
  - 一条消息可拆成多个 `planSteps`，写入步骤会关联一个 server-owned action request；eligible action 可能按本轮 `automationLevel` 自动执行，也可能停在待确认动作卡
  - 只有模型返回 provider-native tool call 才会生成业务 action request；模型只返回 assistant 文本时按普通回复持久化，不用本地规则猜测业务动作。`rules` 只作为本地/CI no-op 生命周期路径，不生成业务 action request。
  - 缺少必要业务信息时，模型应调用 `ask_user_clarification`，返回只读澄清消息和 `info` 计划步骤，不生成确认卡
  - 读取和试算类请求不会生成写入动作
  - 新增或删除团队成员由模型调用 `team_member_add / team_member_delete` 后生成 `workspace.update_draft` action request；用户可以在 pending 状态编辑载荷，执行前仍会校验当前用户 / 工作区、显式导航、风险等级和草稿至少保留 1 个成员
  - 新增或删除运营员工由模型调用 `employee_add / employee_delete` 后生成 `workspace.update_draft` action request；该路径进入成本工作台，执行后更新当前草稿
  - 新增或删除股东、基础成本项和专项成本类型分别由模型调用 `shareholder_add / shareholder_delete`、`cost_item_add / cost_item_delete`、`stage_cost_type_add / stage_cost_type_delete`；股东编辑继续用 `workspace_patch_config` 覆盖既有字段，删除最后一个股东会被拒绝
  - 工作区改名由模型调用 `workspace_rename`，生成 `workspace.rename` action request；该动作必须打开版本管理面板，执行后只改当前工作区名称
  - 通用收入、普通支出、成员/员工按人支出由模型调用 `ledger_create_entry`；一键入账多笔由 `ledger_create_planned_member_income_batch / ledger_create_planned_related_expense_batch` 展开为多张 `ledger.create_entry` action request
  - 修改历史分录、精确作废某一笔、取消作废/恢复分录分别由 `ledger_update_entry / ledger_void_entry / ledger_restore_entry` 生成 action request；服务端会用 `entryId` 或金额/日期/科目/对象/关键词唯一定位，无法唯一定位时不会猜测执行
  - 把某快照发布为正式版由 `workspace_promote_version` 生成 `workspace.promote_version` action request；执行时先恢复指定版本到草稿，再发布新的不可变正式版，历史版本不改写
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
  - 返回更新后的确认卡、最新 `runEvents` 和该 run 的 `planSteps`
- `POST /api/v1/agent/action-requests/{id}/confirm`
  - 仅允许确认当前用户 / 工作区下的 `pending` 动作
  - 执行成功后会写入业务审计和 `agent.action_executed`
  - 返回执行结果、assistant message、最新 `runEvents` 和该 run 的 `planSteps`
- `POST /api/v1/agent/action-requests/{id}/cancel`
  - 取消待确认动作，不写业务数据
  - 返回取消后的确认卡、assistant message、最新 `runEvents` 和该 run 的 `planSteps`

Agent 写入动作统一遵循 `preview -> authority decision -> execute or confirm -> audit -> refresh`。当前支持通用记账、批量记账 action request、历史分录修改、精确作废、恢复作废、草稿修改、团队成员/运营员工/股东新增删除、基础成本项新增删除、专项成本类型新增删除、工作区改名、保存快照、发布当前草稿、把指定快照发布为正式版、恢复版本、删除版本、重置草稿、工作区 bundle 导入、创建 / 撤销分享、锁账 / 解锁；所有写入都先生成 server-owned action request 和可编辑确认卡，再按 ADR 0015 的 Automation Policy Engine 自动执行或等待用户确认。工作区 bundle 导出为只读工具，Agent 会打开版本管理面板并提示通过 `/api/v1/workspace/bundle` 获取完整 JSON。

Agent 只读数据问答通过模型选择 `data_query_workspace` 工具完成，支持整体工作区、单月汇总、成员汇总、团队成员数量/名单、月份排行、预实科目差异深度追问和账本历史筛选。该工具只返回 `planSteps / messages / navigationEvents`，不生成 `actionRequests`，不修改业务数据；账本历史筛选会在导航事件中携带 `ledgerFilters`，前端据此打开账本页并应用方向、状态、日期和关键词过滤器。

## 错误语义

- `401`：未登录或会话已失效
- `403`：资源存在但属于其他工作区
- `404`：资源不存在
- `409`：草稿版本冲突或受保护资源删除失败
- `422`：业务参数非法
