# 运维说明

## 本地运行

前端：

```bash
npm.cmd install
npm.cmd run dev:web
```

后端：

```bash
npm.cmd run dev:api
```

## Linux 一键部署

生产环境的前后端部署统一使用 `infra/scripts/deploy-linux.sh`。这个脚本不会修改 nginx 配置，而是直接在服务器上完成：

- 代码拉取或更新（当提供 `REPO_URL` 时）
- 前端和 TypeScript API 构建
- Node workspace 依赖安装
- `xox-model-api` / `xox-model-web` 两个 systemd 服务写入与重启
- Web 服务同源代理 `/api/*` 到本机 API

在仓库根目录执行：

```bash
sudo bash infra/scripts/deploy-linux.sh
```

如果脚本是单独放在目标机器当前目录执行的，则需要在执行前传入仓库地址：

```bash
sudo REPO_URL=<git-url> bash ./deploy-linux.sh
```

可选参数：

```bash
sudo WEB_PORT=4173 API_PORT=8000 PUBLIC_ORIGIN=http://127.0.0.1:4173 bash infra/scripts/deploy-linux.sh
sudo RUN_TESTS=1 bash infra/scripts/deploy-linux.sh
```

部署后验证：

```bash
curl http://127.0.0.1:8000/api/v1/health
curl http://127.0.0.1:4173/api/v1/health
sudo systemctl status xox-model-api
sudo systemctl status xox-model-web
```

## 数据库

- 本地默认：`SQLite`
- 生产目标：`PostgreSQL`
- 当前建表 / 迁移入口：API 启动时自动运行 `apps/api/src/db/migrations.ts`
- 当前迁移策略基于 `CREATE TABLE IF NOT EXISTS` 和缺列补丁，可重复执行

## Agent Provider

- Agent runtime 采用 provider adapter 模式。`LLM_PROVIDER=openai` 已接入 OpenAI Agents SDK adapter；DeepSeek 只是默认真实 smoke provider，豆包、Qwen 等兼容 `tools / tool_calls` 的服务通过通用 OpenAI-compatible adapter 接入，不改业务工具代码；不引入 Claude Agent SDK。
- SaaS 用户配置优先级最高：`GET/PUT/DELETE /api/v1/agent/provider-settings` 管理当前用户 / 工作区的 OpenAI-compatible provider。响应只返回 `hasApiKey`，不返回 key；首次保存必须提供 key，后续可省略 key 只改 provider/base URL/model。配置 `AGENT_PROVIDER_KEY_ENCRYPTION_SECRET` 后，`agent_provider_settings.api_key` 使用 AES-256-GCM 写入 `enc:v1` ciphertext；旧明文记录仍可读，便于升级。生产部署必须把该 secret 放在 KMS/secret vault 或部署平台 secret 中，并建立轮换策略。
- `POST /api/v1/agent/provider-settings/probe` 可在保存前或保存后验证当前用户 / 工作区的 provider 配置。Probe 使用同一套 `ProviderModelProfile -> ProviderRequestShaper -> Agentic OS schema/payload compatibility` 路径，发送一个低成本非流式 tool-call 请求，并返回脱敏的 `auth / model / chat / tools / stream` 检查结果；它不持久化表单值，也不把 key 写入响应、run event 或日志。
- 服务端环境变量作为没有用户配置时的兜底：
  - `LLM_PROVIDER=openai | openai-compatible | deepseek | doubao | qwen | rules`
  - `OPENAI_BASE_URL=https://api.openai.com/v1`
  - `OPENAI_MODEL=gpt-5.4-mini`
  - `OPENAI_API_KEY=<openai-key>`
  - `OPENAI_COMPATIBLE_PROVIDER=<display-name>`
  - `OPENAI_COMPATIBLE_BASE_URL=<provider-base-url>`
  - `OPENAI_COMPATIBLE_MODEL=<model-name>`
  - `OPENAI_COMPATIBLE_API_KEY=<provider-key>`
  - `AGENT_PROVIDER_KEY_ENCRYPTION_SECRET=<deployment-secret-for-user-provider-keys>`
  - `AGENT_PROVIDER_REQUEST_TIMEOUT_MS=240000`：provider 单轮请求默认预算。复杂结构化目标会在运行时保底使用长预算；生产不建议低于默认值，否则大 tool-call arguments 可能被本服务提前 abort。
