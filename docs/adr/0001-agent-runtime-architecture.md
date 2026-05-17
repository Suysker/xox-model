# ADR 0001: Agent Runtime 架构采用策略

日期：2026-05-16

## 状态

Implemented for Lean Product Harness core. OpenAI Agents SDK 原生 tracing、guardrail、handoff 和 human-in-the-loop event 深度映射保留为后续 runtime maturity gate，不作为当前 `xox-model` Agent OS 的产品阻塞项；理由见 ADR 0003。

## 背景

`xox-model` 的目标不是在现有页面底部放一个聊天 demo，而是把 SaaS 平台升级为 Agent OS：用户可以通过自然语言驱动测算、调模型、记账、预实分析、版本发布、恢复版本、分享、锁账等能力。页面仍可手动操作，但 Agent 必须成为同等能力的主入口。

早期实现已经具备 TypeScript API、确认卡、可编辑待执行动作、租户内 memory、上下文摘要、OpenAI-compatible `tool_calls` 和显式 rules 降级路径，但 provider 调用、planning、tool 映射、业务执行、memory 和 prompt 曾混在一个 API module 附近，缺少正式 runtime 采用决策，也缺少对 OpenAI、Claude Code、OpenClaw 这类成熟架构的边界判断。

当前实现已经按 ADR 0003 收敛为 Lean Product Harness：Agent API boundary、Conversation Store、Lean Agent Kernel、Context Pack、Tool Catalog Gateway、Runtime Adapter、Action Draft Builder 和 Approval Executor 已拆到 `apps/api/src/agent/*`；OpenAI Agents SDK 与 OpenAI-compatible Chat Completions 都通过 provider-neutral runtime adapter 接入，业务执行仍由 domain services 和确认卡掌控。

## 必须满足的产品约束

- SaaS 多租户隔离必须优先于模型能力，任何工具参数都不能让模型选择 `userId`、`workspaceId` 或跨租户范围。
- 页面上能手动修改的业务能力，原则上都必须能通过 Agent 对话完成；账号登录、退出、注销、删除账号、改密码除外。
- Agent 执行业务动作前必须显式导航到对应页面或面板，不能静默后台写入。
- 所有写入动作必须先产生可编辑确认卡，用户确认后才执行。
- 用户一次说多个动作时，系统必须展示多个步骤，支持逐步确认、取消、编辑和失败定位。
- Tool calling 只表示“模型请求调用工具”，不是执行事实。服务端必须重新校验权限、状态、锁账、revision、派生分录和审计。
- Memory 必须按 `tenant/workspace/user/thread` 分层管理，支持查看、删除、压缩和敏感信息过滤。
- Prompt、skills、tool schema 和 policy 必须文件化或模块化，不允许散落在业务路由字符串中。

## 调研结论

### OpenAI

采用为主 runtime 方向。OpenAI Agents SDK / Agents guide 已经提供 agent、tool、handoff、guardrail、session/context、MCP、tracing、human-in-the-loop 等 Agent 应用所需原语。它适合由应用掌控业务工具、确认、人类审批、状态和审计的 SaaS 场景。

采用边界：

- 直接采用：runtime orchestration、tool definition、handoff、guardrail、streaming/tracing、session/context primitives。
- 不直接外包：业务权限、确认卡、审计、租户隔离、React 页面导航、账务领域服务。
- 需要 adapter：OpenAI runtime 只能通过 `AgentRuntimeAdapter` 接入，不能让 OpenAI SDK 类型扩散到 contracts/domain。

参考：

- `https://platform.openai.com/docs/guides/agents`
- `https://openai.github.io/openai-agents-js/`

### Claude Code

Claude Code 本身不作为 xox-model 的嵌入式产品壳使用；它是编码代理产品，不是多租户财务 SaaS runtime。Claude Agent SDK 不引入。Claude Code 的架构模式仍可作为产品参考：

- `CLAUDE.md` / memory 文件体现“项目规则 + 用户记忆”的分层。
- subagents 体现“专用代理 + 独立上下文 + 工具权限”的分工。
- hooks 体现“工具调用前后可插入确定性检查”的安全边界。
- MCP 体现外部工具/连接器的标准化接入方式。
- skills 体现按需加载的过程知识，但不应替代 SaaS 业务工具。

采用边界：

- 借鉴：memory 分层、subagent 分工、hooks、permissions、skills 按需加载。
- 不采用：Claude Agent SDK、Claude Code CLI/产品壳、Anthropic runtime adapter。

参考：

- `https://code.claude.com/docs/en/memory`
- `https://code.claude.com/docs/en/sub-agents`
- `https://code.claude.com/docs/en/hooks`
- `https://code.claude.com/docs/en/mcp`
- `https://code.claude.com/docs/en/skills`

