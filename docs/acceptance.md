# 验收清单

## 认证

- [x] 注册后自动创建默认工作区并完成登录
- [x] 使用有效账号可以正常登录
- [x] 刷新页面后会话保持有效并自动续期
- [x] 退出登录后当前会话失效
- [x] 注销账号会撤销全部会话，并阻止后续再次登录
- [x] 跨工作区越权访问返回 `403`

## 草稿

- [x] 修改测算字段后会自动保存到后端
- [x] 刷新后恢复最近一次成功保存的草稿
- [x] 旧 `revision` 会返回 `409`
- [x] 前端会把版本冲突明确反馈给用户

## 发布 / 回滚 / 分享

- [x] 发布后生成不可变版本，`version_no` 连续递增
- [x] 发布时会同步固化月度事实表和行项目事实表
- [x] 再次编辑只影响草稿，不会改写已发布版本
- [x] 回滚会从历史版本生成新草稿
- [x] 回滚后历史版本保持不变
- [x] 分享链接只允许针对发布版创建
- [x] 公开分享页读取的是冻结的发布载荷
- [x] 公开分享页可查看经营分析、月度结果、成员表现和模型输入
- [x] 撤销分享后原链接立即失效

## 科目映射 / 账务

- [x] 预测收入项和成本项都映射到稳定的 `subject_key`
- [x] 一笔实际分录可以拆分到多个预测科目
- [x] 分摊金额合计必须等于原始分录金额
- [x] 科目方向必须与分录方向一致
- [x] 作废分录不再计入实际汇总
- [x] 锁定期间后禁止记账和作废
- [x] 预测项后续改名或删除后，历史版本和历史分摊名称仍能保留

## 预实分析

- [x] 计划值来自 `ledger_period.baseline_version_id`
- [x] 实际值来自已过账分摊
- [x] 月度汇总与行项目汇总一致
- [x] 当期差异额 / 差异率口径一致
- [x] 累计差异额 / 差异率口径一致

## 非功能

- [x] 核心接口会写入审计日志
- [x] 迁移入口可重复执行
- [x] 前端单测通过
- [x] 前端生产构建通过
- [x] TypeScript 后端 API 集成测试通过
- [x] 浏览器验收覆盖自动保存、发布、分享、记账、预实分析、回滚、撤销分享

## Agent OS 当前能力

- [x] 底部 Agent 台常驻，主工作台缩放为 85%
- [x] Agent 可通过导航事件显式切换到测算、调模型、记账、偏差和版本管理面板
- [x] Agent 可把一条复合指令拆成多步骤计划，并像任务清单一样展示步骤状态
- [x] 待确认动作可在执行前编辑摘要、明细和执行载荷
- [x] Agent 台支持新建对话，且新对话不会清空当前用户 / 当前工作区记忆
- [x] Agent 台展示当前 planner 来源、对话 id、工作区记忆列表，并支持刷新和删除记忆
- [x] API 集成测试覆盖通用 OpenAI-compatible Chat Completions `tool_calls` 协议；假 provider 分别以 `qwen`、`doubao`、`openai-compatible` 配置接入，证明业务工具不特调 DeepSeek；当 provider 已配置或被选择时，模型未返回 tool call 不会回退规则规划
- [x] Agent prompts、tool catalog、memory/context 模块有独立代码边界，不把系统提示词散在路由代码里
- [x] Agent memory 按用户和工作区隔离，支持查询和删除；长对话会生成同租户上下文摘要
- [x] 新建对话后，真实 provider 请求会注入同用户 / 同工作区 memory
- [x] 记账类命令会生成确认卡，确认后过账并刷新工作台
- [x] 线上系数试算类命令只读执行，不修改草稿
- [x] 草稿修改、发布、恢复、分享、锁账等写入动作采用确认卡协议
- [x] 账号登录、退出、注销、删除账号和密码类动作不允许 Agent 自动执行
- [x] Agent 写入动作会记录 `agent_action_requests` 和 `audit_logs`
- [x] `npm.cmd run smoke:agent` 提供受控真实 OpenAI-compatible provider smoke：默认使用 DeepSeek，但通过 `OPENAI_COMPATIBLE_*` 可切换豆包、Qwen 等兼容服务；不允许无 key 回退，覆盖 26 个真实模型方向：只读预测、Data agent、background run 恢复、持久运行轨迹、缺信息澄清提问、memory 写入、新对话记忆注入、多步骤、账号动作拒绝、记账确认卡、确认卡载荷编辑、作废分录、草稿专用字段保存、通用草稿 patch、工作区 bundle 导出、工作区 bundle 导入、锁账、解锁、保存快照、发布、创建分享、撤销分享、恢复版本、删除版本、重置草稿和审计
- [x] 真实 DeepSeek smoke 已验证锁账/解锁不是后端规则推断：planner source 为 `openai_compatible_tool_calls`，模型会根据 tool catalog 和 planner prompt 调用 `ledger_set_period_lock` 并生成确认卡
- [x] 后端接口级 Agent capability matrix 覆盖超过 10 个不同方向的复杂任务，并全部通过：
  - 记忆写入
  - 新对话记忆注入
  - 默认成员记账
  - 只读预测试算
  - 草稿参数保存
  - 通用模型 patch
  - 确认卡编辑后执行
  - 锁账 / 解锁
  - 工作区 bundle 导出 / 导入
  - 保存快照
  - 发布并创建分享链接
  - 撤销分享链接
  - 恢复版本
  - 删除快照
  - 重置草稿
  - 账号动作拒绝
  - Data agent 单月数据问答
  - Agent 审计日志