- DeepSeek 兼容变量仍可用作默认 smoke 配置：`DEEPSEEK_BASE_URL / DEEPSEEK_MODEL / DEEPSEEK_API_KEY`。密钥只放用户提交的 provider setting、本地 `.env` 或部署环境变量，不写入仓库。
- `apps/api/src/agent/runtime/openai-agents-adapter.ts` 使用 OpenAI Agents SDK 的 `Agent / Runner / tool / OpenAIProvider`，SDK tool 只收集内部 plan step，不执行领域写入；`apps/api/src/agent/runtime/openai-compatible-chat-adapter.ts` 使用通用 Chat Completions `tools / tool_calls`，并通过 OpenClaw-inspired provider runtime 兼容层处理多厂商差异：canonical `provider/model`、每个 provider/model 的工具、schema、context、thinking 和 `tool_choice` 策略由 `@agentic-os/runtime-openai-compatible` 的 provider model profile 提供；provider-facing tool schema normalization 和 OpenAI-compatible request body sanitation 也由 `@agentic-os/runtime-openai-compatible` 提供。`provider-request-shaper.ts` 只负责把 xox `RuntimePlanningInput`、prompt/messages、profile 和 package compatibility helper 组合成请求体；`tool-call-repair.ts` 只把 provider 已输出的工具名和 JSON arguments 映射成 xox planner step；provider HTTP classifier、safe error redaction、`tool_choice` rejection detection 和 same-turn retry decision/patch 也由 `@agentic-os/runtime-openai-compatible` 提供，`provider-failover-policy.ts` 只保留 xox 高容量业务工具预算和中文 run-event copy。`tool_choice` 仅按 profile 发送 `auto/required` 或省略，不使用 forced named choice，同时接受普通 assistant 文本作为只读回复。当 `LLM_PROVIDER` 不是 `rules` 时，常规 Agent 请求不会回退到规则/正则生成业务动作；只有 provider-native tool call 才能生成确认卡。真实 smoke 命令不允许无 key 运行。
- Agent memory 会拒绝保存 secret-like 内容；context summary 和 provider prompt 注入的 recent messages 会做 secret redaction，避免 key/token 被带入后续模型上下文。
- `agent_memories` 和 `agent_context_snapshots` 是租户数据，备份、导出和删除策略必须按用户 / 工作区权限处理。
- Agent 历史对话以服务端 `agent_threads / agent_messages / agent_runs / agent_run_events / agent_plan_steps / agent_action_requests` 为事实源。前端 `localStorage` 只保存当前 threadId 指针；发送消息时默认启动 background run，拿到 `threadId/runId/status=running` 后优先订阅 `/api/v1/agent/threads/:threadId/events` 的 SSE `thread_state` 事件，失败时轮询 `/api/v1/agent/threads/:threadId` 恢复 running/completed/failed/cancelled 状态、messages、持久运行轨迹、运行图和待确认动作；新建对话不会删除历史。`agent_runs` 是持久化 run queue，会保存输入消息、`worker_id`、`lease_expires_at` 和 `heartbeat_at`；`agent_run_events` 保存 run 入队、worker 认领、模型规划、provider chunk 预览、工具计划、确认卡生成、确认卡编辑、执行、取消和失败等用户可见步骤，不保存 provider 原始响应、提示词全文、完整 tool arguments 或密钥。OpenAI-compatible provider 调用默认发送 `stream: true`；DeepSeek/Qwen/Doubao 等兼容 `text/event-stream + tool_calls` 的返回会先脱敏截断为 `provider_stream_*` run event，再通过同一条 thread state SSE 投影给前端。background 请求只入队，Agent run worker 按 `AGENT_RUN_WORKER_POLL_MS` 扫描并认领可执行 run。API 启动和周期 worker 都只恢复可认领且尚未产生运行产物的 `running` run；如果 run 在重启前已经生成部分步骤或确认卡，则 fail-closed 并取消未执行确认卡，要求用户重发。用户也可以取消当前 running run，服务端会中止当前进程里的 provider 请求并取消未执行确认卡。多实例部署时必须保证 `AGENT_WORKER_ID` 在每个 API worker 内唯一；`AGENT_RUN_LEASE_TTL_MS` 默认 45000，`AGENT_RUN_WORKER_POLL_MS` 默认 2000，长模型调用期间会 heartbeat 续租，迟到且已失去租约的模型结果不能回写。当前 SSE broker 是单进程内事件总线，跨实例强实时仍需要 Redis/pubsub；当前剩余成熟化工作是独立队列进程和 OpenAI Agents SDK tracing 事件映射。
- 浏览器刷新会并发触发会话恢复和业务数据加载。`/api/v1/auth/me` 必须保持幂等，只延长当前 token 有效期，不在每次恢复时旋转 token，否则并发请求会因为旧 cookie 竞态导致误登出。
- Agent 数据问答通过 `data_query_workspace` 只读工具完成。模型只负责选择查询 scope 和指标，服务端用当前工作区的测算、账本和预实汇总计算答案；不要暴露自由 SQL，也不要在 provider 模式下用本地正则替模型选择工具。
- 团队成员数量、成员名单和团队构成问题使用 `data_query_workspace` 的 `scope=team_summary`；服务端从当前草稿 `teamMembers` 读取人数和名称，不返回工作区财务总览替代答案。
- Agent 普通对话、问候、身份说明和能力说明直接使用 assistant 文本完成。provider 模式下如果模型只返回普通文本而没有 tool call，系统只持久化文本回复，不会用规则伪造业务动作；不保留 `agent_reply` 这类废弃回复工具。
- Agent provider 调用错误会按缺少 API key、HTTP 认证/请求失败、网络/base URL 失败、响应超时、真实无 tool_call 分开展示。切换 provider 时如果 API key 留空会保留旧 key；从 qwen 切到 DeepSeek 时必须重新填写 DeepSeek key，否则会显示 HTTP 401/403 认证失败。复杂 tool-call stream 如果已暴露工具名但超时或参数损坏，系统会记录 `provider_retrying`，改用同一工具投影的非流式请求重试一次；重试不会发送 forced named `tool_choice`，若兼容 provider 连 `tool_choice: auto` 也不支持，adapter 会保留工具列表并去掉 `tool_choice` 再试一次。
- Agent 可写模型字段矩阵维护在 `apps/api/src/agent/tool-coverage.ts`。新增前端手动输入字段时，必须同步补该矩阵和 API 覆盖测试，否则模型可能不知道对应 patch path。真实 provider prompt 只注入 patterns 和少量样例字段，完整矩阵留在代码和测试里，避免每次请求携带所有月份/成本项导致延迟过高。
- 团队成员新增/删除是结构性草稿变更，必须走 `team_member_add` / `team_member_delete` 专用 tool call，再由服务端生成 `workspace.update_draft` 确认卡；不要让模型通过 `workspace_patch_config` 直接重写整个 `teamMembers` 数组。确认执行前会拒绝把团队成员编辑到 0 个，防止用户编辑确认卡载荷后破坏模型可计算性。
- 股东、基础成本项和专项成本类型新增/删除同样是结构性草稿变更，必须走 `shareholder_*`、`cost_item_*`、`stage_cost_type_*` 专用 tool call。专项成本类型变更会同步 `stageCostItems`、模板 `specialCosts` 和每个月的 `specialCosts`，避免只改类型表但月份表残留旧值。
- 工作区 JSON 导入 / 导出已经走 server-side bundle：`GET /api/v1/workspace/bundle` 只读导出，`POST /api/v1/workspace/bundle/import` 覆盖当前草稿。Agent 工具为 `workspace_export_bundle` / `workspace_import_bundle`；导入时用户粘贴的大块 JSON 会先由服务端 artifact parser 解析，模型只选择工具，不负责原样复制 bundle。
- Agent 写入安全策略集中在 `apps/api/src/agent/tool-policy.ts`。确认卡创建、确认卡编辑和确认执行都会校验 action kind、风险等级、必需导航、payload 所属工作区、账期锁定和派生分录限制；用户可以编辑未执行动作，但不能通过编辑确认卡绕过这些策略。

