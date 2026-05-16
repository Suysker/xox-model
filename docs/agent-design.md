# Agent OS 设计

本文件描述 `xox-model` 的目标 Agent OS 架构。正式 runtime 采用策略见 [ADR 0001](adr/0001-agent-runtime-architecture.md)。

## 目标

把测算、调模型、记账、预实分析、版本发布、恢复版本、分享、锁账等平台能力开放给 Agent。Agent 不是绕过页面和权限的后门，而是一个受控操作系统层：它能理解用户指令、显式切换页面、拆分多步骤任务、生成可编辑确认卡，并在用户确认后调用同一套领域服务执行。

用户仍可手动操作页面；原则上页面上能手动修改的业务能力，都必须能通过 Agent 对话完成。账号登录、退出、注册、注销、删除账号和改密码不开放给 Agent 自动执行。

## 架构决策摘要

| 方案 | 决策 | 边界 |
| --- | --- | --- |
| OpenAI Agents SDK | 主 runtime 方向 | 用于 orchestration、tool、handoff、guardrail、tracing、session/context；不托管业务权限、确认卡和审计 |
| OpenClaw | 架构参考 | 借鉴 control plane / execution plane / approval / observability，不直接 fork |
| DeepSeek | provider adapter 与真实模型测试通道 | 使用 OpenAI-compatible Chat Completions `tool_calls`，不作为 Agent OS 架构底座 |
| Claude Code | 交互模式参考 | 不引入 Claude Agent SDK；只借鉴 memory、subagents、hooks、skills、MCP 的产品模式 |
| Skills | 可选过程知识层 | 不能替代 server tools，不能绕过确认、权限、审计 |
| MCP | 外部工具和连接器边界 | 核心财务业务能力继续走受控 server tools |

## 目标模块划分

```text
apps/web Agent OS
  -> packages/contracts Agent Protocol
  -> apps/api Agent Kernel
      -> runtime adapters
      -> memory/context
      -> prompt/skill registry
      -> tool policy/hooks
      -> action graph
      -> confirmation service
      -> audit/events
  -> business tool facade
      -> workspace / ledger / share / variance modules
  -> db
```

### `packages/domain`

承载共享业务模型、默认配置、预测计算、预测科目生成和导入归一化。前端和后端都从这里引用同一套模型逻辑，避免前后端计算漂移。

### `packages/contracts`

承载 REST DTO 和 Agent Protocol。这里不能依赖具体 provider SDK。

目标协议包括：

- `AgentRun`
- `AgentMessage`
- `AgentEvent`
- `AgentActionGraph`
- `AgentPlanStep`
- `AgentActionRequest`
- `AgentToolDescriptor`
- `AgentToolPermission`
- `AgentMemoryRecord`
- `AgentRuntimeProvider`
- `AgentErrorCode`

### `apps/api/src/agent/runtime`

provider adapter 层。所有 provider 必须输出统一的内部 plan/event，不允许直接写库。

- `openai-agents-adapter.ts`
- `openai-compatible-chat-adapter.ts`
- `rules-adapter.ts`
- `runtime-adapter.ts`

本轮先落地最小可验证切分：

```text
modules/agent.ts
  -> build tenant/workspace planning context
  -> runtime/adapter-router.ts
      -> runtime/openai-agents-adapter.ts
          -> OpenAI Agents SDK Agent / Runner / tools
      -> runtime/openai-compatible-chat-adapter.ts
          -> OpenAI-compatible Chat Completions tools/tool_calls
      -> runtime/runtime-adapter.ts
          -> provider-neutral plan result
  -> normalize runtime steps into action requests / read steps
```

边界约束：

- runtime adapter 只接收已脱敏、已按当前用户 / 当前工作区过滤过的 planning context。
- runtime adapter 不读取数据库、不写数据库、不创建确认卡、不执行业务工具。
- OpenAI Agents SDK adapter 使用 SDK 的 `Agent / Runner / tool / OpenAIChatCompletionsModel` 做 orchestration；SDK tool 的 `execute` 只把工具参数收集为内部 `AgentToolCallStep`，返回 model-visible preview receipt，不执行领域服务。
- `LLM_PROVIDER=openai` 只选择 OpenAI Agents SDK adapter；`LLM_PROVIDER=openai-compatible / deepseek / doubao / qwen` 继续走通用 Chat Completions adapter。两条路径都输出同一个 `RuntimePlanResult`。
- `modules/agent.ts` 暂时继续负责业务预览、确认卡和执行，以保证本轮切分后 API 语义不变。
- 后续再把业务预览和确认卡下沉到 `agent/kernel` 与 `agent/tools`。

