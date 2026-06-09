# Agent Tool Manifest

Status: Proposed canonical generated document

Date: 2026-06-10

Source of truth: `apps/api/src/agent/tool-catalog.ts` (`AGENT_TOOL_REGISTRY`) and `apps/api/src/agent/tool-context-engine/tool-manifest.ts` (`buildToolManifests`).

This document is the human/model-readable tool surface for xox-model Agent OS. It should become generated or verified from the registry so the provider tool catalog, progressive discovery index and sandbox SDK documentation stay in one contract.

## Purpose

The Agent runtime has two tool surfaces:

1. Provider tools: model-selected tools exposed through OpenAI-compatible `tool_calls`.
2. Sandbox SDK tools: read-only façades available inside `sandbox_run_code`.

The sandbox must not learn a different private protocol. When code needs current workspace data, it should call a tool-shaped SDK method such as:

```python
import xox_sandbox
summary = xox_sandbox.data_query_workspace(scope="workspace_summary", metrics=["roi", "cash"])
matches = xox_sandbox.rg(pattern="data_query_workspace", paths=["tools/agent-tool-manifest.md"])
xox_sandbox.emit({"summary": summary})
```

## Sandbox `rg`

`rg` is a restricted read-only search over manifest-mounted virtual documents. It is not host filesystem access.

Allowed roots:

- `tools/agent-tool-manifest.md`
- `tools/effective-tool-manifest.md`
- `observations/*.json`
- `observations/*.md`
- `inputs/**` files explicitly authorized in the sandbox manifest

Forbidden roots:

- repository files
- database files
- environment files
- provider keys
- server logs
- other tenant data
- arbitrary absolute paths
- symlinks or `..` traversal

Default behavior:

- literal search by default;
- regex mode only when explicitly requested;
- bounded matches, context lines, bytes and timeout;
- secret redaction before returning results.

## Sandbox SDK Facades

| Provider tool | Sandbox SDK | Authority | Notes |
| --- | --- | --- | --- |
| `data_query_workspace` | `xox_sandbox.data_query_workspace(...)` / `dataQueryWorkspace(...)` | read-only observation | Returns the same domain observation structure the model saw. |
| tool manifest search | `xox_sandbox.rg(...)` / `rg(...)` | read-only search | Searches only manifest-authorized virtual docs and safe input text. |
| sandbox output | `xox_sandbox.emit(...)` / `emit(...)` | observation output | Emits structured sandbox result. |

Business-write tools are not available inside sandbox SDK. Writes must return to provider tools, confirmation cards, domain services and audit.

## Current Provider Tool Index

This table lists the current complete provider tool names. Detailed JSON schema remains in `AGENT_TOOL_REGISTRY`; this document is the searchable summary surface.

| Tool | Capability | Risk | Confirmation | Navigation | Sandbox SDK |
| --- | --- | --- | --- | --- | --- |
| `account_forbidden` | account | read | never | none | no |
| `ask_user_clarification` | clarification | read | never | none | no |
| `tool_discover` | tooling | read | never | none | no |
| `data_query_workspace` | data | read | never | none | `xox_sandbox.data_query_workspace` |
| `sandbox_run_code` | sandbox | read | never | none | outer tool only |
| `memory_search` | memory | read | never | none | no |
| `memory_get` | memory | read | never | none | no |
| `memory_remember` | memory | low | never | none | no |
| `ui_navigate` | navigation | read | never | none | no |
| `ledger_create_entry` | ledger | medium | always | bookkeeping | no |
| `ledger_create_member_income` | ledger | medium | always | bookkeeping | no |
| `ledger_create_planned_member_income_batch` | ledger | medium | always | bookkeeping | no |
| `ledger_create_planned_related_expense_batch` | ledger | medium | always | bookkeeping | no |
| `ledger_update_entry` | ledger | medium | always | bookkeeping | no |
| `ledger_void_entry` | ledger | high | always | bookkeeping | no |
| `ledger_restore_entry` | ledger | high | always | bookkeeping | no |
| `ledger_set_period_lock` | ledger | high | always | bookkeeping | no |
| `team_member_add` | draft | medium | always | inputs | no |
| `team_member_delete` | draft | high | always | inputs | no |
| `employee_add` | draft | medium | always | inputs | no |
| `employee_delete` | draft | high | always | inputs | no |
| `shareholder_add` | draft | medium | always | inputs | no |
| `shareholder_delete` | draft | high | always | inputs | no |
| `cost_item_add` | draft | medium | always | inputs | no |
| `cost_item_delete` | draft | high | always | inputs | no |
| `stage_cost_type_add` | draft | medium | always | inputs | no |
| `stage_cost_type_delete` | draft | high | always | inputs | no |
| `workspace_update_online_factor` | draft | medium | conditional | inputs | no |
| `workspace_patch_config` | draft | medium | always | inputs | no |
| `workspace_configure_operating_model` | draft | high | always | inputs | no |
| `workspace_rename` | draft | medium | always | workspace | no |
| `workspace_export_bundle` | import_export | read | never | workspace | no |
| `workspace_import_bundle` | import_export | high | always | workspace | no |
| `workspace_save_snapshot` | version | low | always | workspace | no |
| `workspace_publish_release` | version | high | always | workspace | no |
| `workspace_promote_version` | version | high | always | workspace | no |
| `workspace_rollback_version` | version | high | always | workspace | no |
| `workspace_delete_version` | version | high | always | workspace | no |
| `workspace_reset_draft` | version | high | always | inputs | no |
| `share_create` | share | high | always | workspace | no |
| `share_revoke` | share | medium | always | workspace | no |