### OpenClaw

OpenClaw 不直接 fork，也不把业务迁移到它的项目结构中。它的价值在于架构参考：multi-ingress、gateway/control plane、agent execution plane、provider、tool、data/session/audit 分层，以及 session key、queue/lane、tool approval、安全和 observability 设计。

采用边界：

- 借鉴：控制面 / 执行面拆分、runId/sessionKey、tool approval、工具安全边界、可观察事件流。
- 不直接采用：整体代码框架、产品壳、通用助理交互。
- 采用前提：如果未来要 fork 或复用具体代码，必须先完成 license、维护活跃度、安全模型和多租户适配评估。

参考：

- `https://openclawlab.com/en/docs/concepts/system-architecture/`

### DeepSeek

DeepSeek 保留为默认真实模型测试通道，不作为 Agent OS 架构底座。当前实现使用通用 OpenAI-compatible Chat Completions adapter，DeepSeek、豆包、Qwen 等兼容 `tool_calls` 的服务都只能证明模型能选择函数和参数，但不提供完整 runtime、memory、approval、tenant isolation、tracing 和前端操作系统协议。

采用边界：

- 保留：开发/测试 provider、OpenAI-compatible Chat Completions tool calls、真实 smoke test。
- 不承担：Agent kernel、memory manager、confirmation workflow、audit、React OS。
- 切换要求：后续换 OpenAI runtime 或任意 OpenAI-compatible provider 只能改当前用户 / 工作区 provider setting、env 兜底或 adapter，不改业务 tool 代码。

参考：

- `https://api-docs.deepseek.com/zh-cn/guides/tool_calls`

## 决策

采用“成熟 runtime + 本项目 SaaS Agent Kernel”的架构，而不是继续扩大自研 planner。

```text
React Agent OS
  -> packages/contracts Agent Protocol
  -> apps/api Agent Kernel
      -> AgentRuntimeAdapter
          -> OpenAI Agents SDK adapter
          -> OpenAI-compatible Chat Completions adapter
          -> Rules adapter only when LLM_PROVIDER=rules
      -> MemoryManager
      -> ContextCompactor
      -> PromptRegistry / SkillRegistry
      -> ToolPolicy / PermissionHooks
      -> ActionPlanner / ActionGraph
      -> ConfirmationCardService
      -> Audit/EventStream
  -> BusinessToolFacade
      -> workspace module
      -> ledger module
      -> share module
      -> variance/domain services
  -> db
```

核心原则：

- OpenAI Agents SDK 是第一优先 runtime 目标。
- DeepSeek 作为兼容 provider 和真实模型验证，不作为架构中心。
- Claude Agent SDK 不引入；Claude Code 只作为交互模式参考。
- OpenClaw 作为 control plane / execution plane / approval / observability 的参考。
- Business tools 不实现为 skills。Skills 只作为可选的模型过程知识包，不能绕过 tool policy、confirmation、domain services 和 audit。
- MCP 用于外部连接器或文件/第三方工具接入；平台内部财务能力继续走 server tools。

## 目标模块划分

### `packages/contracts`

承载稳定协议，不依赖任何 provider SDK：

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

runtime adapter 层：

- `runtime-adapter.ts`：统一接口。
- `openai-agents-adapter.ts`：OpenAI Agents SDK。
- `openai-compatible-chat-adapter.ts`：OpenAI-compatible Chat Completions。
- `rules-adapter.ts`：CI 和无 key 环境兜底。

adapter 只返回规范化 `AgentRuntimePlan` / `AgentRuntimeEvent`，不能写库。

### `apps/api/src/agent/kernel`

业务无关的 Agent OS 内核：

- `agent-kernel.ts`：一次用户消息触发一个 run。当前代码采用文件级 Lean Kernel façade，未强制使用 `kernel/` 子目录。
- `action-graph.ts`：多步骤 DAG 和依赖关系。
- `confirmation-service.ts`：创建、编辑、确认、取消 action request。
- `tool-policy.ts`：工具权限、风险等级、账号动作拒绝。
- `memory-manager.ts`：租户分层记忆。
- `context-compactor.ts`：线程摘要和上下文预算。
- `prompt-registry.ts`：系统提示词、工具说明、skills 说明。
- `event-stream.ts`：前端流式事件。

### `apps/api/src/agent/tools`

受控业务工具，不直接使用 provider SDK：

- `ui-tools.ts`
- `workspace-tools.ts`
- `ledger-tools.ts`
- `version-tools.ts`
- `share-tools.ts`
- `variance-tools.ts`
- `tool-registry.ts`

工具只调用 domain/module service，不直接写表。