### `apps/api/src/agent/kernel`

Agent OS 内核，和具体 provider 解耦：

- `agent-kernel.ts`：创建 run，协调 runtime、memory、tool policy、action graph 和事件输出。
- `action-graph.ts`：多步骤计划、依赖关系、状态转移。
- `confirmation-service.ts`：创建、编辑、确认、取消 action request。
- `tool-policy.ts`：风险等级、权限、账号动作拒绝、写入确认规则。
- `memory-manager.ts`：租户内记忆的 list/delete/注入。
- `context-compactor.ts`：长对话压缩。
- `prompt-registry.ts`：系统提示词、工具说明和 skills 说明文件读取。
- `event-stream.ts`：向前端输出 streaming event。

### `apps/api/src/agent/tools`

受控业务工具层。工具只调用现有领域服务或模块服务，不直接写数据库，也不依赖 provider SDK。

- `ui-tools.ts`
- `workspace-tools.ts`
- `ledger-tools.ts`
- `version-tools.ts`
- `share-tools.ts`
- `variance-tools.ts`
- `tool-registry.ts`

### `apps/api/src/agent/tool-policy.ts`

当前落地的策略切片集中处理 Agent 写入动作的安全边界，避免策略散落在 route handler、planner 和领域服务里：

- `assertActionDraftAllowed`：创建确认卡前校验 action kind、风险等级和必需导航；写入动作不能没有显式页面导航。
- `assertActionUpdateAllowed`：用户编辑待执行确认卡时，仍必须保留该 action kind 的必需导航和合法风险等级；可编辑不等于可绕过策略。
- `assertActionExecutionAllowed`：确认执行前校验 action request 属于当前 user/workspace，payload 指向的账期、分录、版本、分享版本仍在当前 workspace 内；锁定账期和系统派生提成分录直接编辑/作废/恢复会在 policy 层先被拒绝。

依赖方向：

```text
agent routes / confirmation flow
  -> tool-policy
      -> db read-only ownership/status checks
  -> business domain services
```

Tool Policy 只做权限、状态和可见导航校验，不执行业务写入，不生成确认卡，不调用 provider。

### `apps/api/src/agent/prompts`

系统提示词和过程说明文件：

- `operator.system.md`
- `planner.system.md`
- `memory.system.md`
- `tool-policy.system.md`
- `skills/*.md`

Skills 只用于教模型如何使用工具或执行离线流程，不能直接获得业务写权限。

### `apps/web/src/components/agent`

React Agent OS：

- `AgentShell`：主工作台固定缩放为 85%，底部常驻 Agent 台。
- `AgentConsole`：对话输入、流式回复和工具进度。
- `AgentPlanTimeline`：展示多步骤 action graph，类似 Codex 的步骤状态。
- `AgentActionCard`：写入确认卡，可编辑摘要、明细、导航和执行载荷。
- `AgentMemoryPanel`：查看和删除当前用户 / 当前工作区 memory。
- `AgentEventLog`：调试 run/event/tool 状态。

前端 action graph 的实现约束：

- 模块划分：`AgentConsole` 只编排输入、消息、记忆入口和左右布局；`AgentPlanTimeline` 负责把 `planSteps + actionRequests + navigationEvents` 投影为运行图；`AgentActionCard` 只负责单个写入动作的确认、取消和编辑。
- 依赖图：`useAgentThread -> api/contracts -> AgentConsole -> AgentPlanTimeline / AgentActionCard`。展示层不得重新推导业务权限，也不得维护第二套动作状态。
- 复用与抽象：`AgentPlanTimeline` 复用 `AgentPlanStep.actionRequestId` 关联确认卡状态，复用 `AgentNavigationEvent` 渲染“打开页面 / 面板 / 定位记录”，并导出纯函数供测试覆盖，不依赖 DOM 测试库。
- 命名与样式：运行态统一叫 `run graph / timeline / event`；中文界面使用 `步骤 / 导航 / 确认 / 执行 / 失败`；紧凑 SaaS 工作台样式保持 8px 以内圆角、信息密度优先，不做营销式大卡片。
- 验收：一条多步骤消息必须在前端展示步骤序号、状态、导航目标、关联确认卡状态、失败原因和取消状态；执行或取消后，timeline 必须随后端返回的 `planSteps` 与 `actionRequests` 刷新。

