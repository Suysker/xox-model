# M152: Delete Host Prompt Assets

Status: implemented and verified; corrected by M153
Date: 2026-06-22

## Goal

Delete the remaining production `apps/api/src/agent/prompts` directory.

This is an amputation step, not a semantic rewrite of xox business policy. The problem was architectural shape: a downstream SaaS host that keeps `agent/prompts/*.md` still looks like it owns planner, turn-lane, and direct-answer harness surfaces. For future hosts such as navigation, the desirable integration shape is closer to OpenAI Agents JS `Agent({ instructions, tools })`: the host supplies policy and tools at concrete boundaries, while the runner, lane protocol, tool loop, recovery, event lifecycle, and observation semantics stay in Agentic OS.

M153 corrects this document's overreach: prompt files are acceptable as host-profile content assets. The invariant is that `apps/api/src/agent/prompts` and generic harness prompt filenames stay deleted, while xox product policy prompt files may live under `apps/api/src/agent/host-profile/prompts`.

## References

- OpenAI Agents JS keeps runtime instructions on the `Agent` configuration and runs them through the SDK runner; it does not require downstream apps to keep a parallel prompt framework directory.
- Hermes keeps prompt assembly in the agent runtime/session layer and treats cache-sensitive prompt construction as harness infrastructure.
- OpenClaw documents that providers own auth/catalog/runtime hooks while core owns the generic loop; plugin/channel code should not recreate the core loop or prompt assembly.

## Deleted Files

- `apps/api/src/agent/prompts/planner.system.md`
- `apps/api/src/agent/prompts/turn-lane.system.md`
- `apps/api/src/agent/prompts/direct-answer.system.md`

After these files are deleted, the production `apps/api/src/agent/prompts` directory must not exist.

## Module Division

Agentic OS owns:

- turn intake protocol and fail-closed lane resolution;
- direct-answer lane state machine;
- provider runtime turn execution, retry/recovery, tool-call normalization, and observation replay;
- generic loop continuation and finalization semantics.

xox owns:

- product identity text and Chinese business tool planning policy;
- tool manifest, schema, capability, and risk policy;
- provider settings, budget policy, and legacy DTO projection at the concrete runtime adapter;
- durable DB rows, permissions, transport, and localized product events.

## Dependency Graph

```mermaid
flowchart TD
    Worker["xox-run-worker-adapter.ts"] --> TurnIntake["@agentic-os/core resolveAgentTurnIntake"]
    Worker --> DirectAnswer["@agentic-os/core runDirectAnswerLane"]
    Worker --> WorkerPolicy["M153 host-profile prompt assets"]
    Runtime["xox-runtime-adapter.ts"] --> Router["@agentic-os/core createRuntimePlanRouter"]
    Runtime --> ProviderRuntime["@agentic-os/runtime-*"]
    Runtime --> RuntimePolicy["M153 host-profile planning policy asset"]
    Runtime --> Tools["xox tool catalog / gateway / DTO mapping"]
```

## Naming And Style

- M153 restores the retained text to files named `xox-*-policy.md`, not `planner.system.md`.
- The prompt files live under `host-profile/prompts` and are consumed by concrete adapters.
- No standalone `prompt-registry`, generic `agent/prompts` directory, or reusable-looking downstream prompt pack remains.

## Validation

Commands:

```powershell
cd C:\Github\xox-model
npm.cmd run build:api
npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts
npm.cmd run test:api
git diff --check
```

Expected:

- TypeScript build passes with no `readFileSync` prompt asset loading in production agent code.
- Architecture guard proves `apps/api/src/agent/prompts` is absent and no source references the deleted prompt filenames.
- Full API behavior remains at least as good as the previous xox harness cut.

Verified on 2026-06-22:

- `npm.cmd run build:api` passed.
- `npm.cmd run test --workspace @xox/api -- tests/agent-architecture.test.ts` passed: 55 tests.
- `npm.cmd run test:api` passed: 11 files, 219 tests.
- `git diff --check` passed.

## Migration Note

This does not mean xox has no product policy. It means product policy is attached to real host boundaries, while Agentic OS continues to absorb the harness semantics. M153 makes that boundary more maintainable by storing product policy in `host-profile/prompts` markdown files instead of TypeScript constants.
