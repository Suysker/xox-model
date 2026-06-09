# Agent Tool Manifest

Status: Proposed canonical generated document

Date: 2026-06-10

Source of truth: `apps/api/src/agent/tool-catalog.ts` (`AGENT_TOOL_REGISTRY`) and `apps/api/src/agent/tool-context-engine/tool-manifest.ts` (`buildToolManifests`).

This document is the human/model-readable tool surface for xox-model Agent OS. It should become generated or verified from the registry so the provider tool catalog, progressive discovery index and sandbox SDK documentation stay in one contract.

## Purpose

The Agent runtime has two generated tool surfaces:

1. Provider tools: model-selected tools exposed through OpenAI-compatible `tool_calls`.
2. Sandbox SDK tools: language-native functions available inside `sandbox_run_code`.

The sandbox must not learn a different private protocol. Every provider tool should have a generated SDK function with the same semantic name, argument schema and documented result contract. Read-only functions can replay authorized observations or read manifest-mounted bundles. Write-capable functions exist as policy-stop stubs: they never mutate SaaS data from sandbox and instead tell the main loop to use the normal provider tool plus confirmation-card path.

When code needs current workspace data or tool documentation, it should call tool-shaped SDK methods instead of pasting previous tool results into code as prose:

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

## Generated Sandbox SDK Contract

| Surface | Sandbox SDK | Authority | Notes |
| --- | --- | --- | --- |
| read-only provider tools | `xox_sandbox.<tool_name>(...)` / generated JS camelCase | observation replay | Returns the same structured observation contract as the provider tool when the data is authorized in the manifest. |
| write-capable provider tools | `xox_sandbox.<tool_name>(...)` / generated JS camelCase | policy stop | Preserves name and argument schema, but cannot mutate data or create confirmations from sandbox. It returns/raises a structured policy result for the main loop. |
| tool manifest search | `xox_sandbox.rg(...)` / `rg(...)` | manifest search | Searches only manifest-authorized virtual docs and safe input text. |
| sandbox output | `xox_sandbox.emit(...)` / `emit(...)` | output | Emits structured sandbox result. |

The implementation should generate these functions from `AGENT_TOOL_REGISTRY` / `buildToolManifests`, not maintain a hand-written sandbox API list.

## Current Provider Tool Index

This table lists the current complete provider tool names. Detailed JSON schema remains in `AGENT_TOOL_REGISTRY`; this document is the searchable summary surface.

| Tool | Capability | Risk | Confirmation | Navigation | Sandbox SDK |
| --- | --- | --- | --- | --- | --- |
| `account_forbidden` | account | read | never | none | `xox_sandbox.account_forbidden` |
| `ask_user_clarification` | clarification | read | never | none | `xox_sandbox.ask_user_clarification` |
| `tool_discover` | tooling | read | never | none | `xox_sandbox.tool_discover` |
| `data_query_workspace` | data | read | never | none | `xox_sandbox.data_query_workspace` |
| `sandbox_run_code` | sandbox | read | never | none | outer tool only |
| `memory_search` | memory | read | never | none | `xox_sandbox.memory_search` |
| `memory_get` | memory | read | never | none | `xox_sandbox.memory_get` |
| `memory_remember` | memory | low | never | none | `xox_sandbox.memory_remember` |
| `ui_navigate` | navigation | read | never | none | `xox_sandbox.ui_navigate` |
| `ledger_create_entry` | ledger | medium | always | bookkeeping | `xox_sandbox.ledger_create_entry` |
| `ledger_create_member_income` | ledger | medium | always | bookkeeping | `xox_sandbox.ledger_create_member_income` |
| `ledger_create_planned_member_income_batch` | ledger | medium | always | bookkeeping | `xox_sandbox.ledger_create_planned_member_income_batch` |
| `ledger_create_planned_related_expense_batch` | ledger | medium | always | bookkeeping | `xox_sandbox.ledger_create_planned_related_expense_batch` |
| `ledger_update_entry` | ledger | medium | always | bookkeeping | `xox_sandbox.ledger_update_entry` |
| `ledger_void_entry` | ledger | high | always | bookkeeping | `xox_sandbox.ledger_void_entry` |
| `ledger_restore_entry` | ledger | high | always | bookkeeping | `xox_sandbox.ledger_restore_entry` |
| `ledger_set_period_lock` | ledger | high | always | bookkeeping | `xox_sandbox.ledger_set_period_lock` |
| `team_member_add` | draft | medium | always | inputs | `xox_sandbox.team_member_add` |
| `team_member_delete` | draft | high | always | inputs | `xox_sandbox.team_member_delete` |
| `employee_add` | draft | medium | always | inputs | `xox_sandbox.employee_add` |
| `employee_delete` | draft | high | always | inputs | `xox_sandbox.employee_delete` |
| `shareholder_add` | draft | medium | always | inputs | `xox_sandbox.shareholder_add` |
| `shareholder_delete` | draft | high | always | inputs | `xox_sandbox.shareholder_delete` |
| `cost_item_add` | draft | medium | always | inputs | `xox_sandbox.cost_item_add` |
| `cost_item_delete` | draft | high | always | inputs | `xox_sandbox.cost_item_delete` |
| `stage_cost_type_add` | draft | medium | always | inputs | `xox_sandbox.stage_cost_type_add` |
| `stage_cost_type_delete` | draft | high | always | inputs | `xox_sandbox.stage_cost_type_delete` |
| `workspace_update_online_factor` | draft | medium | conditional | inputs | `xox_sandbox.workspace_update_online_factor` |
| `workspace_patch_config` | draft | medium | always | inputs | `xox_sandbox.workspace_patch_config` |
| `workspace_configure_operating_model` | draft | high | always | inputs | `xox_sandbox.workspace_configure_operating_model` |
| `workspace_rename` | draft | medium | always | workspace | `xox_sandbox.workspace_rename` |
| `workspace_export_bundle` | import_export | read | never | workspace | `xox_sandbox.workspace_export_bundle` |
| `workspace_import_bundle` | import_export | high | always | workspace | `xox_sandbox.workspace_import_bundle` |
| `workspace_save_snapshot` | version | low | always | workspace | `xox_sandbox.workspace_save_snapshot` |
| `workspace_publish_release` | version | high | always | workspace | `xox_sandbox.workspace_publish_release` |
| `workspace_promote_version` | version | high | always | workspace | `xox_sandbox.workspace_promote_version` |
| `workspace_rollback_version` | version | high | always | workspace | `xox_sandbox.workspace_rollback_version` |
| `workspace_delete_version` | version | high | always | workspace | `xox_sandbox.workspace_delete_version` |
| `workspace_reset_draft` | version | high | always | inputs | `xox_sandbox.workspace_reset_draft` |
| `share_create` | share | high | always | workspace | `xox_sandbox.share_create` |
| `share_revoke` | share | medium | always | workspace | `xox_sandbox.share_revoke` |

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