## Agent 协议

Agent 输出由事件组成：

- `message`：自然语言回复。
- `navigation`：显式打开页面、面板或定位记录。
- `plan_step`：多步骤计划中的一个步骤。
- `action_request`：待确认写入动作。
- `tool_progress`：工具调用、预览、执行和刷新进度。
- `error`：可恢复或不可恢复错误。

写入生命周期固定为：

```text
model tool_call
  -> normalize intent
  -> policy check
  -> preview
  -> action_request
  -> user edit / confirm / cancel
  -> execute
  -> audit
  -> refresh
```

读取、解释和预测可以自动执行；任何会改变草稿、版本、分享、账务、锁账状态、导入/导出或重置工作区的动作必须确认。

## 工具权限矩阵

| 工具类型 | 示例 | 确认 | 说明 |
| --- | --- | --- | --- |
| Client | `ui.navigate`, `ui.openPanel`, `ui.focusRecord` | 否 | 只改变 React UI 状态 |
| Read | 查询草稿、版本、账期、分录、预实分析、预测试算 | 否 | 不写库，可自动执行 |
| Draft Write | 修改模型字段、导入、重置草稿 | 是 | 展示旧值/新值或摘要 |
| Ledger Write | 记账、修改分录、作废/恢复、锁账/解锁 | 是 | 展示金额、科目、期间和派生影响 |
| Version Write | 保存快照、发布、恢复版本、删除版本 | 是 | 恢复和删除必须提示覆盖或不可恢复影响 |
| Share Write | 创建、复制、撤销分享 | 是 | 公开链接相关动作必须确认 |
| Account | 登录、退出、注册、注销、删除账号、改密码 | 不支持 | Agent 必须拒绝自动执行 |

## Tool Calling 语义

Tool call 不是业务执行结果，只是模型请求调用工具。服务端必须重新做：

- 当前登录用户校验。
- 当前工作区成员关系校验。
- action kind 与权限校验。
- 锁账、revision、分摊金额、派生提成、发布版不可变等领域校验。
- 写入确认卡创建。
- 用户确认后的执行和审计。

禁止以下链路：

- `model tool_call -> 直接写数据库`
- `模型输出 JSON -> 当作已执行工具`
- `模型选择 workspaceId/userId -> 查询数据`
- `skill markdown -> 直接变更业务状态`

## 多步骤与可编辑确认

用户的一条消息可以拆成多个步骤，例如：

```text
记 3 月成员 A 收入；把 4 月线上系数改成 0.3；发布并分享
```

系统必须展示为多个 `planSteps`，每一步有独立状态：

- `pending`
- `ready`
- `executing`
- `executed`
- `cancelled`
- `failed`
- `info`

写入步骤会关联 `agent_action_requests`。用户确认前可以编辑标题、摘要、明细、导航和执行载荷；执行时仍然走同一套领域服务，因此用户编辑后的载荷也必须被服务端重新校验。

## Memory 与上下文压缩

SaaS memory 必须分层隔离：

| 层级 | 范围 | 用途 |
| --- | --- | --- |
| user memory | `userId` | 用户偏好、展示习惯 |
| workspace memory | `workspaceId + userId` | 当前工作区业务别名、默认记账习惯 |
| thread memory | `threadId + workspaceId + userId` | 当前对话状态 |
| run context | `runId` | 本次临时事实 |

要求：

