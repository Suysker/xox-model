# M121 Tool Discovery Observation

Status: implemented
Date: 2026-06-21

## 目标

删除 `apps/api/src/agent/tool-discovery-tool.ts`。

这个文件不是 xox 财务业务工具。它负责把 progressive tool surface manifest 做检索，并生成 `tool_discovery` / `manifest_rg` 这两类模型可见 observation facts。它属于 harness self-discovery，而不是宿主产品逻辑。

正确边界是：Agentic OS core 拥有 self-discovery observation facts；xox 只提供业务 manifest adapter 和中文 `ReadDraft` 包装。

## 模块分工

Agentic OS：

- `@agentic-os/core` 提供 `buildToolSurfaceDiscoveryObservation()`；
- `@agentic-os/core` 提供 `buildToolSurfaceManifestSearchObservation()`；
- core 保证 exact tool names 优先、search hit 合并、descriptor 不泄露 provider schema、manifest rg path/line/context/truncation facts 稳定。

xox：

- `tool-executor.ts`
  - 调用 core builder；
  - 传入 `buildToolManifests(AGENT_TOOL_REGISTRY)`；
  - 只保留中文标题、message、displayPreview 和 `ReadDraft` shape。
- `tool-discovery-tool.ts`
  - 整文件删除。

## 验证

```bash
cd C:\Github\agentic-os
npm.cmd run check

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts tests/tool-context-engine.test.ts tests/sandbox-tool.test.ts
npm.cmd run test:api
```

## 完成标准

- `apps/api/src/agent/tool-discovery-tool.ts` 已删除；
- architecture guard 防止该文件和本地 search/rank helper 回流；
- xox 仍能通过 sandbox/tool docs 搜索相关测试；
- Agentic OS core 测试覆盖 discovery observation 和 manifest search observation。

## 结果

已于 2026-06-21 完成。

- xox `tool-executor.ts` 直接消费 Agentic OS core discovery builders. This supersedes the earlier M121/M146 location after M156 deleted `runtime-intent-handlers.ts`.
- `apps/api/src/agent/tool-discovery-tool.ts` 已删除。
