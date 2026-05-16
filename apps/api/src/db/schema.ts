import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely'

type JsonText = ColumnType<string, string, string>
type Timestamp = ColumnType<string, string | undefined, string>
type NullableTimestamp = ColumnType<string | null, string | null | undefined, string | null>

export type UserTable = {
  id: Generated<string>
  email: string
  display_name: string
  status: string
  cancelled_at: NullableTimestamp
  created_at: Timestamp
  updated_at: Timestamp
}

export type UserCredentialTable = {
  user_id: string
  password_hash: string
  created_at: Timestamp
  updated_at: Timestamp
}

export type UserSessionTable = {
  id: Generated<string>
  user_id: string
  token_hash: string
  user_agent: string | null
  ip_address: string | null
  expires_at: string
  revoked_at: NullableTimestamp
  created_at: Timestamp
  updated_at: Timestamp
}

export type WorkspaceTable = {
  id: Generated<string>
  owner_id: string
  name: string
  schema_version: number
  active_version_id: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type WorkspaceMemberTable = {
  id: Generated<string>
  workspace_id: string
  user_id: string
  role: string
  created_at: Timestamp
  updated_at: Timestamp
}

export type WorkspaceDraftTable = {
  workspace_id: string
  revision: number
  config_json: JsonText
  result_json: JsonText | null
  last_autosaved_at: NullableTimestamp
  updated_by: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type WorkspaceEventTable = {
  id: Generated<string>
  workspace_id: string
  actor_id: string
  event_type: string
  meta_json: JsonText | null
  created_at: Timestamp
}

export type WorkspaceVersionTable = {
  id: Generated<string>
  workspace_id: string
  version_no: number
  name: string
  kind: string
  note: string | null
  baseline_scenario: string
  source_draft_revision: number
  source_version_id: string | null
  payload_json: JsonText
  result_json: JsonText
  created_by: string
  created_at: Timestamp
}

export type WorkspaceVersionShareTable = {
  id: Generated<string>
  workspace_id: string
  version_id: string
  share_token: string
  created_by: string
  revoked_at: NullableTimestamp
  created_at: Timestamp
  updated_at: Timestamp
}

export type ForecastMonthFactTable = {
  id: Generated<string>
  workspace_id: string
  version_id: string
  scenario_key: string
  month_index: number
  month_label: string
  planned_revenue: number
  planned_cost: number
  planned_profit: number
}

export type ForecastLineItemFactTable = {
  id: Generated<string>
  workspace_id: string
  version_id: string
  scenario_key: string
  month_index: number
  month_label: string
  subject_key: string
  subject_name: string
  subject_type: string
  subject_group: string
  entity_type: string | null
  entity_id: string | null
  planned_amount: number
}

export type LedgerPeriodTable = {
  id: Generated<string>
  workspace_id: string
  baseline_version_id: string | null
  month_index: number
  month_label: string
  status: string
  created_at: Timestamp
  updated_at: Timestamp
}

export type ActualEntryTable = {
  id: Generated<string>
  workspace_id: string
  ledger_period_id: string
  direction: string
  amount: number
  occurred_at: string
  counterparty: string | null
  description: string | null
  related_entity_type: string | null
  related_entity_id: string | null
  related_entity_name: string | null
  source_entry_id: string | null
  entry_origin: string
  derived_kind: string | null
  status: string
  created_by: string
  posted_at: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type ActualEntryAllocationTable = {
  id: Generated<string>
  actual_entry_id: string
  subject_key: string
  subject_name: string
  subject_type: string
  amount: number
}

export type AuditLogTable = {
  id: Generated<string>
  workspace_id: string | null
  actor_id: string | null
  action: string
  status: string
  entity_type: string | null
  entity_id: string | null
  meta_json: JsonText | null
  created_at: Timestamp
}

export type AgentThreadTable = {
  id: Generated<string>
  workspace_id: string
  user_id: string
  title: string
  created_at: Timestamp
  updated_at: Timestamp
}

export type AgentMessageTable = {
  id: Generated<string>
  thread_id: string
  role: string
  content: string
  created_at: Timestamp
}

export type AgentRunTable = {
  id: Generated<string>
  thread_id: string
  user_id: string
  status: string
  created_at: Timestamp
  completed_at: string | null
}

export type AgentActionRequestTable = {
  id: Generated<string>
  thread_id: string
  run_id: string
  workspace_id: string
  user_id: string
  kind: string
  status: string
  title: string
  summary: string
  target_label: string
  risk_level: string
  details_json: JsonText
  navigation_json: JsonText
  payload_json: JsonText
  created_at: Timestamp
  executed_at: string | null
  error_message: string | null
}

export type AgentPlanStepTable = {
  id: Generated<string>
  thread_id: string
  run_id: string
  action_request_id: string | null
  sequence_no: number
  title: string
  description: string
  status: string
  navigation_json: JsonText | null
  created_at: Timestamp
  updated_at: Timestamp
}

export type Database = {
  users: UserTable
  user_credentials: UserCredentialTable
  user_sessions: UserSessionTable
  workspaces: WorkspaceTable
  workspace_members: WorkspaceMemberTable
  workspace_drafts: WorkspaceDraftTable
  workspace_events: WorkspaceEventTable
  workspace_versions: WorkspaceVersionTable
  workspace_version_shares: WorkspaceVersionShareTable
  forecast_month_facts: ForecastMonthFactTable
  forecast_line_item_facts: ForecastLineItemFactTable
  ledger_periods: LedgerPeriodTable
  actual_entries: ActualEntryTable
  actual_entry_allocations: ActualEntryAllocationTable
  audit_logs: AuditLogTable
  agent_threads: AgentThreadTable
  agent_messages: AgentMessageTable
  agent_runs: AgentRunTable
  agent_action_requests: AgentActionRequestTable
  agent_plan_steps: AgentPlanStepTable
}

export type Row<T extends keyof Database> = Selectable<Database[T]>
export type NewRow<T extends keyof Database> = Insertable<Database[T]>
export type UpdateRow<T extends keyof Database> = Updateable<Database[T]>