- memory 查询、删除、prompt 注入都必须按当前登录用户和当前工作区过滤。
- secrets、API key、token、密码、验证码等不得写入 memory。
- context summary 只来自同一 thread、同一 user、同一 workspace。
- context summary 和后续 provider prompt 注入的 recent messages 必须经过 secret redaction；即使用户在旧消息里粘贴过 key/token，也不能进入长期摘要或下一轮运行上下文。
- 删除 memory 后，后续 prompt 不再注入；如果 summary 中包含同类信息，需要重新压缩或标记失效。
- 压缩内容只保留业务目标、已确认事实、未完成动作、用户偏好和重要错误。

## Provider 配置

环境变量只决定 provider 和模型，不决定业务行为。

```text
LLM_PROVIDER=openai-compatible | deepseek | doubao | qwen | rules
OPENAI_COMPATIBLE_PROVIDER=deepseek
OPENAI_COMPATIBLE_BASE_URL=https://api.deepseek.com
OPENAI_COMPATIBLE_MODEL=deepseek-v4-pro
OPENAI_COMPATIBLE_API_KEY=<local-only>
```

DeepSeek 的 `DEEPSEEK_BASE_URL / DEEPSEEK_MODEL / DEEPSEEK_API_KEY` 仍作为默认 smoke 兼容变量。豆包、Qwen 等服务只要兼容 OpenAI Chat Completions `tools / tool_choice / tool_calls`，就通过 `OPENAI_COMPATIBLE_*` 配置接入，不改业务工具代码。密钥只允许放在本地 `.env` 或部署环境变量中，不写入仓库、文档、测试夹具或日志。

## 真实 Provider Smoke Harness

真实模型验收不能停留在一次性手工命令。仓库需要一个受控 smoke harness，专门证明 OpenAI-compatible `tool_calls` 链路能驱动 Agent OS 的关键产品能力。默认真实 provider 是 DeepSeek，但它只是兼容 provider 之一。

### 模块划分

- `apps/api/src/agent/real-provider-smoke.ts`：CLI 和可复用 smoke runner。只负责创建临时 API harness、发起 Agent API 请求、断言结果和输出结构化摘要。
- `apps/api/src/server.ts`、`apps/api/src/db/database.ts`：复用正式 Fastify app、迁移和 SQLite database 初始化，不创建 parallel API path。
- `apps/api/src/modules/agent.ts` 与 `apps/api/src/agent/*`：复用真实 Agent planner、tool catalog、memory/context、确认卡、执行和审计逻辑。
- `docs/operations.md`：记录如何通过环境变量运行真实 smoke，明确 key 不入库。

### 依赖图

```text
npm smoke:agent
  -> apps/api/src/agent/real-provider-smoke.ts
      -> createApp(settings, tempDb)
      -> /api/v1/auth/register
      -> /api/v1/agent/messages
      -> /api/v1/agent/memories
      -> /api/v1/agent/action-requests/:id/confirm
      -> audit_logs assertion
  -> stdout structured summary
```

Smoke harness 不直接调用业务模块，不跳过 HTTP 路由，不直接写 `agent_action_requests` 或业务表。这样它验证的是前端会使用的真实 API 语义，而不是内部函数的 happy path。

### 真实模型覆盖矩阵

`smoke:agent` 不只验证一条 happy path。它必须通过真实 OpenAI-compatible `tool_calls` 覆盖至少以下方向：

- 只读预测试算
- memory 写入
- 新对话 memory 注入
- 多步骤拆解
- 账号动作拒绝
- 记账确认卡
- 确认卡载荷编辑后执行
- 作废账本分录
- 草稿专用字段保存
- 通用草稿 patch
- 工作区 bundle 导出
- 工作区 bundle 导入确认卡
- 锁账
- 解锁
- 保存快照
- 发布并创建分享链接
- 撤销分享链接
- 恢复版本
- 删除快照 / 版本
- 重置草稿
- Agent 执行审计

### 复用 / 抽象规则

- 复用正式 `createApp`、`createDatabase`、migrations 和 Agent routes。
- 本轮不抽象新的 test framework；只保留一个小型 `SmokeClient`，避免把测试 helper 泄漏到生产路由。
- 临时 SQLite 路径使用 OS temp dir，运行结束关闭 Fastify 和 DB，不污染本地数据。
- 后续 provider-neutral runtime adapter 落地后，smoke runner 只更换 provider settings，不改业务断言。