## Agent Runtime 成熟化

- [ ] `docs/adr/0001-agent-runtime-architecture.md` 中的 runtime 采用策略完成代码落地
- [ ] `apps/api/src/modules/agent.ts` 拆分为 routes、kernel、runtime adapters、tools、memory/context、confirmation service
- [x] OpenAI-compatible Chat Completions provider 调用已从 `modules/agent.ts` 抽到 `apps/api/src/agent/runtime/openai-compatible-chat-adapter.ts`，通过 `adapter-router.ts` 输出统一 runtime plan result
- [x] Confirmation service 已从 `modules/agent.ts` 抽到 `apps/api/src/agent/action-requests.ts`，统一处理确认卡创建、编辑、确认、取消、执行状态、assistant message、run event 和审计；routes 只做 HTTP 编排与 thread publish
- [x] Server tool execution 已从 confirmation service 抽到 `apps/api/src/agent/tool-executor.ts`，确认执行时先走 tool policy，再由 executor 调用 workspace / ledger / share 领域服务；provider/runtime 仍不能直接写业务数据
- [x] `packages/contracts` 的 planner source 已改为 `openai_agents / openai_compatible_tool_calls / rules`，不再把 DeepSeek planner source 作为唯一主语义，也不再接受 assistant JSON 文本冒充 tool call
- [x] 常规 Agent 请求在 `LLM_PROVIDER != rules` 时不会用本地正则/规则替模型生成业务动作；API 测试覆盖“provider 有 key 但未返回 tool_calls”和“provider 被选择但无 key”两种情况，均不生成确认卡
- [x] Data agent 只读问答必须由模型调用 `data_query_workspace`，API 测试和真实 smoke 覆盖“3 月计划收入和计划成本是多少”这类问题；该路径不生成确认卡、不写业务数据，并打开对应分析页面
- [x] Data Agent 只读回答生成已从 `modules/agent.ts` 抽到 `apps/api/src/agent/data-agent.ts`，只读取当前 workspace projection / ledger period summary，返回回答和导航事件，不创建确认卡、不写业务数据
- [x] `LLM_PROVIDER=openai` 时可通过 OpenAI Agents SDK adapter 跑通只读 tool call 和确认卡写入预览；API 测试用本地 fake OpenAI Chat Completions server 验证 SDK `Agent / Runner / tool / OpenAIProvider` 路径
- [x] `LLM_PROVIDER=deepseek` 或 `LLM_PROVIDER=openai-compatible` 时可用 OpenAI-compatible Chat Completions `tool_calls` 跑通真实模型 10+ 方向 smoke test，并已沉淀为 `npm.cmd run smoke:agent`
- [x] 代码和文档不引入 Claude Agent SDK adapter；Claude Code 只作为交互模式参考
- [x] Agent 可写模型字段矩阵已注册在 `apps/api/src/agent/tool-coverage.ts`，覆盖资本规划、收入引擎、团队成员、成本结构、运营员工、月份模板、工作区 bundle 导入导出等主要手动输入路径；账号动作列为明确手动项
- [x] Tool policy / permission hooks 覆盖账号动作拒绝、写入确认、确认卡编辑后的必需导航、跨租户 payload 禁止、锁账禁止、派生提成禁止直接编辑
- [x] 多步骤消息中如果同时包含合法业务动作和账号禁用动作，合法业务动作仍会生成确认卡，账号动作只作为该步骤的只读拒绝项展示
- [x] Memory list/delete/context injection 有测试证明不会跨用户或跨工作区，并且不会保存 secrets；当前 secret-like 消息会在 provider prompt 中 redaction，后续新线程不再注入
- [x] Context compaction 有测试证明 summary 只来自同一 thread / user / workspace，并且 summary 不包含 API key/token 原文
- [x] React Agent OS 展示 action graph、导航事件、确认卡状态、确认卡编辑、取消、失败和执行后刷新；当前为后端状态刷新式 timeline
- [x] Agent 历史对话和当前线程恢复已由 `/api/v1/agent/threads` 与 `/api/v1/agent/threads/{threadId}` 提供；API 测试覆盖 messages、runs、planSteps、actionRequests、navigationEvents、跨用户隔离和确认后状态恢复，React hook 会用本地 threadId 指针恢复服务端状态
- [x] Agent thread store 已从 `apps/api/src/modules/agent.ts` 拆到 `apps/api/src/agent/thread-store.ts`，集中处理 thread ownership、message 写入、ThreadState 恢复和 DTO 序列化，避免 routes 自己拼恢复状态
- [x] React 默认使用 background run 发送 Agent 消息；`POST /api/v1/agent/messages` 会先返回 `status=running`，后台 run 由持久化 `agent_runs` 队列和 worker lease 认领执行，刷新后通过 SSE thread state 或 REST polling 恢复 completed/failed run、assistant message、计划步骤和确认卡；API 测试和真实 provider smoke 已覆盖后台启动与恢复
- [x] React Agent OS 优先通过 `/api/v1/agent/threads/{threadId}/events` SSE 接收服务端 `thread_state`，连接失败时回退到 REST polling；API 测试覆盖 SSE 初始状态、后续动作事件和跨用户隔离，web 测试覆盖事件 URL 编码
- [x] `agent_runs` 持久化输入消息，API 启动时会恢复可安全重跑的 `running` run；如果重启前已经产生部分 `planSteps/actionRequests`，系统 fail-closed 标记 run failed 并取消未执行确认卡，防止重复确认或重复执行
- [x] 后台 run 支持 worker lease：API 测试覆盖未租约/过期租约可恢复、其他 worker 的未过期租约不会被抢占、旧 worker 在失去租约后收到迟到模型结果也不能写 assistant message、plan step 或 pending confirmation card
- [x] 后台 run 支持周期 worker sweep：background 请求只入队，API 测试覆盖未显式调用 recovery 时，worker 也会按队列扫描认领 unleased running run 并完成真实 provider-compatible tool call 规划
- [x] 后台 run 有持久化 `agent_run_events` 运行轨迹：API、SSE、React 运行图和真实 provider smoke 均覆盖 run 入队、worker 认领、模型规划、工具计划、确认卡生成、确认卡编辑、执行、取消和失败等用户可见步骤
- [x] Run trace 写入和序列化已从 `apps/api/src/modules/agent.ts` 拆到 `apps/api/src/agent/run-events.ts`，作为后续 routes/kernel/confirmation service 继续切分的独立服务边界
- [x] 用户可取消 running run；取消后 run 进入 `cancelled`，当前 provider 请求会被中止，迟到的模型结果不能把 run 改回 completed，也不能留下 pending 确认卡
- [x] 缺少必要业务信息时，模型可通过 `ask_user_clarification` tool_call 生成只读澄清步骤；API 测试和真实 smoke 覆盖“不知道月份/成员/张数时先问用户”，不生成确认卡、不用规则猜参数
- [x] 浏览器刷新时 `/api/v1/auth/me` 并发恢复保持幂等，不会因 token 旋转竞态把用户踢回登录页，从而保证 Agent thread 恢复能发生
- [ ] React Agent OS 支持 provider token 级流式输出；当前已经支持服务端 thread state SSE，但 provider streaming chunk 还未接入
- [ ] 页面可手动修改的业务能力全部映射到 tool registry，或在工具矩阵中列出明确禁止原因；当前剩余缺口是 Agent 模块拆分、独立队列进程/跨实例 pubsub 和 provider token 级流式输出