### `apps/api/src/agent/prompts`

提示词文件目录：

- `operator.system.md`
- `planner.system.md`
- `memory.system.md`
- `tool-policy.system.md`
- `skills/*.md`，仅用于过程说明，不用于绕过工具执行。

### `apps/web/src/components/agent`

React Agent OS：

- `AgentShell`
- `AgentConsole`
- `AgentPlanTimeline`
- `AgentActionCard`
- `AgentMemoryPanel`
- `AgentEventLog`

前端必须展示步骤状态、导航、待确认动作、可编辑 payload、执行结果和错误。

## Memory 设计

Memory 分层：

| 层级 | 范围 | 例子 | 生命周期 |
| --- | --- | --- | --- |
| user memory | `userId` | 用户偏好、展示习惯 | 用户可查看/删除 |
| workspace memory | `workspaceId + userId` | 当前工作区的记账默认人、业务别名 | 用户可查看/删除 |
| thread memory | `threadId + workspaceId + userId` | 当前对话上下文 | 可压缩/归档 |
| run context | `runId` | 本次指令的临时事实 | run 完成后只保留审计摘要 |

禁止项：

- 不能跨用户注入 memory。
- 不能跨 workspace 注入 memory。
- 不能保存 API key、token、密码、验证码、真实隐私标识。
- 不能让模型直接决定 memory 的租户范围。

## Context Compaction 设计

上下文压缩不是简单拼最近消息。目标流程：

1. 每个 run 装载：系统 prompt、tool schema、权限策略、相关 memory、当前 workspace 摘要、最近消息。
2. 超过阈值时生成同租户 thread summary。
3. summary 只保留业务目标、已确认事实、未完成动作、用户偏好和重要错误。
4. summary 不能包含 secrets。
5. 后续 run 使用 summary + recent messages，而不是无限传历史。
6. 用户删除 memory 后，后续 prompt 不得再注入该 memory；thread summary 中如包含同类内容，需要重新压缩或标记失效。

## Tool Calling 语义

正确链路：

```text
model tool_call
  -> normalize to internal tool intent
  -> policy check
  -> preview through business service
  -> create editable action_request
  -> user edit / confirm / cancel
  -> execute through business service
  -> audit
  -> emit refresh/navigation events
```

禁止链路：

```text
model tool_call -> write database
model JSON -> pretend it is an executed tool
model-chosen workspaceId -> query cross tenant data
skill markdown -> directly perform business mutation
```

## 当前实现的处理

保留：

- TypeScript API、Kysely schema、domain/contracts 分层。
- `agent_action_requests`、`agent_plan_steps`、确认/取消/编辑/执行接口。
- `apps/api/src/agent/prompts`、`tool-catalog.ts`、`memory.ts` 的现有能力。
- OpenAI-compatible `tool_calls` 测试路径和显式 `LLM_PROVIDER=rules` 的本地/CI 降级路径。

已落地：

- `apps/api/src/modules/agent.ts` 已删除；routes、run submission、run worker、planner、kernel、runtime adapters、context pack、tool gateway、action graph store、approval executor、tool executor、memory 和 prompts 都位于 `apps/api/src/agent/*`。
- `@openai/agents` 已通过 `openai-agents-adapter.ts` 成为真实 runtime adapter：使用 SDK `Agent / Runner / tool / OpenAIProvider` 收集 provider-native tool call，并规范化为内部 `RuntimePlanResult`。
- `AgentPlannerSource` 已从 DeepSeek 特化改成 provider-neutral 值：`openai_agents | openai_compatible_tool_calls | rules`；不再接受 assistant JSON 文本作为工具计划。
- `LLM_PROVIDER=openai` 可用本地 fake OpenAI Chat Completions server 验证只读 tool call 和确认卡写入预览；SDK runner start、function tool planning 和 runner completed 已映射为 provider-neutral `provider_stream_*` run events。
- `LLM_PROVIDER=deepseek / qwen / doubao / openai-compatible` 走通用 OpenAI-compatible Chat Completions adapter，真实 DeepSeek smoke 覆盖多步骤、记忆、确认卡、账务、版本、分享和审计。

明确延后：

- SDK 原生 tracing、guardrail、handoff 和 human-in-the-loop event 的深度映射属于 runtime maturity gate。当前产品的安全边界由 Tool Policy、Confirmation Card、Approval Executor、domain services、audit logs 和 tenant-scoped memory/context 承担，不能把这些职责外包给 provider SDK。

## 迁移计划

### M1: 架构决策固化

编辑路径：

- `docs/adr/0001-agent-runtime-architecture.md`
- `docs/agent-design.md`
- `docs/project-architecture.md`
- `.agent/lessons.md`

