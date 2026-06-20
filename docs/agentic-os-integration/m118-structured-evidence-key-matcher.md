# M118 Structured Evidence Key Matcher

Status: implemented
Date: 2026-06-21

## 目标

开始按“整文件删除”推进。

`apps/api/src/agent/structured-evidence-utils.ts` 只有一个递归 key matcher，用于 evidence、obligation 和 response evaluator 判断结构化事实里是否出现某个字段。它不依赖 xox 财务领域，是 Agentic OS evidence/obligation CPU 的通用结构化事实匹配能力。

## 模块分工

Agentic OS：

- `@agentic-os/core`
  - 新增 `evidenceFactsContainKey(value, key)`；
  - 负责递归匹配 nested object / array 内的 evidence fact key；
  - 在 core evidence ledger 测试里覆盖直接 key、嵌套数组、缺失 key 和 null 输入。

xox：

- `evidence-ledger.ts`
  - 用 core helper 做 subject inference 和 evidence filtering。
- `loop-obligation-ledger.ts`
  - 用 core helper 判断 shareholder obligation 是否被 domain observation 满足。
- `response-evaluator.ts`
  - 用 core helper 判断 ordered shareholder evidence 是否存在。
- `structured-evidence-utils.ts`
  - 整文件删除。

## 验证

```bash
cd C:\Github\agentic-os
npm.cmd run build -w @agentic-os/core
npm.cmd run test -w @agentic-os/core
npm.cmd run check

cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts tests/response-evaluator.test.ts tests/loop-obligation-ledger.test.ts
npm.cmd run test:api
```

## 完成标准

- `apps/api/src/agent/structured-evidence-utils.ts` 已删除；
- xox 不再保留 structured evidence matcher helper 文件；
- architecture guard 防止该文件回流；
- Agentic OS 和 xox 验证通过。

## 结果

已于 2026-06-21 完成。

- `@agentic-os/core` 新增并导出 `evidenceFactsContainKey()`。
- xox evidence、obligation、response evaluator 三处调用点改为直接消费 core helper。
- `apps/api/src/agent/structured-evidence-utils.ts` 已删除。