## Agent Sandbox Runtime

`sandbox_run_code` 是 Agent harness 的 manifest-scoped 代码执行工具，不是公开 REST 写入接口。服务端会先构造 manifest-scoped 输入包、同名工具 SDK 和输出策略，再通过 `SandboxBroker` 选择真实 backend 执行模型代码。sandbox 不能直接访问 DB、provider key、internal API、领域服务或其他租户数据；代码里的 `xox_sandbox.<tool_name>(...)` 会桥回同一个 Tool Runtime Gateway，按正常租户、权限、确认、领域服务和审计链路执行。

配置项：

- `XOX_SANDBOX_BACKEND=local-script | docker`：默认 `local-script`。`local-script` 在临时工作区启动 Python/Node 子进程，适合本地开发和 smoke；`docker` 使用容器执行，适合后续自托管隔离环境。
- `XOX_SANDBOX_PYTHON_BIN=<path>`：local-script Python 命令，默认 `python`。
- `XOX_SANDBOX_DOCKER_BIN=<path>`：Docker 命令，默认 `docker`。
- `XOX_SANDBOX_DOCKER_PYTHON_IMAGE=python:3.12-alpine`
- `XOX_SANDBOX_DOCKER_NODE_IMAGE=node:22-alpine`

运行约束：

- 子进程/容器只接收 scrubbed env；不会继承 provider key、DB URL、session token、cookie 或 memory 内容。
- 输入文件为 `input.json` 和 `input/input.json`；结构化输出优先写 `output/result.json`。
- 只有 `executionMode=executed`、`status=completed`、`exitCode=0` 且存在结构化输出的 sandbox observation 能满足可复核计算目标。
- `executionMode=not_executed` 只表示 policy 在执行前阻断，不是 fake 结果，不能作为计算 evidence。
- sandbox nested writes 只能通过同名 SDK 桥回 Tool Runtime Gateway。如果嵌套写入超过当前自动化等级，整次 sandbox run 暂停为一张聚合确认/授权；确认后恢复执行或确定性重放，不让模型重新编造写入动作。