验收：

- 文档明确 OpenAI、Claude Code、OpenClaw、DeepSeek 的采用边界，且确认不引入 Claude Agent SDK。
- 文档明确 current implementation 与 target architecture 的差距。

### M2: Provider-neutral contracts

编辑路径：

- `packages/contracts/src/index.ts`
- `apps/api/src/agent/*`
- `apps/api/tests/api.test.ts`

验收：

- contracts 不出现 DeepSeek-only planner source 作为唯一 runtime 语义。
- API 测试仍覆盖 OpenAI-compatible provider，并用不同 provider 名称证明不绑定 DeepSeek。
- 新增 provider-neutral adapter 测试。

### M3: 拆分 Agent module

编辑路径：

- `apps/api/src/modules/agent.ts`
- `apps/api/src/agent/runtime/*`
- `apps/api/src/agent/kernel/*`
- `apps/api/src/agent/tools/*`

验收：

- route 文件只负责 HTTP。
- runtime adapter 不写 DB。
- tools 不读取 provider SDK。
- kernel 统一处理 run、action graph、confirmation、audit。

### M4: 引入 OpenAI Agents SDK adapter

编辑路径：

- `apps/api/package.json`
- `apps/api/src/agent/runtime/openai-agents-adapter.ts`
- `apps/api/src/core/settings.ts`
- `docs/operations.md`

验收：

- `LLM_PROVIDER=openai` 时使用 OpenAI Agents SDK。
- provider-native tool call 和 runner lifecycle 能被 adapter 规范化为内部 plan result 与 run events。
- SDK 原生 handoff/guardrail/tracing 若后续启用，必须继续进入 provider-neutral events，且不得绕过确认卡、Tool Policy、租户隔离和 audit。
- 切换 provider 不改 business tool。

### M5: MCP / Skills / Claude Code 参考边界

编辑路径：

- `apps/api/src/agent/mcp/*`，需要时新增
- `apps/api/src/agent/prompts/skills/*`
- `docs/agent-design.md`

验收：

- 代码和文档不新增 Claude Agent SDK adapter。
- MCP 只接外部工具，不接核心财务写入。
- skills 只作为说明层，不具备执行权限。

### M6: React Agent OS 完整化

编辑路径：

- `apps/web/src/components/agent/*`
- `apps/web/src/hooks/useAgentThread.ts`
- `apps/web/src/lib/api.ts`

验收：

- 多步骤 action graph 可视化。
- pending action 可编辑。
- 每步显示导航、状态、确认、取消、错误。
- 执行后刷新对应页面数据。

## 最终验收标准

- `npm.cmd run test:api` 通过。
- `npm.cmd run test:web` 通过。
- `npm.cmd run build:web` 通过。
- `npm.cmd run build:api` 通过。
- `npm.cmd run test` 通过。
- 配置真实 OpenAI-compatible provider key 后，通过只读试算、多步骤确认写入、账号动作拒绝、memory 隔离和用户 / 工作区 provider setting smoke test；默认 provider 可继续使用 DeepSeek。
- `LLM_PROVIDER=openai` 可在本地通过 OpenAI Agents SDK adapter 跑通至少一条只读 tool call 和一条确认卡写入预览。
- SDK 原生成熟化增强不改变当前 Agent OS 验收：handoff/guardrail/tracing/HITL 只能作为 provider-neutral run events 或 policy hooks 的附加输入，不能成为业务执行权限来源。
- Agent runtime、kernel、tools、routes 分层可通过代码审查验证。
- 页面可手动修改的业务能力均有 tool 覆盖，或在工具矩阵中列出明确禁止原因。
- 所有写入 action request 和 audit log 可查。
- Memory 管理支持 list/delete，并证明跨用户、跨 workspace 无法读取。
- Context compaction 有测试覆盖，不会把其他租户消息或 secrets 注入 prompt。

## 后果

收益：

- 不再把一个 provider 的 `tool_calls` 当成 Agent OS。
- 后续可切换 OpenAI runtime / OpenAI-compatible provider，而不重写业务工具。
- SaaS 安全、确认卡、审计和 React 页面状态成为稳定内核。
- 可以学习 Claude Code / OpenClaw 的成熟模式，同时避免把通用助理框架强行塞进财务业务系统。

代价：

- Agent 边界已拆出，后续新增能力必须继续维护 adapter、kernel、tool registry、approval 和 executor 的分层测试。
- OpenAI Agents SDK 原生成熟化、MCP 和 skills 都要按 feature flag 渐进引入；Claude Agent SDK 不进入实现计划。
- 更清晰的 harness 边界会带来更多小模块和守护测试，但它避免了 provider、业务执行和前端状态混在一起。
