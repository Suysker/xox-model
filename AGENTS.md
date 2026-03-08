# AGENTS.md

## Plan Mode (Native First, ExecPlan Fallback)

### When to use planning
Use a full plan for non-trivial work:
- multi-step operations
- architectural decisions
- multi-file features
- significant refactors
- risky changes with unclear blast radius

Use a lightweight plan for trivial/single-step tasks.

### Plan source of truth (must follow)
- Prefer the runtime's native Plan mode (e.g., Codex plan/update_plan, Claude plan mode) as the default planning mechanism.
- If native Plan mode is unavailable, read .agent/PLANS.md and create/maintain a fallback ExecPlan accordingly.

### Plan discipline (must follow)
- Plan comprehensively across implementation, validation, documentation, and any other necessary engineering phases.
- If the task materially changes or something goes sideways, stop and re-plan before continuing.
- Write concrete, unambiguous milestones/steps (avoid vague intent-only plans).
- Keep plan status up to date after each completed milestone (native plan or fallback ExecPlan).

### Plan step requirements (must follow)
In any non-trivial plan (native Plan mode or fallback ExecPlan), each step should clearly include:
- user-visible goal/outcome
- exact repo paths to edit (prefer existing codepaths)
- Skills/Tools to use (only when helpful)
- concrete validation (commands + expected outputs)
- docs to update alongside code (if behavior changes)

## Working Style (must follow)
- Work in small, verifiable increments: Plan First -> Verify Plan -> Implement & Track Progress -> Validate -> Explain Changes -> Document Results -> Capture Lessons -> Re-plan.
- Prefer editing existing codepaths over creating parallel abstractions (minimal impact by default).
- For high-risk or irreversible changes, check in with the user before proceeding.

## Engineering Standards

### Simplicity first
- Make changes as simple as possible while remaining correct.
- Touch only what is necessary; avoid broad refactors unless required.

### Root cause over patching
- Find and fix root causes; avoid temporary fixes unless explicitly requested.
- If a workaround is used, state why and what the proper fix would be.

### Naming and domain consistency
- Reuse existing names and domain concepts where possible.
- Avoid placeholder names/structures; if new names are required, make them specific and consistent.

### Replace behavior cleanly
- When replacing behavior, remove dead code and collapse duplicate paths.
- Do not keep compatibility shims or parallel logic unless required by the task, tests, or an explicit compatibility contract.

### Module readability
- Prefer small, single-responsibility modules.
- If a file is very large (roughly ~1000 LOC) or mixes responsibilities, consider splitting it when it improves legibility.

### Architectural Elegance
- Treat code as craft: strive for pure boundaries, perfect readability, and art-level simplicity.
- Think systemically: strictly align with the unified architecture; do not build isolated silos.
- Reuse first: actively search for existing components/services before inventing new ones.
- Rule of two: if logic appears in 2+ places, extract it into a reusable module immediately.
- Refactor over patching: extend existing abstractions cleanly instead of duct-taping parallel logic.

## Autonomy and Escalation
- For bug reports, proceed to reproduce -> fix -> validate without hand-holding.
- Use logs, errors, and failing tests as the primary guide to resolution.
- Ask the user only when:
  - required inputs are missing
  - the change is risky/irreversible
  - multiple valid product/architecture choices need a decision

## Subagents (if available)
- Use subagents when they reduce context load or enable parallel exploration.
- Prefer one focused line of inquiry per subagent.
- Do not use subagents by default for simple tasks.

## Task Artifacts (repo-convention dependent)
If this repo already uses task files, follow the convention:
- fallback ExecPlan artifacts must be created/updated according to `.agent/PLANS.md`.
- lessons.md (Long-Term Memory - MUST FOLLOW)
  - MUST READ at session start to prevent repeating known mistakes (Self-Improvement Loop).
  - MUST UPDATE whenever a bug is fixed, a course correction occurs, or an explicit user correction is made.
  - CONSOLIDATE overlapping lessons and group them by logical domain.
  - RECORD the root-cause pattern and a generalized, constructive preventive rule.


## Validation (must follow)
- Never mark a task complete without evidence.
- Run the most relevant existing tests/checks in this repo (do not invent commands).
- If no tests exist, add minimal tests for new logic or provide a reproducible manual verification checklist.
- When relevant, compare old vs new behavior and inspect logs/errors.
- Apply a high review bar before completion: correctness, readability, validation, and docs.

## Documentation (always-on)
- Update docs in the same change as code when behavior, usage, APIs, or architecture expectations change.
- Document:
  - what changed
  - how to use it
  - how to verify it
  - any breaking changes / migration notes

## Delivery Output
When delivering a change, include:
- What changed
- How to verify
- What docs were updated
- Remaining risks / follow-ups
- Lessons captured