### 真实模型 Smoke

`npm.cmd run smoke:agent` 是外网真实 provider 验收命令，不包含在默认 `npm.cmd run test` 中。它会读取根目录 `.env`、`apps/api/.env` 或当前 shell 中的 `OPENAI_COMPATIBLE_API_KEY` / `DEEPSEEK_API_KEY`；这些 `.env` 文件必须保持本地未跟踪，已经由 `.gitignore` 忽略。命令会创建临时 SQLite 数据库，注册临时用户，把真实 provider 保存到当前用户 / 工作区的 provider setting，然后通过真实 HTTP API 验证：

- OpenAI-compatible Chat Completions `tool_calls`，planner 必须返回 `openai_compatible_tool_calls`
- provider setting 不回传 API key，且真实模型调用来自当前用户 / 工作区设置；smoke 的临时数据库会启用 provider key encryption secret
- 只读线上系数试算不写入确认卡
- 缺少记账必要信息时通过模型 tool_call 询问用户补充，不生成确认卡
- 新对话注入同用户 / 同工作区 memory
- 多步骤消息拆出记账确认卡和账号动作拒绝
- 待确认动作载荷可编辑，确认后执行编辑后的载荷
- 员工新增 / 删除和工作区改名
- 通用其他收入、普通支出、员工按人支出
- 一键入账多笔展开为多张确认卡
- 历史账本分录修改、精确作废和恢复作废
- 预实科目差异深度追问和账本历史筛选导航
- 草稿专用字段保存和通用模型 patch
- 工作区 bundle 导出和导入确认卡
- 锁账 / 解锁
- 保存快照
- 把指定快照发布为正式版
- 发布当前版本并创建分享链接
- 撤销分享链接
- 恢复版本、删除快照 / 版本、重置草稿
- background run 启动后可从 thread state 恢复真实模型返回的 data agent 结果
- background run 的持久运行轨迹可从 thread state 恢复
- `agent.action_executed` 审计记录

如果没有 `OPENAI_COMPATIBLE_API_KEY` 或 `DEEPSEEK_API_KEY`，该命令必须失败，不能回退到规则规划。输出只包含结构化验收摘要，不打印 key，临时 smoke 数据库会在运行结束后删除。本轮 DeepSeek `deepseek-v4-pro` smoke 已覆盖 50 个方向，耗时明显长于单元测试，不适合放入默认 CI。

## 验证命令

```bash
npm.cmd run test:web
npm.cmd run build:web
npm.cmd run build:api
npm.cmd run test:api
npm.cmd run test
# 可选，需要真实 OpenAI-compatible provider key；默认可用 DeepSeek key
npm.cmd run smoke:agent
```

预期结果：

- 前端单测全部通过
- 前端生产构建成功
- TypeScript 后端 API/Agent 集成测试全部通过
- 根目录组合测试命令通过

## 审计覆盖

以下核心动作会写入 `audit_logs`：

- 认证：注册 / 登录 / 退出 / 会话续期 / 注销
- 草稿：自动保存与自动保存冲突
- 版本：发布与回滚
- 分享：创建 / 重新签发 / 撤销
- 账务：记账 / 作废
- 期间：锁定 / 解锁
- Agent：确认卡创建 / 执行 / 取消，以及确认后的业务动作

## 部署说明

- `apps/web` 与 `apps/api` 必须保持独立可部署
- 部署脚本放在 `infra/scripts`，不要重新摊平到仓库根目录
- SQLite 仅用于本地和开发环境，生产请使用 PostgreSQL 并配套备份
- 在引入不可逆线上迁移前，先补正式 Kysely migration 版本目录
