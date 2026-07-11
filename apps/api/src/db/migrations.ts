import { sql, type Kysely } from 'kysely'
import type { Database } from './schema.js'

async function exec(db: Kysely<Database>, statement: string) {
  await sql.raw(statement).execute(db)
}

async function tableColumns(db: Kysely<Database>, tableName: string) {
  const rows = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(tableName)})`.execute(db)
  return new Set(rows.rows.map((row) => row.name))
}

async function addColumnIfMissing(db: Kysely<Database>, tableName: string, columnName: string, definition: string) {
  const columns = await tableColumns(db, tableName)
  if (!columns.has(columnName)) {
    await exec(db, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
  }
}

async function renameColumnIfPresent(
  db: Kysely<Database>,
  tableName: string,
  oldColumnName: string,
  newColumnName: string,
) {
  const columns = await tableColumns(db, tableName)
  if (!columns.has(oldColumnName)) return
  if (columns.has(newColumnName)) {
    throw new Error(`${tableName} contains both ${oldColumnName} and ${newColumnName}.`)
  }
  await exec(db, `ALTER TABLE ${tableName} RENAME COLUMN ${oldColumnName} TO ${newColumnName}`)
}

export async function runMigrations(db: Kysely<Database>) {
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      display_name VARCHAR(120) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      cancelled_at DATETIME,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS user_credentials (
      user_id VARCHAR(36) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS user_sessions (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      user_agent VARCHAR(255),
      ip_address VARCHAR(64),
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspaces (
      id VARCHAR(36) PRIMARY KEY,
      owner_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(160) NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      active_version_id VARCHAR(36),
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspace_members (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(32) NOT NULL DEFAULT 'owner',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE(workspace_id, user_id)
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspace_drafts (
      workspace_id VARCHAR(36) PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1,
      config_json JSON NOT NULL,
      result_json JSON,
      last_autosaved_at DATETIME,
      updated_by VARCHAR(36),
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspace_events (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_id VARCHAR(36) NOT NULL REFERENCES users(id),
      event_type VARCHAR(48) NOT NULL,
      meta_json JSON,
      created_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspace_versions (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL,
      name VARCHAR(180) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      note TEXT,
      baseline_scenario VARCHAR(16) NOT NULL DEFAULT 'base',
      source_draft_revision INTEGER NOT NULL,
      source_version_id VARCHAR(36),
      payload_json JSON NOT NULL,
      result_json JSON NOT NULL,
      created_by VARCHAR(36) NOT NULL REFERENCES users(id),
      created_at DATETIME NOT NULL,
      UNIQUE(workspace_id, version_no)
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS workspace_version_shares (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version_id VARCHAR(36) NOT NULL REFERENCES workspace_versions(id) ON DELETE CASCADE UNIQUE,
      share_token VARCHAR(96) NOT NULL UNIQUE,
      created_by VARCHAR(36) NOT NULL REFERENCES users(id),
      revoked_at DATETIME,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS forecast_month_facts (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version_id VARCHAR(36) NOT NULL REFERENCES workspace_versions(id) ON DELETE CASCADE,
      scenario_key VARCHAR(16) NOT NULL,
      month_index INTEGER NOT NULL,
      month_label VARCHAR(32) NOT NULL,
      planned_revenue FLOAT NOT NULL DEFAULT 0,
      planned_cost FLOAT NOT NULL DEFAULT 0,
      planned_profit FLOAT NOT NULL DEFAULT 0,
      UNIQUE(version_id, scenario_key, month_index)
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS forecast_line_item_facts (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version_id VARCHAR(36) NOT NULL REFERENCES workspace_versions(id) ON DELETE CASCADE,
      scenario_key VARCHAR(16) NOT NULL,
      month_index INTEGER NOT NULL,
      month_label VARCHAR(32) NOT NULL,
      subject_key VARCHAR(255) NOT NULL,
      subject_name VARCHAR(180) NOT NULL,
      subject_type VARCHAR(32) NOT NULL,
      subject_group VARCHAR(64) NOT NULL,
      entity_type VARCHAR(64),
      entity_id VARCHAR(128),
      planned_amount FLOAT NOT NULL DEFAULT 0
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS ledger_periods (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      baseline_version_id VARCHAR(36),
      month_index INTEGER NOT NULL,
      month_label VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'open',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE(workspace_id, month_index)
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS actual_entries (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      ledger_period_id VARCHAR(36) NOT NULL REFERENCES ledger_periods(id) ON DELETE CASCADE,
      direction VARCHAR(16) NOT NULL,
      amount FLOAT NOT NULL,
      occurred_at DATETIME NOT NULL,
      counterparty VARCHAR(180),
      description TEXT,
      related_entity_type VARCHAR(32),
      related_entity_id VARCHAR(128),
      related_entity_name VARCHAR(180),
      source_entry_id VARCHAR(36),
      entry_origin VARCHAR(32) NOT NULL DEFAULT 'manual',
      derived_kind VARCHAR(32),
      status VARCHAR(16) NOT NULL DEFAULT 'posted',
      created_by VARCHAR(36) NOT NULL REFERENCES users(id),
      posted_at DATETIME,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS actual_entry_allocations (
      id VARCHAR(36) PRIMARY KEY,
      actual_entry_id VARCHAR(36) NOT NULL REFERENCES actual_entries(id) ON DELETE CASCADE,
      subject_key VARCHAR(255) NOT NULL,
      subject_name VARCHAR(180) NOT NULL,
      subject_type VARCHAR(32) NOT NULL,
      amount FLOAT NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36),
      actor_id VARCHAR(36),
      action VARCHAR(96) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'success',
      entity_type VARCHAR(64),
      entity_id VARCHAR(64),
      meta_json JSON,
      created_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_threads (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(180) NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_messages (
      id VARCHAR(36) PRIMARY KEY,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      role VARCHAR(16) NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_runs (
      id VARCHAR(36) PRIMARY KEY,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(32) NOT NULL,
      input_message_id VARCHAR(36),
      input_message TEXT,
      runtime_source VARCHAR(64),
      automation_level VARCHAR(16) NOT NULL DEFAULT 'manual',
      goal_status VARCHAR(32),
      worker_id VARCHAR(96),
      lease_expires_at DATETIME,
      heartbeat_at DATETIME,
      created_at DATETIME NOT NULL,
      completed_at DATETIME
    )`,
  )
  await addColumnIfMissing(db, 'agent_runs', 'input_message_id', 'VARCHAR(36)')
  await addColumnIfMissing(db, 'agent_runs', 'input_message', 'TEXT')
  await renameColumnIfPresent(db, 'agent_runs', 'planner_source', 'runtime_source')
  await addColumnIfMissing(db, 'agent_runs', 'runtime_source', 'VARCHAR(64)')
  await addColumnIfMissing(db, 'agent_runs', 'automation_level', "VARCHAR(16) NOT NULL DEFAULT 'manual'")
  await addColumnIfMissing(db, 'agent_runs', 'goal_status', 'VARCHAR(32)')
  await addColumnIfMissing(db, 'agent_runs', 'worker_id', 'VARCHAR(96)')
  await addColumnIfMissing(db, 'agent_runs', 'lease_expires_at', 'DATETIME')
  await addColumnIfMissing(db, 'agent_runs', 'heartbeat_at', 'DATETIME')
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_goals (
      id VARCHAR(36) PRIMARY KEY,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      run_id VARCHAR(36) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(32) NOT NULL,
      objective TEXT NOT NULL,
      contract_json JSON NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      completed_at DATETIME,
      blocked_reason TEXT
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_run_events (
      id VARCHAR(36) PRIMARY KEY,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      run_id VARCHAR(36) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      sequence_no INTEGER NOT NULL,
      channel VARCHAR(16) NOT NULL DEFAULT 'lifecycle',
      event_type VARCHAR(64) NOT NULL,
      title VARCHAR(180) NOT NULL,
      message TEXT NOT NULL,
      status VARCHAR(32) NOT NULL,
      data_json JSON,
      created_at DATETIME NOT NULL,
      UNIQUE(run_id, sequence_no)
    )`,
  )
  await addColumnIfMissing(db, 'agent_run_events', 'channel', "VARCHAR(16) NOT NULL DEFAULT 'lifecycle'")
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_action_requests (
      id VARCHAR(36) PRIMARY KEY,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      run_id VARCHAR(36) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind VARCHAR(96) NOT NULL,
      status VARCHAR(32) NOT NULL,
      title VARCHAR(180) NOT NULL,
      summary TEXT NOT NULL,
      target_label VARCHAR(180) NOT NULL,
      risk_level VARCHAR(16) NOT NULL,
      details_json JSON NOT NULL,
      navigation_json JSON NOT NULL,
      payload_json JSON NOT NULL,
      tool_call_id VARCHAR(500),
      created_at DATETIME NOT NULL,
      executed_at DATETIME,
      error_message TEXT
    )`,
  )
  await addColumnIfMissing(db, 'agent_action_requests', 'tool_call_id', 'VARCHAR(500)')
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_plan_steps (
      id VARCHAR(36) PRIMARY KEY,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      run_id VARCHAR(36) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      action_request_id VARCHAR(36) REFERENCES agent_action_requests(id) ON DELETE SET NULL,
      sequence_no INTEGER NOT NULL,
      title VARCHAR(180) NOT NULL,
      description TEXT NOT NULL,
      status VARCHAR(32) NOT NULL,
      navigation_json JSON,
      tool_name VARCHAR(120),
      tool_call_id VARCHAR(180),
      tool_arguments_json JSON,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await addColumnIfMissing(db, 'agent_plan_steps', 'tool_name', 'VARCHAR(120)')
  await addColumnIfMissing(db, 'agent_plan_steps', 'tool_call_id', 'VARCHAR(180)')
  await addColumnIfMissing(db, 'agent_plan_steps', 'tool_arguments_json', 'JSON')
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_memories (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id VARCHAR(36) REFERENCES agent_threads(id) ON DELETE SET NULL,
      kind VARCHAR(64) NOT NULL,
      scope_type VARCHAR(32) NOT NULL DEFAULT 'workspace',
      memory_type VARCHAR(32) NOT NULL DEFAULT 'semantic',
      lane VARCHAR(32) NOT NULL DEFAULT 'semantic',
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      key VARCHAR(128) NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_score REAL NOT NULL DEFAULT 0,
      sensitivity VARCHAR(32) NOT NULL DEFAULT 'normal',
      injectable INTEGER NOT NULL DEFAULT 1,
      normalized_hash VARCHAR(96),
      source_message_id VARCHAR(36),
      source_run_id VARCHAR(36),
      source_kind VARCHAR(64),
      evidence_json JSON,
      last_used_at DATETIME,
      last_verified_at DATETIME,
      promoted_at DATETIME,
      expires_at DATETIME,
      superseded_by VARCHAR(36),
      metadata_json JSON,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      archived_at DATETIME
    )`,
  )
  await addColumnIfMissing(db, 'agent_memories', 'scope_type', "VARCHAR(32) NOT NULL DEFAULT 'workspace'")
  await addColumnIfMissing(db, 'agent_memories', 'memory_type', "VARCHAR(32) NOT NULL DEFAULT 'semantic'")
  await addColumnIfMissing(db, 'agent_memories', 'lane', "VARCHAR(32) NOT NULL DEFAULT 'semantic'")
  await addColumnIfMissing(db, 'agent_memories', 'status', "VARCHAR(32) NOT NULL DEFAULT 'active'")
  await addColumnIfMissing(db, 'agent_memories', 'sensitivity', "VARCHAR(32) NOT NULL DEFAULT 'normal'")
  await addColumnIfMissing(db, 'agent_memories', 'injectable', "INTEGER NOT NULL DEFAULT 1")
  await addColumnIfMissing(db, 'agent_memories', 'normalized_hash', 'VARCHAR(96)')
  await addColumnIfMissing(db, 'agent_memories', 'evidence_score', "REAL NOT NULL DEFAULT 0")
  await addColumnIfMissing(db, 'agent_memories', 'superseded_by', 'VARCHAR(36)')
  await addColumnIfMissing(db, 'agent_memories', 'source_kind', 'VARCHAR(64)')
  await addColumnIfMissing(db, 'agent_memories', 'last_verified_at', 'DATETIME')
  await addColumnIfMissing(db, 'agent_memories', 'source_run_id', 'VARCHAR(36)')
  await addColumnIfMissing(db, 'agent_memories', 'evidence_json', 'JSON')
  await addColumnIfMissing(db, 'agent_memories', 'last_used_at', 'DATETIME')
  await addColumnIfMissing(db, 'agent_memories', 'promoted_at', 'DATETIME')
  await addColumnIfMissing(db, 'agent_memories', 'expires_at', 'DATETIME')
  await addColumnIfMissing(db, 'agent_memories', 'metadata_json', 'JSON')
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_memory_events (
      id VARCHAR(36) PRIMARY KEY,
      memory_id VARCHAR(36) REFERENCES agent_memories(id) ON DELETE SET NULL,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id VARCHAR(36) REFERENCES agent_threads(id) ON DELETE SET NULL,
      run_id VARCHAR(36) REFERENCES agent_runs(id) ON DELETE SET NULL,
      event_type VARCHAR(32) NOT NULL,
      evidence_json JSON,
      metadata_json JSON,
      created_at DATETIME NOT NULL
    )`,
  )
  await exec(db, 'CREATE INDEX IF NOT EXISTS idx_agent_memories_scope ON agent_memories (workspace_id, user_id, archived_at, status)')
  await exec(db, 'CREATE INDEX IF NOT EXISTS idx_agent_memories_recall ON agent_memories (workspace_id, user_id, injectable, lane, status)')
  await exec(db, 'CREATE INDEX IF NOT EXISTS idx_agent_memories_hash ON agent_memories (workspace_id, user_id, normalized_hash)')
  await exec(db, 'CREATE INDEX IF NOT EXISTS idx_agent_memory_events_memory ON agent_memory_events (memory_id, event_type)')
  await exec(db, 'CREATE INDEX IF NOT EXISTS idx_agent_memory_events_run ON agent_memory_events (run_id, event_type)')
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_memory_notes (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id VARCHAR(36) REFERENCES agent_threads(id) ON DELETE SET NULL,
      run_id VARCHAR(36) REFERENCES agent_runs(id) ON DELETE SET NULL,
      note_date VARCHAR(10) NOT NULL,
      layer VARCHAR(32) NOT NULL DEFAULT 'daily',
      title VARCHAR(180) NOT NULL,
      content TEXT NOT NULL,
      evidence_json JSON,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      archived_at DATETIME
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_memory_recall_signals (
      id VARCHAR(36) PRIMARY KEY,
      memory_id VARCHAR(36) NOT NULL REFERENCES agent_memories(id) ON DELETE CASCADE,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recall_count INTEGER NOT NULL DEFAULT 0,
      total_score REAL NOT NULL DEFAULT 0,
      max_score REAL NOT NULL DEFAULT 0,
      query_hashes_json JSON NOT NULL DEFAULT '[]',
      recall_days_json JSON NOT NULL DEFAULT '[]',
      first_recalled_at DATETIME NOT NULL,
      last_recalled_at DATETIME NOT NULL,
      promoted_at DATETIME,
      metadata_json JSON,
      UNIQUE(memory_id, workspace_id, user_id)
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_memory_dream_reports (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id VARCHAR(36) REFERENCES agent_threads(id) ON DELETE SET NULL,
      run_id VARCHAR(36) REFERENCES agent_runs(id) ON DELETE SET NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'review',
      title VARCHAR(180) NOT NULL,
      summary TEXT NOT NULL,
      candidate_ids_json JSON NOT NULL DEFAULT '[]',
      promoted_ids_json JSON NOT NULL DEFAULT '[]',
      score_json JSON,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  )
  await exec(db, 'CREATE INDEX IF NOT EXISTS idx_agent_memory_notes_scope ON agent_memory_notes (workspace_id, user_id, note_date, archived_at)')
  await exec(db, 'CREATE INDEX IF NOT EXISTS idx_agent_memory_recall_signals_scope ON agent_memory_recall_signals (workspace_id, user_id, last_recalled_at)')
  await exec(db, 'CREATE INDEX IF NOT EXISTS idx_agent_memory_dream_reports_scope ON agent_memory_dream_reports (workspace_id, user_id, created_at)')
  await exec(
    db,
    `UPDATE agent_memories
     SET normalized_hash = COALESCE(normalized_hash, lower(substr(key || ':' || value, 1, 96))),
         lane = CASE
           WHEN key LIKE 'agent.evaluator.finding.%' OR value LIKE 'Evaluator 发现目标未满足%' THEN 'diagnostic'
           WHEN key LIKE 'agent.goal.completed.%' THEN 'episodic'
           WHEN key LIKE 'workspace.recent_related_entity.%' THEN 'working'
           WHEN memory_type IN ('semantic', 'procedural', 'working', 'episodic') THEN memory_type
           ELSE lane
         END,
         source_kind = CASE
           WHEN key LIKE 'agent.evaluator.finding.%' OR value LIKE 'Evaluator 发现目标未满足%' THEN 'evaluator_result'
           WHEN key LIKE 'agent.goal.completed.%' THEN 'completed_goal'
           WHEN key LIKE 'workspace.episode.%' OR key LIKE 'ledger.episode.%' THEN 'confirmed_action'
           WHEN key LIKE 'workspace.recent_related_entity.%' THEN 'working_context'
           ELSE source_kind
         END,
         injectable = CASE
           WHEN status = 'candidate' THEN 0
           WHEN status IN ('archived', 'rejected', 'expired', 'superseded') THEN 0
           WHEN key LIKE 'agent.evaluator.finding.%' OR value LIKE 'Evaluator 发现目标未满足%' THEN 0
           WHEN key LIKE 'workspace.episode.%' OR key LIKE 'ledger.episode.%' OR key LIKE 'agent.goal.completed.%' THEN 0
           WHEN key LIKE 'workspace.recent_related_entity.%' THEN 0
           WHEN memory_type IN ('semantic', 'procedural') AND status IN ('active', 'promoted') THEN 1
           ELSE 0
         END`,
  )
  await exec(
    db,
    `UPDATE agent_memories
     SET status = 'archived',
         archived_at = COALESCE(archived_at, updated_at),
         updated_at = updated_at,
         injectable = 0,
         lane = 'diagnostic',
         kind = 'diagnostic',
         source_kind = 'evaluator_result'
     WHERE key LIKE 'agent.evaluator.finding.%'
        OR value LIKE 'Evaluator 发现目标未满足%'`,
  )
  await exec(
    db,
    `UPDATE agent_memories
     SET status = 'archived',
         archived_at = COALESCE(archived_at, updated_at),
         injectable = 0,
         lane = 'episodic',
         source_kind = 'completed_goal'
     WHERE key LIKE 'agent.goal.completed.%'`,
  )
  await exec(
    db,
    `UPDATE agent_memories
     SET status = 'expired',
         expires_at = COALESCE(expires_at, updated_at),
         injectable = 0,
         lane = 'working',
         source_kind = 'working_context'
     WHERE key LIKE 'workspace.recent_related_entity.%'`,
  )
  await exec(
    db,
    `UPDATE agent_memories
     SET status = 'archived',
         archived_at = COALESCE(archived_at, updated_at),
         injectable = 0,
         lane = 'episodic',
         source_kind = COALESCE(source_kind, 'confirmed_action')
     WHERE key LIKE 'workspace.episode.%'
        OR key LIKE 'ledger.episode.%'`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_context_snapshots (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id VARCHAR(36) NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      created_at DATETIME NOT NULL
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_provider_settings (
      id VARCHAR(36) PRIMARY KEY,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(64) NOT NULL,
      base_url TEXT NOT NULL,
      model VARCHAR(128) NOT NULL,
      api_key TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE(workspace_id, user_id)
    )`,
  )
  await exec(
    db,
    `CREATE TABLE IF NOT EXISTS agent_harness_control_records (
      id VARCHAR(36) PRIMARY KEY,
      tenant_id VARCHAR(128) NOT NULL,
      workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id VARCHAR(36) NOT NULL DEFAULT '',
      collection_name VARCHAR(160) NOT NULL,
      record_key VARCHAR(255) NOT NULL,
      version_no INTEGER NOT NULL,
      value_json JSON NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE(tenant_id, workspace_id, user_id, collection_name, record_key)
    )`,
  )
  await exec(
    db,
    'CREATE INDEX IF NOT EXISTS idx_agent_harness_control_collection ON agent_harness_control_records (tenant_id, workspace_id, user_id, collection_name, updated_at)',
  )

  await addColumnIfMissing(db, 'actual_entries', 'related_entity_type', 'VARCHAR(32)')
  await addColumnIfMissing(db, 'actual_entries', 'related_entity_id', 'VARCHAR(128)')
  await addColumnIfMissing(db, 'actual_entries', 'related_entity_name', 'VARCHAR(180)')
  await addColumnIfMissing(db, 'actual_entries', 'source_entry_id', 'VARCHAR(36)')
  await addColumnIfMissing(db, 'actual_entries', 'entry_origin', "VARCHAR(32) DEFAULT 'manual'")
  await addColumnIfMissing(db, 'actual_entries', 'derived_kind', 'VARCHAR(32)')
}