## Provider Tool Summaries

### Kernel And Control

- `account_forbidden`: refuse account-impacting actions.
- `ask_user_clarification`: ask for missing information that is not available from current context or allowed observations.
- `tool_discover`: search the authorized tool manifest and materialize real schemas in the main loop.
- `ui_navigate`: open the relevant product page without writing business data.

### Data And Computation

- `data_query_workspace`: read tenant-scoped workspace facts such as forecast summary, month summary, member/team/entity lists, ledger history and variance detail.
- `sandbox_run_code`: execute manifest-scoped read-only code for calculations, file transformations and temporary artifacts.

### Memory

- `memory_search`: search authorized workspace/user memory.
- `memory_get`: read a precise memory item.
- `memory_remember`: save approved long-term memory.

### Ledger

- `ledger_create_entry`: create a generic income or expense entry.
- `ledger_create_member_income`: create member sales income from offline/online units.
- `ledger_create_planned_member_income_batch`: batch post planned member income.
- `ledger_create_planned_related_expense_batch`: batch post planned member/employee related expenses.
- `ledger_update_entry`: edit a historical ledger entry.
- `ledger_void_entry`: void a ledger entry.
- `ledger_restore_entry`: restore a voided ledger entry.
- `ledger_set_period_lock`: lock or unlock a ledger period.

### Draft Model

- `team_member_add`: add a team member.
- `team_member_delete`: delete a team member.
- `employee_add`: add an employee.
- `employee_delete`: delete an employee.
- `shareholder_add`: add a shareholder.
- `shareholder_delete`: delete a shareholder.
- `cost_item_add`: add a base cost item.
- `cost_item_delete`: delete a base cost item.
- `stage_cost_type_add`: add a stage/special cost type.
- `stage_cost_type_delete`: delete a stage/special cost type.
- `workspace_update_online_factor`: forecast or save an online factor change.
- `workspace_patch_config`: patch generic model fields.
- `workspace_configure_operating_model`: build a complete operating model draft from a structured business brief.
- `workspace_rename`: rename the workspace.

### Import, Version And Share

- `workspace_export_bundle`: export workspace bundle.
- `workspace_import_bundle`: import workspace bundle.
- `workspace_save_snapshot`: save a snapshot.
- `workspace_publish_release`: publish current draft as an immutable release.
- `workspace_promote_version`: publish a snapshot as release.
- `workspace_rollback_version`: restore a draft from a version.
- `workspace_delete_version`: delete a version.
- `workspace_reset_draft`: reset current draft.
- `share_create`: create a public share link for a release.
- `share_revoke`: revoke a share link.

## Generation Requirement

Implementation must add a check so this document cannot drift from `AGENT_TOOL_REGISTRY`.

Expected generator/check behavior:

```text
AGENT_TOOL_REGISTRY
-> buildToolManifests(...)
-> docs/agent-tool-manifest.md
-> sandbox manifest mount: tools/agent-tool-manifest.md
-> sandbox rg search over the mounted doc
```

If a tool is added, removed or renamed, the check must fail until this manifest is regenerated.