### 命名与安全规则

- 命令名：`smoke:agent`，表示外网真实模型 smoke，不纳入默认 `npm test`。
- 输出只包含 provider、model、planner source、步骤数量、动作类型、金额、审计数量等验收摘要。
- `OPENAI_COMPATIBLE_API_KEY` / `DEEPSEEK_API_KEY` 只能来自环境变量或本地 `.env`，脚本不得打印 key，也不得把 key 写入任何 fixture、snapshot、日志文件或文档。
- 如果没有 key，命令必须失败并说明缺少环境变量，不能悄悄回退到规则规划；否则 smoke 会变成无意义 demo。

当前实现支持：

- `openai_agents`
- `openai_compatible_tool_calls`
- `rules`

provider-neutral source 当前固定为：

- `openai_agents`
- `openai_compatible_tool_calls`
- `rules`

### 模型规划不可伪造

- 业务工具规划必须来自 provider-native tool calls：OpenAI Agents SDK 的 function tool 执行，或 OpenAI-compatible Chat Completions 的 `message.tool_calls`。
- 兼容 provider 不再接受 assistant 文本里的 JSON steps 作为工具计划。模型如果没有返回 `tool_calls`，后端只记录失败型只读步骤，不生成确认卡。
- 当 `LLM_PROVIDER` 不是 `rules` 时，`POST /api/v1/agent/messages` 不允许静默回退到本地规则/正则生成业务动作。这样可以防止“模型没调用工具，但页面仍靠代码猜测生成确认卡”的假 Agent。
- `rules` 只保留给明确配置的本地/CI 降级路径；真实 smoke 和产品验收必须使用 provider key，并验证 planner source 为 `openai_agents` 或 `openai_compatible_tool_calls`。

### Data Agent 只读问答

简单数据问答不走自由 SQL，也不让后端用正则猜问题。模型必须调用 `data_query_workspace`，把用户问题归一成 `scope / monthLabel / memberName / metrics / order / limit` 等结构化参数；服务端再用当前租户内的 domain services 和账本汇总计算答案。

当前支持：

- `workspace_summary`：基准场景总收入、总成本、总利润、期末现金、ROI、回本周期。
- `period_summary`：某月计划/实际收入、成本、利润。
- `member_summary`：某成员某月或全周期计划收入、提成、公司净贡献。
- `top_months`：按计划利润、收入、成本或累计现金做月份排行。

Data agent 工具是只读工具，不生成确认卡，不写 `agent_action_requests`，但仍会生成 `agent_plan_steps` 和显式导航事件，便于用户核对回答口径。

## 对话历史与恢复

Agent OS 的对话状态必须以服务端为事实源。前端只允许保存“当前打开的 threadId”这种可丢失指针，不能把 messages、确认卡或运行步骤当成本地唯一状态。这样用户刷新、短暂断网或重新打开页面后，仍可以从后端恢复同一个对话、同一批待确认动作和最新运行图。

### 模块划分

```text
packages/contracts
  -> AgentThreadSummary / AgentThreadState / AgentRunRecord

apps/api/src/modules/agent.ts
  -> GET /api/v1/agent/threads
  -> GET /api/v1/agent/threads/:threadId
  -> POST /api/v1/agent/messages
  -> action request confirm / cancel / edit
  -> serializeThreadState()

apps/web/src/hooks/useAgentThread.ts
  -> refreshThreads()
  -> loadThread(threadId)
  -> current threadId localStorage pointer
  -> server-owned messages / planSteps / actionRequests hydration

apps/web/src/components/agent/AgentConsole.tsx
  -> history drawer
  -> current run graph
  -> pending confirmation cards
```

### 依赖图

```text
React Agent Shell
  -> api.listAgentThreads / api.getAgentThread
  -> contracts DTO
  -> Fastify agent routes
  -> Kysely agent_* tables

POST /agent/messages
  -> agent_runs(running)
  -> model/runtime planner
  -> agent_action_requests / agent_plan_steps
  -> agent_runs(completed | failed, planner_source)
  -> agent_threads(updated_at, title)
```

### 恢复语义

- `GET /api/v1/agent/threads` 返回当前登录用户、当前工作区内的线程摘要，包含最近消息、最新 run 状态、planner source 和待确认动作数量。
- `GET /api/v1/agent/threads/:threadId` 返回完整可恢复状态：messages、runs、最新 run 的 planSteps、该线程 actionRequests、navigationEvents 和 planner source。
- 前端启动时先加载历史列表，再尝试读取 `localStorage` 中的当前 `threadId` 并调用 state API 恢复；如果线程不存在或越权，清掉本地指针。
- 新建对话只清前端指针和当前视图，不删除服务端历史。
- 确认、取消、编辑确认卡后更新线程 `updated_at`，历史列表能反映最后活动。
- 前端发送消息使用 background run：`POST /api/v1/agent/messages` 传 `background=true` 后立即返回 `threadId/runId/status=running` 和用户消息，服务端在同一 API 进程内继续执行模型规划并持久化结果。
- 前端拿到 `threadId` 后立即写入本地指针，并轮询 `GET /api/v1/agent/threads/:threadId`；刷新、网络断开或请求响应丢失后，只要浏览器已拿到启动响应，就能恢复 running/completed/failed run、消息、运行图和待确认动作。
- 普通同步模式仍保留给 API 集成测试和后端调用；产品 UI 默认使用 background 模式。
- `agent_runs` 持久化 `input_message_id` 和 `input_message`，使 running run 在 API 进程重启后仍有足够输入上下文恢复模型规划。
- API 启动后会扫描 `status=running` 的 run：如果该 run 还没有 `planSteps/actionRequests` 产物，则重新调用同一套 planner/tool/confirmation 流程并落库为 completed/failed；如果已有部分产物，则 fail-closed 标记为 failed 并写 assistant 提示，避免重复创建确认卡或让用户确认半成品动作。
- 用户可取消当前 running run：`POST /api/v1/agent/runs/:runId/cancel` 会把 run 标记为 `cancelled`、取消该 run 下尚未执行的确认卡和计划步骤、写入 assistant 提示，并中止当前进程里的 provider 请求（OpenAI-compatible adapter 通过 `AbortSignal`）。
- 取消是服务端状态，不是前端假按钮；即使模型响应晚于取消请求，后台任务在回写前会重新检查 run 状态，不能把 cancelled run 改回 completed，也不能留下 pending 确认卡。
- 该恢复/取消机制覆盖单实例 API 进程重启和临时崩溃后的安全续跑；多实例并发抢占和 SSE/WebSocket progress 仍是下一阶段 maturity gate。

### SaaS 隔离规则

- 每个 thread 必须同时匹配 `workspace_id` 和 `user_id`；跨用户或跨工作区访问历史、确认卡、run state 都返回 `403/404`，不能返回部分数据。
- 记忆注入只从当前用户 + 当前工作区读取，thread recovery 不额外扩大 memory 作用域。
- `agent_runs.planner_source` 只保存 provider-neutral planner source，不保存原始模型响应或 provider key。

## 当前实现与缺口

当前已经完成：

- TypeScript API。
- `agent_action_requests`、`agent_plan_steps`、确认/取消/编辑/执行接口。
- `apps/api/src/agent/prompts`。
- `tool-catalog.ts`。
- `memory.ts`。
- `runtime/openai-agents-adapter.ts`，`LLM_PROVIDER=openai` 时通过 OpenAI Agents SDK 的 `Agent / Runner / tool / OpenAIProvider` 收集 tool call plan，并规范化为内部 `RuntimePlanResult`。
- `runtime/openai-compatible-chat-adapter.ts` 和 `adapter-router.ts`，OpenAI-compatible `tool_calls` 不再写在 route module 内，也不与 DeepSeek 绑定。
- `tool-coverage.ts`，把资本、收入、成员、成本、员工、月份模板和工作区 bundle 导入导出等手动可编辑能力注册为 Agent 覆盖矩阵，并把账号动作列为明确手动项。
- 显式 `LLM_PROVIDER=rules` 的本地/CI 兜底；真实 provider 配置下不再用规则冒充模型 tool call。
- 记账、线上系数试算/保存、发布、恢复、分享、锁账等主链路测试。

### Server-side Workspace Bundle

为补齐“导入 / 导出”这类原本只在浏览器文件系统中完成的手动能力，后端提供 server-side bundle 工具：

```text
GET  /api/v1/workspace/bundle
POST /api/v1/workspace/bundle/import
Agent: workspace_export_bundle
Agent: workspace_import_bundle
```

设计约束：

- bundle 格式复用前端 `WorkspaceBundle` 概念：`schemaVersion / workspaceName / currentConfig / snapshots / lastSavedAt`。
- export 是只读动作，可由 Agent 自动执行并返回摘要；前端后续可把结果转成下载文件。
- import 是写入动作，必须先生成确认卡，再通过 `saveDraft` 覆盖当前草稿。
- import 当前只对齐现有前端语义：导入 `currentConfig` 到当前草稿，不恢复历史 snapshots 到后端版本表。
- 不允许 Agent 直接读写本地文件系统。用户可把 bundle JSON 粘贴给 Agent，或后续由前端上传文件后转为 server-side import payload。
- 用户粘贴的大块 JSON 先由服务端 artifact parser 解析和校验摘要，再交给模型规划。模型只需调用 `workspace_import_bundle` 并声明使用已解析 artifact，不能被要求把完整 bundle 原样复制进 tool 参数。

仍需重构：

- `apps/api/src/modules/agent.ts` 过大，混合 routes、runtime、planning、tools 和 execution。
- OpenAI Agents SDK adapter 已形成最小可验证路径，但还没有把 SDK streaming/tracing/human-in-the-loop events 映射为前端实时事件。
- 前端已有后端状态刷新式 action graph / memory panel，仍缺真正 token/tool progress 流式事件。
- 文档验收需要区分当前可验证能力和下一阶段 runtime maturity gate。

## 迁移顺序

1. 固化 ADR 和设计文档。
2. 把 contracts 改为 provider-neutral Agent Protocol。
3. 拆分 `modules/agent.ts` 到 `runtime / kernel / tools / routes`。
4. 把兼容 Chat Completions provider 迁入 `openai-compatible-chat-adapter.ts`。（已完成第一步，仍需继续补 tracing / provider-neutral events）
5. 实现 OpenAI Agents SDK adapter。（已完成最小可验证路径，仍需 streaming/tracing/human-in-the-loop events）
6. 增强 React Agent OS 的 action graph、event timeline、memory 管理。（已完成后端状态刷新式 action graph，仍需流式事件）
7. 用真实 provider 分别跑只读、确认写入、多步骤、拒绝账号动作、memory 隔离测试。

## 验收标准

- `npm.cmd run test:api` 通过。
- `npm.cmd run test:web` 通过。
- `npm.cmd run build:api` 通过。
- `npm.cmd run build:web` 通过。
- `npm.cmd run test` 通过。
- 配置真实 OpenAI-compatible provider key 后，跑通只读试算、多步骤确认写入、账号动作拒绝和 memory 隔离；默认用 DeepSeek key 做 smoke。
- `LLM_PROVIDER=openai` 时，OpenAI Agents SDK adapter 至少跑通一条只读 tool call 和一条确认卡写入预览。
- 模型草稿、记账、版本、分享和工作区 bundle 导入导出等主要手动业务能力已映射到 tool registry / tool coverage；账号动作继续保持 `manual_only`。
- 所有写入动作都有 `agent_action_requests` 和 `audit_logs`。
- Memory list/delete/context injection 均证明不会跨用户或跨工作区。

## 参考资料

- OpenAI Agents guide：`https://platform.openai.com/docs/guides/agents`
- OpenAI Agents SDK JS：`https://openai.github.io/openai-agents-js/`
- Claude Code memory：`https://code.claude.com/docs/en/memory`
- Claude Code subagents：`https://code.claude.com/docs/en/sub-agents`
- Claude Code hooks：`https://code.claude.com/docs/en/hooks`
- Claude Code MCP：`https://code.claude.com/docs/en/mcp`
- Claude Code skills：`https://code.claude.com/docs/en/skills`
- OpenClaw system architecture：`https://openclawlab.com/en/docs/concepts/system-architecture/`
- DeepSeek Tool Calls：`https://api-docs.deepseek.com/zh-cn/guides/tool_calls`
